#!/usr/bin/env python3
"""Offline geospatial tests. Synthetic rasters exist only in a temporary test directory."""
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from PIL import Image
import rasterio
from rasterio.transform import from_origin, rowcol
from rasterio.warp import transform, transform_bounds
from prepare_tiles import (FRONTEND, OUTPUT, SCALE, WORLD, colorize, file_hash, inspect_source, source_path, tile_bounds, tile_range)


class TilesTest(unittest.TestCase):
    def test_score_bins_and_transparency(self):
        values = np.ma.array([[0, .1999, .2, .3999, .4, .6, .8, 1, -9999, np.nan]], mask=[[False]*8+[True, False]])
        colors = colorize(values)[0]
        palette = [[int(color[i:i+2], 16) for i in (1,3,5)] + [255] for color in SCALE['colors']]
        np.testing.assert_equal(colors[:8], np.array([palette[i] for i in [0,0,1,1,2,3,4,4]]))
        np.testing.assert_equal(colors[8:], 0)

    def test_xyz_geometry(self):
        self.assertEqual(tile_range((-WORLD, -WORLD, WORLD, WORLD), 0), (0,0,0,0))
        self.assertEqual(tile_bounds(0,0,0), (-WORLD,-WORLD,WORLD,WORLD))
        b = tile_bounds(8,180,115)
        self.assertEqual(tile_range(b,8), (180,115,180,115))

    def test_invalid_or_missing_sources(self):
        with self.assertRaises(rasterio.errors.RasterioIOError): inspect_source(Path('/missing/demo-only.tif'), 'Pune')
        with tempfile.TemporaryDirectory(prefix='ghat-geospatial-test-') as temporary:
            for value in [-.1, 1.1, np.nan, -9999]:
                path = Path(temporary) / f'demo-{value}.tif'
                with rasterio.open(path, 'w', driver='GTiff', width=2, height=2, count=1, dtype='float32', crs='EPSG:32643', transform=from_origin(400000, 2100000, 30,30), nodata=-9999) as dst:
                    dst.write(np.full((2,2),value,dtype='float32'),1); dst.update_tags(TEST_MODE='NO', DISTRICT='PUNE')
                with self.assertRaises(ValueError): inspect_source(path, 'Pune')

    def test_real_catalog_and_tiles(self):
        catalog = json.loads((FRONTEND/'src/map/raster-catalog.json').read_text())
        self.assertEqual([item['name'] for item in catalog], ['Pune','Raigad','Ratnagiri','Satara'])
        manifest_path = OUTPUT/'manifest.json'
        if not manifest_path.exists():
            self.skipTest('Generated manifest missing; run map:tiles before real-source tile verification')
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(manifest['colorScale'], SCALE)
        self.assertEqual(manifest['tileCount'], sum(item['tileCount'] for item in manifest['districts']))
        self.assertLessEqual(manifest['tileCount'],3000)
        total_size = 0
        for item in manifest['districts']:
            path = source_path(item['name'])
            current = inspect_source(path,item['name'])
            self.assertEqual(current['sha256'],item['sha256'], 'Source must remain unchanged')
            self.assertEqual(next(entry for entry in catalog if entry['id']==item['id'])['sha256'],item['sha256'])
            np.testing.assert_allclose(current['bounds'],item['bounds'],atol=1e-8)
            folder = OUTPUT/manifest['buildId']/item['id']
            tiles = list(folder.glob('*/*/*.png'))
            self.assertEqual(len(tiles),item['tileCount'])
            # Lossless RGBA and complete bounded XYZ coverage, including blank tiles.
            expected = 0; transparent = 0; opaque = 0
            with rasterio.open(path) as src:
                mercator = transform_bounds(src.crs,'EPSG:3857',*src.bounds,densify_pts=41)
                for z in range(manifest['minzoom'],manifest['maxzoom']+1):
                    x0,y0,x1,y1=tile_range(mercator,z)
                    for x in range(x0,x1+1):
                        for y in range(y0,y1+1): self.assertTrue((folder/str(z)/str(x)/f'{y}.png').exists())
                    expected+=(x1-x0+1)*(y1-y0+1)
                self.assertEqual(expected,len(tiles))
                source_values = src.read(1,masked=True)
                # Independent inverse CRS alignment test against original scores, not the tiling VRT.
                max_tiles = sorted((folder/str(manifest['maxzoom'])).glob('*/*.png'))
                for tile in max_tiles[::max(1,len(max_tiles)//8)]:
                    rgba=np.array(Image.open(tile)); self.assertEqual(rgba.shape,(256,256,4))
                    transparent+=int((rgba[:,:,3]==0).sum()); opaque+=int((rgba[:,:,3]==255).sum())
                    x=int(tile.parent.name); y=int(tile.stem)
                    left,bottom,right,top=tile_bounds(manifest['maxzoom'],x,y)
                    rr,cc=np.meshgrid(np.arange(4,256,8),np.arange(4,256,8),indexing='ij')
                    xx=left+(cc.ravel()+.5)*(right-left)/256
                    yy=top-(rr.ravel()+.5)*(top-bottom)/256
                    sx,sy=transform('EPSG:3857',src.crs,xx,yy)
                    rows,cols=rowcol(src.transform,sx,sy); rows=np.array(rows); cols=np.array(cols)
                    inside=(rows>=0)&(rows<src.height)&(cols>=0)&(cols<src.width)
                    scores=np.ma.masked_all(len(rows),dtype='float32'); scores[inside]=source_values[rows[inside],cols[inside]]
                    expected_color=colorize(scores)
                    actual=rgba[rr.ravel(),cc.ravel()]
                    match=(expected_color==actual).all(axis=1)
                    self.assertGreater(float(match.mean()),.995, 'XYZ-to-source alignment or NoData mismatch')
                self.assertGreater(transparent,0); self.assertGreater(opaque,0)
            size=sum(tile.stat().st_size for tile in tiles); self.assertEqual(size,item['tileBytes']); total_size+=size
            print(f'Validated {item["name"]}: {len(tiles)} PNG tiles; inverse-CRS score/color + NoData checks passed.')
        self.assertEqual(total_size,manifest['tileBytes'])

if __name__ == '__main__': unittest.main(verbosity=2)
