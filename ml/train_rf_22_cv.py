#!/usr/bin/env python3
"""GHAT ISHARA: paired spatial-CV test, 21 vs 22 predictor columns.

Run from ~/GHAT_ISHARA_ML:
    .venv/bin/python train_rf_22_cv.py

Reuses the SAME spatial folds as V2, and NEVER fits or evaluates on
the 447-row locked test set. The old V1/V2 models are NOT overwritten.
"""
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import recall_score, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "data/raw/PRAHARI_250m_Training_Lithology_Rainfall_RiverDistance_REVIEW.csv"
SPLITS = ROOT / "data/spatial_split_250m.csv"
OUT = ROOT / "outputs"
MODELS = ROOT / "models"

BASE = [
    "elevation", "slope", "aspect", "northness", "eastness",
    "curvature", "ruggedness", "twi", "landcover", "ndvi",
    "clay_0_5_pct", "clay_5_15_pct", "clay_15_30_pct",
    "bdod_0_5_kg_dm3", "bdod_5_15_kg_dm3", "bdod_15_30_kg_dm3",
    "cfvo_0_5_pct", "cfvo_5_15_pct", "cfvo_15_30_pct",
]
RAIN = "rainfall_climatology_value"
LITH = "lithology_clean"
RIVER = "distance_to_waterway_m"

RF_ARGS = dict(
    n_estimators=500, max_features=3, min_samples_leaf=3,
    bootstrap=True, max_samples=0.5, random_state=42, n_jobs=-1
)

for path in [SOURCE, SPLITS]:
    if not path.is_file():
        raise SystemExit(f"Missing file: {path}")

df = pd.read_csv(SOURCE)
split = pd.read_csv(SPLITS)
if len(df) != 2050 or len(split) != 2050:
    raise SystemExit("Expected 2050 rows in each file; stopped.")

# Row-by-row alignment is essential to avoid mixing labels/features/splits.
for col in (".geo", "Label", "system:index"):
    if col not in df or col not in split or not df[col].equals(split[col]):
        raise SystemExit(f"ROW ALIGNMENT FAILED: {col}; stopped.")

required = BASE + [RAIN, RIVER, "lithology", "lithology_status"]
missing = [c for c in required if c not in df.columns]
if missing:
    raise SystemExit(f"Missing required columns: {missing}")

df[LITH] = (
    df["lithology"]
    .where(df["lithology_status"].eq("MATCHED"), "UNKNOWN")
    .fillna("UNKNOWN")
    .astype(str)
    .str.strip()
    .str.upper()
)

df["split"] = split["split"]
df["cv_fold"] = split["cv_fold"].astype(int)
df["spatial_group"] = split["spatial_group"]

if (df["split"] == "test").sum() != 447 or (df["split"] == "train").sum() != 1603:
    raise SystemExit("Expected 1603 development and 447 locked-test rows.")
if not (df.loc[df["split"].eq("test"), "cv_fold"] == -1).all():
    raise SystemExit("Locked test fold IDs are unexpected.")

dev = df.loc[df["split"].eq("train")].copy()
if set(dev["cv_fold"]) != set(range(5)):
    raise SystemExit("Expected spatial CV fold IDs 0..4.")

if dev["Label"].isna().any() or dev["spatial_group"].isna().any():
    raise SystemExit("Missing labels or spatial groups in development data.")

for name in BASE + [RAIN, RIVER]:
    if not np.isfinite(pd.to_numeric(dev[name], errors="coerce").to_numpy()).all():
        raise SystemExit(f"Missing or invalid development predictor values: {name}")

def build_model(include_river: bool):
    numeric = BASE + [RAIN] + ([RIVER] if include_river else [])
    encoder = ColumnTransformer(
        transformers=[
            ("numeric", "passthrough", numeric),
            ("lithology", OneHotEncoder(handle_unknown="ignore"), [LITH]),
        ],
        remainder="drop",
    )
    return Pipeline([
        ("features", encoder),
        ("rf", RandomForestClassifier(**RF_ARGS)),
    ])

results = []
for fold in range(5):
    train = dev.loc[dev["cv_fold"].ne(fold)]
    valid = dev.loc[dev["cv_fold"].eq(fold)]
    if set(train["spatial_group"]) & set(valid["spatial_group"]):
        raise SystemExit(f"Spatial group overlap detected in fold {fold}.")
    labels = valid["Label"].astype(int)

    model_21 = build_model(False)
    model_22 = build_model(True)
    model_21.fit(train, train["Label"].astype(int))
    model_22.fit(train, train["Label"].astype(int))

    score_21 = model_21.predict_proba(valid)[:, 1]
    score_22 = model_22.predict_proba(valid)[:, 1]
    auc_21 = roc_auc_score(labels, score_21)
    auc_22 = roc_auc_score(labels, score_22)
    recall_21 = recall_score(labels, score_21 >= 0.5, zero_division=0)
    recall_22 = recall_score(labels, score_22 >= 0.5, zero_division=0)
    results.append({
        "fold": fold, "n_validation": len(valid),
        "v2_21_auc": auc_21, "v3_22_auc": auc_22,
        "auc_change": auc_22 - auc_21,
        "v2_21_recall": recall_21, "v3_22_recall": recall_22,
    })
    print(
        f"Fold {fold}: V2 AUC={auc_21:.4f} | "
        f"V3 AUC={auc_22:.4f} | change={auc_22-auc_21:+.4f}",
        flush=True,
    )

metrics = pd.DataFrame(results)
OUT.mkdir(parents=True, exist_ok=True)
MODELS.mkdir(parents=True, exist_ok=True)
metrics_path = OUT / "cv_comparison_21_vs_22.csv"
metrics.to_csv(metrics_path, index=False)

print("\\nSPATIAL CV SUMMARY (5 folds, 1603 development samples)")
print(f"V2 mean AUC:      {metrics['v2_21_auc'].mean():.4f}")
print(f"V3 mean AUC:      {metrics['v3_22_auc'].mean():.4f}")
print(f"Mean AUC change:  {metrics['auc_change'].mean():+.4f}")
print(f"V2 mean recall:   {metrics['v2_21_recall'].mean():.4f}")
print(f"V3 mean recall:   {metrics['v3_22_recall'].mean():.4f}")
print(f"Comparison saved: {metrics_path}")

final = build_model(True)
final.fit(dev, dev["Label"].astype(int))
model_path = MODELS / "rf_250m_lithology_climatology_rivers_v3_EXPERIMENT.joblib"
joblib.dump(
    {
        "model": final,
        "features": BASE + [RAIN, LITH, RIVER],
        "notes": (
            "Experimental model: 19 original predictors + lithology + rainfall climatology "
            "+ distance to nearest mapped waterway. "
            "Trained on 1603 development samples, spatial 5-fold CV. "
            "Locked 447 test samples unused. Lithology uncertainty encoded UNKNOWN. "
            "Rainfall climatology provenance/statistic pending verification."
        ),
    },
    model_path,
)
print(f"V3 model saved: {model_path}")
print("Locked 447-row test set was NOT used.")
