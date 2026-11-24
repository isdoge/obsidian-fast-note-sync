import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Startup reporting and reset coverage for conflict state:
// 1. startup diagnostics must see the restored conflicted-path set (the incident recorded 0 while
//    the badge said 2315);
// 2. every "reset sync state" entry point must also clear the conflict records, and a baseline
//    scope change (target switch) must do the same.
const root = path.resolve(import.meta.dirname, "..");
const read = (relPath) => fs.readFileSync(path.join(root, relPath), "utf8");

// ─── 1. Ordering inside main.ts ────────────────────────────────────────────────
{
    const main = read("src/main.ts");
    const readback = main.indexOf("this.syncState.conflictedPaths = this.localStorageManager.getConflictedPaths()");
    const record = main.indexOf("recordStartupState(this)");
    const prune = main.indexOf("await pruneInvalidConflictRecords(this)");
    assert.ok(readback > 0, "startup restores conflicted paths");
    assert.ok(record > 0, "startup records diagnostics");
    assert.ok(prune > 0, "startup prunes invalid records");
    assert.ok(readback < record, "conflicted paths are read back before the startup state is recorded");
    assert.ok(record < prune, "pruning happens after the startup snapshot (it never hides the raw readback)");
}

// ─── 2. recordStartupState reports the actual set ─────────────────────────────
function load(relPath, extra = {}) {
    const sourcePath = path.join(root, relPath);
    const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        fileName: sourcePath,
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, {
        module, exports: module.exports, console,
        Map, Set, WeakSet, ArrayBuffer, Uint8Array, Error, JSON, Object, String, Number, Date, BigInt,
        window: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
        navigator: { clipboard: { writeText: async () => {} } },
        require(id) {
            if (id === "obsidian") return { Platform: { isMobile: false, isIosApp: false, isMacOS: true, isWin: false, isLinux: false } };
            if (id === "../helpers_obsidian_bypass") return { dump: () => {} };
            if (id in extra) return extra[id];
            throw new Error(`Unexpected require: ${id}`);
        },
    }, { filename: sourcePath });
    return module.exports;
}

{
    const redact = load("src/lib/utils/redact_log.ts");
    const diag = load("src/lib/utils/sync_diagnostics.ts", { "./redact_log": redact });
    const plugin = {
        manifest: { version: "2.6.11" },
        app: { vault: { adapter: {} }, version: "1.8.0" },
        localStorageManager: { getMetadata: () => 0 },
        fileHashManager: { getDiagnosticCounts: () => ({ hashEntries: 2315, baselineEntries: 2315, confirmedBaselines: 0 }) },
        settings: { syncEnabled: true },
        syncState: { conflictedPaths: new Set(["a.md", "b.md", "c.md"]) },
        retryQueue: { entries: [] },
    };
    diag.recordStartupState(plugin);
    const text = diag.buildSyncDiagnosticsText(plugin);
    assert.ok(text.includes('"conflictedPaths":3'), "startup diagnostics carries the restored count, not 0");
    assert.ok(text.includes('"confirmedBaselines":0'), "startup diagnostics still exposes the unconfirmed state");
}

// ─── 3. Reset entry points clear conflict records ─────────────────────────────
function assertClearThenReset(source, label) {
    const re = /clearSyncTime\(\);?[\s\S]{0,400}?resetConflictRecords\(/;
    assert.ok(re.test(source), `${label} clears conflict records after resetting sync times`);
}

assertClearThenReset(read("src/lib/sync/operator.ts"), "resetSettingSyncTime");
assertClearThenReset(read("src/main.ts"), "SSO/config import");
assertClearThenReset(read("src/views/settings-view.tsx"), "apply remote config");

{
    const settings = read("src/setting.tsx");
    const resetCalls = settings.match(/await resetConflictRecords\(this\.plugin\)/g) ?? [];
    assert.ok(resetCalls.length >= 2, "both API/token change handlers clear conflict records");
    const pairs = settings.match(/clearSyncTime\(\)[\s\S]{0,400}?await resetConflictRecords\(this\.plugin\)/g) ?? [];
    assert.equal(pairs.length, resetCalls.length, "every sync-time reset in the settings tab clears conflict records");
}

// Baseline scope changes (target switch) in all three storage managers.
for (const file of [
    "src/lib/storage/file_hash_manager.ts",
    "src/lib/storage/config_hash_manager.ts",
    "src/lib/storage/folder_snapshot_manager.ts",
]) {
    const source = read(file);
    const calls = source.match(/resetConflictRecords\(/g) ?? [];
    assert.ok(source.includes("ensureBaselineScope"), `${file} still checks the baseline scope`);
    assert.ok(calls.length >= 2, `${file} resets conflict records on both live and startup scope changes`);
}
{
    // A vault switch drops the whole conflict-notes folder and the in-memory set.
    const vaultName = read("src/lib/settings/vault_name.ts");
    assert.ok(vaultName.includes("state?.conflictedPaths?.clear()"), "vault switch clears the in-memory conflict set");
    assert.ok(vaultName.includes("clearVaultConflictBackups"), "vault switch removes the conflict-notes folder");
    const main = read("src/main.ts");
    assert.ok(main.includes("async clearVaultConflictBackups"), "the folder removal exists");
}

console.log("PASS: startup diagnostics see conflict state and every reset path clears it");
