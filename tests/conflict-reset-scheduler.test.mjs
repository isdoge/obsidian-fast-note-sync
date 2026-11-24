import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Scope-change conflict cleanup used to be fire-and-forget: an old-target reset could interleave
// with new conflict writes during a sync, and a failed import/cleanup waited until the next app
// start. It is now a tracked pending promise: every sync round and every new conflict write awaits
// it, and a failure keeps a retry flag for the next round.
const root = path.resolve(import.meta.dirname, "..");
const noop = () => undefined;

function loadModule(relPath, requireStub, extraGlobals = {}) {
    const sourcePath = path.join(root, relPath);
    const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
        fileName: sourcePath,
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, {
        module, exports: module.exports, require: requireStub, console,
        window: { setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop },
        setTimeout, clearTimeout, Promise, Map, Set, JSON, Date,
        ...extraGlobals,
    }, { filename: sourcePath });
    return module.exports;
}

// ─── Part 1: scheduler registers a tracked pending promise ────────────────────
const errors = [];
let resetCalls = 0;
let resetResult = true;
const scheduler = loadModule("src/lib/sync/conflict_reset_scheduler.ts", (id) => {
    if (id === "../utils/helpers") return { dumpError: (...args) => errors.push(args.join(" ")) };
    if (id === "./conflict_store") return {
        resetConflictRecords: async () => { resetCalls += 1; return resetResult; },
    };
    return {};
});

{
    const plugin = { pendingConflictReset: null, conflictResetFailed: false };
    scheduler.scheduleConflictRecordReset(plugin, "scope change");
    assert.ok(plugin.pendingConflictReset, "the reset is registered synchronously, before the import resolves");
    await plugin.pendingConflictReset;
    assert.equal(resetCalls, 1, "the scheduled reset runs");
    assert.equal(plugin.conflictResetFailed, false, "success leaves no retry flag");

    resetResult = false;
    scheduler.scheduleConflictRecordReset(plugin, "second scope change");
    await plugin.pendingConflictReset;
    assert.equal(resetCalls, 2);
    assert.equal(plugin.conflictResetFailed, true, "a failed cleanup keeps the retry flag");
    assert.ok(errors.some((m) => m.includes("not fully cleared")), "the failure is logged");
}

// ─── Part 2: conflict_store awaits / retries the tracked reset ────────────────
const metaFiles = new Map();
const writeOrder = [];

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
    if (id === "obsidian") return { normalizePath: (p) => p };
    if (id === "../i18n/lang" || id === "../../i18n/lang") return { $: (k) => k };
    if (id === "../utils/helpers") return {
        dump: noop, dumpError: (...args) => errors.push(args.join(" ")),
        getPluginDir: () => ".obsidian/plugins/fast-note-sync",
        hashContentAsync: async (s) => `h:${s}`, hashFileAsync: async () => "h",
    };
    if (id === "../utils/config_codec") return { decodeConfigContent: (c) => ({ kind: "text", text: c }) };
    if (id === "../utils/types") return {};
    if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addLog: noop }) } };
    if (id === "./operator_file") return { clearUploadTrackingForConflict: noop };
    if (id === "./operator_note") return {
        conflictBackupPaths,
        readConflictMeta: async (_plugin, p) => (metaFiles.has(p) ? metaFiles.get(p) : null),
        writeConflictMeta: async (_plugin, p, meta) => { writeOrder.push(p); metaFiles.set(p, meta); },
    };
    if (id === "../../main") return {};
    if (id === "../utils/sync_diagnostics") return { recordDiagBufferOnly: noop };
    throw new Error(`Unexpected require in conflict_store: ${id}`);
});

// 2a. A failed previous reset is retried once when the next round awaits it.
{
    const persisted = [];
    const plugin = {
        syncState: { conflictedPaths: new Set(["old.md"]) },
        localStorageManager: { setConflictedPaths: (s) => persisted.push(new Set(s)) },
        statusBarManager: { updateConflictBadge: noop },
        app: { vault: { adapter: { exists: async () => false } } },
        pendingConflictReset: Promise.resolve(),
        conflictResetFailed: true,
    };
    await store.awaitPendingConflictReset(plugin);
    assert.equal(plugin.syncState.conflictedPaths.size, 0, "the retry clears the set");
    assert.equal(persisted.length, 1, "the cleared set is persisted");
    assert.equal(plugin.conflictResetFailed, false, "a successful retry clears the flag");
    assert.equal(plugin.pendingConflictReset, null, "the settled pending reset is released");
}

// 2b. storeSyncConflict waits for the pending reset before writing metadata or recording the path.
{
    metaFiles.clear();
    writeOrder.length = 0;
    let release;
    const plugin = {
        syncState: { conflictedPaths: new Set(), newConflictedPathsThisRound: new Set(), conflictCountsThisRound: new Map() },
        localStorageManager: { setConflictedPaths: noop, savePending: noop },
        statusBarManager: { updateConflictBadge: noop },
        pendingNoteModifies: new Map(),
        pendingUploadHashes: new Map(),
        pendingConfigModifies: new Map(),
        pendingNoteDeleteAcks: new Set(),
        pendingFileDeleteAcks: new Set(),
        pendingConfigDeleteAcks: new Set(),
        syncStatePending: null,
        concurrencyLimiter: { releaseSlot: noop },
        app: {
            vault: {
                getFileByPath: () => null,
                adapter: {
                    exists: async () => false,
                    mkdir: async () => undefined,
                    write: async () => undefined,
                    writeBinary: async () => undefined,
                    remove: async () => undefined,
                },
            },
        },
        settings: { vault: "v" },
        pendingConflictReset: new Promise((resolve) => { release = resolve; }),
        conflictResetFailed: false,
    };
    plugin.syncState.pendingNotePushPageIndex = new Map();
    plugin.syncState.pendingFilePushPageIndex = new Map();
    plugin.syncState.pendingConfigPushPageIndex = new Map();
    plugin.syncState.newUnalignedPathsThisRound = new Set();

    const pending = store.storeSyncConflict(plugin, {
        kind: "note", path: "notes/waits.md", reason: "both_modified", serverDeleted: true, baseMissing: true, serverHash: "h:r",
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(writeOrder.length, 0, "no metadata is written before the pending reset settles");
    release();
    assert.equal(await pending, true);
    assert.ok(writeOrder.includes("notes/waits.md"), "metadata is written after the reset settles");
    assert.ok(plugin.syncState.conflictedPaths.has("notes/waits.md"), "the path is recorded after the reset settles");
}

// 2c. The sync round start awaits it too (operator.ts), before the scan arrays are built.
{
    const operatorSource = fs.readFileSync(path.join(root, "src/lib/sync/operator.ts"), "utf8");
    const call = operatorSource.indexOf("awaitPendingConflictReset(plugin)");
    const handle = operatorSource.indexOf("export const handleSync");
    const scan = operatorSource.indexOf("const delNotes: PathHashFile[]");
    assert.ok(handle > 0 && call > handle, "handleSync awaits the pending reset");
    assert.ok(scan > call, "it awaits before the scan/send phase");
}

console.log("PASS: scope-change conflict resets are tracked, awaited and retried");
