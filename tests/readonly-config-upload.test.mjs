import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// #275: a read-only device must not answer the server's config upload request (SettingSyncNeedUpload).
const code = ts.transpileModule(fs.readFileSync("src/lib/sync/operator_config.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports, console, TextDecoder,
  window: { setTimeout: () => 1, clearTimeout() {} },
  require: id => id === "obsidian" ? { normalizePath: p => p }
    : id.includes("config_codec") ? {
        encodeConfigContent: buf => new TextDecoder().decode(buf),
        decodeConfigContent: s => ({ kind: "text", text: s }),
      }
    : id.includes("helpers") ? new Proxy({ isPathInConfigSyncDirs: () => true, configIsPathExcluded: () => false,
        hashFileAsync: async () => "h", hashContent: () => "p", getSafeCtime: s => s.ctime }, { get: (t, k) => t[k] ?? (() => undefined) })
    : id.includes("sync_log_manager") ? { SyncLogManager: { getInstance: () => ({ addLog() {} }) } }
    : id.includes("i18n") ? { $: k => k } : id.includes("baseline_scope") ? { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) } : id.includes("conflict_store") ? { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" } : {} });
const { receiveConfigUpload } = module.exports;

for (const readonly of [false, true]) {
  const sent = [], completed = [];
  const plugin = {
    settings: { configSyncEnabled: true, readonlySyncEnabled: readonly, vault: "v" },
    localStorageManager: { syncPathPrefix: "__ls__/", savePending() {} },
    app: { vault: { adapter: { exists: async () => true, stat: async () => ({ mtime: 5, ctime: 1, size: 2 }), readBinary: async () => new TextEncoder().encode("{}").buffer } } },
    addIgnoredConfigFile() {}, removeIgnoredConfigFile() {},
    pendingConfigModifies: new Map(), syncState: { pendingConfigPushPageIndex: new Map() },
    concurrencyLimiter: { waitForSlot: async () => true },
    websocket: { SendMessage: async action => sent.push(action) },
    configSyncTasks: { failed: 0 }, recordSyncCompleted: (...a) => completed.push(a),
  };
  await receiveConfigUpload({ path: ".obsidian/app.json", pageIndex: 4 }, plugin);
  assert.deepEqual(sent, readonly ? [] : ["SettingModify"], `readonly=${readonly}`);
  assert.deepEqual(completed, readonly ? [["setting", 4]] : [], `readonly=${readonly} page accounting`);
  assert.equal(plugin.pendingConfigModifies.size, readonly ? 0 : 1);
}
console.log("read-only config upload request tests passed");
