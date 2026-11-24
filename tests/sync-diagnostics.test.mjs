import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// The diagnostics buffer is the only record that survives `logEnabled=off`, and its contents are
// pasted into issue reports. It must stay bounded, mirror error/cancelled sync-log entries without
// recursing, and never persist the token, server address or vault name.
const root = path.resolve(import.meta.dirname, '..');

const obsidian = {
  Platform: { isMobile: false, isIosApp: false, isMacOS: true, isWin: false, isLinux: false },
};
const bypassHelpers = { dump: () => {} };

function makeWindow() {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
}

function load(relPath, extra = {}) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set, WeakSet, ArrayBuffer, Uint8Array, Error, JSON, Object, String, Number, Date, BigInt,
    window: makeWindow(),
    navigator: { clipboard: { writeText: async () => {} } },
    require(id) {
      if (id === 'obsidian') return obsidian;
      if (id === '../helpers_obsidian_bypass') return bypassHelpers;
      if (id in extra) return extra[id];
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename: sourcePath });
  return module.exports;
}

const redact = load('src/lib/utils/redact_log.ts');

function makePlugin(adapter) {
  return {
    manifest: { version: '2.6.5' },
    app: { vault: { adapter }, version: '1.8.0' },
  };
}

function makeAdapter(initial = null) {
  let stored = initial;
  const writes = [];
  return {
    writes,
    get stored() { return stored; },
    exists: async () => stored !== null,
    read: async () => stored,
    write: async (_path, data) => {
      writes.push(data);
      stored = data;
    },
  };
}

async function newDiagnostics(adapter) {
  const mod = load('src/lib/utils/sync_diagnostics.ts', { './redact_log': redact });
  await mod.initSyncDiagnostics(makePlugin(adapter), '.obsidian/plugins/fast-note-sync/diagnostics.json');
  return mod;
}

function lastPayload(adapter) {
  assert.ok(adapter.writes.length > 0, 'diagnostics file was written');
  return JSON.parse(adapter.writes[adapter.writes.length - 1]);
}

// 1. Ring keeps the newest 300 entries and evicts the oldest
{
  const adapter = makeAdapter();
  const mod = await newDiagnostics(adapter);
  for (let i = 0; i < 320; i++) mod.recordDiag('info', `K${i}`, `message ${i}`);
  await mod.flushSyncDiagnostics();
  const payload = lastPayload(adapter);
  assert.equal(payload.entries.length, 300);
  assert.equal(payload.entries[0].kind, 'K20', 'oldest 20 entries are evicted');
  assert.equal(payload.entries[299].kind, 'K319');
}

// 2. error/cancelled sync-log entries are mirrored, success is not, and a writer that mirrors on
//    every addLog call cannot recurse into a second buffer entry
{
  const adapter = makeAdapter();
  const mod = await newDiagnostics(adapter);
  const written = [];
  mod.bindSyncLogWriter((level, kind, message, p) => {
    written.push({ level, kind, message, p });
    mod.mirrorSyncLog({ action: kind, status: level === 'error' ? 'error' : 'success', message, path: p });
  });

  mod.mirrorSyncLog({ action: 'MirrorError', status: 'error', message: 'boom', path: 'a.md' });
  mod.mirrorSyncLog({ action: 'MirrorCancelled', status: 'cancelled', message: 'stopped', path: 'b.md' });
  mod.mirrorSyncLog({ action: 'MirrorOk', status: 'success', message: 'ignored' });
  assert.equal(written.length, 0, 'mirroring alone never writes to the sync log');

  mod.mirrorSyncLog({ action: 'MirrorPayload', status: 'error', message: JSON.stringify({ content: 'secret note body', path: 'c.md' }), path: 'c.md' });

  mod.recordDiag('error', 'Explicit', 'explicit failure');
  assert.equal(written.length, 1, 'explicit record writes exactly one sync-log entry');
  await mod.flushSyncDiagnostics();
  const entries = lastPayload(adapter).entries;
  assert.equal(entries.filter(e => e.kind === 'MirrorError' && e.level === 'error').length, 1);
  assert.equal(entries.filter(e => e.kind === 'MirrorPayload' && e.message.includes('[content omitted]')).length, 1);
  assert.ok(!entries.some(e => e.message.includes('secret note body')), 'note bodies never enter the buffer');
  assert.equal(entries.filter(e => e.kind === 'MirrorCancelled' && e.level === 'warn').length, 1);
  assert.equal(entries.filter(e => e.kind === 'MirrorOk').length, 0);
  assert.equal(entries.filter(e => e.kind === 'Explicit').length, 1, 'no recursion through the log writer');
  assert.equal(entries.length, 4);
}

// 3. Persisted diagnostics never contain the token, server address or vault name/path
{
  const secret = ['tok', 'value', '123'].join('');
  const host = ['sync', 'example', 'com'].join('.');
  const vaultName = ['Private', 'Vault'].join('');
  const vaultPath = `/Users/tester/${vaultName}`;
  redact.setDiagnosticRedactionContext(() => ({ vaultName, vaultPath, serverHosts: [host] }));
  const adapter = makeAdapter();
  const mod = await newDiagnostics(adapter);
  mod.recordDiag('error', 'Net', `token=${secret} GET https://${host}/api/sync?token=${secret} vault=${vaultName}`, `${vaultName}/note.md`);
  mod.recordStartupState({
    manifest: { version: '2.6.5' },
    localStorageManager: { getMetadata: () => undefined },
    fileHashManager: { getDiagnosticCounts: () => ({ hashEntries: 1, baselineEntries: 1, confirmedBaselines: 0, baselineScopeChanged: false }) },
    settings: { logEnabled: 'off', syncEnabled: true },
    syncState: null,
    retryQueue: null,
  });
  await mod.flushSyncDiagnostics();
  const raw = adapter.writes[adapter.writes.length - 1];
  for (const value of [secret, host, vaultName, vaultPath]) {
    assert.ok(!raw.includes(value), `diagnostics file must not contain: ${value}`);
  }
  const text = mod.buildSyncDiagnosticsText(makePlugin(adapter));
  for (const value of [secret, host, vaultName]) {
    assert.ok(!text.includes(value), `copied diagnostics must not contain: ${value}`);
  }
  assert.ok(text.includes('Plugin: 2.6.5'));
  redact.setDiagnosticRedactionContext(null);
}

// 4. A corrupt persisted file is treated as empty instead of throwing
{
  const adapter = makeAdapter('{"version":1,"entries":[');
  const mod = await newDiagnostics(adapter);
  const text = mod.buildSyncDiagnosticsText(makePlugin(adapter));
  assert.ok(text.includes('Diagnostics (0)'), 'corrupt file starts empty');
  mod.recordDiag('info', 'After', 'still works');
  await mod.flushSyncDiagnostics();
  const payload = lastPayload(adapter);
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0].kind, 'After');
}

// 5. Overflow evicts the oldest info first; warn/error survive while any info remains
{
  const adapter = makeAdapter();
  const mod = await newDiagnostics(adapter);
  for (let i = 0; i < 299; i++) mod.recordDiag('error', `E${i}`, `error ${i}`);
  mod.recordDiag('info', 'I0', 'first info');
  mod.recordDiag('info', 'I1', 'second info');
  await mod.flushSyncDiagnostics();
  const entries = lastPayload(adapter).entries;
  assert.equal(entries.length, 300);
  assert.equal(entries.filter(e => e.kind === 'I0').length, 0, 'oldest info is evicted');
  assert.equal(entries.filter(e => e.kind === 'I1').length, 1);
  assert.equal(entries.filter(e => e.kind.startsWith('E')).length, 299, 'all errors retained');
  assert.equal(entries[0].kind, 'E0', 'no error was evicted');
}
{
  const adapter = makeAdapter();
  const mod = await newDiagnostics(adapter);
  for (let i = 0; i < 300; i++) mod.recordDiag('error', `E${i}`, `error ${i}`);
  mod.recordDiag('info', 'N', 'new info');
  await mod.flushSyncDiagnostics();
  const entries = lastPayload(adapter).entries;
  assert.equal(entries.length, 300);
  assert.equal(entries.filter(e => e.kind === 'E0').length, 1, 'errors are not displaced by info');
  assert.equal(entries.filter(e => e.kind === 'N').length, 0, 'the only info (the new one) is evicted');
  assert.equal(entries[0].kind, 'E0');
  assert.equal(entries.at(-1).kind, 'E299');
}

// 6. Read-only skipped uploads: count every entry, write at most 100 pathed entries per round
{
  const adapter = makeAdapter();
  const mod = await newDiagnostics(adapter);
  mod.beginSyncRound('full', true, false);
  for (let i = 0; i < 150; i++) mod.recordUploadSkippedReadOnly(`ro/a${i}.md`);
  await mod.flushSyncDiagnostics();
  let entries = lastPayload(adapter).entries;
  let skipped = entries.filter(e => e.kind === 'UploadSkippedReadOnly');
  assert.equal(skipped.length, 100, 'pathed entries are capped per round');
  assert.equal(skipped[0].path, 'ro/a0.md');
  assert.equal(skipped[99].path, 'ro/a99.md');

  mod.recordRoundSummary({ failed: 0, conflicts: 0, unaligned: 0, hashTimeouts: 0 });
  await mod.flushSyncDiagnostics();
  entries = lastPayload(adapter).entries;
  const summaryEntry = entries.filter(e => e.kind === 'SyncRoundSummary').at(-1);
  assert.equal(JSON.parse(summaryEntry.message).uploadSkippedReadOnly, 150, 'the round total is not capped');

  mod.beginSyncRound('full', true, false);
  mod.recordUploadSkippedReadOnly('ro/second.md');
  await mod.flushSyncDiagnostics();
  entries = lastPayload(adapter).entries;
  skipped = entries.filter(e => e.kind === 'UploadSkippedReadOnly');
  assert.equal(skipped.length, 101, 'a new round resets the cap');
  assert.equal(skipped.at(-1).path, 'ro/second.md');
}
{
  const adapter = makeAdapter();
  const mod = await newDiagnostics(adapter);
  for (let i = 0; i < 120; i++) mod.recordUploadSkippedReadOnly(`no-round/b${i}.md`);
  await mod.flushSyncDiagnostics();
  const skipped = lastPayload(adapter).entries.filter(e => e.kind === 'UploadSkippedReadOnly');
  assert.equal(skipped.length, 100, 'the same cap applies when no round is active');
}

// 7. Buffer-only records never write a SyncLog entry, even when a writer is bound
{
  const adapter = makeAdapter();
  const mod = await newDiagnostics(adapter);
  const written = [];
  mod.bindSyncLogWriter((...args) => written.push(args));
  mod.recordDiagBufferOnly('warn', 'BufferOnly', 'recoverable, not a failure', 'x.md');
  assert.equal(written.length, 0, 'buffer-only never reaches the sync log');
  await mod.flushSyncDiagnostics();
  const entries = lastPayload(adapter).entries;
  assert.equal(entries.filter(e => e.kind === 'BufferOnly' && e.level === 'warn').length, 1);
}

// 8. Redaction happens before the 800-char truncation: a credential straddling the cut is gone
//    from both the in-memory buffer and the persisted file.
{
  const adapter = makeAdapter();
  const mod = await newDiagnostics(adapter);
  const payload = `${'x'.repeat(776)} "apiToken":"OPAQUE_CREDENTIAL_TEST_VALUE"`;
  mod.recordDiag('error', 'CredentialCut', payload);
  await mod.flushSyncDiagnostics();

  const raw = adapter.writes[adapter.writes.length - 1];
  assert.ok(!raw.includes('OPAQUE_CRED'), 'persisted diagnostics never leak the credential prefix');
  assert.ok(raw.includes('[redacted]'), 'the credential is replaced as a whole');

  const inMemory = lastPayload(adapter).entries.find(e => e.kind === 'CredentialCut');
  assert.ok(inMemory, 'the entry is in the buffer');
  assert.ok(!inMemory.message.includes('OPAQUE_CRED'), 'in-memory entry never leaks the credential prefix');
  const text = mod.buildSyncDiagnosticsText(makePlugin(adapter));
  assert.ok(!text.includes('OPAQUE_CRED'), 'copied diagnostics never leak the credential prefix');
}

console.log('sync-diagnostics: all checks passed');
