import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// A conflict whose metadata failed to persist must not enter the conflict set: startup self-heal
// treats a set entry without `conflict-notes/*.meta.json` as a leftover and deletes it, while the
// badge and upload pause would linger until then. This covers the central store and the two
// inline writers (legacy 530 payload, remote note push).
const root = path.resolve(import.meta.dirname, "..");
const noop = () => undefined;
const errors = [];
let metaWriteShouldFail = false;

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
    if (id === "../../i18n/lang") return { $: (k) => k };
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
        readConflictMeta: async () => null,
        writeConflictMeta: async () => {
            if (metaWriteShouldFail) throw new Error("simulated metadata write failure");
        },
    };
    if (id === "../../main") return {};
    if (id === "../utils/sync_diagnostics") return { recordDiagBufferOnly: noop };
    throw new Error(`Unexpected require in conflict_store: ${id}`);
});

function makePlugin() {
    const files = new Set();
    const persisted = [];
    const badgeCalls = { count: 0 };
    return {
        persisted,
        badgeCalls,
        plugin: {
            app: {
                vault: {
                    getFileByPath: () => null,
                    adapter: {
                        exists: async (p) => files.has(p) || p.endsWith("/conflict-notes"),
                        mkdir: async () => undefined,
                        write: async (p) => { files.add(p); },
                        writeBinary: async (p) => { files.add(p); },
                        remove: async (p) => { files.delete(p); },
                    },
                },
            },
            syncState: { conflictedPaths: new Set(), newConflictedPathsThisRound: new Set(), conflictCountsThisRound: new Map() },
            localStorageManager: { setConflictedPaths: (s) => persisted.push(new Set(s)), savePending: noop },
            statusBarManager: { updateConflictBadge: () => { badgeCalls.count += 1; } },
            pendingNoteModifies: new Map(),
            pendingUploadHashes: new Map(),
            pendingConfigModifies: new Map(),
            pendingNoteDeleteAcks: new Set(),
            pendingFileDeleteAcks: new Set(),
            pendingConfigDeleteAcks: new Set(),
            concurrencyLimiter: { releaseSlot: noop },
            settings: { vault: "v" },
        },
    };
}

// 1. Central store: a failed metadata write does not record the path and is logged.
{
    errors.length = 0;
    metaWriteShouldFail = true;
    const failedPath = "notes/meta-write-fails.md";
    const { plugin, persisted, badgeCalls } = makePlugin();
    const stored = await store.storeSyncConflict(plugin, {
        kind: "note",
        path: failedPath,
        reason: "both_modified",
        serverDeleted: true,
        baseMissing: true,
        serverHash: "h:remote",
    });
    metaWriteShouldFail = false;
    assert.equal(stored, false, "store reports that nothing was recorded");
    assert.equal(plugin.syncState.conflictedPaths.has(failedPath), false, "path is not added to the set");
    assert.equal(persisted.length, 0, "the set is not persisted");
    assert.equal(badgeCalls.count, 0, "the badge is not refreshed");
    assert.ok(errors.some((m) => m.includes("not persisted")), "the failure is logged as an error");
}

// 2. The two inline conflict writers only add the path after writeConflictMeta succeeds.
{
    for (const [rel, label] of [
        ["src/lib/sync/websocket_manager.ts", "websocket conflict handler"],
        ["src/lib/sync/operator_note.ts", "remote note push"],
    ]) {
        const source = fs.readFileSync(path.join(root, rel), "utf8");
        assert.ok(source.includes("metaPersisted = true"), `${label} records a successful metadata write`);
        assert.ok(source.includes("if (!metaPersisted)"), `${label} gates the conflict-set update on it`);
    }
}

console.log("PASS: a failed conflict metadata write never enters the conflict set");
