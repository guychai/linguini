import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Engine } from './engine.ts';
import { FixtureHarness, PiHarness } from './harness.ts';
import { SqliteStore, PostgresStore, initial, read } from './store.ts';
import { SandboxBroker, FixtureSandbox } from './sandbox.ts';
import { recoverPiState, importLegacyPiState } from './pi-state.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise,resolve}; }
for (const backend of ['sqlite','postgres'] as const) {
 test(`${backend}: cancellation in durable-claim window does not create harness or execute tools; retries and recovery stay cancelled`, {skip: backend==='postgres' && !process.env.TEST_DATABASE_URL}, async () => {
  const dir = await mkdtemp(join(tmpdir(),'review-race-'));
  const store = backend === 'sqlite' ? new SqliteStore(join(dir,'state.db')) : await PostgresStore.open(process.env.TEST_DATABASE_URL!);
  const id = `race-${crypto.randomUUID()}`, owner='review-race', provider=new FixtureSandbox(), broker=new SandboxBroker(store,provider);
  let factories=0; const claimed=deferred(), release=deferred();
  const engine=new Engine(store,async (o,i,j)=>{ factories++; return new FixtureHarness(broker,o,i,j); },{afterClaim:async()=>{claimed.resolve();await release.promise;}});
  try {
   await store.create(initial(id,owner)); await engine.command(owner,id,{commandId:'first',kind:'prompt',text:'/fixture write secret.txt must-not-run'}); await claimed.promise;
   const cancel={commandId:'cancel',kind:'cancel' as const}; await engine.command(owner,id,cancel); await engine.command(owner,id,cancel); await engine.command(owner,id,{...cancel,commandId:'again'});
   release.resolve(); await engine.idle(owner,id); assert.equal(factories,0); assert.equal(provider.allocations,0);
   await engine.stop(); const next=new Engine(store,async(o,i,j)=>{factories++;return new FixtureHarness(broker,o,i,j);}); await next.recover(owner); await next.idle(owner,id);
   assert.equal((await read(store,owner,id)).jobs[0]?.status,'cancelled');assert.equal(factories,0);await next.stop();
  } finally {release.resolve();await engine.stop();await store.close();await rm(dir,{recursive:true});}
 });

}
test('actual Pi SDK rehydrates structured roles and tool linkage; recovery repairs uncertain outcomes without replay',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'review-pi-')),store=new SqliteStore(join(dir,'state.db')),manager=SessionManager.inMemory(dir);
 const c=initial('pi','alice');manager.appendMessage({role:'user',content:[{type:'text',text:'write code'}],timestamp:1});
 manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:'call-1',name:'write',arguments:{path:'code.txt',content:'code'}}],api:'anthropic-messages',provider:'anthropic',model:'claude-sonnet-4-5',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:2});
 c.piEntries=[manager.getHeader()!,...manager.getEntries()];c.jobs=[{id:'job',text:'write code',status:'running'}];
 recoverPiState(c);assert.ok(c.piEntries.some(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolCallId==='call-1'&&e.message.isError));
 try{await store.create(c);const broker=new SandboxBroker(store,new FixtureSandbox());
  const harness=await PiHarness.create(broker,'alice','pi',dir,'next');
  const saved=await read(store,'alice','pi');const hydrated=SessionManager.inMemory(dir,undefined,saved.piEntries).buildSessionContext();
  assert.deepEqual(hydrated.messages.map(m=>m.role),['user','assistant','toolResult']);assert.equal(hydrated.messages[1]?.role,'assistant');
  assert.equal(SessionManager.inMemory(dir,undefined,saved.piEntries).getSessionId(),manager.getSessionId());assert.equal((await read(store,'alice','pi')).sandbox,null);harness.dispose();
 }finally{await store.close();await rm(dir,{recursive:true});}
});

test('legacy journal imports structured tool linkage and cancelled text without inventing completed outcomes',()=>{
 const c=initial('legacy','alice');c.jobs=[{id:'old',text:'write',status:'cancelled'},{id:'future',text:'not consumed',status:'queued'}];
 c.events=[{seq:1,type:'tool.started',data:{jobId:'old',callId:'native-call',tool:'write',args:{path:'code.txt',content:'code'}}},{seq:2,type:'assistant.delta',data:{jobId:'old',text:'partial'}}];
 importLegacyPiState(c);const entries=structuredClone(c.piEntries);importLegacyPiState(c);assert.deepEqual(c.piEntries,entries);
 const messages=SessionManager.inMemory('/workspace',undefined,c.piEntries).buildSessionContext().messages;assert.deepEqual(messages.map(m=>m.role),['user','assistant','toolResult','assistant']);
 const result=messages[2];assert.equal(result?.role,'toolResult');if(result?.role==='toolResult'){assert.equal(result.toolCallId,'native-call');assert.equal(result.isError,true);}
 assert.ok(c.piEntries?.some(e=>e.type==='custom'&&e.customType==='owned.legacy_import'));
});
