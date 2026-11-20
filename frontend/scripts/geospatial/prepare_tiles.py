#!/usr/bin/env python3
"""Read-only source inspection and bounded, lossless RGBA XYZ display tile generation."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys
import time

import numpy as np
from PIL import Image
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import transform_bounds
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT

FRONTEND = Path(__file__).resolve().parents[2]
ROOT = FRONTEND.parent
SOURCES = ROOT / 'ml/data/district_susceptibility'
OUTPUT = FRONTEND / 'public/generated-data/susceptibility'
SCALE = json.loads((FRONTEND / 'src/map/color-scale.json').read_text())
DISTRICTS = ['Pune', 'Raigad', 'Ratnagiri', 'Satara']
WORLD = 20037508.342789244


def source_path(name):
    return SOURCES / f'PRAHARI_{name.upper()}_250m_22pred_score.tif'


def tile_range(bounds, zoom):
    left, bottom, right, top = bounds
    size = 2 * WORLD / 2**zoom
    return (max(0, math.floor((left + WORLD) / size)), max(0, math.floor((WORLD - top) / size)),
            min(2**zoom - 1, math.ceil((right + WORLD) / size) - 1), min(2**zoom - 1, math.ceil((WORLD - bottom) / size) - 1))


def tile_bounds(zoom, x, y):
    size = 2 * WORLD / 2**zoom
    return (x * size - WORLD, WORLD - (y + 1) * size, (x + 1) * size - WORLD, WORLD - y * size)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def inspect_source(path, name):
    # Explicit read-only mode. No sidecars, overviews or statistics are written.
    with rasterio.open(path, 'r') as src:
        if not src.crs or src.count != 1 or src.nodata is None:
            raise ValueError('Expected one georeferenced band with explicit NoData')
        if src.tags().get('TEST_MODE') != 'NO' or src.tags().get('DISTRICT') != name.upper():
            raise ValueError('Unexpected district or test-mode source')
        count = 0; low = math.inf; high = -math.inf
        for _, window in src.block_windows(1):
            data = src.read(1, window=window, masked=True).compressed()
            if data.size:
                if not np.isfinite(data).all() or data.min() < 0 or data.max() > 1:
                    raise ValueError('Non-finite or out-of-range scores; refusing to clip predictions')
                count += data.size; low = min(low, float(data.min())); high = max(high, float(data.max()))
        if not count:
            raise ValueError('Source has no valid model scores')
        bounds = transform_bounds(src.crs, 'EPSG:4326', *src.bounds, densify_pts=41)
        if not (72 < bounds[0] < bounds[2] < 77 and 15 < bounds[1] < bounds[3] < 21):
            raise ValueError('Unexpected geographic extent for study region')
        return dict(id=name.lower(), name=name, source=path.name, crs=str(src.crs), bounds=list(bounds),
                    sourceBounds=list(src.bounds), resolution=list(src.res), width=src.width, height=src.height,
                    dtype=src.dtypes[0], nodata=src.nodata, validPixels=int(count), validFraction=count/(src.width*src.height),
                    minimum=low, maximum=high, sourceBytes=path.stat().st_size, sha256=file_hash(path), tags=src.tags())


def colorize(scores):
    values = np.ma.getdata(scores)
    valid = ~np.ma.getmaskarray(scores) & np.isfinite(values) & (values >= 0) & (values <= 1)
    rgba = np.zeros((*values.shape, 4), dtype='uint8')
    bins = np.searchsorted(np.array(SCALE['breaks'][1:-1]), values[valid], side='right')
    palette = np.array([[int(color[i:i+2], 16) for i in (1, 3, 5)] for color in SCALE['colors']], dtype='uint8')
    rgba[valid, :3] = palette[bins]
    rgba[valid, 3] = 255
    return rgba


def build_tiles(metadata, build_id, minzoom, maxzoom):
    name = metadata['name']; path = source_path(name)
    folder = OUTPUT / build_id / metadata['id']
    total = 0; size = 0; visible = 0; sample = None
    with rasterio.open(path, 'r') as src:
        for z in range(minzoom, maxzoom + 1):
            bounds = transform_bounds(src.crs, 'EPSG:3857', *src.bounds, densify_pts=41)
            x0, y0, x1, y1 = tile_range(bounds, z)
            left, _, _, top = tile_bounds(z, x0, y0)
            _, bottom, right, _ = tile_bounds(z, x1, y1)
            width = (x1-x0+1)*256; height = (y1-y0+1)*256
            # One globally XYZ-aligned virtual grid per zoom, never an in-memory full warped raster.
            with WarpedVRT(src, crs='EPSG:3857', transform=from_bounds(left, bottom, right, top, width, height),
                           width=width, height=height, resampling=Resampling.nearest,
                           nodata=src.nodata, warp_mem_limit=64, tolerance=0.01) as vrt:
                for x in range(x0, x1+1):
                    for y in range(y0, y1+1):
                        scores = vrt.read(1, window=rasterio.windows.Window((x-x0)*256, (y-y0)*256, 256, 256), masked=True)
                        rgba = colorize(scores)
                        destination = folder / str(z) / str(x) / f'{y}.png'
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        with destination.open('xb') as stream:
                            Image.fromarray(rgba).save(stream, format='PNG', compress_level=6)
                        total += 1; size += destination.stat().st_size
                        if rgba[:, :, 3].any():
                            visible += 1
                            if sample is None: sample = f'/generated-data/susceptibility/{build_id}/{metadata["id"]}/{z}/{x}/{y}.png'
    if file_hash(path) != metadata['sha256']:
        raise ValueError('Source changed during generation; manifest not published')
    if not visible:
        raise ValueError('No visible output tiles; manifest not published')
    print(f'{name}: {total} tiles, {visible} nonempty, {size/1024**2:.2f} MiB', flush=True)
    return dict(**metadata, status='ready', tiles=f'/generated-data/susceptibility/{build_id}/{metadata["id"]}/{{z}}/{{x}}/{{y}}.png',
                tileCount=total, nonemptyTiles=visible, tileBytes=size, sampleTile=sample)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generate', action='store_true', help='Generate a new immutable build and publish derived manifest')
    parser.add_argument('--write-catalog', action='store_true', help='Update the small checked-in source metadata catalog after inspection')
    parser.add_argument('--minzoom', type=int, default=6)
    parser.add_argument('--maxzoom', type=int, default=12)
    args = parser.parse_args()
    if not 5 <= args.minzoom <= args.maxzoom <= 12:
        parser.error('Bounded zoom range must be within 5–12')
    start = time.monotonic()
    with rasterio.Env(GDAL_CACHEMAX=128*1024*1024, GDAL_PAM_ENABLED='NO'):
        catalog = [inspect_source(source_path(name), name) for name in DISTRICTS]
        count = 0
        for item in catalog:
            b = transform_bounds('EPSG:4326', 'EPSG:3857', *item['bounds'], densify_pts=41)
            counts = {}
            for z in range(args.minzoom, args.maxzoom + 1):
                x0,y0,x1,y1 = tile_range(b,z); counts[z] = (x1-x0+1)*(y1-y0+1)
            count += sum(counts.values())
            print(f'{item["name"]}: {item["width"]}×{item["height"]}, {item["crs"]}, resolution={item["resolution"]}, valid={item["validFraction"]:.2%}, range={item["minimum"]:.6f}–{item["maximum"]:.6f}; estimated tiles={sum(counts.values())}')
        print(f'Conservative plan: ≤{count} tiles; raw RGBA ≤{count*256*256*4/1024**2:.1f} MiB; expected PNG ~10–80 MiB, ~1–3 min, bounded GDAL cache 128 MiB + warp 64 MiB.')
        if count > 3000:
            raise ValueError('Plan exceeds 3000-tile safety budget')
        if args.write_catalog:
            (FRONTEND / 'src/map/raster-catalog.json').write_text(json.dumps(catalog, indent=2)+'\n')
        if args.generate:
            import shutil
            if shutil.disk_usage(OUTPUT.parent if OUTPUT.parent.exists() else FRONTEND).free < count*256*256*4*2:
                raise ValueError('Insufficient free disk for conservative plan')
            build_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ').lower()
            derived = [build_tiles(item, build_id, args.minzoom, args.maxzoom) for item in catalog]
            manifest = dict(version=1, generatedAt=datetime.now(timezone.utc).isoformat(), buildId=build_id,
                            crs='EPSG:3857', scheme='xyz', tileSize=256, minzoom=args.minzoom, maxzoom=args.maxzoom,
                            resampling='nearest', colorScale=SCALE, districts=derived,
                            tileBytes=sum(item['tileBytes'] for item in derived), tileCount=sum(item['tileCount'] for item in derived))
            pending = OUTPUT / f'{build_id}.json'
            pending.write_text(json.dumps(manifest, indent=2)+'\n')
            # Retain the build report. Replace only the derived manifest, never source inputs or prior tiles.
            publish = OUTPUT / f'{build_id}.pending'
            publish.write_text(pending.read_text())
            publish.replace(OUTPUT / 'manifest.json')
            print(f'Published {OUTPUT.relative_to(FRONTEND)}/manifest.json: {manifest["tileCount"]} tiles, {manifest["tileBytes"]/1024**2:.2f} MiB')
    print(f'Completed in {time.monotonic()-start:.1f}s; source files opened read-only.')


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, rasterio.errors.RasterioError) as error:
        print(f'Map preparation failed: {error}', file=sys.stderr)
        sys.exit(1)
