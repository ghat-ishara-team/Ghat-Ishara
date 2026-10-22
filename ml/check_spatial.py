import pandas as pd
import json
import numpy as np

df = pd.read_csv(
    "data/raw/PRAHARI_250m_Training_19Predictors.csv"
)

# Extract longitude and latitude from GEE geometry
coords = df[".geo"].apply(
    lambda x: json.loads(x)["coordinates"]
)

df["longitude"] = coords.apply(lambda x: x[0])
df["latitude"] = coords.apply(lambda x: x[1])

# Create 0.30-degree spatial blocks
df["block_x"] = np.floor(df["longitude"] / 0.30).astype(int)
df["block_y"] = np.floor(df["latitude"] / 0.30).astype(int)

df["spatial_group"] = (
    df["block_x"].astype(str) + "_" +
    df["block_y"].astype(str)
)

print("Total samples:", len(df))
print("Landslide samples:", (df["Label"] == 1).sum())
print("Background samples:", (df["Label"] == 0).sum())
print("Unique spatial blocks:", df["spatial_group"].nunique())
print("Duplicate sampled coordinates:",
      df.duplicated(["longitude", "latitude"]).sum())

# Save processed dataset
df.to_csv("data/processed_250m.csv", index=False)

print("Spatial dataset saved successfully")
