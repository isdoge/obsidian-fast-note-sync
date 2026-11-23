import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Cloud-preview "delete local after upload" reads the attachment back before trashing the local
// copy. On the requestUrl network library the call previously had neither a timeout nor a
// redirect guard. requestUrl exposes no final URL, so the fix is fail-closed: only same-origin
// request URLs run, plus a raced timeout. Failures must reject so the caller keeps the local file.
const root = path.resolve(import.meta.dirname, '..');
const noop = () => undefined;

const state = { requestUrl: null, timeoutCallbacks: [], requests: [] };

function load() {
  const sourcePath = path.join(root, 'src/lib/api/http_api_service.ts');
  const code = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set, WeakMap, WeakSet, Promise, JSON,
    URL, URLSearchParams, TextEncoder, Date, ArrayBuffer, Uint8Array, Error, AbortController,
    crypto: globalThis.crypto,
    window: {
      setTimeout: (callback) => { state.timeoutCallbacks.push(callback); return state.timeoutCallbacks.length; },
      clearTimeout: noop,
    },
    require(id) {
      if (id === 'obsidian') return { requestUrl: (...args) => state.requestUrl(...args) };
      if (id === '../utils/helpers') return {
        hashContent: (value) => `p:${value}`,
        addRandomParam: (url) => url,
        showSyncNotice: noop,
        dump: noop,
        dumpError: noop,
        nativeFetch: async () => { throw new Error('nativeFetch not stubbed'); },
        isAllowedRedirect: (from, to) => new URL(from).hostname === new URL(to).hostname,
      };
      if (id === '../utils/types') return { CLIENT_TYPE: 'test' };
      if (id === '../../i18n/lang') return { $: (key) => key, getLocale: () => 'en' };
      if (id === './token_capabilities') return {
        classifyWSClientsResponse: () => ({ ok: false, clients: [], failure: 'error' }),
        parseTokenCapabilities: () => null,
      };
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename: sourcePath });
  return module.exports;
}

const { HttpApiService, isSameOriginRequestUrl } = load();
assert.equal(typeof isSameOriginRequestUrl, 'function');

function makeService({ api = 'https://server.example', networkLibrary = 'requestUrl' } = {}) {
  const plugin = {
    settings: { api, apiToken: 'tok', vault: 'v1', networkLibrary, allowedRedirectDomains: '' },
    runApi: api,
    manifest: { version: '0' },
    getClientName: () => 'test',
  };
  return new HttpApiService(plugin);
}

// Same origin is the only shape requestUrl may fetch
assert.equal(isSameOriginRequestUrl('https://server.example/api/file?x=1', 'https://server.example'), true);
assert.equal(isSameOriginRequestUrl('https://evil.example/api/file', 'https://server.example'), false);
assert.equal(isSameOriginRequestUrl('http://server.example/api/file', 'https://server.example'), false);
assert.equal(isSameOriginRequestUrl('https://server.example:8443/api/file', 'https://server.example'), false);
assert.equal(isSameOriginRequestUrl('not a url', 'https://server.example'), false);

// 1. requestUrl, same origin: bytes are returned
{
  state.requests = [];
  state.requestUrl = async (options) => {
    state.requests.push(options);
    return { status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer };
  };
  const bytes = await makeService().getFileContentForVerification('a.png', 3);
  assert.equal(bytes.byteLength, 3);
  assert.equal(state.requests.length, 1);
}

// 2. requestUrl, cross-origin runApi: rejected before any request is made
{
  state.requests = [];
  state.requestUrl = async () => {
    state.requests.push('called');
    return { status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer };
  };
  const service = makeService();
  service.plugin.runApi = 'https://elsewhere.example';
  await assert.rejects(
    service.getFileContentForVerification('a.png', 3),
    /Cross-origin attachment read-back blocked/,
  );
  assert.deepEqual(state.requests, [], 'no cross-origin request is issued');
}

// 3. requestUrl, hanging request: the raced timeout rejects instead of waiting forever
{
  state.timeoutCallbacks = [];
  state.requestUrl = () => new Promise(() => undefined);
  const pending = makeService().getFileContentForVerification('a.png', 3);
  // Let the call reach the race, then fire the abort timer
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(state.timeoutCallbacks.length > 0, 'a timeout timer is registered');
  for (const callback of state.timeoutCallbacks) callback();
  await assert.rejects(pending, /timeout/);
}

// 4. Non-200 status still rejects so the caller keeps the local file
{
  state.requestUrl = async () => ({ status: 503, arrayBuffer: new Uint8Array([]).buffer });
  await assert.rejects(makeService().getFileContentForVerification('a.png', 3), /HTTP 503/);
}

console.log('PASS: requestUrl attachment read-back is same-origin only, times out, and fails closed');
