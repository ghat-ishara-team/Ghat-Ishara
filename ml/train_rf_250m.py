import os
import joblib
import numpy as np
import pandas as pd

from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import roc_auc_score, recall_score

os.makedirs("models", exist_ok=True)
os.makedirs("outputs", exist_ok=True)

df = pd.read_csv("data/spatial_split_250m.csv")

FEATURES = [
    "elevation", "slope", "aspect",
    "northness", "eastness",
    "curvature", "ruggedness",
    "twi", "landcover", "ndvi",
    "clay_0_5_pct", "clay_5_15_pct",
    "clay_15_30_pct",
    "bdod_0_5_kg_dm3", "bdod_5_15_kg_dm3",
    "bdod_15_30_kg_dm3",
    "cfvo_0_5_pct", "cfvo_5_15_pct",
    "cfvo_15_30_pct"
]

# Only use development samples.
# The locked test set remains untouched.
train = df[df["split"] == "train"].copy()

assert len(FEATURES) == 19
assert train[FEATURES].notna().all().all()
assert np.isfinite(train[FEATURES].to_numpy()).all()
assert (train["cv_fold"] >= 0).all()
assert train["cv_fold"].nunique() == 5

def make_model():
    return RandomForestClassifier(
        n_estimators=500,
        max_features=3,
        min_samples_leaf=3,
        bootstrap=True,
        max_samples=0.5,
        random_state=42,
        n_jobs=-1
    )

results = []

print("Training samples:", len(train))
print("Predictors:", len(FEATURES))
print("\nStarting 5-fold spatial cross-validation...\n")

for fold in range(5):

    tr = train[train["cv_fold"] != fold]
    val = train[train["cv_fold"] == fold]

    assert set(tr["spatial_group"]).isdisjoint(
        set(val["spatial_group"])
    )

    if tr["Label"].nunique() != 2 or val["Label"].nunique() != 2:
        raise ValueError(
            f"Fold {fold} does not contain both classes. "
            "We need to adjust the spatial folds."
        )

    model = make_model()

    model.fit(
        tr[FEATURES],
        tr["Label"]
    )

    probabilities = model.predict_proba(
        val[FEATURES]
    )[:, 1]

    predictions = (probabilities >= 0.5).astype(int)

    auc = roc_auc_score(
        val["Label"], probabilities
    )

    recall = recall_score(
        val["Label"], predictions
    )

    results.append({
        "fold": fold,
        "train_samples": len(tr),
        "validation_samples": len(val),
        "roc_auc": auc,
        "recall": recall
    })

    print(
        f"Fold {fold}: "
        f"AUC={auc:.4f}, "
        f"Recall={recall:.4f}, "
        f"Validation samples={len(val)}"
    )

metrics = pd.DataFrame(results)

print("\n--- SPATIAL CV RESULTS ---")
print("Mean ROC-AUC:", round(metrics["roc_auc"].mean(), 4))
print("Mean Recall:", round(metrics["recall"].mean(), 4))
print("AUC Std Dev:", round(metrics["roc_auc"].std(), 4))

metrics.to_csv(
    "outputs/cv_metrics_250m.csv",
    index=False
)

# Final model trained ONLY on development data.
final_model = make_model()

final_model.fit(
    train[FEATURES],
    train["Label"]
)

joblib.dump(
    {"model": final_model, "features": FEATURES},
    "models/rf_250m.joblib"
)

print("\nModel saved: models/rf_250m.joblib")
print("Metrics saved: outputs/cv_metrics_250m.csv")
print("Locked test set has NOT been used.")
