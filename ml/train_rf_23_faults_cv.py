#!/usr/bin/env python3
"""GHAT ISHARA experimental V5: 22 environmental features vs 23 with fault distance.

Usage from ~/GHAT_ISHARA_ML:
    .venv/bin/python train_rf_23_faults_cv.py

Fits only the 1,603 development rows and compares the same five spatial folds.
Does not train or evaluate on the locked 447-row test set. Road-distance is excluded.
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
SOURCE = ROOT / 'data/raw/PRAHARI_250m_Training_Lithology_Rainfall_RiverDistance_FaultDistance_REVIEW.csv'
SPLITS = ROOT / 'data/spatial_split_250m.csv'
OUT = ROOT / 'outputs'
MODELS = ROOT / 'models'

BASE = [
    'elevation','slope','aspect','northness','eastness','curvature',
    'ruggedness','twi','landcover','ndvi','clay_0_5_pct','clay_5_15_pct',
    'clay_15_30_pct','bdod_0_5_kg_dm3','bdod_5_15_kg_dm3',
    'bdod_15_30_kg_dm3','cfvo_0_5_pct','cfvo_5_15_pct','cfvo_15_30_pct',
]
RAIN = 'rainfall_climatology_value'
LITH = 'lithology_clean'
RIVER = 'distance_to_waterway_m'
FAULT = 'distance_to_fault_m'

RF_ARGS = dict(
    n_estimators=500, max_features=3, min_samples_leaf=3,
    bootstrap=True, max_samples=0.5, random_state=42, n_jobs=-1,
)

for p in (SOURCE, SPLITS):
    if not p.is_file():
        raise SystemExit(f'Missing file: {p}')
df = pd.read_csv(SOURCE)
split = pd.read_csv(SPLITS)
if len(df) != 2050 or len(split) != 2050:
    raise SystemExit('Expected exactly 2,050 rows in each file.')
for c in ('system:index', '.geo', 'Label'):
    if c not in df.columns or c not in split.columns or not df[c].equals(split[c]):
        raise SystemExit(f'Row alignment failed: {c}')

required = BASE + [RAIN, RIVER, FAULT, 'lithology', 'lithology_status']
missing = [c for c in required if c not in df.columns]
if missing:
    raise SystemExit(f'Missing columns: {missing}')

# Only matched lithology becomes a named rock type; unknowns remain UNKNOWN.
df[LITH] = (
    df['lithology'].where(df['lithology_status'].eq('MATCHED'), 'UNKNOWN')
    .fillna('UNKNOWN').astype(str).str.strip().str.upper()
)
df['split'] = split['split']
df['cv_fold'] = split['cv_fold'].astype(int)
df['spatial_group'] = split['spatial_group']
if (df['split'] == 'train').sum() != 1603 or (df['split'] == 'test').sum() != 447:
    raise SystemExit('Unexpected train/test sizes.')
if not (df.loc[df['split'].eq('test'), 'cv_fold'] == -1).all():
    raise SystemExit('Unexpected locked-test fold IDs.')

dev = df.loc[df['split'].eq('train')].copy()
if set(dev['cv_fold']) != set(range(5)):
    raise SystemExit('Expected five spatial CV folds numbered 0..4.')
if dev['spatial_group'].isna().any() or dev['Label'].isna().any():
    raise SystemExit('Missing spatial group or label.')
for c in BASE + [RAIN, RIVER, FAULT]:
    if not np.isfinite(pd.to_numeric(dev[c], errors='coerce').to_numpy()).all():
        raise SystemExit(f'Non-finite feature values: {c}')

# max_features=3 and the five folds match the earlier V3 experiment.
def build(include_fault):
    numeric = BASE + [RAIN, RIVER] + ([FAULT] if include_fault else [])
    encoder = ColumnTransformer([
        ('numeric', 'passthrough', numeric),
        ('lithology', OneHotEncoder(handle_unknown='ignore'), [LITH]),
    ], remainder='drop')
    return Pipeline([
        ('features', encoder),
        ('rf', RandomForestClassifier(**RF_ARGS)),
    ])

rows=[]
for fold in range(5):
    train = dev.loc[dev['cv_fold'].ne(fold)]
    valid = dev.loc[dev['cv_fold'].eq(fold)]
    if set(train['spatial_group']) & set(valid['spatial_group']):
        raise SystemExit(f'Geographic block overlap in fold {fold}.')
    labels = valid['Label'].astype(int)
    baseline=build(False)
    candidate=build(True)
    baseline.fit(train, train['Label'].astype(int))
    candidate.fit(train, train['Label'].astype(int))
    a=baseline.predict_proba(valid)[:,1]
    b=candidate.predict_proba(valid)[:,1]
    a_auc=roc_auc_score(labels,a)
    b_auc=roc_auc_score(labels,b)
    rows.append({
        'fold':fold,'n_validation':len(valid),
        'v3_22_auc':a_auc,'v5_23_faults_auc':b_auc,
        'auc_change':b_auc-a_auc,
        'v3_22_recall':recall_score(labels,a>=0.5,zero_division=0),
        'v5_23_faults_recall':recall_score(labels,b>=0.5,zero_division=0),
    })
    print(f'Fold {fold}: V3 AUC={a_auc:.4f} | V5 faults AUC={b_auc:.4f} | change={b_auc-a_auc:+.4f}',flush=True)

metrics=pd.DataFrame(rows)
OUT.mkdir(exist_ok=True,parents=True)
MODELS.mkdir(exist_ok=True,parents=True)
metrics_path=OUT/'cv_comparison_v3_vs_v5_faults.csv'
metrics.to_csv(metrics_path,index=False)
print('\nSPATIAL CV SUMMARY (5 folds; 1,603 development samples)')
print(f"V3 mean AUC:         {metrics['v3_22_auc'].mean():.4f}")
print(f"V5 faults mean AUC:  {metrics['v5_23_faults_auc'].mean():.4f}")
print(f"Mean AUC change:     {metrics['auc_change'].mean():+.4f}")
print(f"V3 mean recall:      {metrics['v3_22_recall'].mean():.4f}")
print(f"V5 faults recall:    {metrics['v5_23_faults_recall'].mean():.4f}")
print(f'Comparison saved: {metrics_path}')

final=build(True)
final.fit(dev,dev['Label'].astype(int))
model_path=MODELS/'rf_250m_lithology_climatology_rivers_faults_v5_EXPERIMENT.joblib'
joblib.dump({
    'model':final,
    'features':BASE+[RAIN,LITH,RIVER,FAULT],
    'notes':('Experiment: V3 plus candidate raster-derived distance_to_fault_m. '
             'All 1603 development samples; test=447 unused. '
             'Road proximity not included. Rainfall/climatology and fault-source metadata require verification.'),
},model_path)
print(f'Experimental V5 model saved: {model_path}')
print('Locked 447-row test set was NOT used in training or evaluation.')
