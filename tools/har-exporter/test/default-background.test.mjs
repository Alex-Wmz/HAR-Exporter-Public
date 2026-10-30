import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, emitRequest } from './harness.mjs';
async function run(options) {
  const h = createHarness(options);
  h.HarFs.DEFAULT_FOLDER_PATH = 'Z:\\Synthetic\\HARExports';
  await h.startRecording(1);
  emitRequest(h.L, 1, 'r', 'https://example.test/');
  const result = await h.stopRecording();
  return { h, result };
}
test('pending default setup retains recorded data and never falls back to Downloads', async () => {
  const {h, result} = await run({target:{mode:'default'}});
  assert.equal(result.ok,false); assert.match(result.error,/Z:\\Synthetic\\HARExports/);
  assert.equal(h.state.phase,'ready'); assert.equal(h.writes.length,0);
  await h.stopRecording(false);
});
test('authorized default folder is used without a download task', async () => {
  const handle = {};
  const {h,result} = await run({target:{mode:'folder',folderId:'d',defaultFolder:true},folder:{id:'d',handle,name:'HARExports'}});
  assert.equal(result.ok,true);assert.equal(result.method,'folder');
  assert.equal(result.folderName,'Z:\\Synthetic\\HARExports');assert.equal(h.writes.length,1);
  assert.equal(h.writes[0].spec,undefined);
});
test('default folder permission loss retains data instead of using another folder', async () => {
  const {h,result} = await run({target:{mode:'folder',folderId:'d',defaultFolder:true},folder:{id:'d',handle:{}},permission:'denied'});
  assert.equal(result.ok,false);assert.equal(h.writes.length,0);assert.match(result.error,/重新授权/);
  assert.equal(h.state.phase,'ready');await h.stopRecording(false);
});
test('default folder disk write failure is retryable and never invokes Save As', async () => {
  const {h,result} = await run({target:{mode:'folder',folderId:'d',defaultFolder:true},folder:{id:'d',handle:{}},write:async()=>{throw new Error('disk full')}});
  assert.equal(result.ok,false);assert.equal(h.writes.length,0);assert.match(result.error,/写入失败/);
  assert.equal(h.state.phase,'ready');await h.stopRecording(false);
});
test('missing default folder does not reuse another remembered location', async () => {
  const {h,result} = await run({target:{mode:'folder',folderId:'missing',defaultFolder:true}});
  assert.equal(result.ok,false);assert.equal(h.writes.length,0);assert.equal(h.state.phase,'ready');
  await h.stopRecording(false);
});
