import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 阶段 C：协议字段、JSON/PB 编解码与连接级能力协商的定向测试。
// Stage C: directed tests for protocol fields, JSON/PB codecs and connection-level negotiation.

const root = path.resolve(import.meta.dirname, "..");
const noop = () => undefined;

// ---------------------------------------------------------------------------
// 1. PB 编解码：新增字段必须逐字段往返一致，空文本哈希 "0" 原样保留
//    PB codec: every new field must round-trip, and the empty-text hash "0" must survive.
// ---------------------------------------------------------------------------
const { proto } = await import(path.join(root, "src", "pb", "v1", "sync.js"));

function pbRoundTrip(messageType, value) {
  const bytes = messageType.encode(messageType.create(value)).finish();
  return messageType.toObject(messageType.decode(bytes), { defaults: true, longs: Number });
}

function assertFields(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `${label}: ${key}`);
  }
}

// 请求侧字段 / request-side fields
{
  const clientInfo = pbRoundTrip(proto.v1.ClientInfoMessage, { name: "peer", syncBaselineVersion: 1 });
  assertFields(clientInfo, { name: "peer", syncBaselineVersion: 1 }, "ClientInfoMessage");

  const checkVersion = pbRoundTrip(proto.v1.CheckVersionInfo, { syncBaselineVersion: 1 });
  assertFields(checkVersion, { syncBaselineVersion: 1 }, "CheckVersionInfo");

  const noteSync = pbRoundTrip(proto.v1.NoteSyncRequest, {
    context: "ctx", vault: "V", lastTime: 1, totalBatches: 1,
    notes: [{ path: "a.md", pathHash: "ph", contentHash: "0", mtime: 1, ctime: 2, baseHash: "0", baseHashMissing: false, baseRevision: "rev-a" }],
    delNotes: [{ path: "b.md", pathHash: "ph2", baseHash: "bh", baseHashMissing: false, baseRevision: "rev-b" }],
    missingNotes: [{ path: "c.md", pathHash: "ph3", baseHashMissing: true, baseRevision: "rev-c" }],
  });
  assert.equal(noteSync.notes[0].baseHash, "0", "empty-text hash must survive PB encoding");
  assert.equal(noteSync.notes[0].baseRevision, "rev-a");
  assert.equal(noteSync.delNotes[0].baseHash, "bh");
  assert.equal(noteSync.missingNotes[0].baseHashMissing, true);
  assert.equal(noteSync.missingNotes[0].baseRevision, "rev-c");

  const noteModify = pbRoundTrip(proto.v1.NoteModifyOrCreateRequest, {
    vault: "V", path: "a.md", pathHash: "ph", baseHash: "0", baseHashMissing: false,
    content: "", contentHash: "0", ctime: 1, mtime: 2, isConflictResolved: true, baseRevision: "rev-1",
  });
  assertFields(noteModify, { baseHash: "0", contentHash: "0", baseRevision: "rev-1", isConflictResolved: true }, "NoteModifyOrCreateRequest");

  const noteCheck = pbRoundTrip(proto.v1.NoteUpdateCheckRequest, {
    vault: "V", path: "a.md", pathHash: "ph", contentHash: "ch", ctime: 1, mtime: 2,
    baseHash: "bh", baseHashMissing: true, baseRevision: "rev-k",
  });
  assertFields(noteCheck, { baseHash: "bh", baseHashMissing: true, baseRevision: "rev-k" }, "NoteUpdateCheckRequest");

  const noteDelete = pbRoundTrip(proto.v1.NoteDeleteRequest, {
    vault: "V", path: "a.md", pathHash: "ph", context: "ctx", baseHash: "0", baseRevision: "rev-d",
  });
  assertFields(noteDelete, { baseHash: "0", baseRevision: "rev-d" }, "NoteDeleteRequest");

  const fileSync = pbRoundTrip(proto.v1.FileSyncRequest, {
    context: "ctx", vault: "V", lastTime: 1, totalBatches: 1,
    files: [{ path: "a.png", pathHash: "ph", contentHash: "ch", size: 9, mtime: 1, ctime: 2, baseHash: "0", baseHashMissing: false, baseRevision: "rev-f" }],
    delFiles: [{ path: "b.png", pathHash: "ph2", baseHashMissing: true, baseRevision: "rev-g" }],
  });
  assert.equal(fileSync.files[0].baseHash, "0");
  assert.equal(fileSync.files[0].baseRevision, "rev-f");
  assert.equal(fileSync.delFiles[0].baseRevision, "rev-g");

  const fileUpload = pbRoundTrip(proto.v1.FileUploadCheckRequest, {
    vault: "V", path: "a.png", pathHash: "ph", contentHash: "ch", size: 9, ctime: 1, mtime: 2,
    context: "ctx", baseHash: "0", baseHashMissing: false, baseRevision: "rev-u", isConflictResolved: true,
  });
  assertFields(fileUpload, { baseHash: "0", baseRevision: "rev-u", isConflictResolved: true }, "FileUploadCheckRequest");

  const fileDelete = pbRoundTrip(proto.v1.FileDeleteRequest, {
    vault: "V", path: "a.png", pathHash: "ph", context: "ctx", baseHash: "bh", baseHashMissing: false, baseRevision: "rev-x",
  });
  assertFields(fileDelete, { baseHash: "bh", baseRevision: "rev-x" }, "FileDeleteRequest");

  const settingSync = pbRoundTrip(proto.v1.SettingSyncRequest, {
    context: "ctx", vault: "V", lastTime: 1, cover: true, totalBatches: 1,
    settings: [{ path: "cfg", pathHash: "ph", contentHash: "ch", mtime: 1, ctime: 2, baseHash: "0", baseHashMissing: false, baseRevision: "rev-s" }],
    delSettings: [{ path: "d", pathHash: "ph2", baseHashMissing: true, baseRevision: "rev-t" }],
  });
  assert.equal(settingSync.cover, true, "cover now exists on the PB side too");
  assert.equal(settingSync.settings[0].baseHash, "0");
  assert.equal(settingSync.settings[0].ctime, 2, "ctime agrees across encodings");
  assert.equal(settingSync.delSettings[0].baseRevision, "rev-t");

  const settingModify = pbRoundTrip(proto.v1.SettingModifyOrCreateRequest, {
    vault: "V", path: "cfg", pathHash: "ph", content: "{}", contentHash: "ch", ctime: 1, mtime: 2,
    context: "ctx", baseHash: "0", baseHashMissing: false, baseRevision: "rev-m", isConflictResolved: true,
  });
  assertFields(settingModify, { baseHash: "0", baseRevision: "rev-m", isConflictResolved: true }, "SettingModifyOrCreateRequest");

  const settingCheck = pbRoundTrip(proto.v1.SettingUpdateCheckRequest, {
    vault: "V", path: "cfg", pathHash: "ph", contentHash: "ch", ctime: 1, mtime: 2,
    baseHash: "bh", baseHashMissing: false, baseRevision: "rev-n",
  });
  assertFields(settingCheck, { baseHash: "bh", baseRevision: "rev-n" }, "SettingUpdateCheckRequest");

  const settingDelete = pbRoundTrip(proto.v1.SettingDeleteRequest, {
    vault: "V", path: "cfg", pathHash: "ph", context: "ctx", baseHash: "0", baseRevision: "rev-o",
  });
  assertFields(settingDelete, { baseHash: "0", baseRevision: "rev-o" }, "SettingDeleteRequest");

  const folderSync = pbRoundTrip(proto.v1.FolderSyncRequest, {
    context: "ctx", vault: "V", lastTime: 1, totalBatches: 1,
    folders: [{ path: "F", pathHash: "ph", mtime: 1, baseRevision: "rev-a" }],
    delFolders: [{ path: "G", pathHash: "ph2", baseRevision: "rev-b" }],
  });
  assert.equal(folderSync.folders[0].baseRevision, "rev-a");
  assert.equal(folderSync.delFolders[0].baseRevision, "rev-b");

  const folderCreate = pbRoundTrip(proto.v1.FolderCreateRequest, {
    vault: "V", path: "F", pathHash: "ph", context: "ctx", baseRevision: "rev-c", isConflictResolved: true,
  });
  assertFields(folderCreate, { baseRevision: "rev-c", isConflictResolved: true }, "FolderCreateRequest");

  const folderDelete = pbRoundTrip(proto.v1.FolderDeleteRequest, {
    vault: "V", path: "F", pathHash: "ph", context: "ctx", baseRevision: "rev-d",
  });
  assertFields(folderDelete, { baseRevision: "rev-d" }, "FolderDeleteRequest");
}

// 下行字段 / downstream fields
{
  const noteModify = pbRoundTrip(proto.v1.NoteSyncModifyMessage, { path: "a.md", content: "", contentHash: "0", revision: "rev-1" });
  assertFields(noteModify, { contentHash: "0", revision: "rev-1" }, "NoteSyncModifyMessage");

  const noteDelete = pbRoundTrip(proto.v1.NoteSyncDeleteMessage, { path: "a.md", revision: "rev-2", contentHash: "ch" });
  assertFields(noteDelete, { revision: "rev-2", contentHash: "ch" }, "NoteSyncDeleteMessage");

  const noteMtime = pbRoundTrip(proto.v1.NoteSyncMtimeMessage, { path: "a.md", contentHash: "0", revision: "rev-3" });
  assertFields(noteMtime, { contentHash: "0", revision: "rev-3" }, "NoteSyncMtimeMessage");

  const noteEnd = pbRoundTrip(proto.v1.NoteSyncEndMessage, { lastTime: 1, needConflictCount: 6 });
  assert.equal(noteEnd.needConflictCount, 6);

  const noteNeedPush = pbRoundTrip(proto.v1.NoteSyncNeedPushMessage, { path: "a.md", baseMissing: true });
  assert.equal(noteNeedPush.baseMissing, true);

  const noteModifyAck = pbRoundTrip(proto.v1.NoteModifyAckMessage, { path: "a.md", contentHash: "0", revision: "rev-4" });
  assertFields(noteModifyAck, { contentHash: "0", revision: "rev-4" }, "NoteModifyAckMessage");

  const noteDeleteAck = pbRoundTrip(proto.v1.NoteDeleteAckMessage, { path: "a.md", revision: "rev-5" });
  assert.equal(noteDeleteAck.revision, "rev-5");

  const fileModify = pbRoundTrip(proto.v1.FileSyncModifyMessage, { path: "a.png", contentHash: "ch", revision: "rev-f1" });
  assert.equal(fileModify.revision, "rev-f1");
  const fileDelete = pbRoundTrip(proto.v1.FileSyncDeleteMessage, { path: "a.png", revision: "rev-f2", contentHash: "ch" });
  assertFields(fileDelete, { revision: "rev-f2", contentHash: "ch" }, "FileSyncDeleteMessage");
  const fileMtime = pbRoundTrip(proto.v1.FileSyncMtimeMessage, { path: "a.png", contentHash: "0", revision: "rev-f3" });
  assertFields(fileMtime, { contentHash: "0", revision: "rev-f3" }, "FileSyncMtimeMessage");
  assert.equal(pbRoundTrip(proto.v1.FileSyncEndMessage, { needConflictCount: 7 }).needConflictCount, 7);
  assertFields(pbRoundTrip(proto.v1.FileUploadAckMessage, { contentHash: "ch", revision: "rev-f4" }), { contentHash: "ch", revision: "rev-f4" }, "FileUploadAckMessage");
  assert.equal(pbRoundTrip(proto.v1.FileDeleteAckMessage, { revision: "rev-f5" }).revision, "rev-f5");

  const settingModify = pbRoundTrip(proto.v1.SettingSyncModifyMessage, { path: "cfg", contentHash: "0", revision: "rev-s1" });
  assertFields(settingModify, { contentHash: "0", revision: "rev-s1" }, "SettingSyncModifyMessage");
  const settingDelete = pbRoundTrip(proto.v1.SettingSyncDeleteMessage, { path: "cfg", revision: "rev-s2", contentHash: "ch" });
  assertFields(settingDelete, { revision: "rev-s2", contentHash: "ch" }, "SettingSyncDeleteMessage");
  const settingMtime = pbRoundTrip(proto.v1.SettingSyncMtimeMessage, { path: "cfg", contentHash: "0", revision: "rev-s3" });
  assertFields(settingMtime, { contentHash: "0", revision: "rev-s3" }, "SettingSyncMtimeMessage");
  assert.equal(pbRoundTrip(proto.v1.SettingSyncEndMessage, { needConflictCount: 8 }).needConflictCount, 8);
  assertFields(pbRoundTrip(proto.v1.SettingModifyAckMessage, { contentHash: "ch", revision: "rev-s4" }), { contentHash: "ch", revision: "rev-s4" }, "SettingModifyAckMessage");
  assert.equal(pbRoundTrip(proto.v1.SettingDeleteAckMessage, { revision: "rev-s5" }).revision, "rev-s5");

  const folderModify = pbRoundTrip(proto.v1.FolderSyncModifyMessage, { path: "F", revision: "rev-o1" });
  assert.equal(folderModify.revision, "rev-o1");
  const folderDelete = pbRoundTrip(proto.v1.FolderSyncDeleteMessage, { path: "F", revision: "rev-o2" });
  assert.equal(folderDelete.revision, "rev-o2");
  assert.equal(pbRoundTrip(proto.v1.FolderSyncEndMessage, { needConflictCount: 9 }).needConflictCount, 9);
  assert.equal(pbRoundTrip(proto.v1.FolderModifyAckMessage, { revision: "rev-o3" }).revision, "rev-o3");
  assert.equal(pbRoundTrip(proto.v1.FolderDeleteAckMessage, { revision: "rev-o4" }).revision, "rev-o4");
}

// 统一冲突消息 / unified conflict message
{
  const decoded = pbRoundTrip(proto.v1.SyncConflictMessage, {
    kind: "note", path: "a.md", pathHash: "ph", reason: "both_modified",
    serverHash: "sh", serverRevision: "srv-rev", serverDeleted: true,
    baseHash: "0", baseContent: "", baseMissing: false, serverContent: "# new",
  });
  assertFields(decoded, {
    kind: "note", path: "a.md", pathHash: "ph", reason: "both_modified",
    serverHash: "sh", serverRevision: "srv-rev", serverDeleted: true,
    baseHash: "0", baseContent: "", baseMissing: false, serverContent: "# new",
  }, "SyncConflictMessage");
}

// 未知字段兼容：追加一个未来字段的 tag，已知字段仍应正确解码
// Unknown-field compatibility: append a future tag; known fields must still decode.
{
  const inner = proto.v1.ClientInfoMessage.encode(
    proto.v1.ClientInfoMessage.create({ name: "peer", syncBaselineVersion: 1 }),
  ).finish();
  const unknown = new Uint8Array([...inner, 0xc0, 0x7d, 0x01]); // field 2000, varint 1
  const decoded = proto.v1.ClientInfoMessage.toObject(proto.v1.ClientInfoMessage.decode(unknown), {
    defaults: true, longs: Number,
  });
  assert.equal(decoded.name, "peer");
  assert.equal(decoded.syncBaselineVersion, 1);
}

// ---------------------------------------------------------------------------
// 2. JSON 与 PB 语义等价（经 protobuf_mapper）+ 冲突载荷归一
//    JSON/PB semantic equivalence through protobuf_mapper + conflict payload normalization.
// ---------------------------------------------------------------------------
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
    setTimeout,
    clearTimeout,
    window: { setTimeout, clearTimeout },
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

// enSendDTOToProtobuf → deReceivePacket 往返：下行动作必须逐字段一致
// Round-trip through the real mapper: downstream actions must preserve every field.
function mapperRoundTrip(action, payload) {
  // enSendDTOToProtobuf builds an uplink WSMessage. To exercise the client's decode path we
  // wrap the same payload bytes in the WSResponse envelope the server sends.
  // enSendDTOToProtobuf 生成上行 WSMessage；这里把同一载荷包进服务端下行用的 WSResponse 信封，
  // 以覆盖客户端解码路径。
  const wsMessage = proto.v1.WSMessage.decode(mapper.enSendDTOToProtobuf(action, payload));
  assert.equal(wsMessage.type, action);
  const wsResponse = proto.v1.WSResponse.encode(proto.v1.WSResponse.create({
    code: 200, status: true, data: wsMessage.data,
  })).finish();
  const envelope = proto.v1.WSMessage.encode(proto.v1.WSMessage.create({
    type: action, data: wsResponse,
  })).finish();
  return mapper.deReceivePacket(envelope).data;
}

{
  const conflict = mapperRoundTrip(websocketAction.SyncConflict, {
    kind: "note", path: "a.md", pathHash: "ph", reason: "both_modified",
    serverHash: "sh", serverRevision: "srv-rev", serverDeleted: false,
    baseHash: "0", baseContent: "", baseMissing: false, serverContent: "# new",
  });
  assert.equal(conflict.kind, "note");
  assert.equal(conflict.baseHash, "0", "empty-text base hash survives the mapper");
  assert.equal(conflict.baseMissing, false);
  assert.equal(conflict.serverContent, "# new");
  assert.equal(conflict.serverRevision, "srv-rev");

  const conflictMissing = mapperRoundTrip(websocketAction.SyncConflict, {
    kind: "file", path: "a.png", pathHash: "ph2", reason: "remote_deleted",
    serverHash: "", serverRevision: "", serverDeleted: true,
    baseHash: "", baseContent: "", baseMissing: true, serverContent: "",
  });
  assert.equal(conflictMissing.baseMissing, true);
  assert.equal(conflictMissing.baseHash, "");
  assert.equal(conflictMissing.serverDeleted, true);

  // 矛盾输入：baseHash 非空但 baseMissing=true → 以 missing 为准
  // Contradictory input: non-empty baseHash with baseMissing=true → missing wins
  const contradictory = mapper.normalizeConflictPayload({ baseHash: "abc", baseMissing: true });
  assert.equal(contradictory.baseHash, "");
  assert.equal(contradictory.baseMissing, true);

  const noteEnd = mapperRoundTrip(websocketAction.NoteSyncEnd, {
    lastTime: 10, needUploadCount: 1, needModifyCount: 2, needSyncMtimeCount: 3, needDeleteCount: 4, needConflictCount: 5,
  });
  assert.equal(noteEnd.needConflictCount, 5);

  const noteMtime = mapperRoundTrip(websocketAction.NoteSyncMtime, { path: "a.md", contentHash: "0", revision: "rev-3", lastTime: 1 });
  assert.equal(noteMtime.contentHash, "0");
  assert.equal(noteMtime.revision, "rev-3");

  const modifyAck = mapperRoundTrip(websocketAction.NoteModifyAck, { path: "a.md", contentHash: "0", revision: "rev-4", lastTime: 1 });
  assert.equal(modifyAck.contentHash, "0");
  assert.equal(modifyAck.revision, "rev-4");

  const noteDelete = mapperRoundTrip(websocketAction.NoteSyncDelete, { path: "a.md", revision: "rev-2", contentHash: "ch", lastTime: 1 });
  assert.equal(noteDelete.revision, "rev-2");
  assert.equal(noteDelete.contentHash, "ch");

  const folderEnd = mapperRoundTrip(websocketAction.FolderSyncEnd, { lastTime: 1, needModifyCount: 2, needDeleteCount: 3, needConflictCount: 4 });
  assert.equal(folderEnd.needConflictCount, 4);
}

// 全部新增下行字段经真实 mapper 的 PB 往返 / every new downstream field through the real mapper
{
  const cases = [
    [websocketAction.NoteSyncModify, { path: "a.md", content: "", contentHash: "0", revision: "rev-n1" }, { contentHash: "0", revision: "rev-n1" }],
    [websocketAction.NoteSyncDelete, { path: "a.md", revision: "rev-n2", contentHash: "ch" }, { revision: "rev-n2", contentHash: "ch" }],
    [websocketAction.NoteSyncMtime, { path: "a.md", contentHash: "0", revision: "rev-n3" }, { contentHash: "0", revision: "rev-n3" }],
    [websocketAction.NoteSyncEnd, { lastTime: 1, needConflictCount: 6 }, { needConflictCount: 6 }],
    [websocketAction.NoteSyncNeedPush, { path: "a.md", baseMissing: true }, { baseMissing: true }],
    [websocketAction.NoteModifyAck, { path: "a.md", contentHash: "0", revision: "rev-n4" }, { contentHash: "0", revision: "rev-n4" }],
    [websocketAction.NoteDeleteAck, { path: "a.md", revision: "rev-n5" }, { revision: "rev-n5" }],
    [websocketAction.FileSyncUpdate, { path: "a.png", contentHash: "ch", revision: "rev-f1" }, { contentHash: "ch", revision: "rev-f1" }],
    [websocketAction.FileSyncDelete, { path: "a.png", revision: "rev-f2", contentHash: "ch" }, { revision: "rev-f2", contentHash: "ch" }],
    [websocketAction.FileSyncMtime, { path: "a.png", contentHash: "0", revision: "rev-f3" }, { contentHash: "0", revision: "rev-f3" }],
    [websocketAction.FileSyncEnd, { lastTime: 1, needConflictCount: 7 }, { needConflictCount: 7 }],
    [websocketAction.FileUploadAck, { path: "a.png", contentHash: "ch", revision: "rev-f4" }, { contentHash: "ch", revision: "rev-f4" }],
    [websocketAction.FileDeleteAck, { path: "a.png", revision: "rev-f5" }, { revision: "rev-f5" }],
    [websocketAction.SettingSyncModify, { path: "cfg", content: "{}", contentHash: "0", revision: "rev-s1" }, { contentHash: "0", revision: "rev-s1" }],
    [websocketAction.SettingSyncDelete, { path: "cfg", revision: "rev-s2", contentHash: "ch" }, { revision: "rev-s2", contentHash: "ch" }],
    [websocketAction.SettingSyncMtime, { path: "cfg", contentHash: "0", revision: "rev-s3" }, { contentHash: "0", revision: "rev-s3" }],
    [websocketAction.SettingSyncEnd, { lastTime: 1, needConflictCount: 8 }, { needConflictCount: 8 }],
    [websocketAction.SettingModifyAck, { path: "cfg", contentHash: "ch", revision: "rev-s4" }, { contentHash: "ch", revision: "rev-s4" }],
    [websocketAction.SettingDeleteAck, { path: "cfg", revision: "rev-s5" }, { revision: "rev-s5" }],
    [websocketAction.FolderSyncModify, { path: "F", revision: "rev-o1" }, { revision: "rev-o1" }],
    [websocketAction.FolderSyncDelete, { path: "F", revision: "rev-o2" }, { revision: "rev-o2" }],
    [websocketAction.FolderSyncEnd, { lastTime: 1, needConflictCount: 9 }, { needConflictCount: 9 }],
    [websocketAction.FolderModifyAck, { path: "F", revision: "rev-o3" }, { revision: "rev-o3" }],
    [websocketAction.FolderDeleteAck, { path: "F", revision: "rev-o4" }, { revision: "rev-o4" }],
  ];
  for (const [action, payload, expected] of cases) {
    assertFields(mapperRoundTrip(action, payload), expected, `mapper ${action}`);
  }
}

// JSON 与 PB 对同一内容给出同一冲突语义 / JSON and PB agree on the same conflict semantics
{
  const jsonPayload = mapper.normalizeConflictPayload(JSON.parse(JSON.stringify({
    kind: "setting", path: "cfg", pathHash: "ph", reason: "no_baseline",
    serverHash: "sh", serverRevision: "r", serverDeleted: false,
    baseHash: "", baseContent: "", baseMissing: true, serverContent: "{}",
  })));
  const pbPayload = mapperRoundTrip(websocketAction.SyncConflict, {
    kind: "setting", path: "cfg", pathHash: "ph", reason: "no_baseline",
    serverHash: "sh", serverRevision: "r", serverDeleted: false,
    baseHash: "", baseContent: "", baseMissing: true, serverContent: "{}",
  });
  assert.deepEqual(pbPayload, jsonPayload);
}

// ---------------------------------------------------------------------------
// 3. 能力协商状态机（真实 SyncState + 真实 websocket_manager）
//    Negotiation state machine (real SyncState + real websocket_manager).
// ---------------------------------------------------------------------------
const syncStateModule = loadTsModule("src/lib/sync/sync_state.ts", () => {
  throw new Error("sync_state only has type imports");
});

const longTimers = [];
function fakeSetTimeout(callback, delay, ...args) {
  if (delay >= 1000) {
    const id = longTimers.length + 1;
    longTimers.push({ id, callback, args });
    return id;
  }
  return setTimeout(callback, delay, ...args);
}
function fakeClearTimeout(id) {
  const index = longTimers.findIndex((timer) => timer.id === id);
  if (index >= 0) longTimers.splice(index, 1);
  clearTimeout(id);
}
function flushLongTimers() {
  const pending = longTimers.splice(0);
  for (const timer of pending) timer.callback(...timer.args);
}

class MockWebSocketClient {
  constructor(plugin, options) {
    this.plugin = plugin;
    this.options = options;
    this.isOpen = true;
    this.isAuth = false;
    this.useProtobuf = false;
    this.count = 0;
    this.sent = [];
    this.reconnects = 0;
  }
  get ws() { return {}; }
  registerBinaryHandler() {}
  Send(action, data, after) { this.sent.push({ action, data }); after?.(); }
  SendMessage(action, data, before, after) {
    if (before && !before()) return;
    this.sent.push({ action, data });
    after?.();
  }
  register() {}
  triggerReconnect() { this.reconnects++; }
  unRegister() {}
  addStatusListener() {}
  removeStatusListener() {}
  addActivityListener() {}
  notifyActivity() {}
  notifyStatusChange() {}
}

let startupRuns = 0;
const managerModule = (() => {
  const sourcePath = path.join(root, "src", "lib", "sync", "websocket_manager.ts");
  const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(transpiled, {
    require: (id) => {
      switch (id) {
        case "obsidian":
          return {
            moment: Object.assign(() => ({ format: () => "" }), { locale: () => "en" }),
            Platform: { isDesktop: true, isMobile: false },
            normalizePath: (value) => value,
          };
        case "../utils/helpers":
          return new Proxy({ addRandomParam: (v) => v, showSyncNotice: noop, safeStringify: (v) => JSON.stringify(v) }, {
            get: (target, name) => target[name] ?? noop,
          });
        case "../../pb/protobuf_mapper":
          return { enSendDTOToProtobuf: () => new Uint8Array(), deReceivePacket: () => ({ action: "NoteSyncEnd", code: 200 }) };
        case "./sync_log_manager":
          return { SyncLogManager: { getInstance: () => ({ addLog: noop, logReceivedMessage: noop, logSentMessage: noop }) } };
        case "./websocket_client": return { WebSocketClient: MockWebSocketClient };
        case "../utils/types": return { CLIENT_TYPE: "ObsidianPlugin" };
        case "../../i18n/lang": return { $: (key) => key };
        case "./operator_file": return new Proxy({ BINARY_PREFIX_FILE_SYNC: "fs" }, { get: (t, n) => t[n] ?? noop });
        case "./operator_note": return { clearEmptyNoteProbes: noop };
        case "./operator": return {
          receiveOperators: new Map(),
          startupSync: () => { startupRuns++; },
          startupFullSync: () => { startupRuns++; },
          settleAllBatchSendSessionsOnClose: noop,
          settleSyncTimes: noop,
        };
        case "./websocket_action": return websocketAction;
        case "./websocket_client.ts": return { WebSocketClient: MockWebSocketClient };
        default:
          throw new Error(`Unexpected manager import: ${id}`);
      }
    },
    module,
    exports: module.exports,
    console,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    setTimeout,
    clearTimeout,
    window: { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout },
  }, { filename: sourcePath });
  return module.exports;
})();


function makeFixture() {
  const syncState = new syncStateModule.SyncState();
  const plugin = {
    settings: { protobufEnabled: true, apiToken: "token", offlineSyncStrategy: "", startupDelay: 0, manualSyncEnabled: false, vault: "V" },
    manifest: { version: "2.6.3" },
    runWsApi: "wss://example.test",
    getClientName: () => "test-client",
    syncState,
    localStorageManager: { getMetadata: () => undefined, setMetadata: noop },
    shareIndicatorManager: { updateSharedPaths: noop },
    versionManager: { updateFromClientInfo: noop },
    concurrencyLimiter: { clear: noop, releaseSlot: noop },
    retryQueue: { onAuthenticated: async () => {}, onDisconnected: noop },
    fileHashManager: { isReady: () => true },
    fileSyncTasks: { completed: 0 },
    isSyncing: false,
    isSyncRequesting: false,
    isSyncBaselineModeEnabled() { return syncState.isSyncBaselineModeEnabled(); },
  };
  startupRuns = 0;
  longTimers.length = 0;
  const manager = new managerModule.WebSocketManager(plugin);
  return { plugin, manager, client: manager.client, syncState };
}

function authenticate(client, data) {
  client.isAuth = false;
  client.options.onMessage(client, "Authorization", { code: 200, data: { paths: [], ...data } });
}

function clientInfoReply(client, data) {
  client.options.onMessage(client, "ClientInfo", { code: 200, data });
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

// 3.1 老服务端：鉴权广告缺省 0 → 立即放行，进入兼容模式
// Legacy server: absent advertisement (0) → gate opens immediately, compatibility mode.
{
  const { manager, client, syncState } = makeFixture();
  authenticate(client);
  assert.equal(syncState.serverAdvertisedBaselineVersion, 0);
  await settle();
  assert.equal(startupRuns, 1, "legacy server must not block startup");
  assert.equal(client.sent.find((m) => m.action === "ClientInfo").data.syncBaselineVersion, 1,
    "ClientInfo always requests version 1");
  clientInfoReply(client, {});
  assert.equal(syncState.clientInfoConfirmed, true);
  assert.equal(syncState.negotiatedSyncBaselineVersion, 0);
  assert.equal(manager.plugin.isSyncBaselineModeEnabled(), false);
}

// 3.2 新服务端广告 1：确认前闸门阻塞，ClientInfo 应答 1 后才开始同步
// New server advertises 1: blocked until the ClientInfo reply confirms 1.
{
  const { manager, client, syncState } = makeFixture();
  authenticate(client, { syncBaselineVersion: 1 });
  await settle();
  assert.equal(startupRuns, 0, "startup must wait for the ClientInfo confirmation");
  assert.equal(syncState.isSyncBaselineGateOpen(), false);
  assert.equal(syncState.negotiatedSyncBaselineVersion, 0);

  clientInfoReply(client, { syncBaselineVersion: 1 });
  await settle();
  assert.equal(startupRuns, 1);
  assert.equal(syncState.negotiatedSyncBaselineVersion, 1);
  assert.equal(manager.plugin.isSyncBaselineModeEnabled(), true);
}

// 3.3 广告 1 但应答缺省 0：进入兼容模式，不阻塞
// Advertised 1 but the reply omits the field: compatibility mode, still starts.
{
  const { client, syncState } = makeFixture();
  authenticate(client, { syncBaselineVersion: 1 });
  await settle();
  assert.equal(startupRuns, 0);
  clientInfoReply(client, {});
  await settle();
  assert.equal(startupRuns, 1);
  assert.equal(syncState.negotiatedSyncBaselineVersion, 0);
  assert.equal(syncState.clientInfoConfirmed, true);
}

// 3.4 确认超时：绝不静默启用新模式，而是重连
// Confirmation timeout: never silently enables the new mode; reconnects instead.
{
  const { client, syncState } = makeFixture();
  authenticate(client, { syncBaselineVersion: 1 });
  await settle();
  assert.equal(client.reconnects, 0);
  flushLongTimers();
  await settle();
  assert.equal(client.reconnects, 1, "timeout must reconnect instead of enabling the mode");
  assert.equal(startupRuns, 0, "no sync may start without confirmation");
  assert.equal(syncState.negotiatedSyncBaselineVersion, 0);
  assert.equal(syncState.isSyncBaselineModeEnabled(), false);
}

// 3.5 PB 降级重发 ClientInfo：携带同一版本，不重置已确认的模式
// PB downgrade re-send: same requested version, never resets the confirmed mode.
{
  const { client, syncState } = makeFixture();
  authenticate(client, { syncBaselineVersion: 1 });
  clientInfoReply(client, { syncBaselineVersion: 1 });
  await settle();
  const before = client.sent.filter((m) => m.action === "ClientInfo").length;
  client.options.onMessage(client, "NoteSync", {
    code: 305, details: "Protobuf decode failed: bad wire data",
  });
  const infos = client.sent.filter((m) => m.action === "ClientInfo");
  assert.equal(infos.length, before + 1, "downgrade re-sends ClientInfo");
  assert.equal(infos.at(-1).data.syncBaselineVersion, 1, "re-send carries the same requested version");
  assert.equal(syncState.negotiatedSyncBaselineVersion, 1, "re-send must not reset the mode");
}

// 3.6 后台广播不翻转已确认模式 / A background broadcast never flips the confirmed mode
{
  const { client, syncState } = makeFixture();
  authenticate(client, { syncBaselineVersion: 1 });
  clientInfoReply(client, { syncBaselineVersion: 1 });
  await settle();
  clientInfoReply(client, { syncBaselineVersion: 0, versionIsNew: true });
  assert.equal(syncState.negotiatedSyncBaselineVersion, 1, "broadcast must not downgrade");
  clientInfoReply(client, { syncBaselineVersion: 1, pluginVersionIsNew: true });
  assert.equal(syncState.negotiatedSyncBaselineVersion, 1);
}

// 3.7 断线清零：下一条连接重新协商
// Disconnect resets: the next connection negotiates from scratch.
{
  const { client, syncState } = makeFixture();
  authenticate(client, { syncBaselineVersion: 1 });
  clientInfoReply(client, { syncBaselineVersion: 1 });
  await settle();
  assert.equal(syncState.negotiatedSyncBaselineVersion, 1);
  client.options.onClose(client, 1006, "reset");
  assert.equal(syncState.negotiatedSyncBaselineVersion, 0);
  assert.equal(syncState.clientInfoConfirmed, false);
  assert.equal(syncState.serverAdvertisedBaselineVersion, 0);
  assert.equal(syncState.isSyncBaselineGateOpen(), true, "an unnegotiated connection has no gate");
}

// 3.8 闸门取消（断线）时，等待中的启动不得继续
// A pending start must not continue when the wait is cancelled by a disconnect.
{
  const { client, syncState } = makeFixture();
  authenticate(client, { syncBaselineVersion: 1 });
  await settle();
  assert.equal(startupRuns, 0);
  client.options.onClose(client, 1006, "closed");
  await settle();
  assert.equal(startupRuns, 0, "a closed connection must not start a sync");
  assert.equal(syncState.isSyncBaselineModeEnabled(), false);
}

console.log("sync baseline stage C: PB/JSON codec, conflict payload, and negotiation gate passed");
