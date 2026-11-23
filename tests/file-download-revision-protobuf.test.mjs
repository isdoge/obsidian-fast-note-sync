import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { proto } from "../src/pb/v1/sync.js";

// Same regression as file-download-revision.test.mjs, but driven end-to-end through the real
// Protobuf channel: FileSyncUpdate is decoded with FileSyncModifyMessage and the ready message
// with FileSyncDownloadMessage, then both mapped objects feed the download handlers. This matters
// because the generated decoder emits defaults ("" for a missing string) instead of undefined, so
// a "??"-style fallback would silently keep an empty token.
//
// 与 file-download-revision.test.mjs 同一回归，但走真实 Protobuf 通道：FileSyncUpdate 用
// FileSyncModifyMessage 解码、就绪消息用 FileSyncDownloadMessage 解码，再把映射后的对象交给
// 下载处理器。生成代码对缺省字符串字段给的是空串而不是 undefined，纯 "??" 回退会留下空令牌。
const root = path.resolve(import.meta.dirname, "..");
const noop = () => undefined;

function loadTsModule(relPath, requireStub, extraGlobals = {}) {
  const sourcePath = path.join(root, relPath);
  const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(transpiled, {
    require: requireStub,
    module,
    exports: module.exports,
    console,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
    Date,
    // Cross-realm globals: protobufjs compares options.longs === Number against its own realm's
    // Number, so the mapper must see the same intrinsic. Without this, toObject leaves Longs.
    // 跨 realm：protobufjs 用自身 realm 的 Number 比较 options.longs，必须传同一份内建对象，
    // 否则 toObject 会把 Long 原样留下。
    Number,
    String,
    Boolean,
    Object,
    Array,
    JSON,
    Math,
    Error,
    window: { setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop },
    ...extraGlobals,
  }, { filename: sourcePath });
  return module.exports;
}

const websocketAction = loadTsModule("src/lib/sync/websocket_action.ts", () => {
  throw new Error("websocket_action has no runtime imports");
});
const mapper = loadTsModule("src/pb/protobuf_mapper.ts", (id) => {
  if (id === "../lib/sync/websocket_action") return websocketAction;
  if (id === "./v1/sync") return { proto };
  throw new Error(`Unexpected mapper import: ${id}`);
});

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

const operatorFileSource =
  fs.readFileSync(path.join(root, "src/lib/sync/operator_file.ts"), "utf8") +
  "\nexport {handleFileChunkDownloadComplete as testComplete};\n";
const operatorFileTranspiled = ts.transpileModule(operatorFileSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  fileName: path.join(root, "src/lib/sync/operator_file.ts"),
}).outputText;
const operatorFileModule = { exports: {} };
vm.runInNewContext(operatorFileTranspiled, {
  module: operatorFileModule,
  exports: operatorFileModule.exports,
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
const ops = operatorFileModule.exports;

const PATH = "att/photo.png";

// Wraps inner proto bytes in the downlink WSResponse + WSMessage envelope and runs the real
// mapper over them, exactly like websocket_manager does for incoming packets.
function mapped(action, innerBytes) {
  const wsResponse = proto.v1.WSResponse.encode(proto.v1.WSResponse.create({
    code: 200, status: true, data: innerBytes,
  })).finish();
  const envelope = proto.v1.WSMessage.encode(proto.v1.WSMessage.create({
    type: action, data: wsResponse,
  })).finish();
  return mapper.deReceivePacket(envelope).data;
}

const pbUpdate = (overrides = {}) => mapped(websocketAction.FileSyncUpdate,
  proto.v1.FileSyncModifyMessage.encode(proto.v1.FileSyncModifyMessage.create({
    path: PATH,
    pathHash: "ph",
    contentHash: "hash-a",
    revision: "rev-pb",
    size: 1,
    ctime: 1,
    mtime: 1700000000000,
    lastTime: 1000,
    ...overrides,
  })).finish());

const pbReady = (overrides = {}) => mapped(websocketAction.FileSyncChunkDownload,
  proto.v1.FileSyncDownloadMessage.encode(proto.v1.FileSyncDownloadMessage.create({
    path: PATH,
    contentHash: "hash-a",
    ctime: 1,
    mtime: 1700000000000,
    sessionId: "session-1",
    chunkSize: 1024,
    totalChunks: 1,
    size: 1,
    ...overrides,
  })).finish());

function fixture() {
  const file = new TFile(PATH);
  const confirmed = [];
  const plain = [];
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
    recordSyncCompleted: noop,
    downloadedFilesCount: 0,
    fileSyncTasks: { failed: 0 },
    isSyncing: false,
    totalFilesToDownload: 0,
    totalChunksToDownload: 0,
  };
  return { plugin, confirmed, plain };
}

async function download(plugin, update, ready) {
  await ops.receiveFileSyncUpdate(update, plugin);
  await ops.receiveFileSyncChunkDownload(ready, plugin);
  const session = plugin.fileDownloadSessions.get(ready.sessionId);
  assert.ok(session, "ready message promotes the temp session");
  session.chunks = new Map([[0, Uint8Array.from([7]).buffer]]);
  delete session.tempDir;
  await ops.testComplete(session, plugin);
  return session;
}

// 0. Wire-level fact this fix depends on: a missing field 9 decodes as "" under defaults, while
//    a present one survives. (Guards against a future pb regeneration changing the default.)
//    缺省字段 9 在 defaults 下解成空串，显式下发则保留。
{
  const missing = proto.v1.FileSyncDownloadMessage.toObject(
    proto.v1.FileSyncDownloadMessage.decode(proto.v1.FileSyncDownloadMessage.encode(
      proto.v1.FileSyncDownloadMessage.create({ path: PATH }),
    ).finish()),
    { defaults: true, longs: Number },
  );
  assert.equal(missing.revision, "", "absent field decodes as an empty string under defaults");
  assert.equal(pbReady().revision, undefined, "mapper normalizes the absent token to undefined");
  assert.equal(pbReady({ revision: "rev-9" }).revision, "rev-9", "field 9 is readable through the mapper");
}

// 1. Protobuf path: FileSyncUpdate carries revision; ready message without field 9 keeps it and
//    the commit establishes a confirmed baseline.
{
  const f = fixture();
  const update = pbUpdate();
  assert.equal(update.revision, "rev-pb", "FileSyncUpdate mapping carries the revision");
  const session = await download(f.plugin, update, pbReady());
  assert.equal(session.revision, "rev-pb", "empty ready token falls back to the FileSyncUpdate token");
  assert.deepEqual(f.confirmed, [[PATH, "hash-a", "rev-pb", 1700000000000, 1]], "confirmed baseline carries the revision");
  assert.equal(f.plain.length, 0, "no plain-hash fallback on the Protobuf channel");
}

// 2. Protobuf path: a ready message that does carry field 9 wins.
{
  const f = fixture();
  const session = await download(f.plugin, pbUpdate(), pbReady({ revision: "rev-pb-ready" }));
  assert.equal(session.revision, "rev-pb-ready", "ready-message token overrides the earlier one");
  assert.deepEqual(f.confirmed, [[PATH, "hash-a", "rev-pb-ready", 1700000000000, 1]], "commit uses the ready token");
  assert.equal(f.plain.length, 0, "no plain-hash fallback");
}

// 3. Protobuf path, legacy server: neither message has a revision → unchanged plain-hash commit.
{
  const f = fixture();
  const session = await download(f.plugin, pbUpdate({ revision: "" }), pbReady());
  assert.equal(session.revision, "", "no token anywhere");
  assert.equal(f.confirmed.length, 0, "no confirmed baseline without a token");
  assert.deepEqual(f.plain, [[PATH, "hash-a", 1700000000000, 1]], "legacy plain hash is still recorded");
}

console.log("file download revision protobuf tests passed");
