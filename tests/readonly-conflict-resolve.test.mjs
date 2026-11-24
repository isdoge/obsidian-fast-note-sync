// Conflict-panel resolution must never change the remote in read-only mode. Uplink actions
// (SettingDelete / FileRePush / conditional submits / conditional deletes) are rejected as a
// whole BEFORE any local side effect, so the local copy and the conflict state can never end up
// half-resolved. Local-only actions (adopting a remote tombstone) stay allowed.
// Gate is fail-closed: round snapshot OR live setting.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const noop = () => undefined;

function load(relPath, extra = {}) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set, WeakMap, WeakSet, Date, Promise,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
    window: { setTimeout: () => 1, clearTimeout: noop },
    require: (id) => {
      if (id === "obsidian") return { normalizePath: (x) => x };
      if (id.includes("helpers")) return {
        dump: noop, dumpError: noop,
        hashContent: (x) => `p:${x}`, hashContentAsync: async () => "local-hash",
        hashFileAsync: async () => "file-hash",
      };
      if (id.includes("conflict_store")) return {
        CONFLICT_KIND_NOTE: "note", CONFLICT_KIND_SETTING: "setting", CONFLICT_KIND_FOLDER: "folder",
        readUnifiedConflictMeta: async () => ctx.meta,
        clearConflictState: (...args) => ctx.calls.push(["clearConflictState", args[1]]),
      };
      if (id.includes("operator_note")) return {
        conflictBackupPaths: () => ({ dir: "conflict-notes", baseBackupPath: "b", remoteBackupPath: "r", metaPath: "m", localBackupPath: "l" }),
        readConflictMeta: async () => ({ localHashAtDetection: null }),
        removeConflictBackups: async (...args) => ctx.calls.push(["removeConflictBackups", args[1]]),
        CONFLICT_REASON_UNALIGNED: "unaligned",
        noteDeleteByPath: async (...args) => ctx.calls.push(["noteDeleteByPath", args[0]]),
        noteModify: async (...args) => ctx.calls.push(["noteModify", args[0]?.path]),
      };
      if (id.includes("operator_file")) return {
        fileDeleteByPath: async (...args) => ctx.calls.push(["fileDeleteByPath", args[0]]),
        fileModify: async (...args) => ctx.calls.push(["fileModify", args[0]?.path]),
      };
      if (id.includes("operator_folder")) return {
        folderDeleteByPath: async (...args) => ctx.calls.push(["folderDeleteByPath", args[0]]),
        folderModify: async (...args) => ctx.calls.push(["folderModify", args[0]?.path]),
      };
      if (id.includes("operator_config")) return {
        configModify: async (...args) => ctx.calls.push(["configModify", args[0]]),
      };
      if (id in extra) return extra[id];
      return {};
    },
  }, { filename: sourcePath });
  return module.exports;
}

const ctx = { meta: null, calls: [] };
const ops = load("src/lib/sync/conflict_resolve.ts");

function makePlugin({ snapshot = false, live = false } = {}) {
  const sent = [];
  const calls = [];
  ctx.calls = calls; // module-level helper spies record into the current plugin's call log
  const plugin = {
    syncRoundReadonly: snapshot,
    settings: { readonlySyncEnabled: live, vault: "v" },
    app: {
      vault: {
        getFileByPath: () => ctx.file,
        getAbstractFileByPath: () => ctx.folder,
        read: async () => "local-content",
        modify: async (...args) => calls.push(["vault.modify", args[0]?.path]),
        create: async (...args) => calls.push(["vault.create", args[0]]),
        createFolder: async (...args) => calls.push(["vault.createFolder", args[0]]),
        adapter: {
          exists: async () => ctx.remoteBackupExists === true,
          read: async () => "remote-content",
          readBinary: async () => { calls.push(["adapter.readBinary"]); return new ArrayBuffer(4); },
          write: async (...args) => calls.push(["adapter.write", args[0]]),
          writeBinary: async (...args) => calls.push(["adapter.writeBinary", args[0]]),
          remove: async (...args) => calls.push(["adapter.remove", args[0]]),
          stat: async () => ({ mtime: 10, size: 4 }),
        },
        fileManager: { trashFile: async (...args) => calls.push(["trashFile", args[0]?.path]) },
      },
      fileManager: { trashFile: async (...args) => calls.push(["trashFile", args[0]?.path]) },
    },
    api: { getNoteContent: async () => null },
    fileHashManager: { removeFileHash: (...args) => calls.push(["fileHashManager.removeFileHash", args[0]]), setConfirmedBaseline: noop },
    configHashManager: { removeFileHash: noop, setConfirmedBaseline: noop, recordPendingDeleteBaseline: (...args) => calls.push(["recordPendingDeleteBaseline", args[0]]) },
    pendingConfigDeleteAcks: new Set(),
    lastSyncMtime: new Map(),
    websocket: { SendMessage: async (action, payload) => { sent.push({ action, payload }); } },
    localStorageManager: {
      syncPathPrefix: "__ls__/",
      getItemValue: () => ctx.localConfigValue,
      pathToKey: (p) => p.replace("__ls__/", ""),
      setConflictedPaths: noop,
      handleReceivedUpdate: async (...args) => calls.push(["handleReceivedUpdate", args[0]]),
    },
    syncState: { conflictedPaths: new Set() },
    statusBarManager: { updateConflictBadge: noop },
    menuManager: { removeConflictedPath: noop },
    lockManager: { withLock: async (_path, fn) => fn() },
    concurrencyLimiter: { waitForSlot: async () => true },
    folderSnapshotManager: { removeFolder: noop, setFolderMtime: noop, setConfirmedRevision: noop },
  };
  return { plugin, sent, calls };
}

function reset({ meta, file = null, folder = null, remoteBackupExists = false, localConfigValue = null } = {}) {
  ctx.meta = meta;
  ctx.file = file;
  ctx.folder = folder;
  ctx.remoteBackupExists = remoteBackupExists;
  ctx.localConfigValue = localConfigValue;
  ctx.calls.length = 0;
}

const settingMeta = (extra = {}) => ({ kind: "setting", serverHash: "remote-hash", serverRevision: "r1", localHashAtDetection: null, ...extra });
const fileMeta = (extra = {}) => ({ kind: "file", serverHash: "remote-hash", serverRevision: "r1", localHashAtDetection: null, ...extra });
const fileObj = { path: "img/a.png", stat: { mtime: 10, size: 4, ctime: 1 } };

// ── 1. Read-only (live) + snapshot writable: the three uplink entries send nothing ──
{
  // 1a. Setting local-deleted -> SettingDelete
  reset({ meta: settingMeta(), localConfigValue: null });
  let { plugin, sent, calls } = makePlugin({ snapshot: false, live: true });
  let result = await ops.resolveConflictEntry(plugin, "__ls__/app", "local");
  assert.equal(result.ok, false, "setting delete blocked");
  assert.equal(result.reason, "readonly");
  assert.deepEqual(sent, [], "no SettingDelete sent");
  assert.equal(plugin.pendingConfigDeleteAcks.has("__ls__/app"), false, "no pending delete ack");
  assert.equal(calls.some(c => c[0] === "recordPendingDeleteBaseline"), false, "no pending delete baseline");
  assert.equal(calls.some(c => c[0] === "clearConflictState"), false, "conflict state untouched");

  // 1b. File missing local -> FileRePush
  reset({ meta: fileMeta(), file: null });
  ({ plugin, sent, calls } = makePlugin({ snapshot: false, live: true }));
  result = await ops.resolveConflictEntry(plugin, "img/a.png", "remote");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "readonly");
  assert.deepEqual(sent, [], "no FileRePush sent (missing local)");
  assert.equal(calls.some(c => c[0] === "clearConflictState"), false, "conflict state untouched");

  // 1c. File exists, adopt remote -> FileRePush after deleting local
  reset({ meta: fileMeta(), file: fileObj });
  ({ plugin, sent, calls } = makePlugin({ snapshot: false, live: true }));
  result = await ops.resolveConflictEntry(plugin, "img/a.png", "remote");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "readonly");
  assert.deepEqual(sent, [], "no FileRePush sent (existing local)");
  assert.equal(calls.some(c => c[0] === "trashFile"), false, "local file not deleted");
  assert.equal(calls.some(c => c[0] === "adapter.writeBinary" || c[0] === "adapter.readBinary"), false, "no local backup written");
  assert.equal(calls.some(c => c[0] === "clearConflictState"), false, "conflict state untouched");
}

// ── 2. Snapshot read-only + live writable: still blocked (fail-closed) ─────────
{
  reset({ meta: settingMeta(), localConfigValue: null });
  let { plugin, sent } = makePlugin({ snapshot: true, live: false });
  let result = await ops.resolveConflictEntry(plugin, "__ls__/app", "local");
  assert.equal(result.reason, "readonly", "setting delete blocked by the round snapshot");
  assert.deepEqual(sent, []);

  reset({ meta: fileMeta(), file: null });
  ({ plugin, sent } = makePlugin({ snapshot: true, live: false }));
  result = await ops.resolveConflictEntry(plugin, "img/a.png", "remote");
  assert.equal(result.reason, "readonly", "re-push blocked by the round snapshot");
  assert.deepEqual(sent, []);

  reset({ meta: fileMeta(), file: fileObj });
  ({ plugin, sent } = makePlugin({ snapshot: true, live: false }));
  result = await ops.resolveConflictEntry(plugin, "img/a.png", "remote");
  assert.equal(result.reason, "readonly", "existing-local re-push blocked by the round snapshot");
  assert.deepEqual(sent, []);
}

// ── 3. Writable: behavior unchanged ───────────────────────────────────────────
{
  // 3a. Setting local-deleted -> SettingDelete
  reset({ meta: settingMeta(), localConfigValue: null });
  let { plugin, sent, calls } = makePlugin({ snapshot: false, live: false });
  let result = await ops.resolveConflictEntry(plugin, "__ls__/app", "local");
  assert.equal(result.ok, true);
  assert.deepEqual(sent.map(s => s.action), ["SettingDelete"]);
  assert.equal(plugin.pendingConfigDeleteAcks.has("__ls__/app"), true);
  assert.equal(calls.some(c => c[0] === "clearConflictState"), true);

  // 3b. File missing local -> FileRePush
  reset({ meta: fileMeta(), file: null });
  ({ plugin, sent, calls } = makePlugin({}));
  result = await ops.resolveConflictEntry(plugin, "img/a.png", "remote");
  assert.equal(result.ok, true);
  assert.deepEqual(sent.map(s => s.action), ["FileRePush"]);

  // 3c. File exists, adopt remote -> delete local then FileRePush
  reset({ meta: fileMeta(), file: fileObj });
  ({ plugin, sent, calls } = makePlugin({}));
  result = await ops.resolveConflictEntry(plugin, "img/a.png", "remote");
  assert.equal(result.ok, true);
  assert.deepEqual(sent.map(s => s.action), ["FileRePush"]);
  assert.equal(calls.some(c => c[0] === "trashFile"), true, "local file deleted as before");
  assert.equal(calls.some(c => c[0] === "adapter.writeBinary"), true, "local backup kept as before");
}

// ── 4. Local-only actions stay allowed in read-only mode ──────────────────────
{
  // 4a. Setting: remote is a tombstone and the local copy is gone -> only clear state
  reset({ meta: settingMeta({ serverDeleted: true }), localConfigValue: null });
  let { plugin, sent, calls } = makePlugin({ snapshot: true, live: true });
  let result = await ops.resolveConflictEntry(plugin, "__ls__/app", "remote");
  assert.equal(result.ok, true, "adopting a remote tombstone does not touch the remote");
  assert.deepEqual(sent, []);
  assert.equal(calls.some(c => c[0] === "clearConflictState"), true);

  // 4b. File: remote is a tombstone -> delete the local copy, no re-push
  reset({ meta: fileMeta({ serverDeleted: true }), file: fileObj });
  ({ plugin, sent, calls } = makePlugin({ snapshot: true, live: true }));
  result = await ops.resolveConflictEntry(plugin, "img/a.png", "remote");
  assert.equal(result.ok, true, "adopting a remote file tombstone is local-only");
  assert.deepEqual(sent, []);
  assert.equal(calls.some(c => c[0] === "trashFile"), true, "local tombstone mirror still deletes locally");

  // 4c. Note: adopt remote body -> local write only, no upload
  reset({ meta: { kind: "note", serverHash: "remote-hash", serverRevision: "r1", localHashAtDetection: "local-hash" }, file: { path: "n.md", stat: { mtime: 10, size: 5, ctime: 1 } }, remoteBackupExists: true });
  ({ plugin, sent, calls } = makePlugin({ snapshot: true, live: true }));
  result = await ops.resolveConflictEntry(plugin, "n.md", "remote");
  assert.equal(result.ok, true, "adopting the remote note body is local-only");
  assert.deepEqual(sent, []);
  assert.equal(calls.some(c => c[0] === "vault.modify"), true, "remote body written locally");

  // 4d. Folder: adopt remote (local folder missing) -> create locally, no upload
  reset({ meta: { kind: "folder", serverHash: "", serverRevision: "r1", localHashAtDetection: null }, folder: null });
  ({ plugin, sent, calls } = makePlugin({ snapshot: true, live: true }));
  result = await ops.resolveConflictEntry(plugin, "folder-a", "remote");
  assert.equal(result.ok, true, "adopting the remote folder is local-only");
  assert.deepEqual(sent, []);
  assert.equal(calls.some(c => c[0] === "vault.createFolder"), true);
}

// ── 5. Uplink actions other than the three SendMessage sites are blocked too ──
{
  // Note "keep local" -> conditional NoteModify
  reset({ meta: { kind: "note", serverHash: "remote-hash", serverRevision: "r1", localHashAtDetection: "local-hash" }, file: { path: "n.md", stat: { mtime: 10, size: 5, ctime: 1 } } });
  let { plugin, sent, calls } = makePlugin({ snapshot: true, live: true });
  let result = await ops.resolveConflictEntry(plugin, "n.md", "local");
  assert.equal(result.reason, "readonly");
  assert.equal(calls.some(c => c[0] === "noteModify"), false, "no note upload");
  assert.equal(calls.some(c => c[0] === "clearConflictState"), false, "conflict state untouched");

  // Folder "keep local" -> conditional folderModify
  reset({ meta: { kind: "folder", serverHash: "", serverRevision: "r1", localHashAtDetection: null }, folder: { path: "folder-a" } });
  ({ plugin, sent, calls } = makePlugin({ snapshot: true, live: true }));
  result = await ops.resolveConflictEntry(plugin, "folder-a", "local");
  assert.equal(result.reason, "readonly");
  assert.equal(calls.some(c => c[0] === "folderModify"), false, "no folder upload");
  assert.equal(calls.some(c => c[0] === "clearConflictState"), false, "conflict state untouched");

  // "Keep both" note -> remote copy + upload: blocked before the copy
  reset({ meta: { kind: "note", serverHash: "remote-hash", serverRevision: "r1", localHashAtDetection: "local-hash" }, file: { path: "n.md", stat: { mtime: 10, size: 5, ctime: 1 } }, remoteBackupExists: true });
  ({ plugin, sent, calls } = makePlugin({ snapshot: true, live: true }));
  result = await ops.resolveConflictEntry(plugin, "n.md", "both");
  assert.equal(result.reason, "readonly");
  assert.equal(calls.some(c => c[0] === "vault.create"), false, "no local remote-copy created");
  assert.equal(calls.some(c => c[0] === "noteModify"), false, "no note upload");
}

// ── 6. Batch alignment: uplink modes blocked, local-only remote mode allowed ──
{
  const align = load("src/lib/sync/conflict_align.ts", { "./conflict_resolve": { readonlyResolutionBlocked: ops.readonlyResolutionBlocked } });
  const makeAlignPlugin = (snapshot, live) => ({
    syncRoundReadonly: snapshot,
    settings: { readonlySyncEnabled: live, vault: "v" },
    app: { vault: { getFileByPath: () => ({ path: "n.md", stat: { mtime: 1, size: 1 } }), read: async () => "local", modify: async () => undefined, adapter: { exists: async () => true, read: async () => "remote", write: async () => undefined, mkdir: async () => undefined } } },
    lockManager: { withLock: async (_p, fn) => fn() },
    fileHashManager: { setFileHash: noop },
    lastSyncMtime: new Map(),
    websocket: { SendMessage: async (action) => { alignSent.push(action); } },
    syncState: { conflictedPaths: new Set(["n.md"]) },
    localStorageManager: { setConflictedPaths: noop },
    statusBarManager: { updateConflictBadge: noop },
  });
  const alignSent = [];
  const blocked = await align.alignConflictEntries(makeAlignPlugin(true, true), ["n.md"], "local");
  assert.equal(blocked[0].reason, "readonly", "batch keep-local is an uplink");
  assert.deepEqual(alignSent, []);
  const blockedBoth = await align.alignConflictEntries(makeAlignPlugin(false, true), ["n.md"], "both");
  assert.equal(blockedBoth[0].reason, "readonly", "batch keep-both is an uplink (live read-only)");
  const allowed = await align.alignConflictEntries(makeAlignPlugin(true, true), ["n.md"], "remote");
  assert.equal(allowed[0]?.ok, true, "batch adopt-remote is local-only and stays allowed");
}

console.log("read-only conflict resolution tests passed");