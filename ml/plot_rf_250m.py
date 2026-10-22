import pandas as pd
import matplotlib.pyplot as plt

from sklearn.metrics import (
    roc_curve,
    roc_auc_score,
    confusion_matrix,
    ConfusionMatrixDisplay
)

df = pd.read_csv("outputs/test_predictions_250m.csv")

y_true = df["Label"]
y_score = df["rf_score"]
y_pred = df["rf_prediction"]

# 1. ROC Curve
fpr, tpr, thresholds = roc_curve(y_true, y_score)
auc_score = roc_auc_score(y_true, y_score)

fig, ax = plt.subplots(figsize=(7, 6))
ax.plot(fpr, tpr, linewidth=2,
        label=f"Random Forest (AUC = {auc_score:.4f})")
ax.plot([0, 1], [0, 1], linestyle="--",
        label="Random classifier")

ax.set_xlabel("False Positive Rate")
ax.set_ylabel("True Positive Rate (Recall)")
ax.set_title("GHAT ISHARA - 250m Buffer ROC Curve")
ax.legend()
ax.grid(alpha=0.3)

fig.tight_layout()
fig.savefig("outputs/roc_curve_250m.png", dpi=300)
plt.close(fig)

# 2. Confusion Matrix
cm = confusion_matrix(y_true, y_pred, labels=[0, 1])

fig, ax = plt.subplots(figsize=(7, 6))

disp = ConfusionMatrixDisplay(
    confusion_matrix=cm,
    display_labels=["Background", "Landslide"]
)

disp.plot(ax=ax)
ax.set_title("GHAT ISHARA - 250m Buffer Confusion Matrix")

fig.tight_layout()
fig.savefig("outputs/confusion_matrix_250m.png", dpi=300)
plt.close(fig)

print("ROC-AUC:", round(auc_score, 4))
print("Confusion matrix:")
print(cm)
print("Both plots saved in outputs/")
