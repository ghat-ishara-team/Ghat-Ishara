"""GHAT ISHARA: process controlled 90m/500m samples and spatially CV 22 predictors.

Run from ~/GHAT_ISHARA_ML with its .venv active.
Preserves every original CSV/model and DOES NOT evaluate the held-out test set.
"""
from pathlib import Path
import json

import geopandas as gpd
import joblib
import numpy as np
import pandas as pd
import rasterio
import shapely
from rasterio.warp import transform
from shapely.strtree import STRtree
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import f1_score, precision_score, recall_score, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
DATA = ROOT / "data"
MODELS = ROOT / "models"
# Input files are relative to the ML project root.

RAIN = DATA / "rainfall/PRAHARI_Rainfall_Climatology_1981_2010.tif"
RIVERS = DATA / "gis/hydro/PRAHARI_four_district_rivers_streams.gpkg"
LITHO_FILES = {
    "RAIGAD": DATA / "gis/lithology/RAIGAD/PRAHARI_Raigad_Lithology_CLIPPED.gpkg",
    "PUNE": DATA / "gis/lithology/PUNE/LITHOLOGY_DIST_PUNE.shp",
    "SATARA": DATA / "gis/lithology/SATARA/LITHOLOGY_DIST_SATARA.shp",
    "RATNAGIRI": DATA / "gis/lithology/RATNAGIRI/LITHOLOGY_DIST_RATNAGIRI.shp",
}
OLD_SPLIT = DATA / "spatial_split_250m.csv"

BASE19 = [
    "elevation", "slope", "aspect", "northness", "eastness", "curvature",
    "ruggedness", "twi", "landcover", "ndvi",
    "clay_0_5_pct", "clay_5_15_pct", "clay_15_30_pct",
    "bdod_0_5_kg_dm3", "bdod_5_15_kg_dm3", "bdod_15_30_kg_dm3",
    "cfvo_0_5_pct", "cfvo_5_15_pct", "cfvo_15_30_pct",
]
NUMERIC = BASE19 + ["rainfall_climatology_value", "distance_to_waterway_m"]
FEATURES = NUMERIC + ["lithology_clean"]
assert len(BASE19) == 19 and len(FEATURES) == 22


def check_paths():
    needed = [RAIN, RIVERS, OLD_SPLIT] + list(LITHO_FILES.values()) + [
        RAW / f"PRAHARI_{size}m_Controlled_19Predictors.csv" for size in (90, 500)
    ]
    missing = [str(p) for p in needed if not p.is_file()]
    if missing:
        raise FileNotFoundError("Missing input file(s):\n" + "\n".join(missing))


def load_geology():
    layers = []
    for district, path in LITHO_FILES.items():
        layer = gpd.read_file(path)
        if layer.crs is None:
            raise ValueError(f"Lithology has no CRS: {path}")
        layer = layer.to_crs("EPSG:4326")[["lithologic", "geometry"]].copy()
        layer["source_district"] = district
        layers.append(layer)
    geology = gpd.GeoDataFrame(pd.concat(layers, ignore_index=True), crs="EPSG:4326")
    return geology.loc[geology.geometry.notna() & ~geology.geometry.is_empty].copy()


def load_rivers():
    rivers = gpd.read_file(RIVERS)
    if rivers.crs is None:
        raise ValueError("River dataset CRS is missing")
    rivers = rivers.loc[rivers.geometry.notna() & ~rivers.geometry.is_empty].to_crs("EPSG:32643")
    if len(rivers) == 0:
        raise ValueError("No valid river geometries")
    geometries = rivers.geometry.to_numpy()
    return geometries, STRtree(geometries)


def original_block_map():
    old = pd.read_csv(OLD_SPLIT)
    bx = np.floor(old.longitude / 0.30).astype(int)
    by = np.floor(old.latitude / 0.30).astype(int)
    keys = bx.astype(str) + "_" + by.astype(str)
    if not keys.equals(old.spatial_group.astype(str)):
        raise ValueError("Original block formula differs from 0.30-degree grid")
    if (old.groupby("spatial_group")["split"].nunique() != 1).any():
        raise ValueError("Conflicting train/test assignments in original blocks")
    if (old.groupby("spatial_group")["cv_fold"].nunique() != 1).any():
        raise ValueError("Conflicting CV fold assignments in original blocks")
    return old.groupby("spatial_group").agg(split=("split", "first"), cv_fold=("cv_fold", "first"))


def build_dataset(buffer_m, geology, river_geometries, river_tree, block_map):
    source = RAW / f"PRAHARI_{buffer_m}m_Controlled_19Predictors.csv"
    df = pd.read_csv(source)
    if ".geo" not in df or not set(BASE19 + ["Label"]).issubset(df.columns):
        raise ValueError(f"Missing mandatory columns in {source}")
    if df[BASE19].isna().any().any():
        raise ValueError(f"Missing original predictor data in {source}")

    coords = np.array([json.loads(value)["coordinates"] for value in df[".geo"]], dtype=float)
    lon, lat = coords[:, 0], coords[:, 1]
    points = gpd.GeoDataFrame(
        df[["Label"]].copy(), geometry=gpd.points_from_xy(lon, lat), crs="EPSG:4326"
    )

    # Lithology: deduplicate consistent polygon overlaps; retain unknown/water cases.
    matched = gpd.sjoin(points, geology, how="left", predicate="intersects")
    matched["lithologic"] = matched["lithologic"].fillna("UNKNOWN").astype(str).str.strip().str.upper()
    rock_sets = matched.groupby(level=0)["lithologic"].agg(lambda x: sorted(set(x)))
    conflict = rock_sets[rock_sets.map(len) > 1]
    if not conflict.empty:
        raise ValueError(f"{buffer_m}m: conflicting overlapping geology classes: {conflict.to_dict()}")
    df["lithology"] = rock_sets.map(lambda values: values[0]).reindex(df.index)
    df["lithology_status"] = df.lithology.map(
        lambda value: "UNMATCHED" if value == "UNKNOWN" else "WATER_BODY" if value == "WATER BODY" else "MATCHED"
    )
    df["lithology_clean"] = df.lithology.replace({"WATER BODY": "UNKNOWN"})

    # Raster pixel sampling: source CRS transformation + nodata/mask handling.
    with rasterio.open(RAIN) as src:
        if src.crs is None or src.count < 1:
            raise ValueError("Rainfall raster CRS or first band missing")
        rx, ry = transform("EPSG:4326", src.crs, lon.tolist(), lat.tolist())
        vals = []
        for sample in src.sample(zip(rx, ry), indexes=1, masked=True):
            v = sample[0]
            vals.append(np.nan if np.ma.is_masked(v) else float(v))
        df["rainfall_climatology_value"] = vals
        print(f"  Rainfall source CRS={src.crs}; units={src.units}; source metadata={src.tags()}")

    # Nearest vector river in UTM 43N, distances are metres.
    point_geoms = points.to_crs("EPSG:32643").geometry.to_numpy()
    nearest = river_tree.query_nearest(point_geoms, all_matches=False)
    distances = np.full(len(df), np.nan)
    distances[nearest[0]] = shapely.distance(point_geoms[nearest[0]], river_geometries[nearest[1]])
    df["distance_to_waterway_m"] = distances

    df["longitude"] = lon
    df["latitude"] = lat
    df["block_x"] = np.floor(lon / 0.30).astype(int)
    df["block_y"] = np.floor(lat / 0.30).astype(int)
    df["spatial_group"] = df.block_x.astype(str) + "_" + df.block_y.astype(str)
    df["split"] = df.spatial_group.map(block_map.split).fillna("unassigned")
    df["cv_fold"] = df.spatial_group.map(block_map.cv_fold).fillna(-2).astype(int)

    if df[FEATURES].isna().any().any():
        missing = df[FEATURES].isna().sum()
        raise ValueError(f"{buffer_m}m: missing predictors: {missing[missing > 0].to_dict()}")
    if not np.isfinite(df[NUMERIC].to_numpy(dtype=float)).all():
        raise ValueError(f"{buffer_m}m: non-finite numeric features")
    if set(df.split.unique()) - {"train", "test", "unassigned"}:
        raise ValueError("Unexpected split label")

    out = DATA / f"processed_{buffer_m}m_controlled_22predictors_spatial_REVIEW.csv"
    df.to_csv(out, index=False)
    print(f"  Samples={len(df)}; splits={df.split.value_counts().to_dict()}")
    print(f"  Lithology={df.lithology_clean.value_counts().to_dict()}")
    print(f"  Rainfall missing={df.rainfall_climatology_value.isna().sum()}; river missing={df.distance_to_waterway_m.isna().sum()}")
    print(f"  Saved {out}")
    return df


def make_model():
    return Pipeline([
        ("preprocessing", ColumnTransformer([
            ("numeric", "passthrough", NUMERIC),
            ("lithology", OneHotEncoder(handle_unknown="ignore"), ["lithology_clean"]),
        ])),
        ("random_forest", RandomForestClassifier(
            n_estimators=500, max_features=3, min_samples_leaf=3,
            max_samples=0.5, random_state=42, n_jobs=-1
        )),
    ])


def train_cv(buffer_m, df):
    dev = df.loc[df.split == "train"].copy()
    X = dev[FEATURES]
    y = dev.Label.astype(int)
    rows = []
    for fold in range(5):
        training = dev.cv_fold != fold
        valid = dev.cv_fold == fold
        if not valid.any() or y.loc[valid].nunique() != 2 or y.loc[training].nunique() != 2:
            raise ValueError(f"{buffer_m}m: fold {fold} missing a class")
        if not set(dev.loc[training, "spatial_group"]).isdisjoint(set(dev.loc[valid, "spatial_group"])):
            raise ValueError("Spatial group leakage across CV folds")
        model = make_model()
        model.fit(X.loc[training], y.loc[training])
        prob = model.predict_proba(X.loc[valid])[:, 1]
        pred = (prob >= 0.5).astype(int)
        rows.append({
            "fold": fold, "samples": int(valid.sum()),
            "auc": roc_auc_score(y.loc[valid], prob),
            "recall": recall_score(y.loc[valid], pred),
            "precision": precision_score(y.loc[valid], pred, zero_division=0),
            "f1": f1_score(y.loc[valid], pred),
        })
    scores = pd.DataFrame(rows)
    scores_path = DATA / f"controlled_{buffer_m}m_22pred_spatial_cv_results.csv"
    scores.to_csv(scores_path, index=False)
    model = make_model()
    model.fit(X, y)  # DEVELOPMENT DATA ONLY; test + unassigned never used
    model_path = MODELS / f"rf_{buffer_m}m_controlled_22pred_EXPERIMENT.joblib"
    joblib.dump({
        "model": model, "features": FEATURES, "experiment": f"controlled_{buffer_m}m_v2",
        "development_samples": len(dev), "heldout_test_evaluated": False,
    }, model_path)
    print(f"  CV per fold:\n{scores.round(4).to_string(index=False)}")
    print("  Mean CV:", scores[["auc", "recall", "precision", "f1"]].mean().round(4).to_dict())
    print(f"  Saved {scores_path} and {model_path}")
    print("  HELD-OUT TEST NOT EVALUATED")
    return scores


def main():
    check_paths()
    DATA.mkdir(exist_ok=True)
    MODELS.mkdir(exist_ok=True)
    geology = load_geology()
    river_geometries, river_tree = load_rivers()
    block_map = original_block_map()
    all_results = []
    for buffer_m in (90, 500):
        print(f"\n========== CONTROLLED {buffer_m}m ==========")
        df = build_dataset(buffer_m, geology, river_geometries, river_tree, block_map)
        scores = train_cv(buffer_m, df)
        all_results.append({"buffer_m": buffer_m, **scores[["auc", "recall", "precision", "f1"]].mean().to_dict()})
    old250_path = DATA / "controlled_250m_22pred_spatial_cv_results.csv"
    if old250_path.exists():
        prior = pd.read_csv(old250_path)
        all_results.append({"buffer_m": 250, **prior[["auc", "recall", "precision", "f1"]].mean().to_dict()})
    comparison = pd.DataFrame(all_results).sort_values("buffer_m")
    comparison_path = DATA / "controlled_90_250_500_cv_comparison_REVIEW.csv"
    comparison.to_csv(comparison_path, index=False)
    print("\n========== ALL BUFFER CV MEANS ==========")
    print(comparison.round(4).to_string(index=False))
    print(f"Saved {comparison_path}")
    print("CAUTION: sample sets differ slightly; CV scores alone cannot prove buffer superiority.")
    print("Rainfall units/source still require independent verification before scientific claims.")


if __name__ == "__main__":
    main()
