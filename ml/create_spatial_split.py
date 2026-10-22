import pandas as pd
from sklearn.model_selection import (
    GroupShuffleSplit,
    StratifiedGroupKFold
)

df = pd.read_csv("data/processed_250m.csv")

X = df.drop(columns=["Label"])
y = df["Label"]
groups = df["spatial_group"]

# Step 1: Reserve independent geographic blocks for testing
splitter = GroupShuffleSplit(
    n_splits=1,
    test_size=0.20,
    random_state=42
)

train_idx, test_idx = next(
    splitter.split(X, y, groups)
)

df["split"] = "train"
df.loc[test_idx, "split"] = "test"
df["cv_fold"] = -1

# Step 2: Create five spatial folds within training data
train_df = df.iloc[train_idx]

cv = StratifiedGroupKFold(
    n_splits=5,
    shuffle=True,
    random_state=42
)

for fold, (_, val_idx) in enumerate(
    cv.split(
        train_df,
        train_df["Label"],
        train_df["spatial_group"]
    )
):
    df.loc[train_df.index[val_idx], "cv_fold"] = fold

# Verify that train and test blocks never overlap
train_blocks = set(df.loc[df["split"] == "train", "spatial_group"])
test_blocks = set(df.loc[df["split"] == "test", "spatial_group"])

assert train_blocks.isdisjoint(test_blocks)

# Save the fixed assignments
df.to_csv("data/spatial_split_250m.csv", index=False)

print("Training samples:", len(train_idx))
print("Testing samples:", len(test_idx))
print("Training blocks:", len(train_blocks))
print("Testing blocks:", len(test_blocks))

print("\nTraining labels:")
print(df.loc[df["split"] == "train", "Label"].value_counts())

print("\nTesting labels:")
print(df.loc[df["split"] == "test", "Label"].value_counts())

print("\nSpatial validation folds:")
print(df.loc[df["split"] == "train", "cv_fold"].value_counts().sort_index())

print("\nSpatial split saved successfully")
