import joblib
import pandas as pd
import matplotlib.pyplot as plt

saved = joblib.load("models/rf_250m.joblib")

model = saved["model"]
features = saved["features"]

importance = pd.DataFrame({
    "Feature": features,
    "Importance": model.feature_importances_
}).sort_values("Importance", ascending=False)

print("\n--- FEATURE IMPORTANCE ---")
print(importance.to_string(index=False))

importance.to_csv(
    "outputs/feature_importance_250m.csv",
    index=False
)

fig, ax = plt.subplots(figsize=(10, 8))

ax.barh(
    importance["Feature"],
    importance["Importance"]
)

ax.invert_yaxis()
ax.set_xlabel("Random Forest Feature Importance")
ax.set_title("GHAT ISHARA - 250m Buffer Feature Importance")

fig.tight_layout()
fig.savefig(
    "outputs/feature_importance_250m.png",
    dpi=300
)

plt.close(fig)

print("\nFeature importance plot saved!")
