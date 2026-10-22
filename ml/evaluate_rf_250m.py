import joblib
import pandas as pd
from sklearn.metrics import (
    roc_auc_score,
    recall_score,
    precision_score,
    f1_score,
    confusion_matrix
)

df = pd.read_csv("data/spatial_split_250m.csv")
saved = joblib.load("models/rf_250m.joblib")

model = saved["model"]
features = saved["features"]

test = df[df["split"] == "test"].copy()

X_test = test[features]
y_test = test["Label"]

probabilities = model.predict_proba(X_test)[:, 1]
predictions = (probabilities >= 0.5).astype(int)

print("--- LOCKED SPATIAL TEST RESULTS ---")
print("Test samples:", len(test))

print("ROC-AUC:", round(
    roc_auc_score(y_test, probabilities), 4
))

print("Recall:", round(
    recall_score(y_test, predictions), 4
))

print("Precision:", round(
    precision_score(y_test, predictions, zero_division=0), 4
))

print("F1-score:", round(
    f1_score(y_test, predictions), 4
))

print("\nConfusion matrix:")
print(confusion_matrix(y_test, predictions))

print("\nTest label distribution:")
print(y_test.value_counts())

test["rf_score"] = probabilities
test["rf_prediction"] = predictions

test.to_csv(
    "outputs/test_predictions_250m.csv",
    index=False
)

print("\nTest predictions saved successfully.")
