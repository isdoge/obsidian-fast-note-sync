import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/api/http_api_service.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module, exports: module.exports, URLSearchParams, AbortController, window: { setTimeout, clearTimeout },
  require: id => id.includes('helpers') ? { hashContent: s => `hash:${s}` } : {} });
const api = new module.exports.HttpApiService({ settings: { vault: 'v' } });
for (const kind of ['note', 'file']) {
  api.request = async (endpoint, options) => {
    assert.equal(endpoint.split('?')[0], kind === 'note' ? '/api/note' : '/api/file/info');
    const query = new URLSearchParams(endpoint.split('?')[1]);
    assert.equal(query.get('path'), 'dir/a + 中.md'); assert.equal(query.get('vault'), 'v');
    assert.equal(query.get('pathHash'), 'hash:dir/a + 中.md'); assert.equal(query.get('isRecycle'), 'false');
    assert.equal(options.method, 'GET'); assert.ok(options.signal);
    return { status: 200, json: { code: 200, data: { path: 'dir/a + 中.md', contentHash: 'h' } } };
  };
  assert.equal((await api.getRetryQueueState(kind, 'dir/a + 中.md')).contentHash, 'h');
  for (const code of [430, 455]) {
    api.request = async () => ({ status: 200, json: { code } });
    assert.equal(await api.getRetryQueueState(kind, 'a.md'), null);
  }
  for (const response of [
    { status: 500, json: { code: 200, data: { path: 'a.md', contentHash: 'h' } } },
    { status: 200, json: { code: 200, data: { path: 'other.md', contentHash: 'h' } } },
    { status: 200, json: { code: 200, data: { path: 'a.md' } } },
    { status: 200, json: { code: 200, data: { path: 'a.md', contentHash: 'h', isRecycle: true } } },
    { status: 200, json: { code: 0, details: 'permission denied' } },
    { status: 200, json: null },
  ]) {
    api.request = async () => response;
    await assert.rejects(() => api.getRetryQueueState(kind, 'a.md'));
  }
}
api.request = async () => ({ status: 200, json: { code: 0, details: 'record not found' } });
assert.equal(await api.getRetryQueueState('file', 'a.png'), null);
console.log('retry-queue-api.test.mjs: existing read-only endpoint contracts passed');
