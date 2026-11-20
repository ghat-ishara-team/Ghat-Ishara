import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import ts from 'typescript'
const output = 'qa-results/map-unit'
await mkdir(output, { recursive: true })
let source = ts.transpileModule(await readFile('src/map/config.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
for (const [name,file] of [['catalog','raster-catalog.json'],['scale','color-scale.json']]) source = source.replace(new RegExp(`import ${name} from '[^']+';`), `const ${name} = ${await readFile(`src/map/${file}`,'utf8')};`)
source = source.replace("from './basemap'", "from './basemap.mjs'")
await writeFile(`${output}/basemap.mjs`,ts.transpileModule(await readFile('src/map/basemap.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText)
await writeFile(`${output}/config.mjs`,source)
const { districtCatalog, studyBounds, validBounds, baseStyle, parseManifest, overlaySource, boundsForDistrict, colorScale } = await import(`../${output}/config.mjs?run=${Date.now()}`)
assert.deepEqual(districtCatalog.map(item=>item.id),['pune','raigad','ratnagiri','satara'])
assert.ok(validBounds(studyBounds)); assert.ok(districtCatalog.every(item=>validBounds(item.bounds) && item.resolution.every(value=>value===30)))
assert.deepEqual(boundsForDistrict(null),studyBounds)
assert.deepEqual(boundsForDistrict('Pune'),districtCatalog[0].bounds)
for (const value of [[NaN,17,74,18],[74,18,73,17],[181,17,182,18],[73,-90,74,18],null,[]]) assert.equal(validBounds(value),false)
const style=baseStyle()
assert.deepEqual(style.sources,{})
const {resolveBasemapConfiguration,validateBasemapStyle,loadBasemapStyle}=await import(`../${output}/basemap.mjs`)
const configuration=resolveBasemapConfiguration({})
assert.equal(configuration.styleURL,'https://tiles.openfreemap.org/styles/liberty')
for(const credit of ['OpenFreeMap','OpenMapTiles','OpenStreetMap']) assert.ok(configuration.attribution.includes(credit))
assert.equal(resolveBasemapConfiguration({VITE_BASEMAP_PROVIDER:'none'}).styleURL,null)
assert.equal(resolveBasemapConfiguration({VITE_BASEMAP_PROVIDER:'unknown'}).styleURL,null)
assert.equal(resolveBasemapConfiguration({VITE_BASEMAP_STYLE:'invalid'}).styleURL,null)
assert.ok(resolveBasemapConfiguration({VITE_BASEMAP_STYLE:'dark'}).styleURL.endsWith('/dark'))
const {offlineVectorStyle,offlineBasemap}=await import('./fixtures/map-basemap.mjs')
assert.equal(validateBasemapStyle(offlineVectorStyle).sources.openmaptiles.type,'vector')
assert.throws(()=>validateBasemapStyle({...offlineVectorStyle,sources:{bad:{type:'vector',url:'https://untrusted.example/planet'}}}))
const withoutRaster=validateBasemapStyle({...offlineVectorStyle,sources:{...offlineVectorStyle.sources,shaded:{type:'raster',tiles:['https://tiles.openfreemap.org/natural_earth/{z}/{x}/{y}.png']}},layers:[...offlineVectorStyle.layers,{id:'shaded',source:'shaded',type:'raster'}]})
assert.equal(withoutRaster.sources.shaded,undefined);assert.equal(withoutRaster.layers.some(layer=>layer.id==='shaded'),false)
const previousFetch=globalThis.fetch
try {
 for(const response of [new Response('blocked',{status:403}),new Response(offlineBasemap,{headers:{'content-type':'image/png'}}),new Response('{}',{headers:{'content-type':'application/json'}})]) {
  globalThis.fetch=async()=>response
  await assert.rejects(loadBasemapStyle(configuration,new AbortController().signal))
 }
 globalThis.fetch=async(url,options)=>{assert.equal(options.credentials,'omit');assert.equal(options.cache,undefined);return new Response(JSON.stringify(offlineVectorStyle),{headers:{'content-type':'application/json'}})}
 assert.equal((await loadBasemapStyle(configuration,new AbortController().signal)).sources.openmaptiles.type,'vector')
}finally{globalThis.fetch=previousFetch}
assert.ok((await readFile('index.html','utf8')).includes('name="referrer" content="strict-origin"'))
// Test fixtures use real metadata, not synthetic scores.
const manifest={ version:1, generatedAt:new Date().toISOString(), crs:'EPSG:3857', scheme:'xyz', tileSize:256, minzoom:6, maxzoom:12, colorScale,
  districts:districtCatalog.map(item=>({...item,status:'ready',tiles:`/generated-data/susceptibility/test/${item.id}/{z}/{x}/{y}.png`,sampleTile:`/generated-data/susceptibility/test/${item.id}/6/44/28.png`,tileCount:1,tileBytes:100})) }
const parsed=parseManifest(manifest)
assert.equal(parsed.districts.length,4)
assert.equal(overlaySource(parsed.districts[0],parsed).maxzoom,12)
assert.equal(overlaySource(parsed.districts[0],parsed).scheme,'xyz')
for (const change of [{version:2},{crs:'EPSG:4326'},{scheme:'tms'},{tileSize:512},{maxzoom:24},{colorScale:{...colorScale,version:2}},{generatedAt:'invalid'}]) assert.equal(parseManifest({...manifest,...change}),null)
for (const change of [{bounds:[0,0,1,1]},{sha256:'stale'},{tiles:'https://untrusted.example/tiles.png'},{tileCount:0}]) assert.equal(parseManifest({...manifest,districts:[{...manifest.districts[0],...change}]}),null)
assert.equal(parseManifest({...manifest,districts:[manifest.districts[0],manifest.districts[0]]}),null)
assert.equal(parseManifest({...manifest,districts:[]}).districts.length,0)
console.log('PASS: four districts, real raster extents, coordinates, basemap attribution, XYZ overlays, common color scale, stale/invalid/partial catalog handling.')
const protocolSource=ts.transpileModule(await readFile('src/map/tileProtocol.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
await writeFile(`${output}/tileProtocol.mjs`,protocolSource)
const { fetchSusceptibilityTile }=await import(`../${output}/tileProtocol.mjs`)
const originalFetch=globalThis.fetch
const request={url:'ghat-susceptibility://generated-data/susceptibility/test/pune/6/44/28.png'}
try {
  globalThis.fetch=async(url,options)=>{assert.equal(url,'/generated-data/susceptibility/test/pune/6/44/28.png');assert.equal(options.credentials,'omit');return new Response(Uint8Array.from([137,80,78,71,13,10,26,10]),{headers:{'content-type':'image/png'}})}
  assert.equal((await fetchSusceptibilityTile(request,new AbortController())).data.byteLength,8)
  for(const response of [new Response('missing',{status:404}),new Response('<html>SPA fallback</html>',{headers:{'content-type':'text/html'}}),new Response('not PNG',{headers:{'content-type':'image/png'}})]) {
    globalThis.fetch=async()=>response
    await assert.rejects(fetchSusceptibilityTile(request,new AbortController()),/Susceptibility tile unavailable: pune/)
  }
  await assert.rejects(fetchSusceptibilityTile({url:'ghat-susceptibility://private/credentials'},new AbortController()),/Invalid susceptibility/)
} finally {globalThis.fetch=originalFetch}
console.log('PASS: public tile protocol rejects 404, HTML SPA fallbacks, malformed PNGs and unexpected paths without forwarding credentials.')
