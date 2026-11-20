import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// B-02: resolving a merged text setting must persist the merged content before submitting.
// - `_localStorage/` virtual configs have no disk file: the merge must be written back into
//   localStorage through LocalStorageManager.handleReceivedUpdate, otherwise the following
//   receiveConfigModifyAck sees the pre-merge value, treats it as a mid-upload edit and
//   schedules a loop resend;
// - disk configs still go through the adapter, and their localStorage stays untouched.
const root = path.resolve(import.meta.dirname, "..");
const noop = () => undefined;

function loadModule(relPath, requireStub, globals = {}) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    require: requireStub, module, exports: module.exports, console, Map, Set, Date, Promise, Array,
    TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, JSON,
    window: { setTimeout: () => 1, clearTimeout() {}, localStorage: { getItem: () => null, setItem() {} } },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: noop,
    ...globals,
  });
  return module.exports;
}

const helpers = new Proxy({
  hashContent: (s) => `h:${s}`,
  hashContentAsync: async (s) => `h:${s}`,
  hashFileAsync: async () => "f",
  hashArrayBuffer: async () => "arr",
  computeMirrorDigest: (s) => `digest:${s.length}`,
  dump: noop, dumpError: noop,
  LocalStateFileMirror: class { constructor() {} async read() { return null; } scheduleWrite() {} },
}, { get: (t, k) => t[k] ?? noop });

const { LocalStorageManager } = loadModule("src/lib/storage/local_storage_manager.ts", (id) => {
  if (id === "../utils/helpers") return helpers;
  if (id === "../sync/operator_config") return { configModify: async () => undefined };
  if (id === "../../main") return {};
  throw new Error(`Unexpected require in local_storage_manager: ${id}`);
});

const configModifyCalls = [];
const cleanupCalls = [];
const { ConflictResolveModal } = loadModule("src/views/conflict-resolve-modal.ts", (id) => {
  if (id === "obsidian") {
    return {
      App: class {}, Modal: class { constructor(app) { this.app = app; } close() {} },
      setIcon() {}, TFile: class {}, Platform: { isMobile: false },
      Notice: class { constructor(message) { this.message = message; } }, normalizePath: (p) => p,
    };
  }
  if (id === "../i18n/lang") return { $: (key) => key };
  if (id === "../lib/utils/helpers") return helpers;
  if (id === "../lib/sync/operator_note") {
    return { removeConflictBackups: async (_plugin, p) => { cleanupCalls.push(p); } };
  }
  if (id === "../lib/sync/operator_config") {
    return { configModify: async (...args) => { configModifyCalls.push(args); } };
  }
  if (id === "../main") return {};
  throw new Error(`Unexpected require in conflict-resolve-modal: ${id}`);
});

function makePlugin() {
  const storage = new Map();
  const adapterWrites = [];
  const removed = [];
  const plugin = {
    settings: {},
    app: {
      vault: { getName: () => "v", adapter: { write: async (p, c) => { adapterWrites.push([p, c]); } } },
      loadLocalStorage: (key) => (storage.has(key) ? storage.get(key) : null),
      saveLocalStorage: (key, value) => {
        if (value === null) storage.delete(key); else storage.set(key, value);
      },
    },
    lockManager: { withLock: async (_k, fn) => fn() },
    menuManager: { removeConflictedPath: (p) => removed.push(p) },
  };
  plugin.localStorageManager = new LocalStorageManager(plugin);
  return { plugin, storage, adapterWrites, removed };
}

const fileFor = (p) => ({ path: p, stat: { ctime: 1, mtime: 2 } });

// Virtual setting: the merged content is written back into localStorage through the
// received-update path, then submitted with the same content and the detection-time revision.
{
  configModifyCalls.length = 0;
  cleanupCalls.length = 0;
  const { plugin, storage, adapterWrites, removed } = makePlugin();
  const targetPath = "_localStorage/pdfjs.history";
  const modal = new ConflictResolveModal(plugin.app, plugin, fileFor(targetPath), "local", "remote", "base", "h:remote", true, {
    kind: "setting", path: targetPath, serverRevision: "rev-7",
  });

  await modal.applySettingResolution("merged content");

  assert.equal(storage.get("pdfjs.history"), "merged content", "the virtual config key holds the merged content");
  assert.equal(plugin.localStorageManager.getItemValue("pdfjs.history"), "merged content");
  assert.equal(plugin.localStorageManager.lastHashes.get("pdfjs.history"), "h:merged content",
    "the received-update hash is recorded so the ack does not see a mid-upload edit");
  assert.equal(adapterWrites.length, 0, "virtual configs never touch the disk adapter");
  const virtualCall = configModifyCalls[0];
  assert.equal(virtualCall[0], targetPath);
  assert.equal(virtualCall[2], false);
  assert.equal(virtualCall[3], "merged content", "the submission carries the merged content");
  assert.equal(virtualCall[4], true, "conflict resolution forces the upload past hash interception");
  assert.deepEqual(JSON.parse(JSON.stringify(virtualCall[5])), { isConflictResolved: true, baseRevision: "rev-7" }, "the confirmed revision is submitted");
  assert.deepEqual(removed, [targetPath], "the conflict marker is cleared");
  assert.deepEqual(cleanupCalls, [targetPath], "the conflict backups are cleaned after the submit");
}

// Disk setting: the merged content is written to the adapter and no virtual key is touched.
{
  configModifyCalls.length = 0;
  cleanupCalls.length = 0;
  const { plugin, storage, adapterWrites } = makePlugin();
  const targetPath = ".obsidian/app.json";
  const modal = new ConflictResolveModal(plugin.app, plugin, fileFor(targetPath), "local", "remote", "base", "h:remote", true, {
    kind: "setting", path: targetPath, serverRevision: "rev-3",
  });

  await modal.applySettingResolution("merged disk content");

  assert.deepEqual(adapterWrites, [[targetPath, "merged disk content"]], "disk configs are written to their file");
  assert.equal(storage.size, 0, "disk configs do not write virtual localStorage keys");
  const diskCall = configModifyCalls[0];
  assert.equal(diskCall[0], targetPath);
  assert.equal(diskCall[3], undefined, "disk submissions let configModify read the file (no content override)");
  assert.equal(diskCall[4], true);
  assert.deepEqual(JSON.parse(JSON.stringify(diskCall[5])), { isConflictResolved: true, baseRevision: "rev-3" });
}

console.log("PASS: virtual merged settings persist to localStorage (no loop resend); disk settings still write files");
