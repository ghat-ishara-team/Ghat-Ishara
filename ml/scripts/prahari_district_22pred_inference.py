#!/usr/bin/env python3
"""Memory-bounded GHAT ISHARA district inference (22-predictor controlled 250 m RF).

Example quick smoke test (two nonempty raster tiles, rest NoData):
    python scripts/prahari_district_22pred_inference.py --district 1 --max-tiles 2

Full Pune inference (can take considerable time):
    python scripts/prahari_district_22pred_inference.py --district 1

Requires the existing Python GIS environment and original data sources. The output
is an UNCALIBRATED susceptibility score, not an event probability or warning.
"""
import argparse
from pathlib import Path

import geopandas as gpd
import joblib
import numpy as np
import pandas as pd
import rasterio
import shapely
from rasterio.enums import Resampling
from rasterio.warp import reproject
from rasterio.windows import Window
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
PREDICTOR_DIR = ROOT / "data/rasters/predictors"
RAIN = ROOT / "data/rainfall/PRAHARI_Rainfall_Climatology_1981_2010.tif"
RIVERS = ROOT / "data/gis/hydro/PRAHARI_four_district_rivers_streams.gpkg"
GEOLOGY = {
    "RAIGAD": ROOT / "data/gis/lithology/RAIGAD/PRAHARI_Raigad_Lithology_CLIPPED.gpkg",
    "PUNE": ROOT / "data/gis/lithology/PUNE/LITHOLOGY_DIST_PUNE.shp",
    "SATARA": ROOT / "data/gis/lithology/SATARA/LITHOLOGY_DIST_SATARA.shp",
    "RATNAGIRI": ROOT / "data/gis/lithology/RATNAGIRI/LITHOLOGY_DIST_RATNAGIRI.shp",
}
MODEL = ROOT / "models/rf_250m_controlled_22pred_EXPERIMENT.joblib"
DISTRICTS = {1: "PUNE", 2: "RAIGAD", 3: "RATNAGIRI", 4: "SATARA"}
BASE_FEATURES = [
    "elevation", "slope", "aspect", "northness", "eastness", "curvature",
    "ruggedness", "twi", "landcover", "ndvi", "clay_0_5_pct",
    "clay_5_15_pct", "clay_15_30_pct", "bdod_0_5_kg_dm3",
    "bdod_5_15_kg_dm3", "bdod_15_30_kg_dm3", "cfvo_0_5_pct",
    "cfvo_5_15_pct", "cfvo_15_30_pct",
]
EXTRA_FEATURES = ["rainfall_climatology_value", "distance_to_waterway_m", "lithology_clean"]
NODATA = -9999.0


def windows(height, width, tile_size):
    for row in range(0, height, tile_size):
        for col in range(0, width, tile_size):
            yield Window(col, row, min(tile_size, width-col), min(tile_size, height-row))


def build_geology_tree(crs):
    parts = []
    for district, path in GEOLOGY.items():
        layer = gpd.read_file(path)[["lithologic", "geometry"]]
        if layer.crs is None:
            raise ValueError(f"Missing CRS in {district} geology")
        layer = layer.to_crs(crs)
        layer = layer.loc[layer.geometry.notna() & ~layer.geometry.is_empty]
        parts.append(layer)
    geology = pd.concat(parts, ignore_index=True)
    geoms = geology.geometry.to_numpy()
    rocks = geology["lithologic"].fillna("UNKNOWN").astype(str).str.strip().str.upper().to_numpy()
    print(f"Geology polygons loaded: {len(geoms)}", flush=True)
    return STRtree(geoms), rocks


def assign_lithology(points, tree, rocks):
    """Match vectorized points; flag conflicting overlapping rock types."""
    result = np.full(len(points), "UNKNOWN", dtype=object)
    matches = tree.query(points, predicate="intersects")
    if matches.shape[1] == 0:
        return result
    point_idx, poly_idx = matches
    order = np.lexsort((poly_idx, point_idx))
    pi, gi = point_idx[order], poly_idx[order]
    first = np.r_[True, pi[1:] != pi[:-1]]
    unique_pi, chosen_rocks = pi[first], rocks[gi[first]]
    if (~first).any():
        for_pi = pi[~first]
        first_positions = np.searchsorted(unique_pi, for_pi)
        differing = rocks[gi[~first]] != chosen_rocks[first_positions]
        if differing.any():
            raise ValueError(
                f"Conflicting geology at {int(np.unique(for_pi[differing]).size)} raster pixels"
            )
    result[unique_pi] = chosen_rocks
    result[result == "WATER BODY"] = "UNKNOWN"
    return result


def build_river_tree(crs):
    rivers = gpd.read_file(RIVERS)
    if rivers.crs is None:
        raise ValueError("River layer has no CRS")
    rivers = rivers.to_crs(crs)
    rivers = rivers[rivers.geometry.notna() & ~rivers.geometry.is_empty]
    geoms = rivers.geometry.to_numpy()
    if len(geoms) == 0:
        raise ValueError("No river geometries found")
    print(f"River geometries loaded: {len(geoms)}", flush=True)
    return STRtree(geoms), geoms


def point_locations(window, raster_transform, valid_rows, valid_cols):
    """Pixel centers in the output projected CRS, without a slow per-point loop."""
    r = valid_rows.astype(np.float64) + float(window.row_off) + 0.5
    c = valid_cols.astype(np.float64) + float(window.col_off) + 0.5
    t = raster_transform
    xs = t.a * c + t.b * r + t.c
    ys = t.d * c + t.e * r + t.f
    return shapely.points(xs, ys)


def rainfall_for_window(rain, raster, win, h, w):
    # Nearest-neighbor matches the earlier point extraction approach.
    arr = np.full((h, w), np.nan, dtype=np.float32)
    reproject(
        source=rasterio.band(rain, 1),
        destination=arr,
        src_transform=rain.transform,
        src_crs=rain.crs,
        src_nodata=rain.nodata,
        dst_transform=raster.window_transform(win),
        dst_crs=raster.crs,
        dst_nodata=np.nan,
        resampling=Resampling.nearest,
        init_dest_nodata=True,
    )
    arr[~np.isfinite(arr) | (arr <= 0)] = np.nan
    return arr


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--district", type=int, choices=DISTRICTS, required=True)
    parser.add_argument("--tile-size", type=int, default=128)
    parser.add_argument("--max-tiles", type=int, default=0,
                        help="For a quick TEST: score this many nonempty tiles; 0=all")
    args = parser.parse_args()
    if args.tile_size < 32 or args.tile_size > 512:
        parser.error("--tile-size must be between 32 and 512")
    if args.max_tiles < 0:
        parser.error("--max-tiles must be nonnegative")

    district = DISTRICTS[args.district]
    raster_path = PREDICTOR_DIR / f"PRAHARI_19Band_District_{args.district}.tif"
    outdir = ROOT / "data/district_susceptibility"
    suffix = f"_TEST_{args.max_tiles}tiles" if args.max_tiles else ""
    output = outdir / f"PRAHARI_{district}_250m_22pred_score{suffix}.tif"
    required = [raster_path, RAIN, RIVERS, MODEL, *GEOLOGY.values()]
    missing = [str(p) for p in required if not p.is_file()]
    if missing:
        raise SystemExit("Missing files:\n" + "\n".join(missing))

    bundle = joblib.load(MODEL)
    if not isinstance(bundle, dict) or not {"model", "features"} <= set(bundle):
        raise ValueError("Unexpected saved model structure")
    model, features = bundle["model"], bundle["features"]
    if len(features) != 22 or set(features) != set(BASE_FEATURES + EXTRA_FEATURES):
        raise ValueError(f"Model feature list inconsistent: {features}")

    with rasterio.open(raster_path) as src, rasterio.open(RAIN) as rain:
        if src.count != 19 or list(src.descriptions) != BASE_FEATURES:
            raise ValueError("Input raster band count/names/order do not match training")
        if src.crs is None or src.crs.to_epsg() != 32643:
            raise ValueError(f"Expected EPSG:32643, got {src.crs}")
        if any(abs(v-30) > 0.01 for v in src.res):
            raise ValueError(f"Expected 30m resolution, got {src.res}")
        if rain.crs is None or rain.count != 1:
            raise ValueError("Rainfall raster must have a CRS and one band")
        print(f"District {args.district} = {district}; size={src.width}x{src.height}; "
              f"rainfall units={rain.units}; test mode={bool(args.max_tiles)}", flush=True)
        geo_tree, rock_names = build_geology_tree(src.crs)
        river_tree, river_geoms = build_river_tree(src.crs)

        outdir.mkdir(parents=True, exist_ok=True)
        profile = dict(
            driver="GTiff", width=src.width, height=src.height,
            count=1, dtype="float32", crs=src.crs, transform=src.transform,
            nodata=NODATA, tiled=True, blockxsize=256, blockysize=256,
            compress="deflate", predictor=3, BIGTIFF="IF_SAFER",
        )
        scored_tiles = 0
        scored_pixels = 0
        invalid_pixels = 0
        overall_min = np.inf
        overall_max = -np.inf
        # All unprocessed tiles are explicitly written NoData, including in test mode.
        with rasterio.open(output, "w", **profile) as dst:
            for wi, win in enumerate(windows(src.height, src.width, args.tile_size), start=1):
                height, width = int(win.height), int(win.width)
                result = np.full((height, width), NODATA, dtype=np.float32)
                if args.max_tiles and scored_tiles >= args.max_tiles:
                    dst.write(result, 1, window=win)
                    continue

                data = src.read(window=win, masked=True, out_dtype="float32")
                arr = data.filled(np.nan)
                valid = (~np.ma.getmaskarray(data).any(axis=0)) & np.isfinite(arr).all(axis=0)
                valid &= arr[BASE_FEATURES.index("clay_0_5_pct")] > 0
                valid &= arr[BASE_FEATURES.index("bdod_0_5_kg_dm3")] > 0
                valid &= (arr[BASE_FEATURES.index("landcover")] >= 0) & (arr[BASE_FEATURES.index("landcover")] <= 8)
                valid &= (arr[BASE_FEATURES.index("ndvi")] >= -1) & (arr[BASE_FEATURES.index("ndvi")] <= 1)
                if not valid.any():
                    dst.write(result, 1, window=win)
                    continue
                rr, cc = np.where(valid)
                points = point_locations(win, src.transform, rr, cc)
                rain_grid = rainfall_for_window(rain, src, win, height, width)
                predictors = pd.DataFrame(arr[:, rr, cc].T, columns=BASE_FEATURES)
                predictors["rainfall_climatology_value"] = rain_grid[rr, cc]
                predictors["lithology_clean"] = assign_lithology(points, geo_tree, rock_names)

                nearest = river_tree.query_nearest(points, all_matches=False)
                distance = np.full(len(points), np.nan, dtype=np.float64)
                if nearest.shape[1]:
                    distance[nearest[0]] = shapely.distance(points[nearest[0]], river_geoms[nearest[1]])
                predictors["distance_to_waterway_m"] = distance
                usable = predictors[features].notna().all(axis=1).to_numpy()
                invalid_pixels += int(len(usable) - usable.sum())
                if usable.any():
                    score = model.predict_proba(predictors.loc[usable, features])[:, 1].astype(np.float32)
                    result[rr[usable], cc[usable]] = score
                    scored_pixels += int(len(score))
                    overall_min = min(overall_min, float(np.min(score)))
                    overall_max = max(overall_max, float(np.max(score)))
                    scored_tiles += 1
                    if scored_tiles <= 3 or scored_tiles % 50 == 0:
                        print(f"  tile {scored_tiles} (window {wi}): scored pixels={scored_pixels:,}, "
                              f"score range so far={overall_min:.4f}–{overall_max:.4f}", flush=True)
                dst.write(result, 1, window=win)

            dst.set_band_description(1, "rf_susceptibility_score_uncalibrated")
            dst.update_tags(
                DISTRICT=district, MODEL="rf_250m_controlled_22pred_EXPERIMENT",
                TEST_MODE="YES" if args.max_tiles else "NO",
                RAINFALL_UNITS="UNVERIFIED",
                DESCRIPTION="Uncalibrated landslide susceptibility score; not event probability or operational warning",
            )

    print(f"Finished {district}: scored {scored_pixels:,} pixels across {scored_tiles} tiles; "
          f"GIS-missing pixels={invalid_pixels:,}", flush=True)
    print(f"Saved: {output}", flush=True)
    if args.max_tiles:
        print("TEST ONLY: Most of the GeoTIFF is NoData. Do not publish this file.", flush=True)
    else:
        print("Provisional full-district score; rainfall provenance and independent validation pending.", flush=True)


if __name__ == "__main__":
    main()
