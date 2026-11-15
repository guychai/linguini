import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.ts';
import { FixtureHarness } from './harness.ts';
import { SqliteStore, PostgresStore, initial, read } from './store.ts';
import { SandboxBroker, FixtureSandbox } from './sandbox.ts';

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
