import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// 附件 fileModify 在 pendingUploadHashes.set 后 waitForSlot 排队。排到名额后、发送
// FileUploadCheck 前必须复查：若排队期间服务端已确认相同内容（pending 被消费且基线
// 等于本次内容哈希），不再发检查、不 arm 60 秒超时，并只释放自己获得的名额。
// 与在途上传共用名额（waitForSlot 对 active key 立即返回 true）时不能释放别人的名额。
// 使用实际 ConcurrencyLimiter 与实际 receiveFileUploadAck / receiveFileUpload。
const noop = () => {};
const dumps = [];
const timers = [];
const cleared = [];
const state = { hash: "h-new" };
const helpers = new Proxy({
  dump: (...a) => dumps.push(a.map(String)),
  isPathExcluded: () => false,
  isLargeBinarySyncRisk: () => false,
  hashFileAsync: async () => state.hash,
  hashContent: p => `ph:${p}`,
  getSafeCtime: s => s.ctime,
  logMemorySnapshot: noop,
  normalizeServerTimestamp: t => t,
}, { get: (t, k) => t[k] ?? noop });
class TFile { constructor(p) { this.path = p; this.stat = { size: 10, mtime: 200, ctime: 1 }; } }
function load(file, extra = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, Map, Set, JSON, Promise, Object, Array, Date, Math, TextEncoder, Uint8Array, ArrayBuffer, DataView,
    window: { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: h => { cleared.push(h); } },
    require: id => id === "obsidian" ? { TFile, normalizePath: p => p, Platform: { isMobile: false } }
      : id.includes("helpers") ? helpers
      : id.includes("sync_log_manager") ? { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } }
      : id.includes("sync_state") ? { advanceLiveSyncTime }
      : extra[id] || {} });
  return module.exports;
}
const { ConcurrencyLimiter } = load("src/lib/sync/concurrency_limiter.ts");
const { advanceLiveSyncTime } = load("src/lib/sync/sync_state.ts");
const ops = load("src/lib/sync/operator_file.ts");
const tick = () => new Promise(setImmediate);

function makePlugin({ max = 1 } = {}) {
  const sent = [];
  const baselines = new Map();
  const files = new Map();
  const meta = new Map();
  const plugin = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v", concurrencyControlEnabled: true, maxConcurrentUploads: max },
    lockManager: { withLock: async (_p, fn) => fn() },
    addIgnoredFile: noop, removeIgnoredFile: noop, isIgnoredFile: () => false,
    fileHashManager: {
      getPathHash: p => baselines.get(p) ?? null,
      getValidHash: () => null,
      setFileHash: (p, h) => baselines.set(p, h),
    },
    lastSyncMtime: new Map(),
    pendingUploadHashes: new Map(),
    pendingFileDeleteAcks: new Set(),
    localStorageManager: { savePending: noop, getMetadata: k => meta.get(k) ?? 0, setMetadata: (k, v) => meta.set(k, v) },
    syncState: { activeSyncContext: null, hasSyncedThisConnection: true, pendingFilePushPageIndex: new Map() },
    websocket: {
      SendMessage: async (action, data) => { sent.push({ action, data }); },
      SendBinary: async (_d, _p, _before, after) => { after?.(); return "sent"; },
    },
    recordSyncCompleted: noop,
    fileSyncTasks: { failed: 0 },
    totalChunksToUpload: 0, uploadedChunksCount: 0,
    app: { vault: { getFileByPath: p => files.get(p), readBinary: async () => new ArrayBuffer(0), getName: () => "v" }, loadLocalStorage: noop, saveLocalStorage: noop },
  };
  plugin.concurrencyLimiter = new ConcurrencyLimiter(plugin);
  return { plugin, sent, baselines, files };
}

// (a) 名额占满排队，期间同路径 ACK 消费 pending 并提交相同内容基线：
//     名额空出后不得再发 FileUploadCheck、不 arm 60 秒超时、名额释放回占用前状态。
{
  const { plugin, sent, baselines, files } = makePlugin();
  const file = new TFile("queued.bin"); files.set("queued.bin", file);
  state.hash = "h-new";
  baselines.set("queued.bin", "h-base");
  await plugin.concurrencyLimiter.waitForSlot("busy.bin");
  const timersBefore = timers.length;
  const modify = ops.fileModify(file, plugin, true);
  await tick(); await tick();
  assert.equal(plugin.pendingUploadHashes.has("queued.bin"), true, "(a) queued task registered its pending hash");
  assert.equal(sent.length, 0, "(a) nothing sent while queued");
  ops.receiveFileUploadAck({ path: "queued.bin", lastTime: 42 }, plugin);
  assert.equal(plugin.pendingUploadHashes.has("queued.bin"), false, "(a) ACK consumed the pending hash");
  assert.equal(baselines.get("queued.bin"), "h-new", "(a) ACK committed the matching baseline");
  plugin.concurrencyLimiter.releaseSlot("busy.bin");
  await modify;
  assert.equal(sent.length, 0, "(a) confirmed content must not be re-checked after queuing");
  assert.equal(plugin.concurrencyLimiter.activeKeys.size, 0, "(a) slot released back to pre-queue occupancy");
  assert.equal(timers.length, timersBefore, "(a) no 60s ack timeout armed");
  assert.ok(dumps.some(d => d.join(" ").includes("queued.bin") && d.join(" ").includes("already confirmed")), "(a) recheck decision logged");
  console.log("PASS (a): queued fileModify skips the check after its content was confirmed during the wait");
}

// (b) pending 仍在：正常发检查、arm 超时、持有名额。
{
  const { plugin, sent, baselines, files } = makePlugin();
  const file = new TFile("pending.bin"); files.set("pending.bin", file);
  state.hash = "h-new";
  baselines.set("pending.bin", "h-base");
  await plugin.concurrencyLimiter.waitForSlot("busy.bin");
  const timersBefore = timers.length;
  const modify = ops.fileModify(file, plugin, true);
  await tick(); await tick();
  plugin.concurrencyLimiter.releaseSlot("busy.bin");
  await modify;
  assert.equal(sent.length, 1, "(b) pending still present: check goes out");
  assert.equal(sent[0].action, "FileUploadCheck");
  assert.equal(sent[0].data.path, "pending.bin");
  assert.equal(sent[0].data.contentHash, "h-new");
  assert.equal(timers.length, timersBefore + 1, "(b) ack timeout armed");
  assert.ok(plugin.concurrencyLimiter.activeKeys.has("pending.bin"), "(b) slot held until ACK");
  console.log("PASS (b): queued fileModify with pending intact still sends FileUploadCheck and holds its slot");
}

// (c) 与在途上传共用名额（waitForSlot 对 active key 立即 true）：pending 在发送前刚写入，
//     必须照常发检查，且不得释放共用的名额。
{
  const { plugin, sent, baselines, files } = makePlugin();
  const file = new TFile("share.bin"); files.set("share.bin", file);
  state.hash = "h-new";
  baselines.set("share.bin", "h-base");
  await plugin.concurrencyLimiter.waitForSlot("share.bin");
  plugin.pendingUploadHashes.set("share.bin", "h-new");
  await ops.fileModify(file, plugin, true);
  assert.equal(sent.length, 1, "(c) sharing a slot with an in-flight upload still sends the check");
  assert.equal(plugin.concurrencyLimiter.activeKeys.size, 1);
  assert.ok(plugin.concurrencyLimiter.activeKeys.has("share.bin"), "(c) shared slot must not be released");
  console.log("PASS (c): fileModify sharing an in-flight upload's slot sends normally and keeps the slot");
}

// (c2) 排队期间内容被确认，同时迟到的 FileUpload 让另一路上传以更高优先级先获得名额并登记
//      activeUploadsMap：复查应跳过检查，但不得释放该在途上传的名额（由上传自行释放）。
{
  const { plugin, sent, baselines, files } = makePlugin({ max: 2 });
  const file = new TFile("shared.bin"); files.set("shared.bin", file);
  state.hash = "h-new";
  baselines.set("shared.bin", "h-base");
  await plugin.concurrencyLimiter.waitForSlot("busy1.bin");
  await plugin.concurrencyLimiter.waitForSlot("busy2.bin");
  const modify = ops.fileModify(file, plugin, true);
  await tick(); await tick();
  assert.equal(plugin.pendingUploadHashes.has("shared.bin"), true, "(c2) queued task registered its pending hash");
  ops.receiveFileUploadAck({ path: "shared.bin", lastTime: 7 }, plugin);
  assert.equal(baselines.get("shared.bin"), "h-new", "(c2) baseline committed during the wait");
  plugin.app.vault.readBinary = () => new Promise(() => { }); // 上传停在读取阶段，保持 activeUploadsMap 登记
  ops.receiveFileUpload({ path: "shared.bin", sessionId: "00000000-0000-0000-0000-000000000000", chunkSize: 1024, pathHash: "ph" }, plugin);
  await tick(); await tick();
  plugin.concurrencyLimiter.releaseSlot("busy2.bin");
  plugin.concurrencyLimiter.releaseSlot("busy1.bin");
  await modify;
  assert.equal(sent.length, 0, "(c2) confirmed content is not re-checked");
  assert.ok(plugin.concurrencyLimiter.activeKeys.has("shared.bin"), "(c2) in-flight upload keeps its slot");
  assert.equal(plugin.concurrencyLimiter.activeKeys.size, 1);
  console.log("PASS (c2): recheck skips the duplicate check without releasing an in-flight upload's slot");
}

// (d) forceCheck 恢复重试同样适用：内容未变，排队期间原上传的迟到确认消费 pending 并提交
//     相同基线后，重试不再发检查。
{
  const { plugin, sent, baselines, files } = makePlugin();
  const file = new TFile("retry.bin"); files.set("retry.bin", file);
  state.hash = "h-base";
  baselines.set("retry.bin", "h-base");
  await plugin.concurrencyLimiter.waitForSlot("busy.bin");
  const modify = ops.fileModify(file, plugin, false, true);
  await tick(); await tick();
  assert.equal(plugin.pendingUploadHashes.has("retry.bin"), true, "(d) forced retry registers pending");
  ops.receiveFileUploadAck({ path: "retry.bin", lastTime: 9 }, plugin);
  plugin.concurrencyLimiter.releaseSlot("busy.bin");
  await modify;
  assert.equal(sent.length, 0, "(d) forced retry skips when a late ACK confirmed the content");
  assert.equal(plugin.concurrencyLimiter.activeKeys.size, 0, "(d) slot released");
  console.log("PASS (d): forceCheck retry also skips once the late ACK confirmed identical content");
}

// (e) pending 消失但基线不同 / 为空：不能跳过，必须照常发检查。
for (const [label, base] of [["stale baseline", "h-base"], ["no baseline", null]]) {
  const { plugin, sent, baselines, files } = makePlugin();
  const file = new TFile("diff.bin"); files.set("diff.bin", file);
  state.hash = "h-new";
  if (base) baselines.set("diff.bin", base);
  await plugin.concurrencyLimiter.waitForSlot("busy.bin");
  const modify = ops.fileModify(file, plugin, true);
  await tick(); await tick();
  assert.equal(plugin.pendingUploadHashes.has("diff.bin"), true);
  plugin.pendingUploadHashes.delete("diff.bin"); // 模拟 pending 被消费但基线未提交匹配值
  plugin.concurrencyLimiter.releaseSlot("busy.bin");
  await modify;
  assert.equal(sent.length, 1, `(e:${label}) baseline mismatch must still send the check`);
  assert.ok(plugin.concurrencyLimiter.activeKeys.has("diff.bin"), `(e:${label}) slot held`);
  console.log(`PASS (e:${label}): pending gone but ${label} — check still sent`);
}
