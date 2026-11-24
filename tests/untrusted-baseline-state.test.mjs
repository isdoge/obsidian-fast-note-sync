import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 外来同步状态判定 / Foreign sync-state detection:
// A new device that copied another machine's whole plugin folder gets the hash/baseline
// mirrors but not the localStorage confirmation table ("2315 baselines, 0 confirmed").
// Such a state must behave like a first sync: full scan, content-based baseline rebuild and
// no scan-inferred deletions. An in-place legacy install (sync times native to this app)
// keeps the previous incremental behavior.
const root = path.resolve(import.meta.dirname, "..");
const noop = () => {};

function loadModule(relPath, requireStub = () => ({}), extraGlobals = {}) {
    const sourcePath = path.join(root, relPath);
    const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
        fileName: sourcePath,
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, {
        module,
        exports: module.exports,
        require: requireStub,
        console,
        window: { setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop },
        setTimeout,
        clearTimeout,
        Date,
        ...extraGlobals,
    });
    return module.exports;
}

// ─── Part 1: isUntrustedBaselineState / buildBaselineFields (real module) ─────
const baselineScope = loadModule("src/lib/storage/baseline_scope.ts", (id) => {
    if (id.includes("helpers")) return { computeMirrorDigest: (s) => `digest:${s}` };
    return {};
});
const { isUntrustedBaselineState, buildBaselineFields } = baselineScope;

{
    const probe = (counts, mirror) => ({
        fileHashManager: { getDiagnosticCounts: () => counts },
        localStorageManager: { wasSyncStateRestoredFromMirror: () => mirror },
    });
    assert.equal(isUntrustedBaselineState(probe({ baselineEntries: 2315, confirmedBaselines: 0 }, true)), true,
        "baselines restored from mirror with zero confirmed is untrusted");
    assert.equal(isUntrustedBaselineState(probe({ baselineEntries: 2315, confirmedBaselines: 1 }, true)), false,
        "any confirmed baseline makes the history trusted");
    assert.equal(isUntrustedBaselineState(probe({ baselineEntries: 0, confirmedBaselines: 0 }, true)), false,
        "no baselines at all is an ordinary first install");
    assert.equal(isUntrustedBaselineState(probe({ baselineEntries: 2315, confirmedBaselines: 0 }, false)), false,
        "in-place legacy state (native sync times) is not foreign");
    assert.equal(isUntrustedBaselineState({}), false, "missing managers never throw");
}

// Content that still matches a persisted baseline must be reported as an equal base,
// never as a missing base (otherwise the server can only answer with a conflict).
{
    const equalBase = buildBaselineFields({
        isSyncBaselineModeEnabled: () => true,
        fileHashManager: {
            getConfirmedBaseline: () => null,
            getVerifiedPathHash: () => "h-equal",
        },
    }, "note", "notes/a.md", "h-equal");
    assert.equal(equalBase.baseHash, "h-equal", "equality-verified baseline carries the real hash");
    assert.equal(equalBase.baseHashMissing, false, "equality-verified baseline is not reported as missing");
    const missingBase = buildBaselineFields({
        isSyncBaselineModeEnabled: () => true,
        fileHashManager: {
            getConfirmedBaseline: () => null,
            getVerifiedPathHash: () => null,
        },
    }, "note", "notes/a.md", "h-new");
    assert.equal(missingBase.baseHashMissing, true, "changed content without a trusted base stays explicit");
}

// ─── Part 2: operator wiring ───────────────────────────────────────────────────
class TFile {
    constructor(p, ext = "md", mtime = 50, size = 10) {
        this.path = p;
        this.extension = ext;
        this.stat = { mtime, ctime: mtime, size };
    }
}
class TFolder {}

const sent = [];
const logs = [];
const diagnostics = [];
const { SyncState } = loadModule("src/lib/sync/sync_state.ts");

const helpersStub = {
    dump: noop,
    dumpError: noop,
    isPathExcluded: () => false,
    isFolderSyncPathExcluded: () => false,
    configIsPathExcluded: () => false,
    getConfigSyncCustomDirs: () => [],
    generateUUID: () => "ctx-untrusted",
    showSyncNotice: noop,
    isLargeBinarySyncRisk: () => false,
    describeBinarySyncLimit: () => "100MB",
    hashContent: (x) => `ph_${x}`,
    hashContentAsync: async (x) => `ch_${x}`,
    hashFileAsync: async (_app, p) => `fh_${p}`,
    formatFileSize: (n) => `${n}B`,
    yieldToMain: async () => {},
    getPluginDir: () => ".obsidian/plugins/fast-note-sync",
    checkAndNotifyCaseConflict: () => false,
    getSafeCtime: (s) => s?.ctime ?? 0,
    normalizeServerTimestamp: (t) => t,
};

const guard = loadModule("src/lib/sync/mass_delete_guard.ts");

const operatorRequire = (id) => {
    if (id === "obsidian") return { normalizePath: (x) => x, TFile, TFolder, Platform: {} };
    if (id === "./mass_delete_guard") return guard;
    if (id.includes("helpers")) return helpersStub;
    if (id.includes("baseline_scope")) {
        // Keep the real trust probe; stub the request builders that need a full manager stack.
        return { ...baselineScope, buildBaselineFields: () => ({}), buildDeleteBaselineFields: () => ({}) };
    }
    if (id.includes("sync_diagnostics")) {
        return { recordDiagBufferOnly: (level, kind, message) => diagnostics.push({ level, kind, message }) };
    }
    if (id.includes("sync_log_manager")) {
        return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: noop, addLog: (type, action, message, status) => logs.push({ type, action, message, status }) }) } };
    }
    if (id.includes("i18n")) return { $: (k, params) => `${k}:${JSON.stringify(params ?? {})}` };
    if (id.includes("conflict_store")) {
        return {
            conflictKindToSyncType: () => "note", normalizeConflict: () => null,
            storeSyncConflict: async () => false, resetConflictRecords: async () => {},
        };
    }
    if (id.includes("file_cloud_preview")) return { FileCloudPreview: class {} };
    return {};
};

const op = loadModule("src/lib/sync/operator.ts", operatorRequire, {
    sleep: async () => {},
    WebSocket: { OPEN: 1 },
    activeDocument: undefined,
});

const tasks = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, needConflict: 0, completed: 0, failed: 0 });

function makePlugin(trackedPaths, liveFiles, { mirrorRestored, confirmedCount }) {
    const meta = new Map([
        ["lastNoteSyncTime", 100],
        ["lastFileSyncTime", 100],
        ["lastFolderSyncTime", 100],
        ["lastConfigSyncTime", 100],
        ["isInitSync", true],
    ]);
    const legacyHashes = new Map(trackedPaths.map((p) => [p, `ph_${p}`]));
    const syncState = new SyncState();
    syncState.syncUpChunkNum = 10000;
    return {
        meta,
        syncState,
        settings: {
            syncEnabled: true,
            configSyncEnabled: false,
            isShowNotice: true,
            hashSyncLimitEnabled: false,
            hashSyncLimit: 0,
            noteSyncLimit: 20,
            attachmentSyncLimit: 100,
            vault: "v1",
            offlineDeleteSyncEnabled: true,
            readonlySyncEnabled: false,
            cloudPreviewEnabled: false,
            cloudPreviewTypeRestricted: true,
        },
        isSyncing: false,
        isSyncRequesting: false,
        currentSyncType: "incremental",
        syncTypeCompleteCount: 0,
        expectedSyncCount: 3,
        totalFilesToDownload: 0,
        downloadedFilesCount: 0,
        totalChunksToDownload: 0,
        downloadedChunksCount: 0,
        totalChunksToUpload: 0,
        uploadedChunksCount: 0,
        noteSyncTasks: tasks(),
        fileSyncTasks: tasks(),
        folderSyncTasks: tasks(),
        configSyncTasks: tasks(),
        pendingFileRenames: [],
        pendingNoteRenames: new Map(),
        pendingDeleteNotePaths: new Set(),
        pendingDeleteFilePaths: new Set(),
        pendingDeleteFolderPaths: new Set(),
        pendingDeleteConfigPaths: new Set(),
        pendingNoteDeleteAcks: new Set(),
        pendingFileDeleteAcks: new Set(),
        pendingConfigDeleteAcks: new Set(),
        pendingNoteModifies: new Map(),
        pendingUploadHashes: new Map(),
        pendingConfigModifies: new Map(),
        scannedNoteHashes: new Map(),
        scannedFileHashes: new Map(),
        scannedConfigHashes: new Map(),
        fileDownloadSessions: new Map(),
        syncPageStateMap: new Map(),
        menuManager: { ribbonIconStatus: true },
        statusBarManager: { updateConflictBadge: noop },
        concurrencyLimiter: { activeKeys: new Set(), queue: [] },
        resetSyncTasks: function () { this.syncState.resetSession(); },
        updateStatusBar: noop,
        progressTracker: {
            reset: noop, recordHashProgress: noop, isTypeFullyDone: () => false,
            getOverallPct: () => 50, getDetailText: () => "", forceComplete: noop,
        },
        localStorageManager: {
            getMetadata: (k) => meta.get(k) ?? 0,
            setMetadata: (k, v) => meta.set(k, v),
            savePending: noop,
            wasSyncStateRestoredFromMirror: () => mirrorRestored,
        },
        fileHashManager: {
            getAllPaths: () => trackedPaths,
            getDiagnosticCounts: () => ({ baselineEntries: trackedPaths.length, confirmedBaselines: confirmedCount }),
            getBaselineProvenance: (p) => (confirmedCount > 0 && legacyHashes.has(p) ? "confirmed" : "none"),
            isBaselineConfirmed: () => confirmedCount > 0,
            getPathHash: (p) => legacyHashes.get(p) ?? null,
            getValidHash: (p) => legacyHashes.get(p) ?? null,
            bulkSetFromScanned: noop,
        },
        folderSnapshotManager: { getMtime: () => undefined, isReady: () => false, isBaselineConfirmed: () => false },
        websocket: {
            ws: { readyState: 1, bufferedAmount: 0 },
            isOpen: true,
            SendMessage: (action, payload, _x, cb) => { sent.push({ action, payload }); cb?.(); },
            on: noop,
            off: noop,
        },
        app: {
            vault: {
                configDir: ".obsidian",
                adapter: { exists: async () => false },
                getAllLoadedFiles: () => liveFiles,
            },
        },
    };
}

function resetCapture() {
    sent.length = 0;
    logs.length = 0;
    diagnostics.length = 0;
}

const payloadFor = (action) => sent.find((entry) => entry.action === action)?.payload;
const tracked = Array.from({ length: 200 }, (_, i) => `notes/n${i}.md`);

// A. Foreign state: full sync decision, no scan-inferred deletions, one diagnostic line.
{
    resetCapture();
    const plugin = makePlugin(tracked, [], { mirrorRestored: true, confirmedCount: 0 });
    assert.equal(op.resolveStartupIncremental(plugin), false, "foreign state must not run incrementally");
    assert.equal(op.resolveStartupIncremental(plugin), false, "decision is stable across calls");
    assert.equal(diagnostics.filter((d) => d.kind === "BaselineTrust").length, 1, "trust issue is reported once");
    await op.handleSync(plugin, false);
    assert.equal(payloadFor("NoteSync")?.delNotes?.length ?? 0, 0, "no scan-inferred note deletions are sent");
    assert.equal(payloadFor("FileSync")?.delFiles?.length ?? 0, 0, "no scan-inferred attachment deletions are sent");
    assert.equal(plugin.pendingDeleteNotePaths.size, 0, "nothing is queued as pending deletion");
    assert.equal(logs.filter((l) => l.action === "MassDeleteGuard").length, 0, "guard is untouched (deletes are simply not inferred)");
}

// B. Same counters but native sync times (in-place legacy install): behavior is unchanged.
{
    resetCapture();
    const plugin = makePlugin(tracked, [], { mirrorRestored: false, confirmedCount: 0 });
    assert.equal(op.resolveStartupIncremental(plugin), true, "legacy in-place state remains incremental");
    assert.equal(isUntrustedBaselineState(plugin), false);
    await op.handleSync(plugin, true);
    assert.equal(payloadFor("NoteSync")?.delNotes?.length, 200, "legacy incremental deletes are still reported");
    assert.equal(diagnostics.filter((d) => d.kind === "BaselineTrust").length, 0, "no foreign-state diagnostic for legacy");
}

// C. A state with any server-confirmed baseline is trusted even if other entries came from the mirror.
{
    resetCapture();
    const plugin = makePlugin(tracked, [], { mirrorRestored: true, confirmedCount: 1 });
    assert.equal(isUntrustedBaselineState(plugin), false);
    assert.equal(op.resolveStartupIncremental(plugin), true, "trusted state keeps incremental startup");
}

console.log("PASS: foreign baseline state forces full sync and suppresses inferred deletions");
