import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { build, preview } from 'vite'
import { chromium } from 'playwright-core'
import AxeBuilder from '@axe-core/playwright'
import { mockVectorBasemap } from './fixtures/map-basemap.mjs'

process.env.VITE_BASEMAP_PROVIDER='openfreemap'
process.env.VITE_BASEMAP_STYLE='liberty'
process.env.VITE_SUPABASE_URL=''
process.env.VITE_SUPABASE_PUBLISHABLE_KEY=''
let browser; let server; let count=0
const pass = message => { count++; console.log(`PASS: ${message}`) }
try {
  await build({ logLevel:'error', build:{outDir:'qa-results/map-dist'} })
  server=await preview({logLevel:'error',build:{outDir:'qa-results/map-dist'},preview:{host:'127.0.0.1',port:0}})
  const base=`http://127.0.0.1:${server.httpServer.address().port}`
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']})
  const context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'})
  const manifest=JSON.parse(await readFile('public/generated-data/susceptibility/manifest.json','utf8'))
  let mode='normal'; let tiles=[]; let basemaps=0
  const errors=[]
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)))
  // Offline basemap fixture only. All susceptibility tiles are actual generated ML tiles.
  await context.route('**/*',route=>{
    const url=new URL(route.request().url())
    if(url.hostname==='tiles.openfreemap.org') {basemaps++;return mockVectorBasemap(route,mode)}
    if(url.origin!==base) return route.abort()
    if(url.pathname.endsWith('/manifest.json')) {
      if(mode==='missing') return route.fulfill({status:404,body:'not generated'})
      if(mode==='invalid') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...manifest,crs:'EPSG:4326'})})
      if(mode==='partial') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...manifest,districts:manifest.districts.filter(item=>item.id!=='pune')})})
    }
    if(url.pathname.startsWith('/generated-data/')&&url.pathname.endsWith('.png')) {tiles.push(url.pathname); if(mode==='tile-error') return route.fulfill({status:404,body:'missing tile'})}
    return route.continue()
  })
  const page=await context.newPage()
  const key='ghat-ishara:persist:public:map.preferences'
  const saved=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key))?.value,key)
  const settled=async()=>{
    await page.waitForFunction(()=>document.querySelector('[aria-label="Zoom in"]')?.disabled===false&&!document.querySelector('.map-loading'))
    await page.waitForFunction(key=>{try{return !!JSON.parse(localStorage.getItem(key))?.value?.position}catch{return false}},key)
  }
  const initialOverlay=page.waitForResponse(response=>new URL(response.url()).pathname.startsWith('/generated-data/')&&response.url().endsWith('.png'))
  await page.goto(`${base}/explore-map`)
  await initialOverlay
  await page.getByRole('heading',{name:'Map Explorer',exact:true}).waitFor()
  await page.getByRole('button',{name:'Zoom in',exact:true}).waitFor({state:'visible'})
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Zoom in"]').disabled)
  await settled()
  assert.equal(await page.locator('.map-fatal').count(),0)
  assert.ok(tiles.length>0);assert.ok(basemaps>0)
  assert.equal(await page.locator('#map-district option').count(),5)
  assert.equal(await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('link',{name:'Explore Map',exact:true}).getAttribute('aria-current'),'page')
  pass('/explore-map renders a functioning WebGL map with actual ML tile requests and an attributed basemap')
  for(const name of ['Pune','Raigad','Ratnagiri','Satara']) {
    await page.locator('#map-district').selectOption(name)
    await settled()
    await page.waitForFunction(({key,name})=>JSON.parse(localStorage.getItem(key))?.value.district===name,{key,name})
    const value=await saved();const bounds=manifest.districts.find(item=>item.name===name).bounds
    assert.ok(value.position.longitude>=bounds[0]&&value.position.longitude<=bounds[2]);assert.ok(value.position.latitude>=bounds[1]&&value.position.latitude<=bounds[3])
    assert.ok(tiles.some(tile=>tile.includes(`/${name.toLowerCase()}/`)))
  }
  pass('all four real district overlays load and camera framing follows measured geographic extents')
  let before=(await saved()).position.zoom
  await page.getByRole('button',{name:'Zoom in',exact:true}).click()
  await page.waitForFunction(({key,before})=>JSON.parse(localStorage.getItem(key))?.value.position.zoom>before,{key,before})
  await page.getByRole('button',{name:'Zoom out',exact:true}).click()
  await page.getByRole('button',{name:'Reset district view'}).click()
  const canvas=page.locator('.maplibregl-canvas'); const box=await canvas.boundingBox()
  const old=(await saved()).position.longitude
  await page.mouse.move(box.x+box.width*.55,box.y+box.height*.55);await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+box.height*.55,{steps:8});await page.mouse.up()
  await page.waitForFunction(({key,old})=>JSON.parse(localStorage.getItem(key))?.value.position.longitude!==old,{key,old})
  await canvas.focus();await page.keyboard.press('+');await page.keyboard.press('ArrowLeft')
  pass('zoom, pan, reset and keyboard map interactions update the saved camera')
  await page.locator('#map-opacity').fill('40')
  await page.locator('#map-overlay').uncheck()
  await page.waitForFunction(key=>JSON.parse(localStorage.getItem(key))?.value.opacity===.4,key)
  await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('link',{name:'Districts',exact:true}).click()
  await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('link',{name:'Explore Map',exact:true}).click()
  await page.waitForSelector('#map-district');assert.equal(await page.locator('#map-district').inputValue(),'Satara')
  assert.equal(await page.locator('#map-opacity').inputValue(),'40');assert.equal(await page.locator('#map-overlay').isChecked(),false)
  tiles=[];await page.reload();await settled();assert.equal(tiles.length,0)
  const hiddenImage=await page.locator('.map-canvas').screenshot()
  const overlayLoaded=page.waitForResponse(response=>new URL(response.url()).pathname.startsWith('/generated-data/')&&response.url().endsWith('.png'))
  await page.locator('#map-overlay').check();await overlayLoaded;await settled();assert.ok(tiles.length>0)
  const shownImage=await page.locator('.map-canvas').screenshot();assert.notEqual(Buffer.compare(hiddenImage,shownImage),0,'Real overlay changes rendered map pixels')
  pass('/map remains a working alias; navigation and refresh restore district, opacity, visibility and camera without loading hidden overlays')
  await page.screenshot({path:'qa-results/map-desktop.png',fullPage:true})
  const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()
  assert.deepEqual(audit.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.target)})),[])
  for(const width of [320,390,768,1024]) {await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth))}
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'qa-results/map-mobile.png',fullPage:true})
  pass('desktop/mobile layouts have no horizontal overflow and pass automated WCAG AA checks')
  for(const failure of ['missing','invalid']) {mode=failure;await page.reload();await page.getByText('Susceptibility data unavailable',{exact:true}).waitFor();assert.equal(await page.locator('.map-fatal').count(),0)}
  mode='partial';await page.reload();await page.locator('#map-district').selectOption('Pune');await page.getByText('Susceptibility data unavailable',{exact:true}).waitFor()
  pass('missing, invalid and partial manifests show explicit unavailable states without simulated data')
  mode='tile-error';await page.reload();await page.getByText('Some susceptibility tiles could not load.',{exact:true}).waitFor()
  mode='normal';await page.getByRole('button',{name:'Retry map resources'}).click();await settled();assert.equal(await page.getByText('Some susceptibility tiles could not load.',{exact:true}).count(),0)
  mode='basemap-error';await page.reload();await page.getByText('The basemap could not load.',{exact:true}).waitFor()
  mode='normal';await page.getByRole('button',{name:'Retry map resources'}).click();await settled()
  mode='basemap-image';await page.reload();await page.getByText('The basemap could not load.',{exact:true}).waitFor()
  assert.equal(await page.locator('.map-fatal').count(),0)
  mode='normal';await page.getByRole('button',{name:'Retry map resources'}).click();await settled()
  mode='basemap-tile-image';await page.reload();await page.getByText('The basemap could not load.',{exact:true}).waitFor()
  assert.equal(await page.locator('.map-fatal').count(),0)
  mode='normal';await page.getByRole('button',{name:'Retry map resources'}).click();await settled()
  pass('404 overlay tiles and HTTP 403 and HTTP 200 warning-image basemaps produce friendly errors and recover on retry')
  await page.evaluate(key=>localStorage.setItem(key,'{invalid'),key);await page.reload();await settled();assert.equal(await page.locator('#map-district').inputValue(),'')
  const valid=await page.evaluate(key=>localStorage.getItem(key),key)
  await page.evaluate(({key,valid})=>{const entry=JSON.parse(valid);entry.value.position.longitude=999;localStorage.setItem(key,JSON.stringify(entry))},{key,valid})
  await page.reload();await settled();assert.ok((await saved()).position.longitude<=77)
  pass('corrupted preferences and invalid camera coordinates cannot break the explorer')
  assert.deepEqual(errors,[])
  const noGPU=await browser.newContext()
  await noGPU.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(String(type).startsWith('webgl')) return null;return original.call(this,type,...args)}})
  const fallback=await noGPU.newPage();await fallback.goto(`${base}/explore-map`);await fallback.getByText('The interactive map could not start.',{exact:true}).waitFor();assert.equal(await fallback.locator('#map-district').isEnabled(),true)
  await noGPU.close()
  pass('WebGL-unavailable browsers retain accessible controls, metadata and a clear fallback')
  console.log(`PASS: ${count} map browser scenarios; real local susceptibility tiles, offline basemap fixture, zero Supabase requests.`)
} finally {await browser?.close();await new Promise(resolve=>server?server.httpServer.close(resolve):resolve())}
