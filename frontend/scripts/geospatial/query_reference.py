#!/usr/bin/env python3
"""Read-only offline QA reference query. Not an HTTP server or application backend."""
import argparse
import json
import math
import numpy as np
import rasterio
from rasterio.warp import transform
from rasterio.windows import Window
from prepare_tiles import DISTRICTS, source_path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('district',choices=DISTRICTS)
parser.add_argument('longitude',type=float)
parser.add_argument('latitude',type=float)
args=parser.parse_args()
if not (math.isfinite(args.longitude) and math.isfinite(args.latitude) and abs(args.longitude)<=180 and abs(args.latitude)<=85):parser.error('Invalid coordinates')
with rasterio.Env(GDAL_PAM_ENABLED='NO'):
 with rasterio.open(source_path(args.district),'r') as src:
  x,y=transform('EPSG:4326',src.crs,[args.longitude],[args.latitude])
  row,column=src.index(x[0],y[0]);score=None
  if 0<=row<src.height and 0<=column<src.width:
   value=src.read(1,window=Window(column,row,1,1),masked=True)[0,0]
   if not np.ma.is_masked(value):score=float(value)
  print(json.dumps(dict(row=row,column=column,score=score)))
