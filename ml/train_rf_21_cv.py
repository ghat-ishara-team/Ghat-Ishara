#!/usr/bin/env python3
"""GHAT ISHARA: paired spatial-CV comparison of 19-feature baseline vs 21-feature candidate.

Usage:
  cd ~/GHAT_ISHARA_ML
  .venv/bin/python train_rf_21_cv.py

Keeps the 447 locked test rows unused and does not overwrite V1 artifacts.
"""
from pathlib import Path
import numpy as np
import pandas as pd
import joblib
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score, recall_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "data/raw/PRAHARI_250m_Training_Lithology_Rainfall_REVIEW.csv"
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
RF_ARGS = dict(
    n_estimators=500, max_features=3, min_samples_leaf=3,
    bootstrap=True, max_samples=0.5, random_state=42, n_jobs=-1
)

if not SOURCE.exists():
    raise SystemExit(
        f"Missing: {SOURCE}\n"
        "Download PRAHARI_250m_Training_Lithology_Rainfall_REVIEW.csv "
        "into ~/GHAT_ISHARA_ML/data/raw/"
    )
if not SPLITS.exists():
    raise SystemExit(f"Missing split file: {SPLITS}")

df = pd.read_csv(SOURCE)
split = pd.read_csv(SPLITS)
if len(df) != 2050 or len(split) != len(df):
    raise SystemExit("Unexpected row counts. Do not train until alignment is fixed.")
for col in [".geo", "Label", "system:index"]:
    if col not in df or col not in split or not df[col].equals(split[col]):
        raise SystemExit(f"ROW ALIGNMENT FAILED for {col}. Training stopped.")

required = BASE + [RAIN, "lithology", "lithology_status"]
missing = [c for c in required if c not in df.columns]
if missing:
    raise SystemExit(f"Missing predictor columns: {missing}")
df["lithology_clean"] = df["lithology"].where(
    df["lithology_status"].eq("MATCHED"), "UNKNOWN"
).fillna("UNKNOWN").astype(str).str.strip().str.upper()
df["split"] = split["split"]
df["cv_fold"] = split["cv_fold"].astype(int)
df["spatial_group"] = split["spatial_group"]

if set(df["split"]) != {"train", "test"} or (df["split"] == "test").sum() != 447:
    raise SystemExit("Unexpected locked-test split. Training stopped.")
dev = df.loc[df["split"] == "train"].copy()
if len(dev) != 1603 or set(dev["cv_fold"]) != set(range(5)):
    raise SystemExit("Unexpected training rows or cross-validation folds.")

for c in BASE + [RAIN]:
    if not np.isfinite(pd.to_numeric(dev[c], errors="coerce").to_numpy()).all():
        raise SystemExit(f"Invalid or missing development values: {c}")
if dev["Label"].isna().any():
    raise SystemExit("Missing labels.")
if dev["spatial_group"].isna().any():
    raise SystemExit("Missing spatial group.")

def make_v2():
    transformer = ColumnTransformer(
        transformers=[
            ("continuous", "passthrough", BASE + [RAIN]),
            ("lithology", OneHotEncoder(handle_unknown="ignore"), [LITH]),
        ],
        remainder="drop",
    )
    return Pipeline([
        ("features", transformer),
        ("rf", RandomForestClassifier(**RF_ARGS)),
    ])

results = []
for fold in range(5):
    train = dev.loc[dev["cv_fold"] != fold]
    valid = dev.loc[dev["cv_fold"] == fold]
    if set(train["spatial_group"]) & set(valid["spatial_group"]):
        raise SystemExit(f"Spatial group overlap in fold {fold}!")
    y_train = train["Label"].astype(int)
    y_valid = valid["Label"].astype(int)

    baseline = RandomForestClassifier(**RF_ARGS)
    baseline.fit(train[BASE], y_train)
    score_base = baseline.predict_proba(valid[BASE])[:, 1]

    candidate = make_v2()
    candidate.fit(train, y_train)
    score_v2 = candidate.predict_proba(valid)[:, 1]

    auc_base = roc_auc_score(y_valid, score_base)
    auc_v2 = roc_auc_score(y_valid, score_v2)
    recall_base = recall_score(y_valid, score_base >= 0.5, zero_division=0)
    recall_v2 = recall_score(y_valid, score_v2 >= 0.5, zero_division=0)
    results.append({
        "fold": fold,
        "n_validation": len(valid),
        "baseline_auc": auc_base,
        "v2_auc": auc_v2,
        "auc_change": auc_v2 - auc_base,
        "baseline_recall": recall_base,
        "v2_recall": recall_v2,
    })
    print(
        f"Fold {fold}: baseline AUC={auc_base:.4f} | "
        f"V2 AUC={auc_v2:.4f} | change={auc_v2-auc_base:+.4f}",
        flush=True,
    )

scores = pd.DataFrame(results)
OUT.mkdir(exist_ok=True)
MODELS.mkdir(exist_ok=True)
metric_path = OUT / "cv_comparison_19_vs_21.csv"
scores.to_csv(metric_path, index=False)
print("\nSPATIAL CV SUMMARY (5 folds, 1,603 development samples)")
print(f"Baseline mean AUC: {scores['baseline_auc'].mean():.4f}")
print(f"V2 mean AUC:       {scores['v2_auc'].mean():.4f}")
print(f"Mean AUC change:   {scores['auc_change'].mean():+.4f}")
print(f"Baseline recall:   {scores['baseline_recall'].mean():.4f}")
print(f"V2 recall:         {scores['v2_recall'].mean():.4f}")
print(f"Fold metrics saved: {metric_path}")

final_model = make_v2()
final_model.fit(dev, dev["Label"].astype(int))
model_path = MODELS / "rf_250m_lithology_climatology_v2_EXPERIMENT.joblib"
joblib.dump(
    {
        "model": final_model,
        "features": BASE + [RAIN, LITH],
        "notes": (
            "EXPERIMENT: 5 spatial folds; trained on 1,603 development rows only. "
            "447 held-out test rows NOT evaluated. "
            "Rainfall climatology statistic and provenance pending verification; "
            "11 uncertain lithology values mapped to UNKNOWN."
        ),
    },
    model_path,
)
print(f"Experimental model saved: {model_path}")
print("Locked 447-row test set was NOT used.")
