import assert from 'node:assert/strict'
import { mkdir,readFile } from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {existsSync,realpathSync} from 'node:fs'
import {build,preview} from 'vite'
import {chromium} from 'playwright-core'
import AxeBuilder from '@axe-core/playwright'
import {mockVectorBasemap} from './fixtures/map-basemap.mjs'

process.env.VITE_SUPABASE_URL='';process.env.VITE_SUPABASE_PUBLISHABLE_KEY=''
process.env.VITE_BASEMAP_PROVIDER='openfreemap';process.env.VITE_BASEMAP_STYLE='liberty'
let browser;let server;let count=0
const pass=message=>{count++;console.log(`PASS: ${message}`)}
try {
 const golden=JSON.parse(await readFile('qa-results/score-samples.json','utf8'))
 await mkdir('qa-results',{recursive:true})
 await build({logLevel:'error',build:{outDir:'qa-results/scores-dist'}})
 server=await preview({logLevel:'error',build:{outDir:'qa-results/scores-dist'},preview:{host:'127.0.0.1',port:0}})
 const origin=`http://127.0.0.1:${server.httpServer.address().port}`
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']})
 const context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'})
 let mode='normal';let hold=false;let held=[];let requestCount=0
 const errors=[]
 context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)))
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url())
  if(url.hostname==='tiles.openfreemap.org')return mockVectorBasemap(route)
  if(url.origin!==origin)return route.abort()
  if(url.pathname.startsWith('/generated-data/scores/')){
   requestCount++
   if(url.pathname.endsWith('manifest.json')&&mode==='missing')return route.fulfill({status:404,body:'Test-only numerical catalog missing'})
   if(url.pathname.endsWith('.sct.gz')){
    if(mode==='failed')return route.fulfill({status:404,body:'Test-only failed numerical tile'})
    if(mode==='corrupt')return route.fulfill({status:200,contentType:'application/octet-stream',body:'<html>Test-only SPA fallback</html>'})
    if(hold)await new Promise(resolve=>held.push(resolve))
   }
  }
  return route.continue().catch(()=>{})
 })
 const page=await context.newPage()
 const samples=golden.samples
 const seed=async(sample)=>{
  await page.goto(origin)
  await page.evaluate(sample=>localStorage.setItem('ghat-ishara:persist:public:map.preferences',JSON.stringify({version:1,savedAt:Date.now(),expiresAt:Date.now()+30*86400000,value:{district:sample.district,layers:['susceptibility'],opacity:.6,position:{longitude:sample.longitude,latitude:sample.latitude,zoom:11}}})),sample)
  await page.goto(`${origin}/explore-map`)
  await page.waitForFunction(()=>document.querySelector('[aria-label="Zoom in"]')?.disabled===false&&!document.querySelector('.map-loading'))
 }
 const inspect=async()=>page.getByRole('button',{name:'Inspect map center',exact:true}).click()
 const complete=async()=>page.waitForFunction(()=>document.querySelector('#location-details .location-result')&&!document.querySelector('#location-details .location-result')?.textContent.includes('Looking up'))
 const score=()=>page.getByTestId('location-score')
 for(const district of ['Pune','Raigad','Ratnagiri','Satara']){
  const sample=samples.find(item=>item.district===district&&item.label==='ui-valid')
  await seed(sample);assert.equal(await page.locator('#location-details').count(),0)
  await inspect();await complete()
  assert.equal(await score().textContent(),sample.score.toPrecision(9))
  assert.ok((await page.locator('#location-details').innerText()).includes(`${district} dataset`))
  assert.equal(await page.locator('.location-marker').count(),1)
 }
 pass('all four districts display exact original Float32 scores from generated numerical tiles')
 const pune=samples.find(item=>item.district==='Pune'&&item.label==='ui-valid')
 await seed(pune)
 const canvas=page.locator('.maplibregl-canvas');let box=await canvas.boundingBox()
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await complete()
 const coordinates=await page.locator('.location-coordinates dd').allTextContents()
 const python=process.env.GHAT_GEO_PYTHON??(existsSync('../.venv')?`${realpathSync('../.venv')}/bin/python`:'python3')
 const reference=JSON.parse((await promisify(execFile)(python,['scripts/geospatial/query_reference.py','Pune',String(parseFloat(coordinates[1])),String(parseFloat(coordinates[0]))])).stdout)
 assert.equal(await score().textContent(),reference.score.toPrecision(9),'Mouse click score independently matches Rasterio at reported coordinates')
 assert.ok((await page.locator('.location-sample small').innerText()).includes(`row ${reference.row}, column ${reference.column}`))
 await page.getByRole('button',{name:/Selected location: latitude/}).focus();await page.keyboard.press('Enter')
 assert.equal(await page.locator('#location-details').evaluate(node=>node===document.activeElement),true)
 await page.getByRole('button',{name:'Close location details'}).click()
 assert.equal(await canvas.evaluate(node=>node===document.activeElement),true)
 await page.keyboard.press('Enter');await complete();assert.equal(await score().textContent(),pune.score.toPrecision(9))
 pass('map clicks, Enter at map center, keyboard-accessible marker and close/focus restoration work')
 const previous=await page.locator('#location-details').innerText()
 hold=true;box=await canvas.boundingBox()
 await page.mouse.click(box.x+box.width/2+300,box.y+box.height/2)
 await page.getByText('Looking up the original model score…',{exact:true}).waitFor()
 assert.equal(await score().count(),0,'Prior point score is removed immediately')
 await page.waitForFunction(()=>document.querySelector('.location-marker')?.getAttribute('aria-label')?.includes('Selected location'))
 await page.locator('#map-district').selectOption('Ratnagiri')
 await page.getByText('No model score available',{exact:true}).waitFor()
 const after=await page.locator('#location-details').innerText();assert.notEqual(after,previous)
 hold=false;for(const release of held)release();held=[]
 await page.waitForTimeout(100)
 assert.equal(await page.locator('#location-details').innerText(),after)
 assert.equal(await score().count(),0)
 pass('new clicks clear old scores immediately; district changes and late responses cannot restore stale values')
 const nodata=samples.find(item=>item.district==='Pune'&&item.label==='nodata')
 await seed(nodata);await inspect();await complete()
 await page.getByText('No model score available',{exact:true}).waitFor();assert.equal(await score().count(),0)
 const zero=samples.find(item=>item.district==='Pune'&&item.label==='zero')
 assert.ok(zero);await seed(zero);await inspect();await complete();assert.equal(await score().textContent(),(0).toPrecision(9))
 pass('NoData is explicit and valid zero remains a real score, not missing data')
 for(const failure of ['missing','failed','corrupt']){
  mode=failure;await seed(pune);await inspect();await complete()
  assert.ok((await page.locator('.location-result').innerText()).includes('Numerical data unavailable'))
  assert.equal(await score().count(),0)
  assert.equal(await page.getByText('No model score available',{exact:true}).count(),0)
  mode='normal';await page.getByRole('button',{name:'Retry score lookup'}).click();await complete()
  assert.equal(await score().textContent(),pune.score.toPrecision(9))
 }
 pass('missing catalogs, 404 numerical tiles and invalid HTTP 200 data show unavailable, never fake/old scores, and retry safely')
 await page.locator('#map-overlay').uncheck();assert.equal(await score().textContent(),pune.score.toPrecision(9))
 const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('ghat-ishara:persist:public:map.preferences')).value)
 assert.deepEqual(Object.keys(stored).sort(),['district','layers','opacity','position'])
 await page.reload();await page.locator('#map-district').waitFor();assert.equal(await page.locator('#location-details').count(),0)
 assert.equal(await page.locator('#map-overlay').isChecked(),false)
 pass('lookup is independent of display opacity/visibility; existing preferences restore while score results stay ephemeral')
 await page.locator('#map-overlay').check();await inspect();await complete()
 const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()
 assert.deepEqual(audit.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.target)})),[])
 await page.screenshot({path:'qa-results/score-inspection-desktop.png',fullPage:true})
 for(const width of [320,390,768,1024]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth))}
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'qa-results/score-inspection-mobile.png',fullPage:true})
 const mobileAudit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(mobileAudit.violations.map(item=>item.id),[])
 assert.deepEqual(errors,[]);assert.ok(requestCount>0)
 pass('location panel passes desktop/mobile automated WCAG AA, responsive overflow and browser error checks')
 console.log(`PASS: ${count} location-inspection browser scenarios; actual numerical/visual assets, offline basemap, no Supabase requests.`)
}finally{await browser?.close();await new Promise(resolve=>server?server.httpServer.close(resolve):resolve())}
