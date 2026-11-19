import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// haierkeys/fast-note-sync-service#312: FileRenameAck used to pop pendingFileRenames FIFO-style,
// so with several quick renames (or an out-of-order/failed ack) the ack landed on the wrong entry
// and the local hash baseline was written to the wrong path. The server's FileRenameAck carries the
// new path; match the pending entry precisely by it. An ack without path (legacy server) falls back
// to FIFO, and an ack matching nothing must not consume another entry.
const root = path.resolve(import.meta.dirname, "..");
class TFile { constructor(p) { this.path = p; this.stat = { size: 3, mtime: 100 }; } }
const noop = () => undefined;
const dumps = [];
const helpers = new Proxy({
  isPathExcluded: () => false, isLargeBinarySyncRisk: () => false,
  dump: (...a) => dumps.push(a.map(String).join(" ")),
}, { get: (t, k) => t[k] ?? noop });
const source = fs.readFileSync(path.join(root, "src/lib/sync/operator_file.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(code, {
  module, exports: module.exports, console, Map, Set, WeakMap, URLSearchParams, TextEncoder,
  window: { setTimeout: () => 1, clearTimeout: noop },
  require(id) {
    if (id === "obsidian") return { TFile, normalizePath: p => p, Platform: { isMobile: false } };
    if (id === "../utils/helpers") return helpers;
    if (id === "../utils/types") return { CLIENT_TYPE: "test" };
    if (id === "./remote_path_guard") return { blockAliasedRemoteMutation: () => false };
    if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } };
    if (id === "./sync_state") return { advanceLiveSyncTime: (plugin, field, lastTime) => { if (lastTime && lastTime > Number(plugin.localStorageManager.getMetadata(field))) plugin.localStorageManager.setMetadata(field, lastTime); } };
    if (id === "../storage/file_cloud_preview") return { FileCloudPreview: { isRestrictedType: () => true } };
    return {};
  },
});
const ops = module.exports;
function loadLocal(file) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, { module, exports: module.exports, console, Map, Set,
    require: id => id.includes('helpers') ? helpers
      : id === 'obsidian' ? { TFile, normalizePath: p => p }
      : id.includes('sync_state') ? { advanceLiveSyncTime: noop } : {} });
  return module.exports;
}
const { ConcurrencyLimiter } = loadLocal('src/lib/sync/concurrency_limiter.ts');
const noteOps = loadLocal('src/lib/sync/operator_note.ts');

function fixture(entries) {
  const hashLog = [];
  const files = new Map(entries.map(e => [e.newPath, new TFile(e.newPath)]));
  const plugin = {
    retryQueue: { matchesAck: () => false },
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    app: { vault: { getFileByPath: p => files.get(p) ?? null } },
    pendingFileRenames: entries.map(e => ({ ...e })),
    fileHashManager: {
      setFileHash: (p, hash, mtime, size) => hashLog.push(["set", p, hash]),
      removeFileHash: p => hashLog.push(["remove", p]),
      getPathHash: () => null, getValidHash: () => null,
    },
    localStorageManager: { getMetadata: () => 0, setMetadata: noop },
    concurrencyLimiter: { releaseSlot: noop, releaseFifoSlot: noop },
  };
  return { plugin, hashLog };
}

// 1. Two pending renames, acks arrive out of order: each lands on its own path
{
  const f = fixture([
    { oldPath: "dir/a.png", newPath: "dir/1.png", contentHash: "hash-a" },
    { oldPath: "dir/b.png", newPath: "dir/2.png", contentHash: "hash-b" },
  ]);
  // second rename confirmed first
  ops.receiveFileRenameAck({ path: "dir/2.png", lastTime: 1 }, f.plugin);
  assert.deepEqual(f.hashLog, [["set", "dir/2.png", "hash-b"], ["remove", "dir/b.png"]],
    "out-of-order ack lands on its own entry");
  assert.equal(f.plugin.pendingFileRenames.length, 1, "the unmatched entry stays queued");
  assert.equal(f.plugin.pendingFileRenames[0].newPath, "dir/1.png", "the remaining entry is the right one");
  // then the first
  ops.receiveFileRenameAck({ path: "dir/1.png", lastTime: 2 }, f.plugin);
  assert.deepEqual(f.hashLog, [["set", "dir/2.png", "hash-b"], ["remove", "dir/b.png"], ["set", "dir/1.png", "hash-a"], ["remove", "dir/a.png"]],
    "the second ack lands on the other entry");
  assert.equal(f.plugin.pendingFileRenames.length, 0);
}

// 2. Ack without path (legacy server / protobuf default empty string) falls back to FIFO
{
  const f = fixture([
    { oldPath: "dir/a.png", newPath: "dir/1.png", contentHash: "hash-a" },
    { oldPath: "dir/b.png", newPath: "dir/2.png", contentHash: "hash-b" },
  ]);
  ops.receiveFileRenameAck({ lastTime: 1 }, f.plugin);
  assert.deepEqual(f.hashLog, [["set", "dir/1.png", "hash-a"], ["remove", "dir/a.png"]],
    "ack without path takes the oldest pending entry (FIFO)");
  ops.receiveFileRenameAck({ path: "", lastTime: 2 }, f.plugin);
  assert.deepEqual(f.hashLog, [["set", "dir/1.png", "hash-a"], ["remove", "dir/a.png"], ["set", "dir/2.png", "hash-b"], ["remove", "dir/b.png"]],
    "an empty path (protobuf default) also falls back to FIFO");
  assert.equal(f.plugin.pendingFileRenames.length, 0);
}

// 3. Ack matching nothing leaves the queue intact
{
  const f = fixture([
    { oldPath: "dir/a.png", newPath: "dir/1.png", contentHash: "hash-a" },
  ]);
  ops.receiveFileRenameAck({ path: "dir/unknown.png", lastTime: 1 }, f.plugin);
  assert.deepEqual(f.hashLog, [], "an unmatched ack writes no hash entries");
  assert.equal(f.plugin.pendingFileRenames.length, 1, "an unmatched ack consumes no pending entry");
  assert.ok(dumps.some(d => d.includes("dir/unknown.png")), "the miss is logged");
}

console.log("PASS: file rename acks match pending entries by path, FIFO fallback for legacy, misses consume nothing");

// 槽位与精确匹配项一致；无路径回退只消费该类型的首个待确认项。
for (const type of ['file', 'note']) {
  const f = fixture([
    { oldPath: 'a', newPath: 'A', contentHash: 'ha' },
    { oldPath: 'b', newPath: 'B', contentHash: 'hb' },
  ]);
  f.plugin.settings.concurrencyControlEnabled = true;
  f.plugin.settings.maxConcurrentUploads = 5;
  f.plugin.pendingNoteRenames = new Map(f.plugin.pendingFileRenames.map(e => [e.newPath, e]));
  f.plugin.concurrencyLimiter = new ConcurrencyLimiter(f.plugin);
  const limiter = f.plugin.concurrencyLimiter;
  await limiter.waitForSlot('unrelated', true);
  await limiter.waitForSlot('A', true);
  await limiter.waitForSlot('B', true);
  const ack = type === 'file' ? ops.receiveFileRenameAck : noteOps.receiveNoteRenameAck;
  ack({ path: 'B' }, f.plugin);
  assert.equal(limiter.activeKeys.has('B'), false, `${type}: release matched B slot`);
  assert.equal(limiter.activeKeys.has('A'), true, `${type}: A remains active`);
  ack({ path: 'missing' }, f.plugin);
  assert.equal(limiter.activeKeys.has('A'), true, `${type}: unmatched ack consumes no slot`);
  ack({}, f.plugin);
  assert.equal(limiter.activeKeys.has('A'), false, `${type}: legacy ack releases matched first entry`);
  assert.equal(limiter.activeKeys.has('unrelated'), true, `${type}: unrelated FIFO entry survives`);
}
console.log('PASS: note/file rename slots follow matched pending entries, including legacy and unmatched ACKs');

// A pathless ACK uses the same FIFO pending identity even when the retry queue exists.
{
  const f = fixture([{ oldPath: 'a.png', newPath: 'b.png', contentHash: 'h' }]);
  const calls = [];
  f.plugin.retryQueue = {
    matchesAck: (action, path) => action === 'FileRenameAck' && path === 'b.png',
    acknowledge: (action, path) => { calls.push([action, path]); return true; },
  };
  f.plugin.localStorageManager.setMetadata = () => assert.fail('retry ACK must not advance sync time');
  ops.receiveFileRenameAck({ lastTime: 999 }, f.plugin);
  assert.equal(f.plugin.pendingFileRenames.length, 0, 'legacy FIFO ACK settles the matching queue operation');
  assert.deepEqual(calls, [['FileRenameAck', 'b.png']]);
}
