#!/usr/bin/env python3
"""Create bounded lossless source-grid numerical lookup tiles; never reproject/resample predictions."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
import shutil
import struct
import time
import numpy as np
import rasterio
from rasterio.windows import Window
from prepare_tiles import FRONTEND, DISTRICTS, inspect_source, source_path, file_hash

OUTPUT = FRONTEND/'public/generated-data/scores'
SIZE = 256
MAGIC = b'GHATSCR1'
HEADER = struct.Struct('<8sIIIIfI')


def payload_for(src, row, column):
    width=min(SIZE,src.width-column);height=min(SIZE,src.height-row)
    values=src.read(1,window=Window(column,row,width,height),masked=True)
    if np.ma.getmaskarray(values).all(): return None
    # Preserve all valid IEEE-754 Float32 bits. Masked values become the declared NoData sentinel.
    data=np.asarray(values.filled(src.nodata),dtype='<f4')
    return HEADER.pack(MAGIC,row,column,width,height,src.nodata,1)+data.tobytes(order='C')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generate',action='store_true')
    args=parser.parse_args()
    started=time.monotonic()
    catalog=json.loads((FRONTEND/'src/map/raster-catalog.json').read_text())
    with rasterio.Env(GDAL_CACHEMAX=128*1024*1024,GDAL_PAM_ENABLED='NO'):
        sources=[inspect_source(source_path(name),name) for name in DISTRICTS]
        count=sum(math.ceil(item['width']/SIZE)*math.ceil(item['height']/SIZE) for item in sources)
        raw=sum(item['width']*item['height']*4 for item in sources)
        print(f'Plan: at most {count} native-grid chunks, {raw/1024**2:.2f} MiB Float32 before gzip; expected ~80–150 MiB, ~30–90s, one worker; no overviews or resampling.',flush=True)
        if count>2048 or raw>512*1024**2: raise ValueError('Numerical output exceeds bounded processing budget')
        for item in sources:
            reference=next(entry for entry in catalog if entry['id']==item['id'])
            if item['sha256']!=reference['sha256']: raise ValueError('Source differs from checked-in catalog; refusing stale integration')
        if not args.generate: return
        if shutil.disk_usage(FRONTEND).free<raw*2: raise ValueError('Insufficient space for conservative numerical output plan')
        build=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ').lower()
        output=OUTPUT/build
        districts=[];total=0;size=0
        for metadata in sources:
            entries={};files=0;district_bytes=0
            with rasterio.open(source_path(metadata['name']),'r') as src:
                if src.crs.to_epsg()!=32643 or src.dtypes!=('float32',) or src.transform.b!=0 or src.transform.d!=0:
                    raise ValueError('Expected the reviewed Float32, north-up UTM 43N source grid')
                for row in range(0,src.height,SIZE):
                    for column in range(0,src.width,SIZE):
                        if time.monotonic()-started>180: raise ValueError('Numerical generation exceeded 180-second budget')
                        key=f'{row//SIZE}/{column//SIZE}'
                        payload=payload_for(src,row,column)
                        if payload is None: entries[key]=None;continue
                        compressed=gzip.compress(payload,compresslevel=6,mtime=0)
                        destination=output/metadata['id']/f'{key}.sct.gz'
                        destination.parent.mkdir(parents=True,exist_ok=True)
                        with destination.open('xb') as stream: stream.write(compressed)
                        entries[key]={'sha256':hashlib.sha256(payload).hexdigest(),'bytes':len(compressed)}
                        files+=1;district_bytes+=len(compressed)
                districts.append(dict(id=metadata['id'],name=metadata['name'],sourceSha256=metadata['sha256'],
                    crs='EPSG:32643',width=src.width,height=src.height,transform=list(src.transform)[:6],nodata=src.nodata,
                    tiles=entries,files=files,bytes=district_bytes))
            if file_hash(source_path(metadata['name']))!=metadata['sha256']: raise ValueError('Source changed during generation')
            total+=files;size+=district_bytes
            print(f'{metadata["name"]}: {files} files, {len(entries)-files} known-empty chunks, {district_bytes/1024**2:.2f} MiB',flush=True)
        manifest=dict(version=1,buildId=build,tileSize=SIZE,encoding='float32-le',compression='gzip',
            generatedAt=datetime.now(timezone.utc).isoformat(),districts=districts,files=total,bytes=size)
        report=OUTPUT/f'{build}.json';report.write_text(json.dumps(manifest,separators=(',',':'))+'\n')
        pending=OUTPUT/f'{build}.pending';pending.write_bytes(report.read_bytes());pending.replace(OUTPUT/'manifest.json')
        print(f'Published {total} numerical files, {size/1024**2:.2f} MiB, in {time.monotonic()-started:.1f}s at {OUTPUT.relative_to(FRONTEND)}',flush=True)


if __name__=='__main__': main()
