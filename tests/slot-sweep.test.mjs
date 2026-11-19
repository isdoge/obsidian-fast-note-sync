import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// 名额清扫：长期没有动静的活跃键被 sweepStale 归还并唤醒排队任务；touch 过、isBusy 判定为忙、
// 以及并发控制关闭时都不动；FIFO 键被清扫后，迟到的无路径确认不能错放别的键。
// 使用真实的 ConcurrencyLimiter，并用真实的 isSyncStalled 验证清扫后停滞条件得以满足。
const noop = () => {};
const dumps = [];
const activeUploads = new Set();
const helpers = new Proxy({
  dump: (...args) => dumps.push(args.map(String).join(" ")),
}, { get: (target, key) => target[key] ?? noop });

function load(file, extra = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set, JSON, Promise, Object, Array, Date, Math,
    TextEncoder, Uint8Array, ArrayBuffer, DataView, WebSocket: { OPEN: 1 },
    window: { setTimeout: () => 1, clearTimeout: noop, clearInterval: noop },
    require: id => id === "obsidian"
      ? { normalizePath: p => p, TFile: class {}, TFolder: class {}, Platform: { isMobile: false } }
      : id.includes("helpers") ? helpers
      : id.includes("sync_log_manager") ? { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } }
      : id.includes("i18n") ? { $: key => key }
      : id === "./operator_file" ? new Proxy({
          sweepStalledDownloadSessions: async () => 0,
          invalidateFileDownloads: noop,
          isAttachmentUploadActive: path => activeUploads.has(path),
        }, { get: (target, key) => target[key] ?? noop })
      : id === "./operator_note" ? new Proxy({}, { get: () => noop })
      : id === "./operator_config" ? new Proxy({}, { get: () => noop })
      : id === "./operator_folder" ? new Proxy({}, { get: () => noop })
      : extra[id] || {},
  });
  return module.exports;
}

const { ConcurrencyLimiter } = load("src/lib/sync/concurrency_limiter.ts");
const { isSyncStalled, checkSyncCompletion, SYNC_STALL_RESTART_MS, SYNC_SLOT_STALE_MS } = load("src/lib/sync/operator.ts");
const tick = () => new Promise(setImmediate);

function makeLimiter({ max = 2, enabled = true } = {}) {
  const plugin = {
    settings: { concurrencyControlEnabled: enabled, maxConcurrentUploads: max },
    syncState: { activeSyncContext: null },
  };
  return { plugin, limiter: new ConcurrencyLimiter(plugin) };
}

const MAX_IDLE = 60_000;

// (a) 超时无动静的键被清掉并唤醒排队任务；刚 touch 过的键保留
{
  const { limiter } = makeLimiter({ max: 2 });
  const base = Date.now();
  await limiter.waitForSlot("stale.md");
  await limiter.waitForSlot("fresh.md");
  limiter.touch("fresh.md", base + 1);

  let queuedGranted = false;
  const queued = limiter.waitForSlot("queued.md").then(granted => { queuedGranted = granted; return granted; });
  assert.equal(limiter.activeKeys.size, 2, "(a) both slots held before the sweep");

  const swept = limiter.sweepStale(MAX_IDLE, undefined, base + MAX_IDLE + 1);
  assert.deepEqual([...swept], ["stale.md"], "(a) only the untouched key is swept");
  await queued;
  await tick();
  assert.equal(queuedGranted, true, "(a) the queued task is granted the freed slot");
  assert.deepEqual([...limiter.activeKeys].sort(), ["fresh.md", "queued.md"], "(a) touched key survives");
  assert.ok(dumps.some(line => line.includes("Sweeping slot stale.md")), "(a) sweep is logged");
  assert.equal(limiter.getSlotContext("stale.md"), undefined, "(a) swept key has no slot context");
  // 迟到的确认对不存在的键是空操作
  limiter.releaseSlot("stale.md");
  assert.deepEqual([...limiter.activeKeys].sort(), ["fresh.md", "queued.md"], "(a) late release is a no-op");
}

// (b) isBusy 判定为忙的不过期
{
  const { limiter } = makeLimiter({ max: 2 });
  const base = Date.now();
  await limiter.waitForSlot("uploading.bin");
  await limiter.waitForSlot("idle.md");
  const swept = limiter.sweepStale(MAX_IDLE, key => key === "uploading.bin", base + MAX_IDLE + 1);
  assert.deepEqual([...swept], ["idle.md"], "(b) busy key is kept, idle key is swept");
  assert.deepEqual([...limiter.activeKeys], ["uploading.bin"]);
}

// (c) touch 续期后，即使总额度足够也不再被清
{
  const { limiter } = makeLimiter({ max: 1 });
  const base = Date.now();
  await limiter.waitForSlot("chunked.bin");
  limiter.touch("chunked.bin", base + MAX_IDLE - 1);
  assert.deepEqual([...limiter.sweepStale(MAX_IDLE, undefined, base + MAX_IDLE + 1)], [], "(c) refreshed key is not stale");
  limiter.touch("chunked.bin", base + 2 * MAX_IDLE);
  assert.deepEqual([...limiter.sweepStale(MAX_IDLE, undefined, base + 2 * MAX_IDLE + 1)], []);
}

// (d) FIFO 键被清后，迟到的无路径确认不会错放另一个 FIFO 键
{
  const { limiter } = makeLimiter({ max: 2 });
  const base = Date.now();
  await limiter.waitForSlot("renamed-a.md", true);
  await limiter.waitForSlot("renamed-b.md", true);
  limiter.touch("renamed-b.md", base + 1);
  assert.deepEqual([...limiter.sweepStale(MAX_IDLE, undefined, base + MAX_IDLE + 1)], ["renamed-a.md"]);
  assert.deepEqual([...limiter.activeKeys], ["renamed-b.md"]);
  limiter.releaseFifoSlot();
  assert.deepEqual([...limiter.activeKeys], ["renamed-b.md"], "(d) swept FIFO key's late ack must not release another key");
  // 第二条无路径确认才轮到仍在等待的 renamed-b.md
  limiter.releaseFifoSlot();
  assert.equal(limiter.activeKeys.size, 0, "(d) the live FIFO key's own ack still releases it");
}

// (e) 并发控制关闭时什么都不做
{
  const { plugin, limiter } = makeLimiter({ max: 1 });
  await limiter.waitForSlot("held.md");
  plugin.settings.concurrencyControlEnabled = false;
  assert.deepEqual([...limiter.sweepStale(0, undefined, Date.now() + 10 * MAX_IDLE)], [], "(e) disabled sweep returns nothing");
  assert.deepEqual([...limiter.activeKeys], ["held.md"], "(e) disabled sweep keeps keys");
  limiter.touch("held.md", Date.now() + 10 * MAX_IDLE);
  limiter.releaseSlot("held.md");
  assert.deepEqual([...limiter.activeKeys], ["held.md"], "(e) release is also inert while disabled");
}

// (f) 清扫只归还名额：名额条件满足后，isSyncStalled 能照常判定停滞
{
  const { plugin, limiter } = makeLimiter({ max: 4 });
  Object.assign(plugin, {
    noteSyncTasks: { completed: 1, failed: 0 }, fileSyncTasks: { completed: 5, failed: 0 },
    folderSyncTasks: { completed: 0, failed: 0 }, configSyncTasks: { completed: 0, failed: 0 },
    uploadedChunksCount: 0, downloadedChunksCount: 0,
    progressTracker: { getOverallPct: () => 40 },
    fileDownloadSessions: new Map(), isSyncRequesting: false,
    concurrencyLimiter: limiter,
  });
  await limiter.waitForSlot("leaked-note.md");
  const t0 = 1_000_000;
  assert.equal(isSyncStalled(plugin, "ctx", t0), false, "(f) first observation records the baseline");
  const stalledAt = t0 + SYNC_STALL_RESTART_MS + 1;
  assert.equal(isSyncStalled(plugin, "ctx", stalledAt), false, "(f) a leaked slot keeps the watchdog from firing");
  assert.deepEqual([...limiter.sweepStale(SYNC_SLOT_STALE_MS, undefined, Date.now() + SYNC_SLOT_STALE_MS + 1)], ["leaked-note.md"]);
  assert.equal(limiter.activeKeys.size, 0);
  assert.equal(isSyncStalled(plugin, "ctx", stalledAt), true, "(f) with the slot returned, the stall is detected");
}

// (g) 定时检查先清扫再判停滞：上传中与下载会话占用的键保留，其余泄漏键归还
{
  const { plugin, limiter } = makeLimiter({ max: 4 });
  Object.assign(plugin, {
    syncState: {
      activeSyncContext: "ctx", progressCheckIntervalId: 1,
      pendingSyncEndTime: new Map(), syncTimeBaseline: new Map(),
    },
    settings: { concurrencyControlEnabled: true, maxConcurrentUploads: 4, syncEnabled: true, configSyncEnabled: false, isShowNotice: false },
    noteSyncTasks: { completed: 0, failed: 0 }, fileSyncTasks: { completed: 0, failed: 0 },
    folderSyncTasks: { completed: 0, failed: 0 }, configSyncTasks: { completed: 0, failed: 0 },
    uploadedChunksCount: 0, downloadedChunksCount: 0,
    concurrencyLimiter: limiter,
    fileDownloadSessions: new Map([["s1", { path: "drawing.png", initialSlotKey: "download_drawing.png" }]]),
    isSyncRequesting: false, isSyncing: true,
    websocket: { ws: { readyState: 1, bufferedAmount: 0 }, isOpen: true },
    progressTracker: { getOverallPct: () => 10, getDetailText: () => "", isTypeFullyDone: () => false, forceComplete: noop },
    syncPageStateMap: new Map(), resetSyncTasks: noop,
    localStorageManager: { getMetadata: () => 0, setMetadata: noop },
    updateStatusBar: noop,
  });
  await limiter.waitForSlot("uploading.bin");
  await limiter.waitForSlot("download_drawing.png");
  await limiter.waitForSlot("leaked-config.json");
  activeUploads.add("uploading.bin");
  // 把这些键的最近动静时间调到很久以前
  for (const key of limiter.activeKeys) limiter.keyActivityAt.set(key, 0);

  checkSyncCompletion(plugin, 1, 0, "ctx");
  assert.deepEqual([...limiter.activeKeys].sort(), ["download_drawing.png", "uploading.bin"],
    "(g) busy upload/download keys are kept, the leaked key is swept");
  activeUploads.clear();
}

console.log("concurrency slot sweep tests passed");
