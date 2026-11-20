import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// #261, fast-note-sync-service#462/#476: every conflict entry must either open
// a resolver or give the user a visible, actionable recovery choice.
const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "src", "lib", "ui", "menu_manager.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

const notices = [];
const historyOpened = [];
const removed = [];
const conflictModals = [];
const remoteFetches = [];
let unifiedMeta = null;
let remoteBodyResult = null;
class Notice { constructor(message) { notices.push(message); } }
const module = { exports: {} };
vm.runInNewContext(code, {
  module,
  exports: module.exports,
  console,
  window: { setTimeout: () => 1, clearTimeout() {} },
  MutationObserver: class { observe() {} },
  require(id) {
    if (id === "obsidian") {
      return {
        Menu: class {}, MenuItem: class {}, Notice,
        Platform: { isMobile: false }, normalizePath: p => p,
        setIcon() {},
      };
    }
    if (id === "../sync/operator") return {};
    if (id === "../utils/types") return {};
    if (id === "../../views/note-history/history-modal") {
      return { NoteHistoryModal: class { constructor(_app, _plugin, path) { this.path = path; } open() { historyOpened.push(this.path); } } };
    }
    if (id === "../../views/recycle-bin-modal") return { RecycleBinModal: class {} };
    if (id === "../../views/share-modal") return { ShareModal: class {} };
    if (id === "../../views/about-modal") return { AboutModal: class {} };
    if (id === "../../views/confirm-modal") return { ConfirmModal: class {} };
    if (id === "../utils/helpers") {
      return {
        getPluginDir: () => ".obsidian/plugins/fast-note-sync",
        hashContent: p => `hash-${p}`,
        showSyncNotice: message => notices.push(message),
      };
    }
    if (id === "../../i18n/lang") return { $: key => key };
    if (id === "./status_bar_manager") return { StatusBarManager: class {} };
    if (id === "../sync/operator_note") {
      // Stage B: menu_manager reads backup paths/metadata from operator_note
      return {
        conflictBackupPaths: (_plugin, p) => ({
          dir: ".obsidian/plugins/fast-note-sync/conflict-notes",
          safeName: p.replace(/\.md$/, "").replace(/[/\\]/g, "_"),
          pathHash: `hash-${p}`,
          baseBackupPath: `.obsidian/plugins/fast-note-sync/conflict-notes/${p.replace(/\.md$/, "").replace(/[/\\]/g, "_")}_hash-${p}.base.md`,
          remoteBackupPath: `.obsidian/plugins/fast-note-sync/conflict-notes/${p.replace(/\.md$/, "").replace(/[/\\]/g, "_")}_hash-${p}.remote.md`,
          metaPath: `.obsidian/plugins/fast-note-sync/conflict-notes/${p.replace(/\.md$/, "").replace(/[/\\]/g, "_")}_hash-${p}.meta.json`,
          localBackupPath: `.obsidian/plugins/fast-note-sync/conflict-notes/${p.replace(/\.md$/, "").replace(/[/\\]/g, "_")}_hash-${p}.local-backup.md`,
        }),
        readConflictMeta: async () => null,
        CONFLICT_REASON_UNALIGNED: "unaligned_no_baseline",
      };
    }
    if (id === "../sync/sync_log_manager") {
      return { SyncLogManager: { getInstance: () => ({ getLogs: () => [] }) } };
    }
    if (id === "../sync/conflict_store") {
      return { readUnifiedConflictMeta: async () => unifiedMeta };
    }
    if (id === "../sync/conflict_resolve") {
      return {
        loadRemoteNoteBody: async (_plugin, p, meta) => {
          remoteFetches.push([p, meta]);
          return remoteBodyResult;
        },
      };
    }
    if (id === "../../views/conflict-resolve-modal") {
      return {
        ConflictResolveModal: class {
          constructor(_app, _plugin, _file, localContent, serverContent, baseContent, serverHash, baseMissing, options) {
            this.args = { localContent, serverContent, baseContent, serverHash, baseMissing, options };
          }
          open() { conflictModals.push(this.args); }
        },
      };
    }
    return {};
  },
}, { filename: sourcePath });

function fixture(paths, file) {
  const conflictedPaths = new Set(paths);
  const plugin = {
    syncState: { conflictedPaths },
    app: {
      vault: {
        getFileByPath: () => file,
        read: async () => "local",
        adapter: { exists: async () => false },
      },
    },
    localStorageManager: { setConflictedPaths: set => removed.push(Array.from(set)) },
    statusBarManager: { updateConflictBadge() { this.updated = true; } },
  };
  const manager = Object.create(module.exports.MenuManager.prototype);
  manager.plugin = plugin;
  return { manager, plugin };
}

{
  const { manager, plugin } = fixture(["Untitled.md", "other.md"], null);
  await manager.openConflictResolverForPath("Untitled.md");
  assert.deepEqual(historyOpened, ["Untitled.md"], "missing local notes open the existing history recovery UI");
  assert(notices.includes("ui.conflict.missing_local"), "missing local notes have a visible explanation");
  assert.equal(plugin.syncState.conflictedPaths.size, 2, "opening recovery does not silently discard the conflict");

  await manager.removeConflictedPath("Untitled.md");
  assert.deepEqual(Array.from(plugin.syncState.conflictedPaths), ["other.md"], "explicit removal leaves all remaining entries actionable");
  assert.deepEqual(removed, [["other.md"]], "explicit conflict removal is persisted");
  assert.equal(plugin.statusBarManager.updated, true, "removal refreshes the conflict badge");

  await manager.openConflictResolverForPath("other.md");
  assert.equal(notices.at(-1), "ui.conflict.missing_local", "another missing entry still responds after one was removed");
}

{
  const file = { path: "broken.md" };
  const { manager } = fixture(["broken.md"], file);
  manager.plugin.app.vault.read = async () => { throw new Error("read failed"); };
  await manager.openConflictResolverForPath("broken.md");
  assert.equal(conflictModals.length, 0);
  assert.equal(notices.at(-1), "ui.conflict.open_failed", "resolver failures are user-visible");
}

// B-02: an un-inlined (530) note body must be pulled on demand; if that fails the resolver is
// never opened with an empty remote pane.
{
  conflictModals.length = 0;
  remoteFetches.length = 0;
  remoteBodyResult = null;
  unifiedMeta = { kind: "note", hasServerContent: false, serverDeleted: false, serverHash: "h:remote", serverRevision: "rev-9" };
  const file = { path: "remote.md", stat: { ctime: 1, mtime: 2 } };
  const { manager } = fixture(["remote.md"], file);
  await manager.openConflictResolverForPath("remote.md");
  assert.equal(remoteFetches.length, 1, "the un-inlined note is fetched on demand");
  assert.equal(remoteFetches[0][1].serverHash, "h:remote", "the fetch verifies against the detection-time hash");
  assert.equal(conflictModals.length, 0, "no blank remote pane is opened");
  assert.equal(notices.at(-1), "ui.conflict.remote_unavailable", "the user is told to resync and retry");
  unifiedMeta = null;
}

// B-02: when the on-demand fetch succeeds, its body feeds the remote pane and the unified
// serverHash is carried into the modal.
{
  conflictModals.length = 0;
  remoteFetches.length = 0;
  remoteBodyResult = { body: "remote body", hash: "h:remote" };
  unifiedMeta = { kind: "note", hasServerContent: false, serverDeleted: false, serverHash: "h:remote", serverRevision: "rev-9" };
  const file = { path: "remote.md", stat: { ctime: 1, mtime: 2 } };
  const { manager } = fixture(["remote.md"], file);
  await manager.openConflictResolverForPath("remote.md");
  assert.equal(conflictModals.length, 1, "the resolver opens once the remote body is available");
  assert.equal(conflictModals[0].serverContent, "remote body", "the fetched body is shown, not an empty string");
  assert.equal(conflictModals[0].serverHash, "h:remote", "the unified serverHash is used when no log hash exists");
  assert.deepEqual(JSON.parse(JSON.stringify(conflictModals[0].options)), { kind: "note", path: "remote.md", serverRevision: "rev-9", serverDeleted: false });
  remoteBodyResult = null;
  unifiedMeta = null;
}

// B-02: a non-inlined virtual setting cannot be fetched item-wise; refuse instead of showing "".
{
  conflictModals.length = 0;
  remoteFetches.length = 0;
  remoteBodyResult = { body: "unused", hash: "h:cfg" };
  unifiedMeta = { kind: "setting", hasServerContent: false, serverDeleted: false, serverHash: "h:cfg", serverRevision: "rev-1" };
  const { manager } = fixture(["_localStorage/pdfjs.history"], null);
  await manager.openConflictResolverForPath("_localStorage/pdfjs.history");
  assert.equal(conflictModals.length, 0, "the diff editor is not opened for an unfetchable config");
  assert.equal(remoteFetches.length, 0, "settings are not routed through the note fetch");
  assert.equal(notices.at(-1), "ui.conflict.remote_unavailable", "the user gets the resync notice");
  remoteBodyResult = null;
  unifiedMeta = null;
}

console.log("Conflict entries: missing-file recovery/removal, visible errors and un-inlined remote bodies passed");
