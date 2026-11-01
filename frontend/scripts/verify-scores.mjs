import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { gzipSync } from 'node:zlib'

const output='qa-results/score-unit'
await mkdir(output,{recursive:true})
// Execute actual frontend modules. Project configuration/json imports are inlined only for Node loading.
for(const file of ['config','basemap','scoreLookup']) {
 let source=ts.transpileModule(await readFile(`src/map/${file}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 for(const [name,json] of [['catalog','raster-catalog.json'],['scale','color-scale.json']]) source=source.replace(new RegExp(`import ${name} from '[^']+';`),`const ${name}=${await readFile(`src/map/${json}`,'utf8')};`)
 source=source.replace(/from '(\.\/[^']+)'/g,"from '$1.mjs'")
 await writeFile(`${output}/${file}.mjs`,source)
}
const {ScoreLookup,parseScoreManifest,projectedPoint,cellForProjectedPoint,decodeScoreTile,formatScore,scoreBand,validPoint}=await import(`../${output}/scoreLookup.mjs`)
const rawManifest=JSON.parse(await readFile('public/generated-data/scores/manifest.json','utf8'))
const manifest=parseScoreManifest(rawManifest)
const golden=JSON.parse(await readFile('qa-results/score-samples.json','utf8'))
const originalFetch=globalThis.fetch
let requests=[];let fail=false;let corrupt=false
const actualFetch=async(url,options)=>{
 assert.equal(options.credentials,'omit');requests.push(url)
 if(fail&&url.endsWith('.sct.gz'))return new Response('Unavailable',{status:404})
 const absolute=path.resolve(`public${url}`)
 assert.ok(absolute.startsWith(path.resolve('public/generated-data/scores')+path.sep))
 const bytes=await readFile(absolute)
 return new Response(corrupt&&url.endsWith('.sct.gz')?Buffer.from('<html>SPA</html>'):bytes,{headers:{'content-type':url.endsWith('.json')?'application/json':'application/octet-stream'}})
}
globalThis.fetch=actualFetch
try {
 const lookup=new ScoreLookup();let maximumError=0;let verified=0
 for(const sample of golden.samples) {
  const grid=manifest.districts.find(item=>item.name===sample.district)
  const [x,y]=projectedPoint(sample)
  maximumError=Math.max(maximumError,Math.abs(x-sample.x),Math.abs(y-sample.y))
  const cell=cellForProjectedPoint(grid,x,y)
  assert.deepEqual(cell,sample.row===null?null:{row:sample.row,column:sample.column},`${sample.district} ${sample.label} coordinate to native pixel`)
  const result=await lookup.inspect(sample,sample.district,new AbortController().signal)
  assert.deepEqual(result.unavailable,[])
  if(sample.score===null)assert.equal(result.values.length,0)
  else {assert.equal(result.values.length,1);assert.equal(result.values[0].score,sample.score,'Exact original Float32 promoted to JS Number');assert.equal(Math.fround(Number(formatScore(result.values[0].score))),sample.score,'9 significant digit display round-trips Float32')}
  verified++
 }
 assert.ok(maximumError<.0001,`Proj4js vs GDAL/PROJ residual ${maximumError} m`)
 console.log(`PASS: ${verified} real-source cases, exact Float32 scores/NoData and native cells; CRS residual ≤${maximumError.toExponential(3)} m.`)
 const grid=manifest.districts[0]
 const [a,b,c,d,e,f]=grid.transform
 assert.deepEqual(cellForProjectedPoint(grid,c,f),{row:0,column:0})
 assert.equal(cellForProjectedPoint(grid,c+a*grid.width,f-15),null)
 assert.equal(cellForProjectedPoint(grid,c+15,f+e*grid.height),null)
 for(const point of [{longitude:NaN,latitude:18},{longitude:999,latitude:18},{longitude:74,latitude:90}]){
  assert.equal(validPoint(point),false);await assert.rejects(lookup.inspect(point,null,new AbortController().signal))
 }
 assert.deepEqual(await lookup.inspect({longitude:0,latitude:0},null,new AbortController().signal),{values:[],unavailable:[]})
 for(const change of [{version:2},{encoding:'uint16'},{compression:'unknown'},{tileSize:512},{buildId:'../private'}])assert.throws(()=>parseScoreManifest({...rawManifest,...change}))
 for(const change of [{sourceSha256:'stale'},{width:1},{transform:[30,0,0,0,-30,0]},{tiles:{}}])assert.throws(()=>parseScoreManifest({...rawManifest,districts:[{...rawManifest.districts[0],...change},...rawManifest.districts.slice(1)]}))
 const sample=golden.samples.find(item=>item.district==='Pune'&&item.label==='ui-valid')
 fail=true;const retryLookup=new ScoreLookup()
 const failed=await retryLookup.inspect(sample,'Pune',new AbortController().signal)
 assert.equal(failed.values.length,0);assert.deepEqual(failed.unavailable,['Pune'])
 fail=false;assert.equal((await retryLookup.inspect(sample,'Pune',new AbortController().signal)).values[0].score,sample.score)
 corrupt=true;assert.deepEqual((await new ScoreLookup().inspect(sample,'Pune',new AbortController().signal)).unavailable,['Pune']);corrupt=false
 const row=Math.floor(sample.row/256)*256,column=Math.floor(sample.column/256)*256
 const key=`${row/256}/${column/256}`;const entry=grid.tiles[key]
 const bytes=new Uint8Array(await readFile(`public/generated-data/scores/${manifest.buildId}/pune/${key}.sct.gz`))
 await assert.rejects(decodeScoreTile(bytes,grid,row+256,column,entry.sha256))
 await assert.rejects(decodeScoreTile(bytes,grid,row,column,'0'.repeat(64)))
 await assert.rejects(decodeScoreTile(new Uint8Array(gzipSync(Buffer.alloc(300000))),grid,row,column,entry.sha256))
 const controller=new AbortController();controller.abort()
 await assert.rejects(new ScoreLookup().inspect(sample,'Pune',controller.signal))
 for(const value of [0,.19999,.2,.4,.6,.8,1])assert.ok(scoreBand(value).label)
 assert.equal(scoreBand(0).label,'0–<0.2');assert.equal(scoreBand(1).label,'0.8–1.0')
 for(const name of ['Pune','Raigad','Ratnagiri','Satara']) {
  const point=golden.samples.find(item=>item.district===name&&item.label==='ui-valid')
  const result=await lookup.inspect(point,null,new AbortController().signal)
  assert.equal(result.values.find(item=>item.district===name)?.score,point.score)
 }
 console.log('PASS: edges/seams, district restriction/all-dataset lookup, malformed manifests, missing/corrupted/oversized tiles, integrity, aborts and retry without fake values.')
}finally{globalThis.fetch=originalFetch}
