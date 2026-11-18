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
    if (id === "../sync/sync_log_manager") {
      return { SyncLogManager: { getInstance: () => ({ getLogs: () => [] }) } };
    }
    if (id === "../../views/conflict-resolve-modal") {
      return { ConflictResolveModal: class { open() { conflictModals.push("open"); } } };
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

console.log("Conflict entries: missing-file recovery/removal and visible errors passed");
