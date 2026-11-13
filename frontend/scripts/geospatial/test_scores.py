#!/usr/bin/env python3
"""Verify all numerical payloads bit-for-bit and export real-source golden samples for JS/browser tests."""
import gzip
import hashlib
import json
from pathlib import Path
import struct
import unittest
import numpy as np
import rasterio
from rasterio.warp import transform
from rasterio.windows import Window
from prepare_tiles import FRONTEND, source_path, file_hash
from prepare_scores import OUTPUT, HEADER, SIZE, MAGIC


class ScoresTest(unittest.TestCase):
    def test_header_contract(self):
        self.assertEqual(HEADER.size,32)
        self.assertEqual(MAGIC,b'GHATSCR1')

    def test_real_lossless_tiles_and_golden_points(self):
        manifest=json.loads((OUTPUT/'manifest.json').read_text())
        self.assertEqual(manifest['tileSize'],256)
        self.assertEqual(len(manifest['districts']),4)
        catalog=json.loads((FRONTEND/'src/map/raster-catalog.json').read_text())
        samples=[];stats=[];source_hashes={}
        for grid in manifest['districts']:
            path=source_path(grid['name']);before=file_hash(path)
            self.assertEqual(before,grid['sourceSha256'])
            self.assertEqual(before,next(item for item in catalog if item['id']==grid['id'])['sha256'])
            total=0;size=0;first_valid=None;first_nodata=None;zero=None;valid_samples=[]
            with rasterio.open(path,'r') as src:
                self.assertEqual(list(src.transform)[:6],grid['transform'])
                for key,entry in grid['tiles'].items():
                    row,column=[int(value)*SIZE for value in key.split('/')]
                    source=src.read(1,window=Window(column,row,min(SIZE,src.width-column),min(SIZE,src.height-row)),masked=True)
                    if entry is None: self.assertTrue(np.ma.getmaskarray(source).all());continue
                    tile=OUTPUT/manifest['buildId']/grid['id']/f'{key}.sct.gz'
                    raw=gzip.decompress(tile.read_bytes())
                    self.assertEqual(hashlib.sha256(raw).hexdigest(),entry['sha256'])
                    self.assertEqual(tile.stat().st_size,entry['bytes'])
                    magic,r,c,width,height,nodata,version=HEADER.unpack(raw[:32])
                    self.assertEqual((magic,r,c,nodata,version),(MAGIC,row,column,src.nodata,1))
                    self.assertEqual((height,width),source.shape)
                    values=np.frombuffer(raw,dtype='<f4',offset=32).reshape(height,width)
                    valid=~np.ma.getmaskarray(source)
                    np.testing.assert_array_equal(values[valid].view('uint32'),np.ma.getdata(source)[valid].view('uint32'),err_msg='Every valid source Float32 bit must survive exactly')
                    self.assertTrue((values[~valid]==src.nodata).all())
                    for valid,label in [(values!=src.nodata,'valid'),(values==src.nodata,'nodata'),(values==0,'zero')]:
                        locations=np.argwhere(valid)
                        if locations.size:
                            rr,cc=locations[len(locations)//2]
                            item=(row+int(rr),column+int(cc),label)
                            if label=='valid':
                                valid_samples.append(item)
                                if first_valid is None:first_valid=item
                            elif label=='nodata' and first_nodata is None:first_nodata=item
                            elif label=='zero' and zero is None:zero=item
                    total+=1;size+=len(tile.read_bytes())
                self.assertEqual(total,grid['files']);self.assertEqual(size,grid['bytes'])
                self.assertIsNotNone(first_valid);self.assertIsNotNone(first_nodata)
                nearest=min(valid_samples,key=lambda cell:(cell[0]-src.height/2)**2+(cell[1]-src.width/2)**2)
                cells=[(*nearest[:2],'ui-valid'),first_valid,first_nodata]+([zero] if zero else [])
                rng=np.random.default_rng(43)
                cells += [(int(rng.integers(0,src.height)),int(rng.integers(0,src.width)),'sample') for _ in range(60)]
                # Both sides of chunk seams and source edges.
                cells += [(0,0,'edge'),(src.height-1,src.width-1,'edge'),(255,255,'seam'),(256,256,'seam')]
                for row,column,label in cells:
                    x,y=src.xy(row,column)
                    lon,lat=transform(src.crs,'EPSG:4326',[x],[y])
                    value=src.read(1,window=Window(column,row,1,1),masked=True)[0,0]
                    score=None if np.ma.is_masked(value) else float(value)
                    samples.append(dict(district=grid['name'],label=label,longitude=lon[0],latitude=lat[0],x=x,y=y,row=row,column=column,score=score))
                # Footprint boundaries are not administrative borders. Outside native grid is outside.
                left,bottom,right,top=src.bounds
                for x,y in [(left-.001,top-15),(right+.001,top-15),(left+15,top+.001),(left+15,bottom-.001)]:
                    lon,lat=transform(src.crs,'EPSG:4326',[x],[y])
                    samples.append(dict(district=grid['name'],label='outside',longitude=lon[0],latitude=lat[0],x=x,y=y,row=None,column=None,score=None))
            self.assertEqual(file_hash(path),before)
            source_hashes[grid['name']]=before
            stats.append(dict(district=grid['name'],files=total,bytes=size))
            print(f'PASS: {grid["name"]}: {total} numerical files bit-for-bit equal to original source windows.')
        qa=FRONTEND/'qa-results';qa.mkdir(exist_ok=True)
        (qa/'score-samples.json').write_text(json.dumps(dict(samples=samples,stats=stats,sourceHashes=source_hashes),indent=2)+'\n')
        self.assertEqual(sum(item['bytes'] for item in stats),manifest['bytes'])


if __name__=='__main__':unittest.main(verbosity=2)
