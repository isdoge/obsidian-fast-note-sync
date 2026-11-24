import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// A leftover conflicted path with no `conflict-notes/*.meta.json` cannot show its kind or reason
// and cannot be resolved (the real incident: plugin-dir state was cleared but the localStorage
// `fns-conflicted-paths` set survived, leaving 2315 "unknown reason" entries). Startup/list-open
// pruning must drop only such records, persist the set and leave every backup body on disk.
// A sync-state reset must also clear the set and the metadata files.
const root = path.resolve(import.meta.dirname, "..");

function loadModule(relPath, requireStub) {
    const sourcePath = path.join(root, relPath);
    const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
        fileName: sourcePath,
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, {
        module, exports: module.exports, require: requireStub, console,
        window: { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} },
        setTimeout, clearTimeout, queueMicrotask, Promise, Map, Set, JSON, Date,
    }, { filename: sourcePath });
    return module.exports;
}

const noop = () => undefined;
const diag = [];

// Mirror conflictBackupPaths() closely enough for these records.
function conflictBackupPaths(_plugin, p) {
    const safe = p.replace(/\.md$/, "").replace(/[/\\]/g, "_");
    const dir = ".obsidian/plugins/fast-note-sync/conflict-notes";
    return {
        dir,
        safeName: safe,
        pathHash: `ph:${p}`,
        baseBackupPath: `${dir}/${safe}_ph.base.md`,
        remoteBackupPath: `${dir}/${safe}_ph.remote.md`,
        metaPath: `${dir}/${safe}_ph.meta.json`,
        localBackupPath: `${dir}/${safe}_ph.local-backup.md`,
    };
}

const store = loadModule("src/lib/sync/conflict_store.ts", (id) => {
    if (id === "obsidian") return { normalizePath: (p) => p, TFile: class {}, TFolder: class {}, Platform: {} };
    if (id === "../../i18n/lang") return { $: (k) => k };
    if (id === "../utils/helpers") return {
        dump: noop, dumpError: noop, getPluginDir: () => ".obsidian/plugins/fast-note-sync",
        hashContentAsync: async (s) => `h:${s}`, hashFileAsync: async () => "h",
    };
    if (id === "../utils/config_codec") return { decodeConfigContent: (c) => ({ kind: "text", text: c }) };
    if (id === "../utils/types") return {};
    if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: noop }) } };
    if (id === "./operator_file") return { clearUploadTrackingForConflict: noop };
    if (id === "./operator_note") return {
        conflictBackupPaths,
        readConflictMeta: async () => null,
        writeConflictMeta: async () => undefined,
    };
    if (id === "../../main") return {};
    if (id === "../utils/sync_diagnostics") return {
        recordDiagBufferOnly: (level, kind, message) => diag.push({ level, kind, message }),
    };
    throw new Error(`Unexpected require in conflict_store: ${id}`);
});

function makePlugin(existingFiles, initialPaths) {
    const files = new Set(existingFiles);
    const persisted = [];
    const statusBarCalls = { count: 0 };
    return {
        persisted,
        statusBarCalls,
        files,
        plugin: {
            app: {
                vault: {
                    adapter: {
                        // The conflict-notes directory itself is implicitly present.
                        exists: async (p) => files.has(p) || p.endsWith("/conflict-notes"),
                        list: async (dir) => ({
                            files: Array.from(files).filter((f) => f.startsWith(`${dir}/`)),
                            folders: [],
                        }),
                        remove: async (p) => { files.delete(p); },
                    },
                },
            },
            syncState: { conflictedPaths: new Set(initialPaths) },
            localStorageManager: { setConflictedPaths: (s) => persisted.push(new Set(s)) },
            statusBarManager: { updateConflictBadge: () => { statusBarCalls.count += 1; } },
        },
    };
}

// 1. Prune: only paths without meta are dropped; meta-bearing and unreadable records stay.
{
    const keepPath = "notes/keep.md";
    const gonePath = "notes/gone.md";
    const { plugin, persisted, statusBarCalls } = makePlugin(
        [conflictBackupPaths({}, keepPath).metaPath],
        [keepPath, gonePath],
    );
    const removed = await store.pruneInvalidConflictRecords(plugin);
    assert.equal(removed, 1, "one record without meta is pruned");
    assert.deepEqual(Array.from(plugin.syncState.conflictedPaths), [keepPath], "meta-bearing record is kept");
    assert.equal(persisted.length, 1, "pruned set is persisted once");
    assert.deepEqual(Array.from(persisted[0]), [keepPath], "only the valid path is persisted");
    assert.equal(statusBarCalls.count, 1, "badge refreshes after pruning");
    assert.ok(diag.some((e) => e.kind === "ConflictState" && e.message.includes("1")), "diagnostics record the count");
    assert.equal(diag.filter((e) => e.level === "warn").length, 1, "one summary line, not one per path");
}

// 2. Nothing to prune: no persistence, no badge churn.
{
    const kept = "notes/kept.md";
    const { plugin, persisted, statusBarCalls } = makePlugin(
        [conflictBackupPaths({}, kept).metaPath],
        [kept],
    );
    assert.equal(await store.pruneInvalidConflictRecords(plugin), 0);
    assert.equal(persisted.length, 0, "a clean set is not rewritten");
    assert.equal(statusBarCalls.count, 0, "badge is untouched when nothing changes");
}

// 2b. The whole conflict-notes directory is gone (the incident: plugin-dir state wiped):
//     every surviving path is invalid and gets dropped in one pass.
{
    const a = "notes/a.md";
    const b = "files/b.png";
    const { plugin, persisted } = makePlugin([], [a, b]);
    plugin.app.vault.adapter.exists = async () => false;
    assert.equal(await store.pruneInvalidConflictRecords(plugin), 2);
    assert.equal(plugin.syncState.conflictedPaths.size, 0, "all records are dropped when no metadata remains");
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].size, 0);
}

// 3. Reset: clear the set/localStorage and delete metadata, but keep content backups.
{
    const a = "notes/a.md";
    const b = "files/b.png";
    const dir = ".obsidian/plugins/fast-note-sync/conflict-notes";
    const metaA = conflictBackupPaths({}, a).metaPath;
    const metaB = conflictBackupPaths({}, b).metaPath;
    const baseA = conflictBackupPaths({}, a).baseBackupPath;
    const localA = conflictBackupPaths({}, a).localBackupPath;
    const { plugin, files, persisted } = makePlugin([metaA, metaB, baseA, localA], [a, b]);
    await store.resetConflictRecords(plugin);
    assert.equal(plugin.syncState.conflictedPaths.size, 0, "in-memory set cleared");
    assert.equal(persisted.length, 1, "empty set persisted");
    assert.equal(persisted[0].size, 0);
    assert.equal(files.has(metaA), false, "meta A removed");
    assert.equal(files.has(metaB), false, "meta B removed");
    assert.equal(files.has(baseA), true, "base backup is preserved");
    assert.equal(files.has(localA), true, "local backup is preserved");
    assert.ok(files.size > 0, "conflict folder itself is not removed");
}

console.log("PASS: invalid conflict records self-heal and sync-state reset clears metadata");
