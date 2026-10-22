#!/usr/bin/env python3
"""GHAT ISHARA road reporting-bias diagnostic on spatial CV development data.

Usage (from ~/GHAT_ISHARA_ML):
    .venv/bin/python check_road_bias_v3_v4.py

The existing locked 447-row test split is NEVER used for fitting or evaluation.
Models V3 and V4 are refit on the same 5 geographical folds and not overwritten.
"""
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score, recall_score, confusion_matrix
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data/raw/PRAHARI_250m_Training_Lithology_Rainfall_RiverDistance_RoadDistance_REVIEW.csv"
SPLIT = ROOT / "data/spatial_split_250m.csv"
OUT = ROOT / "outputs"

BASE = [
    "elevation", "slope", "aspect", "northness", "eastness",
    "curvature", "ruggedness", "twi", "landcover", "ndvi",
    "clay_0_5_pct", "clay_5_15_pct", "clay_15_30_pct",
    "bdod_0_5_kg_dm3", "bdod_5_15_kg_dm3", "bdod_15_30_kg_dm3",
    "cfvo_0_5_pct", "cfvo_5_15_pct", "cfvo_15_30_pct",
]
RAIN, RIVER, ROAD, LITH = (
    "rainfall_climatology_value", "distance_to_waterway_m", "distance_to_road_m", "lithology_clean"
)
RF_ARGS = dict(
    n_estimators=500, max_features=3, min_samples_leaf=3,
    bootstrap=True, max_samples=0.5, random_state=42, n_jobs=-1
)

for path in (DATA, SPLIT):
    if not path.is_file():
        raise SystemExit(f"Missing file: {path}\nPlace the downloaded file in data/raw/ and retry.")

df = pd.read_csv(DATA)
split = pd.read_csv(SPLIT)
if len(df) != 2050 or len(split) != 2050:
    raise SystemExit("Expected exactly 2050 rows in both files; refusing to continue.")
for col in (".geo", "Label", "system:index"):
    if col not in df or col not in split or not df[col].equals(split[col]):
        raise SystemExit(f"Row-alignment failure for {col}; refusing to continue.")

required = BASE + [RAIN, RIVER, ROAD, "lithology", "lithology_status"]
missing = [x for x in required if x not in df]
if missing:
    raise SystemExit(f"Missing predictors: {missing}")

df[LITH] = (df["lithology"].where(df["lithology_status"].eq("MATCHED"), "UNKNOWN")
            .fillna("UNKNOWN").astype(str).str.strip().str.upper())
df["split"] = split["split"]
df["cv_fold"] = split["cv_fold"].astype(int)
df["spatial_group"] = split["spatial_group"]

if (df["split"].eq("train").sum(), df["split"].eq("test").sum()) != (1603, 447):
    raise SystemExit("Unexpected train/test sizes; refusing to continue.")
if not (df.loc[df["split"].eq("test"), "cv_fold"] == -1).all():
    raise SystemExit("Unexpected held-out test fold assignments.")

dev = df.loc[df["split"].eq("train")].copy()
if set(dev["cv_fold"]) != set(range(5)):
    raise SystemExit("Expected development folds 0 through 4.")
if dev["spatial_group"].isna().any():
    raise SystemExit("Missing spatial groups.")
for name in BASE + [RAIN, RIVER, ROAD]:
    if not np.isfinite(pd.to_numeric(dev[name], errors="coerce").to_numpy()).all():
        raise SystemExit(f"Invalid predictor values in development data: {name}")


def build_model(include_road):
    numeric = BASE + [RAIN, RIVER] + ([ROAD] if include_road else [])
    encoder = ColumnTransformer([
        ("numeric", "passthrough", numeric),
        ("lithology", OneHotEncoder(handle_unknown="ignore"), [LITH]),
    ])
    return Pipeline([
        ("features", encoder),
        ("rf", RandomForestClassifier(**RF_ARGS)),
    ])


def auc_if_possible(y, scores):
    return roc_auc_score(y, scores) if len(np.unique(y)) == 2 else float("nan")


oof = []
fold_rows = []
print("Checking V3 (without roads) against V4 (with roads) on 5 SPATIAL folds...", flush=True)
for fold in range(5):
    tr = dev.loc[dev["cv_fold"].ne(fold)]
    va = dev.loc[dev["cv_fold"].eq(fold)]
    if set(tr["spatial_group"]) & set(va["spatial_group"]):
        raise SystemExit(f"Spatial leakage: group overlap in fold {fold}.")
    models = {}
    for key, with_roads in (("v3", False), ("v4", True)):
        clf = build_model(with_roads)
        clf.fit(tr, tr["Label"].astype(int))
        models[key] = clf

    p3 = models["v3"].predict_proba(va)[:, 1]
    p4 = models["v4"].predict_proba(va)[:, 1]
    y_va = va["Label"].astype(int).to_numpy()
    y_tr = tr["Label"].astype(int).to_numpy()
    auc3 = auc_if_possible(y_va, p3)
    auc4 = auc_if_possible(y_va, p4)
    tr3 = auc_if_possible(y_tr, models["v3"].predict_proba(tr)[:, 1])
    tr4 = auc_if_possible(y_tr, models["v4"].predict_proba(tr)[:, 1])
    fold_rows.append({"fold": fold, "n": len(va), "v3_train_auc": tr3,
                      "v3_valid_auc": auc3, "v4_train_auc": tr4,
                      "v4_valid_auc": auc4, "valid_auc_difference": auc4 - auc3})
    part = va[["system:index", "Label", ROAD, "cv_fold", "spatial_group"]].copy()
    part["v3_score"] = p3
    part["v4_score"] = p4
    oof.append(part)
    print(f"Fold {fold}: V3 val AUC={auc3:.4f}; V4 val AUC={auc4:.4f}; "
          f"V4 train AUC={tr4:.4f}", flush=True)

fold_results = pd.DataFrame(fold_rows)
predictions = pd.concat(oof, ignore_index=True)
if len(predictions) != 1603 or predictions["system:index"].duplicated().any():
    raise SystemExit("Out-of-fold prediction validation failed.")
predictions["road_band"] = pd.cut(
    predictions[ROAD], bins=[-np.inf, 100, 500, np.inf],
    labels=["Near: 0-100m", "Middle: 100-500m", "Far: >500m"]
)

print("\n--- OVERALL MEAN OF 5 SPATIAL FOLDS ---")
for tag in ("v3", "v4"):
    mean_train = fold_results[f"{tag}_train_auc"].mean()
    mean_val = fold_results[f"{tag}_valid_auc"].mean()
    print(f"{tag.upper()}: train AUC={mean_train:.4f}; spatial valid AUC={mean_val:.4f}; "
          f"gap={mean_train-mean_val:+.4f}")

print("\n--- ROAD-DISTANCE SUBGROUPS (POOLED OUT-OF-FOLD PREDICTIONS) ---")
rows = []
for group, sub in predictions.groupby("road_band", observed=True):
    y = sub["Label"].astype(int)
    p3 = sub["v3_score"].to_numpy()
    p4 = sub["v4_score"].to_numpy()
    a3 = auc_if_possible(y, p3)
    a4 = auc_if_possible(y, p4)
    rec3 = recall_score(y, p3 >= 0.5, zero_division=0)
    rec4 = recall_score(y, p4 >= 0.5, zero_division=0)
    fp3 = confusion_matrix(y, p3 >= 0.5, labels=[0, 1])[0, 1]
    fp4 = confusion_matrix(y, p4 >= 0.5, labels=[0, 1])[0, 1]
    n0 = int((y == 0).sum())
    n1 = int((y == 1).sum())
    rows.append({"road_band": str(group), "total": len(sub), "background": n0,
                 "landslide": n1, "v3_auc": a3, "v4_auc": a4,
                 "auc_gain": a4-a3, "v3_recall": rec3, "v4_recall": rec4,
                 "v3_false_positive_rate": fp3/n0 if n0 else np.nan,
                 "v4_false_positive_rate": fp4/n0 if n0 else np.nan})
    print(f"{group}: n={len(sub)} (landslides={n1}, background={n0}); "
          f"V3 AUC={a3:.4f}, V4 AUC={a4:.4f}, gain={a4-a3:+.4f}; "
          f"recall {rec3:.3f}->{rec4:.3f}")

# AUC of proximity alone quantifies the inventory/road association; not causation.
proximity_auc = roc_auc_score(predictions["Label"], -predictions[ROAD])
print(f"\nRoad proximity ALONE AUC for identifying inventory labels: {proximity_auc:.4f}")
print("Interpretation: this does NOT prove road proximity causes landslides.")
print("Near/far subgroup AUCs are exploratory, and may be unstable with small subgroup sizes.")
print("The locked 447-row independent test set was NEVER accessed by model fitting or evaluation.")

OUT.mkdir(parents=True, exist_ok=True)
fold_results.to_csv(OUT / "road_bias_fold_metrics.csv", index=False)
pd.DataFrame(rows).to_csv(OUT / "road_bias_subgroup_metrics.csv", index=False)
predictions.to_csv(OUT / "road_bias_oof_predictions.csv", index=False)
print("\nSaved: outputs/road_bias_fold_metrics.csv")
print("Saved: outputs/road_bias_subgroup_metrics.csv")
print("Saved: outputs/road_bias_oof_predictions.csv")
