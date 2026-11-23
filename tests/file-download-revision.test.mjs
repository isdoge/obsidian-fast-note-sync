import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Download baseline token regression: FileSyncUpdate creates the temp download session with the
// server revision, but the "download ready" message (FileSyncChunkDownload) may not carry one.
// Rebuilding the session used to overwrite revision with undefined, so the commit fell back to
// setFileHash() and never established a confirmed baseline — later renames/edits of that
// attachment could not present a revision and the server rejected them as conflicts.
//
// 下载基线令牌回归：FileSyncUpdate 建临时会话时带上了服务端 revision，但“下载就绪”消息
// （FileSyncChunkDownload）可能不带。重建会话曾把 revision 覆盖成 undefined，落盘时退化为
// setFileHash()，建不起已确认基线；之后对该附件的改名/修改带不出令牌，被服务端判冲突。
const root = path.resolve(import.meta.dirname, "..");

const source =
  fs.readFileSync(path.join(root, "src/lib/sync/operator_file.ts"), "utf8") +
  "\nexport {handleFileChunkDownloadComplete as testComplete};\n";
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const noop = () => undefined;
class TFile {
  constructor(p) {
    this.path = p;
    this.stat = { size: 1, ctime: 1, mtime: 1700000000000 };
    this.bytes = [0];
  }
}

const helpers = {
  dump: noop,
  dumpError: noop,
  isLargeBinarySyncRisk: () => false,
  isPathExcluded: () => false,
  checkAndNotifyCaseConflict: () => false,
  hashArrayBuffer: async (b) => String(new Uint8Array(b)[0]),
  getPluginDir: () => ".plugin",
  logMemorySnapshot: noop,
  normalizeServerTimestamp: (t) => (t === undefined ? undefined : t > 0 && t < 1e11 ? t * 1000 : t),
  hashContent: (s) => `h${s.length}`,
  hashFileAsync: async () => "0",
  sleep: async () => undefined,
};

const moduleObj = { exports: {} };
vm.runInNewContext(transpiled, {
  module: moduleObj,
  exports: moduleObj.exports,
  console,
  Uint8Array,
  ArrayBuffer,
  Map,
  Set,
  Date,
  window: { setTimeout: () => 1, clearTimeout: noop },
  require: (id) => {
    if (id === "obsidian") return { TFile, normalizePath: (p) => p, Platform: { isMobile: true } };
    if (id === "../utils/helpers") return helpers;
    if (id.includes("sync_log_manager")) return { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } };
    if (id.includes("remote_path_guard")) return { blockAliasedRemoteMutation: () => false };
    if (id.includes("remote_delete_guard")) return { firstKeepWithoutBaseline: () => false };
    if (id.includes("sync_state")) return { advanceLiveSyncTime: noop };
    if (id.includes("baseline_scope")) {
      return { buildBaselineFields: () => ({}), buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}) };
    }
    return {};
  },
});
const ops = moduleObj.exports;

const PATH = "att/photo.png";

function fixture() {
  const file = new TFile(PATH);
  const confirmed = [];
  const plain = [];
  const completed = [];
  const plugin = {
    settings: { syncEnabled: true, cloudPreviewEnabled: false, vault: "v" },
    app: {
      vault: {
        getFileByPath: (p) => (p === PATH ? file : null),
        getFolderByPath: () => ({}),
        createFolder: async () => undefined,
        modifyBinary: async (f, bytes, options) => {
          Object.assign(f.stat, options, { size: bytes.byteLength });
        },
        createBinary: async () => undefined,
      },
    },
    lockManager: { withLock: async (_path, fn) => fn() },
    pendingFileDeleteAcks: new Set(),
    pendingUploadHashes: new Map(),
    pendingDeleteFilePaths: new Set(),
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot: noop },
    websocket: { SendMessage: async () => undefined },
    fileDownloadSessions: new Map(),
    lastSyncMtime: new Map(),
    fileHashManager: {
      getPathHash: () => null,
      setConfirmedBaseline: (...args) => confirmed.push(args),
      setFileHash: (...args) => plain.push(args),
    },
    localStorageManager: { getMetadata: () => 0, setMetadata: noop },
    addIgnoredFile: noop,
    removeIgnoredFile: noop,
    recordSyncCompleted: (...args) => completed.push(args),
    downloadedFilesCount: 0,
    fileSyncTasks: { failed: 0 },
    isSyncing: false,
    totalFilesToDownload: 0,
    totalChunksToDownload: 0,
  };
  return { file, plugin, confirmed, plain, completed };
}

const updateMessage = (overrides = {}) => ({
  path: PATH,
  pathHash: "ph",
  contentHash: "hash-a",
  revision: "rev-fsu",
  size: 1,
  mtime: 1700000000000,
  ctime: 1,
  lastTime: 1000,
  pageIndex: 1,
  ...overrides,
});

const readyMessage = (overrides = {}) => ({
  path: PATH,
  contentHash: "hash-a",
  ctime: 1,
  mtime: 1700000000000,
  sessionId: "session-1",
  chunkSize: 1024,
  totalChunks: 1,
  size: 1,
  ...overrides,
});

async function download(plugin, update, ready) {
  await ops.receiveFileSyncUpdate(update, plugin);
  assert.ok(plugin.fileDownloadSessions.has(`temp_${PATH}`), "FileSyncUpdate creates the temp session");
  await ops.receiveFileSyncChunkDownload(ready, plugin);
  const session = plugin.fileDownloadSessions.get(ready.sessionId);
  assert.ok(session, "ready message promotes the temp session");
  session.chunks = new Map([[0, Uint8Array.from([7]).buffer]]);
  delete session.tempDir;
  await ops.testComplete(session, plugin);
  return session;
}

// 1. Ready message without revision: keep the token captured from FileSyncUpdate and bind a
//    confirmed baseline at commit.
{
  const f = fixture();
  const session = await download(f.plugin, updateMessage(), readyMessage());
  assert.equal(session.revision, "rev-fsu", "ready message without revision keeps the FileSyncUpdate token");
  assert.deepEqual(f.confirmed, [[PATH, "hash-a", "rev-fsu", 1700000000000, 1]], "commit binds the confirmed baseline with that revision");
  assert.equal(f.plain.length, 0, "commit must not degrade to a plain hash when a revision is known");
  assert.deepEqual(f.completed, [["file", 1]], "download page is booked complete");
  assert.equal(f.plugin.fileSyncTasks.failed, 0, "download is not a failure");
}

// 2. Ready message with revision: it wins over the FileSyncUpdate token.
{
  const f = fixture();
  const session = await download(f.plugin, updateMessage(), readyMessage({ revision: "rev-ready" }));
  assert.equal(session.revision, "rev-ready", "ready-message revision overrides the earlier token");
  assert.deepEqual(f.confirmed, [[PATH, "hash-a", "rev-ready", 1700000000000, 1]], "commit uses the newer ready-message revision");
  assert.equal(f.plain.length, 0, "no plain-hash fallback");
}

// 3. Neither message carries a revision (legacy server): unchanged fallback to setFileHash.
{
  const f = fixture();
  const session = await download(f.plugin, updateMessage({ revision: undefined }), readyMessage());
  assert.equal(session.revision, undefined, "no revision from either message");
  assert.equal(f.confirmed.length, 0, "no confirmed baseline without a token");
  assert.deepEqual(f.plain, [[PATH, "hash-a", 1700000000000, 1]], "legacy behavior: plain hash is still recorded");
}

console.log("file download revision tests passed");
