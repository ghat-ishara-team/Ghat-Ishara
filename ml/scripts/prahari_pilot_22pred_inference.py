#!/usr/bin/env python3
"""Pilot inference for GHAT ISHARA controlled 250 m 22-predictor RF.

Reads the GEE 19-band pilot, samples 1981-2010 rainfall, point-joins geology,
computes nearest-river distance, and writes a 30 m susceptibility-score GeoTIFF.
Does not access held-out test samples or retrain the model.
"""
from pathlib import Path
import sys

import geopandas as gpd
import joblib
import numpy as np
import pandas as pd
import rasterio
import shapely
from rasterio.transform import xy as pixel_xy
from rasterio.warp import transform as convert_coords
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
# Input files are relative to the ML project root.
PILOT = ROOT / "data/rasters/predictors/PRAHARI_Controlled_19Band_Pilot.tif"
RAIN = ROOT / "data/rainfall/PRAHARI_Rainfall_Climatology_1981_2010.tif"
RIVERS = ROOT / "data/gis/hydro/PRAHARI_four_district_rivers_streams.gpkg"
GEOLOGY = {
    "RAIGAD": ROOT / "data/gis/lithology/RAIGAD/PRAHARI_Raigad_Lithology_CLIPPED.gpkg",
    "PUNE": ROOT / "data/gis/lithology/PUNE/LITHOLOGY_DIST_PUNE.shp",
    "SATARA": ROOT / "data/gis/lithology/SATARA/LITHOLOGY_DIST_SATARA.shp",
    "RATNAGIRI": ROOT / "data/gis/lithology/RATNAGIRI/LITHOLOGY_DIST_RATNAGIRI.shp",
}
MODEL = ROOT / "models/rf_250m_controlled_22pred_EXPERIMENT.joblib"
OUTPUT = ROOT / "data/prahari_controlled_250m_pilot_susceptibility_score.tif"

BASE_FEATURES = [
    "elevation", "slope", "aspect", "northness", "eastness", "curvature",
    "ruggedness", "twi", "landcover", "ndvi", "clay_0_5_pct",
    "clay_5_15_pct", "clay_15_30_pct", "bdod_0_5_kg_dm3",
    "bdod_5_15_kg_dm3", "bdod_15_30_kg_dm3", "cfvo_0_5_pct",
    "cfvo_5_15_pct", "cfvo_15_30_pct"
]


def require_files():
    files = [PILOT, RAIN, RIVERS, MODEL, *GEOLOGY.values()]
    missing = [str(p) for p in files if not p.is_file()]
    if missing:
        sys.exit("Missing required files:\n" + "\n".join(missing))


def read_pilot():
    with rasterio.open(PILOT) as src:
        names = list(src.descriptions)
        if src.count != len(BASE_FEATURES) or names != BASE_FEATURES:
            raise ValueError(f"Band names/order mismatch. Found: {names}")
        if src.crs is None or src.crs.to_epsg() != 32643:
            raise ValueError(f"Unexpected pilot CRS: {src.crs}")
        if any(abs(r - 30) > 1e-6 for r in src.res):
            raise ValueError(f"Unexpected pilot resolution: {src.res}")
        data = src.read(masked=True)
        masks = np.ma.getmaskarray(data)
        n_bands, height, width = data.shape
        flat = data.filled(np.nan).astype("float64").reshape(n_bands, -1).T
        valid = (~masks.reshape(n_bands, -1).any(axis=0)) & np.isfinite(flat).all(axis=1)
        # GEE exports sometimes lack a NoData tag; invalid soil zeros are an extra guard.
        valid &= (flat[:, BASE_FEATURES.index("clay_0_5_pct")] > 0)
        valid &= (flat[:, BASE_FEATURES.index("bdod_0_5_kg_dm3")] > 0)
        valid &= (flat[:, BASE_FEATURES.index("landcover")] >= 0)
        valid &= (flat[:, BASE_FEATURES.index("landcover")] <= 8)
        valid &= (flat[:, BASE_FEATURES.index("ndvi")] >= -1)
        valid &= (flat[:, BASE_FEATURES.index("ndvi")] <= 1)
        profile = src.profile.copy()
        transform = src.transform
        crs = src.crs
        print(f"Pilot size: {width} x {height} = {height * width} pixels")
        print(f"NoData metadata: {src.nodata}; mask-invalid pixels: {int(masks.any(axis=0).sum())}")
        print(f"Pixels passing baseline checks: {int(valid.sum())} / {len(valid)}")
        if valid.sum() == 0:
            raise ValueError("No usable pixels; inspect exported pixel values and masks")
        rows, cols = np.divmod(np.flatnonzero(valid), width)
        xs, ys = pixel_xy(transform, rows.tolist(), cols.tolist(), offset="center")
        pts = gpd.GeoDataFrame(
            {"pixel_index": np.flatnonzero(valid)},
            geometry=gpd.points_from_xy(xs, ys), crs=crs,
        )
        predictors = pd.DataFrame(flat[valid], columns=BASE_FEATURES)
        return predictors, pts, profile, valid, (height, width)


def add_rainfall(pred, pts):
    lonlat = pts.to_crs("EPSG:4326")
    with rasterio.open(RAIN) as src:
        if src.crs is None:
            raise ValueError("Rainfall raster has no CRS")
        if src.count != 1:
            raise ValueError(f"Expected single-band rainfall raster; got {src.count}")
        xs = lonlat.geometry.x.to_list()
        ys = lonlat.geometry.y.to_list()
        rx, ry = convert_coords("EPSG:4326", src.crs, xs, ys)
        samples = src.sample(zip(rx, ry), indexes=1, masked=True)
        rainfall = np.array([
            np.nan if np.ma.is_masked(s[0]) else float(s[0]) for s in samples
        ], dtype="float64")
        print(f"Rainfall CRS={src.crs}; raster units={src.units}; tags={src.tags()}")
    rainfall[rainfall <= 0] = np.nan  # zero/negative rainfall indicates likely missing values here
    pred["rainfall_climatology_value"] = rainfall
    print(f"Rainfall missing/invalid pixels: {int(np.isnan(rainfall).sum())}")


def add_lithology(pred, pts):
    layers = []
    for district, path in GEOLOGY.items():
        gdf = gpd.read_file(path)[["lithologic", "geometry"]].to_crs("EPSG:32643")
        gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()
        gdf["source_district"] = district
        layers.append(gdf)
    geology = gpd.GeoDataFrame(pd.concat(layers, ignore_index=True), crs="EPSG:32643")
    joined = gpd.sjoin(pts, geology, how="left", predicate="intersects")
    joined["lithologic"] = joined["lithologic"].fillna("UNKNOWN").astype(str).str.strip().str.upper()
    groups = joined.groupby("pixel_index")["lithologic"].agg(lambda v: set(v))
    conflicts = groups[groups.apply(len) > 1]
    if len(conflicts):
        raise ValueError(f"Conflicting rock types at {len(conflicts)} pixels; inspect geological overlaps")
    by_pixel = groups.map(lambda v: next(iter(v))).to_dict()
    rocks = pd.Series(pts["pixel_index"].map(by_pixel).to_numpy(), index=pred.index)
    pred["lithology_clean"] = rocks.replace({"WATER BODY": "UNKNOWN"}).fillna("UNKNOWN")
    print("Lithology counts:", pred["lithology_clean"].value_counts().to_dict())


def add_river_distance(pred, pts):
    rivers = gpd.read_file(RIVERS)
    if rivers.crs is None:
        raise ValueError("River dataset is missing CRS")
    rivers = rivers.to_crs("EPSG:32643")
    rivers = rivers[rivers.geometry.notna() & ~rivers.geometry.is_empty]
    geoms = rivers.geometry.to_numpy()
    query = pts.to_crs("EPSG:32643").geometry.to_numpy()
    nearest = STRtree(geoms).query_nearest(query, all_matches=False)
    distances = np.full(len(query), np.nan, dtype=float)
    distances[nearest[0]] = shapely.distance(query[nearest[0]], geoms[nearest[1]])
    pred["distance_to_waterway_m"] = distances
    print(f"River distance missing pixels: {int(np.isnan(distances).sum())}")


def main():
    require_files()
    bundle = joblib.load(MODEL)
    if not isinstance(bundle, dict) or "model" not in bundle or "features" not in bundle:
        raise ValueError("Unexpected saved model bundle structure")
    features = bundle["features"]
    model = bundle["model"]
    if set(features) != set(BASE_FEATURES + ["rainfall_climatology_value", "distance_to_waterway_m", "lithology_clean"]):
        raise ValueError(f"Unexpected model features: {features}")
    pred, pts, profile, valid, shape = read_pilot()
    add_rainfall(pred, pts)
    add_lithology(pred, pts)
    add_river_distance(pred, pts)
    usable = pred[features].notna().all(axis=1).to_numpy()
    if not usable.any():
        raise ValueError("No pixels with all 22 predictors")
    score = model.predict_proba(pred.loc[usable, features])[:, 1]
    print(f"Scored pixels: {len(score)}; min={score.min():.4f}, median={np.median(score):.4f}, max={score.max():.4f}")
    out = np.full(shape[0] * shape[1], -9999.0, dtype="float32")
    out[np.flatnonzero(valid)[usable]] = score.astype("float32")
    profile.update(driver="GTiff", count=1, dtype="float32", nodata=-9999.0, compress="deflate")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(OUTPUT, "w", **profile) as dst:
        dst.write(out.reshape(shape), 1)
        dst.set_band_description(1, "rf_susceptibility_score_uncalibrated")
        dst.update_tags(
            MODEL="rf_250m_controlled_22pred_EXPERIMENT",
            DESCRIPTION="Pilot-only uncalibrated Random Forest susceptibility score; not event probability or operational warning",
            RAINFALL_UNITS="UNVERIFIED",
        )
    print(f"Saved pilot susceptibility GeoTIFF: {OUTPUT}")
    print("Note: this pilot is NOT a final validated hazard map. Rainfall units/provenance remain unverified.")


if __name__ == "__main__":
    main()
