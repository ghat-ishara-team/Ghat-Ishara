#!/usr/bin/env python3
"""Download four-district OpenStreetMap driving roads for PRAHARI.

First inspect the boundaries, no internet:
    .venv/bin/python fetch_prahari_roads.py --check

Then download one district to test:
    .venv/bin/python fetch_prahari_roads.py --district RAIGAD

Then finish remaining districts:
    .venv/bin/python fetch_prahari_roads.py --district ALL

Requires: pip install osmnx geopandas
Input: data/raw/PRAHARI_SoI_four_district_boundaries.gpkg
Output: data/roads/prahari_roads_<district>.gpkg and, when complete,
        data/roads/PRAHARI_four_district_roads.gpkg

Queries use each district's true boundary, buffered by 2 km to include
nearby roads across the border. This is a *driving network*, not all tracks
or footpaths. Data are current OSM, with coverage and reporting biases.
"""
import argparse
from pathlib import Path
import sys

import geopandas as gpd
import pandas as pd

DISTRICTS = ("RAIGAD", "PUNE", "SATARA", "RATNAGIRI")
CRS_METRES = "EPSG:32643"

def prepare_boundaries(path):
    if not path.is_file():
        raise FileNotFoundError(
            f"Missing boundaries: {path}\n"
            "Download PRAHARI_SoI_four_district_boundaries.gpkg "
            "and put it under data/raw/."
        )
    g = gpd.read_file(path)
    if "DISTRICT" not in g.columns:
        raise ValueError(f"Expected DISTRICT column; found {list(g.columns)}")
    if g.crs is None:
        raise ValueError("Boundary data have no coordinate reference system")
    g = g.to_crs(CRS_METRES)
    g["DISTRICT"] = g["DISTRICT"].astype(str).str.upper().str.strip()
    if len(g) != 4 or set(g["DISTRICT"]) != set(DISTRICTS):
        raise ValueError("Expected exactly RAIGAD, PUNE, SATARA, RATNAGIRI; "
                         f"found {g['DISTRICT'].tolist()}")
    if g.geometry.isna().any() or (~g.geometry.is_valid).any():
        raise ValueError("Some district geometries are missing or invalid")
    return g.set_index("DISTRICT")

def download_district(district, boundary, out, ox):
    target = out / f"prahari_roads_{district.lower()}.gpkg"
    if target.exists():
        try:
            old = gpd.read_file(target)
            if len(old) and old.crs is not None:
                print(f"[SKIP] {district}: {len(old):,} road lines already saved at {target}",
                      flush=True)
                return
        except Exception:
            pass
        raise RuntimeError(f"{target} exists but does not look valid; inspect it "
                           "before deleting or rerunning.")

    # Work in metres for buffer/simplification, then convert to lon/lat for OSMnx.
    buffered = boundary.buffer(2000)
    query_polygon = gpd.GeoSeries([buffered.simplify(150, preserve_topology=True)],
                                  crs=CRS_METRES).to_crs(4326).iloc[0]
    print(f"\n[DOWNLOAD] {district}, district area: {boundary.area/1e6:,.0f} km²",
          flush=True)
    print("  Querying OpenStreetMap/Overpass. Large areas may take a while.", flush=True)

    graph = ox.graph.graph_from_polygon(
        query_polygon,
        network_type="drive",
        simplify=True,
        retain_all=True,
        truncate_by_edge=True,
    )
    edges = ox.convert.graph_to_gdfs(graph, nodes=False, edges=True)
    if edges.empty:
        raise RuntimeError(f"No OSM driving roads returned for {district}")

    edges = edges.to_crs(CRS_METRES)
    # Clip to original boundary + 2km: neighboring road can be closest to a
    # sample near a district boundary.
    edges = gpd.clip(edges, buffered, keep_geom_type=True).copy()
    edges = edges[edges.geometry.notna() &
                  edges.geom_type.isin(["LineString", "MultiLineString"])]
    edges = edges[edges.geometry.length > 0]
    if edges.empty:
        raise RuntimeError(f"No road linework remains after clipping {district}")

    # Keep simple, GeoPackage-safe attributes. Values from OSM may be lists.
    def column_as_str(name):
        if name in edges.columns:
            return edges[name].map(
                lambda v: "|".join(map(str, v)) if isinstance(v, list)
                          else "" if v is None else str(v)
            ).to_numpy()
        return [""] * len(edges)

    result = gpd.GeoDataFrame(
        {
            "district": district,
            "highway": column_as_str("highway"),
            "road_name": column_as_str("name"),
            "road_ref": column_as_str("ref"),
            "length_m": edges.geometry.length.to_numpy(),
        },
        geometry=edges.geometry.to_numpy(),
        crs=CRS_METRES,
    )
    result.to_file(target, driver="GPKG", layer="roads")
    print(f"[SAVED] {district}: {len(result):,} road line features -> {target}",
          flush=True)

def merge_when_complete(out):
    sources = [out / f"prahari_roads_{d.lower()}.gpkg" for d in DISTRICTS]
    missing = [str(p.name) for p in sources if not p.is_file()]
    if missing:
        print(f"\nCombined file not built yet. Missing: {', '.join(missing)}",
              flush=True)
        return
    parts = [gpd.read_file(p) for p in sources]
    if any(p.empty for p in parts):
        raise RuntimeError("A saved district road dataset is empty")
    combined = gpd.GeoDataFrame(
        pd.concat(parts, ignore_index=True),
        geometry="geometry",
        crs=CRS_METRES,
    )
    dest = out / "PRAHARI_four_district_roads.gpkg"
    combined.to_file(dest, layer="roads", driver="GPKG")
    print(f"\n[READY] {len(combined):,} road line features across four datasets")
    print(f"[SAVED] {dest}")
    print("Note: nearby district edge lines may be duplicated. "
          "That does not affect nearest-road distances.")

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true",
                        help="Verify district boundaries without downloading roads")
    parser.add_argument("--district", choices=("ALL",) + DISTRICTS, default="ALL",
                        help="Download one district or all four (default ALL)")
    parser.add_argument("--boundaries", type=Path,
                        default=Path("data/raw/PRAHARI_SoI_four_district_boundaries.gpkg"))
    parser.add_argument("--output", type=Path, default=Path("data/roads"))
    args = parser.parse_args()
    districts = prepare_boundaries(args.boundaries)
    print("Validated boundaries:")
    for name in DISTRICTS:
        print(f"  {name:<10} {districts.loc[name].geometry.area / 1e6:,.0f} km²")
    print("CRS:", districts.crs)
    if args.check:
        print("\nBoundary check passed. No download was started.")
        return
    try:
        import osmnx as ox
    except ImportError as exc:
        raise SystemExit("OSMnx not installed. Run: "
                         ".venv/bin/python -m pip install osmnx") from exc
    args.output.mkdir(parents=True, exist_ok=True)
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(args.output / "osmnx_cache")
    ox.settings.requests_timeout = 600
    ox.settings.overpass_rate_limit = True

    chosen = DISTRICTS if args.district == "ALL" else [args.district]
    for district in chosen:
        download_district(district, districts.loc[district].geometry, args.output, ox)
    merge_when_complete(args.output)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
