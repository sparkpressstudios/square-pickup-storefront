import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import express from 'express';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {adminCatalogRouter} from '../server/src/admin-catalog';
import {compareVersions,createReleaseChecker,installedVersion,validateManifest} from '../server/src/release-updates';
import {ReleaseDetails,ReleaseUpdates} from '../client/src/release-updates';
const manifest=JSON.parse(readFileSync(new URL('../releases/latest.json',import.meta.url),'utf8'));
test('semver compares prereleases numerically and ignores build metadata',()=>{
 for(const [a,b] of [['1.0.0','1.0.0-rc.1'],['1.0.0-rc.10','1.0.0-rc.2'],['1.0.0-beta','1.0.0-1'],['2.0.0','1.99.99']])assert.equal(compareVersions(a!,b!),1);
 assert.equal(compareVersions('1.0.0+a','1.0.0+b'),0);assert.equal(compareVersions('1.0.0-alpha','1.0.0-alpha.1'),-1);
 for(const version of ['01.0.0','1.0','1.0.0-01','v1.0.0'])assert.throws(()=>compareVersions(version,'1.0.0'));
 assert.equal(installedVersion,JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version);
});
test('manifest strict shape excludes arbitrary URLs and bounds text',()=>{
 assert.deepEqual(validateManifest(manifest),manifest);
 for(const value of [null,[],{...manifest,url:'https://evil.example'},{...manifest,summary:'x'.repeat(1501)},{...manifest,releasedAt:'tomorrow'},{...manifest,version:'1.0.0-01'}])assert.throws(()=>validateManifest(value));
});
test('checks coalesce, cache for 24h, back off and retain stale metadata without data writes',async()=>{
 let now=100000,calls=0,offline=false;const unchanged={orders:[{id:'owned'}],settings:{brand:'Keep'}};const before=JSON.stringify(unchanged);
 const checker=createReleaseChecker((async(url,options)=>{calls++;assert.equal(String(url),'https://raw.githubusercontent.com/sparkpressstudios/square-pickup-storefront/main/releases/latest.json');assert.equal(options?.redirect,'error');assert.equal(options?.headers&&'Authorization' in options.headers,false);await Promise.resolve();if(offline)throw Error();return new Response(JSON.stringify(manifest));}) as typeof fetch,()=>now);
 const values=await Promise.all([checker(),checker(),checker()]);assert.equal(calls,1);assert.equal(values[0]!.state,'current');await checker();assert.equal(calls,1);
 now+=86400000;offline=true;const stale=await checker();assert.equal(calls,2);assert.equal(stale.state,'offline');assert.equal(stale.stale,true);assert.deepEqual(stale.latest,manifest);await checker();assert.equal(calls,2);now+=3600000;await checker();assert.equal(calls,3);assert.equal(JSON.stringify(unchanged),before);
});
test('malformed, oversized and redirected responses fail closed',async()=>{
 for(const response of [new Response('not json'),new Response('x'.repeat(8193)),new Response('',{status:302}),new Response(JSON.stringify({...manifest,version:'bad'}))]) {
  const checker=createReleaseChecker((async()=>response) as typeof fetch);const value=await checker();assert.equal(value.state,'offline');assert.equal(value.latest,undefined);
 }
});
test('endpoint requires verified administrator before network; other GETs never check releases',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=(async()=>{calls++;return new Response(JSON.stringify(manifest));}) as typeof fetch;
 let dataAccesses=0;const app=express();app.use('/api/admin',adminCatalogRouter({store:{load:async()=>{dataAccesses++;throw Error('Unexpected data access');},update:async()=>{dataAccesses++;throw Error('Unexpected mutation');}},verifyStaff:async req=>req.headers['x-test-role']?{id:'test',role:req.headers['x-test-role'] as 'admin',csrfToken:'test-only-csrf-token'}:null}));const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 try {
  assert.equal((await original(base+'/api/admin/updates')).status,401);
  assert.equal((await original(base+'/api/admin/updates',{headers:{'x-test-role':'manager'}})).status,403);
  await original(base+'/api/admin/session',{headers:{'x-test-role':'admin'}});await original(base+'/api/storefront');assert.equal(calls,0);
  const response=await original(base+'/api/admin/updates',{headers:{'x-test-role':'admin'}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(calls,1);assert.equal(dataAccesses,0);
 } finally {globalThis.fetch=original;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('UI renders readable escaped text, fixed HTTPS guides and no automatic update promise',()=>{
 const html=renderToStaticMarkup(createElement(ReleaseDetails,{status:{installedVersion:'0.1.0-rc.1',state:'offline',stale:true,latest:{...manifest,summary:'<script>alert(1)</script>'}}}));assert.match(html,/Installed version: 0.1.0-rc.1/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/does not mean you are up to date/);assert.match(html,/may be stale/);
 const card=renderToStaticMarkup(createElement(ReleaseUpdates));assert.match(card,/does not poll/);assert.match(card,/manual merge/);assert.match(card,/https:\/\/github.com\/sparkpressstudios\/square-pickup-storefront\/blob\/main\/docs\/UPGRADES.md/);assert.doesNotMatch(card,/<iframe|dangerouslySetInnerHTML/);
});

test('upstream hang is aborted by bounded timeout',async()=>{
 const checker=createReleaseChecker((async(_url,options)=>await new Promise<Response>((_resolve,reject)=>{options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})) as typeof fetch);
 const start=Date.now();assert.equal((await checker()).state,'offline');assert.ok(Date.now()-start<6000);
});

test('Updates navigation is available only when verified admin capability is supplied',async()=>{
 const {AdminLayout}=await import('../client/src/admin');
 for(const available of [false,true]) {
  const html=renderToStaticMarkup(createElement(AdminLayout,{path:'/admin',root:'/admin',navigate:()=>{},preview:false,updatesAvailable:available,children:null}));
  assert.equal(html.includes('href="/admin/updates"'),available);
 }
});
