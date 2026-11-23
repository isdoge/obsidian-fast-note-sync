import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Cloud-preview "delete local after upload" is a device-local cleanup, not a user deletion.
// The eviction journal must be written before the local file is trashed, rolled back on failure,
// and consulted by the offline-delete scan so it never removes the server/other-device copies.
const root = path.resolve(import.meta.dirname, '..');
const noop = () => undefined;

function transpile(relPath) {
  const sourcePath = path.join(root, relPath);
  return {
    source: ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      fileName: sourcePath,
    }).outputText,
    sourcePath,
  };
}

function runModule(relPath, requires) {
  const { source, sourcePath } = transpile(relPath);
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, console, Map, Set, WeakMap, WeakSet, ArrayBuffer, Uint8Array,
    URLSearchParams, TextEncoder, Date, Promise, crypto: globalThis.crypto,
    window: { setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop },
    WebSocket: { OPEN: 1 },
    require: (id) => {
      if (id in requires) return requires[id];
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename: sourcePath });
  return module.exports;
}

// ---------------------------------------------------------------------------
// 1. Journal: durable, vault-scoped, atomic, clearable
// ---------------------------------------------------------------------------
const excludedPaths = [];
let clock = 1000;
const helpersStub = {
  configAddPathExcluded: (p) => excludedPaths.push(p),
  getPluginDir: () => '.obsidian/plugins/fast-note-sync',
  dumpError: noop,
  dump: noop,
};
const disks = new Map();
const operations = [];
const adapter = {
  exists: async (p) => disks.has(p),
  read: async (p) => {
    if (!disks.has(p)) throw new Error(`missing ${p}`);
    return discs.get(p);
  },
  write: async (p, data) => { operations.push(['write', p]); disks.set(p, data); },
  remove: async (p) => { operations.push(['remove', p]); disks.delete(p); },
  rename: async (from, to) => {
    operations.push(['rename', from, to]);
    if (!disks.has(from)) throw new Error(`missing ${from}`);
    const value = disks.get(from);
    disks.delete(from);
    disks.set(to, value);
  },
};
const discs = disks; // keep the typo-proof alias used above
const journalSettings = { api: 'http://Server.Example/', vault: 'vault-a' };
const plugin = { settings: journalSettings, app: { vault: { adapter } } };
const { CloudAttachmentEviction, computeEvictionScope } = runModule('src/lib/storage/cloud_attachment_eviction.ts', { '../utils/helpers': helpersStub });

const journalPath = '.obsidian/plugins/fast-note-sync/cloud-attachments-evicted.json';

const scopeA = computeEvictionScope(journalSettings);
const journal = new CloudAttachmentEviction(plugin);
assert.deepEqual(excludedPaths, [journalPath, `${journalPath}.tmp`], 'journal must be excluded from config sync');
await journal.initialize();
assert.equal(journal.isEvicted('img/a.png'), false);
await journal.record({ path: 'img/a.png', sha256: 'sha-a', size: 3, evictedAt: clock++ });

assert.ok(disks.has(journalPath), 'journal is persisted inside the plugin dir');
assert.ok(!disks.has(`${journalPath}.tmp`), 'temporary file is removed after the atomic rename');
const successful = operations.filter(([, p]) => p === journalPath || p === `${journalPath}.tmp`);
assert.deepEqual(successful.map(op => op[0]), ['write', 'rename'], 'write .tmp then atomically rename');
const persisted = JSON.parse(disks.get(journalPath));
assert.equal(persisted.version, 1);
assert.deepEqual(persisted.entries, [{ scope: scopeA, path: 'img/a.png', sha256: 'sha-a', size: 3, evictedAt: 1000 }]);

// A fresh instance recovers the journal
const reloaded = new CloudAttachmentEviction(plugin);
await reloaded.initialize();
assert.equal(reloaded.isEvicted('img/a.png'), true, 'journal survives a plugin reload');

// Vault scoping: another remote vault must not see the record
plugin.settings.vault = 'vault-b';
assert.equal(reloaded.isEvicted('img/a.png'), false, 'records are isolated per vault scope');
await reloaded.record({ path: 'img/full-size.png', sha256: 'sha-b', size: 9, evictedAt: clock++ });
plugin.settings.vault = 'vault-a';
assert.equal(reloaded.isEvicted('img/a.png'), true);

// Reappearance drops the record; clearScope removes only the requested scope
await reloaded.forget(['img/a.png']);
assert.equal(reloaded.isEvicted('img/a.png'), false, 'reappearing local file clears its eviction record');
plugin.settings.vault = 'vault-b';
assert.equal(reloaded.isEvicted('img/full-size.png'), true);
await reloaded.clearScope(computeEvictionScope({ api: 'http://server.example', vault: 'vault-b' }));
assert.equal(reloaded.isEvicted('img/full-size.png'), false, 'switching vault clears the old scope');

// ---------------------------------------------------------------------------
// 2. Cleanup helper: verify full bytes, journal before trash, roll back on failure
// ---------------------------------------------------------------------------
const helperState = { present: true, events: [], readbackThrows: false, trashThrows: false, localBytes: new Uint8Array([1, 2, 3]), remoteBytes: new Uint8Array([1, 2, 3]), info: null };
const evictionEvents = { record: 0, remove: 0 };
const evictionState = { usable: true };
class HttpApiService {
  async getFileInfo() { return helperState.info; }
  async getFileContentForVerification() {
    if (helperState.readbackThrows) throw new Error('read-back unavailable');
    return helperState.remoteBytes;
  }
}
const helperModule = runModule('src/lib/sync/operator_file.ts', {
  './remote_path_guard': { blockAliasedRemoteMutation: () => false },
  './remote_delete_guard': { firstKeepWithoutBaseline: () => false },
  'obsidian': {
    TFile: class TFile { constructor(p) { this.path = p; } },
    TAbstractFile: class TAbstractFile {},
    normalizePath: (p) => p,
    Platform: { isMobile: false },
  },
  '../utils/types': { CLIENT_TYPE: 'test' },
  '../utils/helpers': {
    hashContent: (x) => `p:${x}`,
    hashArrayBuffer: async () => 'h',
    getPluginDir: () => '.obsidian/plugins/fast-note-sync',
    dump: noop,
    dumpError: noop,
    sleep: async () => undefined,
    isPathExcluded: () => false,
    getSafeCtime: (stat) => stat.ctime,
    isLargeBinarySyncRisk: () => false,
    describeBinarySyncLimit: () => '100MB',
    showSyncNotice: noop,
    checkAndNotifyCaseConflict: () => false,
    logMemorySnapshot: noop,
    hashFileAsync: async () => 'h',
    normalizeServerTimestamp: (t) => t === undefined ? undefined : (t > 0 && t < 1e11 ? t * 1000 : t),
    vaultDelete: async (_vault, file) => {
      helperState.events.push('trash');
      if (helperState.trashThrows) throw new Error('trash failed');
      helperState.present = false;
      assert.equal(file.path, 'a.png');
    },
  },
  '../storage/file_cloud_preview': { FileCloudPreview: { isRestrictedType: () => true } },
  './sync_log_manager': { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } },
  './sync_state': { advanceLiveSyncTime: noop },
  '../api/http_api_service': { HttpApiService },
  '../storage/baseline_scope': {
    buildDeleteBaselineFields: () => ({}),
    baselineFieldsFromDeleteRecord: () => ({}),
    buildBaselineFields: () => ({}),
  },
});
const { maybeAutoDeleteUploadedAttachment } = helperModule;
assert.equal(typeof maybeAutoDeleteUploadedAttachment, 'function');

function makePlugin() {
  const file = { path: 'a.png', extension: 'png', stat: { size: 3, mtime: 2e12, ctime: 1 } };
  return {
    file,
    plugin: {
      settings: { cloudPreviewEnabled: true, cloudPreviewAutoDeleteLocal: true, cloudPreviewTypeRestricted: false },
      app: { vault: {
        getFileByPath: (p) => (helperState.present && p === 'a.png' ? file : null),
        readBinary: async () => helperState.localBytes,
      } },
      fileHashManager: { removeFileHash: () => helperState.events.push('removeHash') },
      addIgnoredFile: () => helperState.events.push('ignore'),
      removeIgnoredFile: () => helperState.events.push('unignore'),
      cloudAttachmentEviction: {
        record: async () => {
          if (!evictionState.usable) throw new Error('Cloud attachment eviction journal is unavailable');
          evictionEvents.record++; helperState.events.push('record');
        },
        remove: async () => { evictionEvents.remove++; helperState.events.push('rollback'); },
        get isUsable() { return evictionState.usable; },
      },
    },
  };
}

function resetHelper({ remoteBytes = new Uint8Array([1, 2, 3]), readbackThrows = false, trashThrows = false, size = 3 } = {}) {
  helperState.present = true;
  helperState.events = [];
  helperState.readbackThrows = readbackThrows;
  helperState.trashThrows = trashThrows;
  helperState.localBytes = new Uint8Array([1, 2, 3]);
  helperState.remoteBytes = remoteBytes;
  helperState.info = { path: 'a.png', size, mtime: 2e12, contentHash: 'content-hash' };
  evictionEvents.record = 0;
  evictionEvents.remove = 0;
  evictionState.usable = true;
}

// 2a. Full byte mismatch: keep the local file, never journal or trash it
{
  resetHelper({ remoteBytes: new Uint8Array([1, 2, 4]) });
  const { plugin, file } = makePlugin();
  const deleted = await maybeAutoDeleteUploadedAttachment(plugin, file, 'content-hash');
  assert.equal(deleted, false);
  assert.equal(helperState.present, true, 'verification failure keeps the local file');
  assert.deepEqual(helperState.events, [], 'no journal record and no trash on hash mismatch');
}

// 2b. Remote read-back failure: keep the local file
{
  resetHelper({ readbackThrows: true });
  const { plugin, file } = makePlugin();
  assert.equal(await maybeAutoDeleteUploadedAttachment(plugin, file, 'content-hash'), false);
  assert.equal(helperState.present, true);
  assert.equal(evictionEvents.record, 0);
  assert.ok(!helperState.events.includes('trash'));
}

// 2c. Unknown/zero size: unverifiable, keep the local file
{
  resetHelper({ size: 0, remoteBytes: new Uint8Array([]) });
  const { plugin, file } = makePlugin();
  file.stat.size = 0;
  assert.equal(await maybeAutoDeleteUploadedAttachment(plugin, file, 'content-hash'), false);
  assert.equal(helperState.present, true);
  assert.equal(evictionEvents.record, 0);
}

// 2d. Success: journal is written before the file is trashed
{
  resetHelper();
  const { plugin, file } = makePlugin();
  assert.equal(await maybeAutoDeleteUploadedAttachment(plugin, file, 'content-hash'), true);
  assert.equal(helperState.present, false);
  assert.ok(helperState.events.indexOf('record') !== -1, 'eviction is recorded');
  assert.ok(helperState.events.indexOf('record') < helperState.events.indexOf('trash'), 'record precedes the move to the bin');
  assert.equal(evictionEvents.remove, 0, 'successful eviction keeps its record');
  assert.ok(helperState.events.includes('unignore'));
}

// 2e. Trash failure: the eviction record is rolled back and the file stays
{
  resetHelper({ trashThrows: true });
  const { plugin, file } = makePlugin();
  assert.equal(await maybeAutoDeleteUploadedAttachment(plugin, file, 'content-hash'), false);
  assert.equal(helperState.present, true);
  assert.ok(helperState.events.indexOf('record') < helperState.events.indexOf('trash'));
  assert.ok(helperState.events.includes('rollback'), 'failed move rolls the eviction record back');
  assert.equal(evictionEvents.remove, 1);
}

// 2f. Corrupt journal: cleanup is refused, the local file stays and nothing is reported
{
  resetHelper();
  evictionState.usable = false;
  const { plugin, file } = makePlugin();
  assert.equal(await maybeAutoDeleteUploadedAttachment(plugin, file, 'content-hash'), false);
  assert.equal(helperState.present, true, 'an unusable journal keeps the local file');
  assert.equal(evictionEvents.record, 0, 'no eviction is recorded');
  assert.ok(!helperState.events.includes('trash'), 'nothing is moved to the bin');
}

// ---------------------------------------------------------------------------
// 3. Full scan: journaled paths are never reported as offline deletions
// ---------------------------------------------------------------------------
const scanHelpers = {
  dump: noop, dumpError: noop, sleep: async () => undefined, isPathExcluded: () => false, isFolderSyncPathExcluded: () => false,
  configIsPathExcluded: () => false, getConfigSyncCustomDirs: () => [],
  hashContent: (x) => `p:${x}`, hashContentAsync: async (x) => `h:${x}`,
  getPluginDir: () => '.obsidian/plugins/fast-note-sync', showSyncNotice: noop, isLargeBinarySyncRisk: () => false,
  describeBinarySyncLimit: () => '', hashFileAsync: async () => 'f', formatFileSize: () => '',
  yieldToMain: async () => undefined, checkAndNotifyCaseConflict: () => false, getSafeCtime: (s) => s?.ctime ?? 0,
  generateUUID: () => 'ctx-1', normalizeServerTimestamp: (v) => v,
};
const scanLogs = { addLog: noop, addOrUpdateLog: noop, logReceivedMessage: noop };
class ScanTFile { constructor(p, extension = 'png', size = 3) { this.path = p; this.extension = extension; this.stat = { mtime: 200, ctime: 200, size }; } }
class ScanTFolder {}
function loadScanModule(relPath, extra = {}) {
  const { source, sourcePath } = transpile(relPath);
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, console, Map, Set, Date, Promise, WeakMap,
    window: { setTimeout: () => 1, clearTimeout: noop, clearInterval: noop, setInterval: () => 1 },
    WebSocket: { OPEN: 1 },
    sleep: async () => undefined,
    require: (id) => {
      if (id === 'obsidian') return { normalizePath: (x) => x, TFile: ScanTFile, TFolder: ScanTFolder, Platform: { isMobile: false } };
      if (id.includes('helpers')) return scanHelpers;
      if (id.includes('sync_log_manager')) return { SyncLogManager: { getInstance: () => scanLogs } };
      if (id.includes('i18n')) return { $: (key) => key };
      if (id.includes('baseline_scope')) return {
        buildBaselineFields: () => ({}), buildDeleteBaselineFields: () => ({}),
        baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => 'scope',
        parseScopedState: () => ({ state: { scope: 'scope', revisions: {}, pendingDeletes: {} }, scopeChanged: false }),
        serializeScopedState: (state) => JSON.stringify(state),
      };
      if (id.includes('conflict_store')) return {
        storeSyncConflict: async () => true, normalizeConflict: () => null,
        conflictKindToSyncType: () => 'note', conflictReasonLabel: () => '', conflictKindLabel: () => '',
      };
      if (id in extra) return extra[id];
      return {};
    },
  }, { filename: sourcePath });
  return module.exports;
}
const { SyncState } = loadScanModule('src/lib/sync/sync_state.ts');
const { evaluateMassDeleteGuard } = loadScanModule('src/lib/sync/mass_delete_guard.ts');
const scanModules = {
  './mass_delete_guard': { evaluateMassDeleteGuard },
  './websocket_action': new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) }),
  './operator_note': { receiveNoteSyncEnd: async () => undefined, receiveNoteUpload: async () => undefined, receiveNoteModifyAck: async () => undefined, receiveNoteRenameAck: async () => undefined, receiveNoteDeleteAck: async () => undefined, conflictBackupPaths: () => ({ baseBackupPath: 'b', remoteBackupPath: 'r', metaPath: 'm', localBackupPath: 'l' }) },
  './operator_file': { sweepStalledDownloadSessions: async () => 0, invalidateFileDownloads: noop },
  './operator_folder': {},
  './operator_config': { configAllPaths: async () => [] },
  './sync_progress_tracker': { SyncType: {} },
  '../storage/file_cloud_preview': { FileCloudPreview: { isRestrictedType: () => true } },
  './sync_state': { advanceLiveSyncTime: noop },
  '../../views/confirm-modal': { ConfirmModal: class ConfirmModal {} },
};

function makeScanPlugin(trackedPaths, localFiles, evictedPaths, { evictionUsable = true } = {}) {
  const forgotten = [];
  const sent = [];
  const tasks = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, needConflict: 0, completed: 0, failed: 0 });
  const meta = new Map([
    ['lastNoteSyncTime', 100], ['lastFileSyncTime', 100],
    ['lastFolderSyncTime', 100], ['lastConfigSyncTime', 100], ['isInitSync', true],
  ]);
  const done = { note: false, file: false, folder: false, setting: false };
  const syncState = new SyncState();
  syncState.syncUpChunkNum = 50;
  const plugin = {
    syncState,
    settings: {
      syncEnabled: true, configSyncEnabled: false, isShowNotice: false,
      hashSyncLimitEnabled: true, hashSyncLimit: 50000, noteSyncLimit: 20, attachmentSyncLimit: 50,
      vault: 'v1', offlineDeleteSyncEnabled: true, readonlySyncEnabled: false,
      cloudPreviewEnabled: false, cloudPreviewTypeRestricted: true,
    },
    isSyncing: false, isSyncRequesting: false, currentSyncType: 'incremental', syncTypeCompleteCount: 0,
    expectedSyncCount: 3, totalFilesToDownload: 0, downloadedFilesCount: 0, totalChunksToDownload: 0,
    downloadedChunksCount: 0, totalChunksToUpload: 0, uploadedChunksCount: 0,
    noteSyncTasks: tasks(), fileSyncTasks: tasks(), folderSyncTasks: tasks(), configSyncTasks: tasks(),
    pendingFileRenames: [], pendingNoteRenames: new Map(),
    pendingDeleteNotePaths: new Set(), pendingDeleteFilePaths: new Set(),
    pendingDeleteFolderPaths: new Set(), pendingDeleteConfigPaths: new Set(),
    pendingNoteDeleteAcks: new Set(), pendingFileDeleteAcks: new Set(), pendingConfigDeleteAcks: new Set(),
    pendingNoteModifies: new Map(), pendingUploadHashes: new Map(), pendingConfigModifies: new Map(),
    scannedNoteHashes: new Map(), scannedFileHashes: new Map(), scannedConfigHashes: new Map(),
    fileDownloadSessions: new Map(), syncPageStateMap: new Map(),
    menuManager: { ribbonIconStatus: true }, statusBarManager: { updateConflictBadge: noop },
    concurrencyLimiter: { activeKeys: new Set(), queue: [] },
    resetSyncTasks: noop, updateStatusBar: noop,
    progressTracker: {
      reset: noop, recordHashProgress: noop, isTypeFullyDone: (t) => done[t],
      getOverallPct: () => 50, getDetailText: () => '', forceComplete: noop,
    },
    localStorageManager: {
      getMetadata: (k) => meta.get(k) ?? 0, setMetadata: (k, v) => meta.set(k, v),
      savePending: noop, clearPending: noop,
    },
    fileHashManager: {
      getAllPaths: () => trackedPaths,
      getPathHash: (p) => trackedPaths.includes(p) ? 'base' : null,
      getValidHash: () => null,
      bulkSetFromScanned: noop,
      removeFileHashes: noop, setFileHashes: noop, flush: noop,
      isBaselineConfirmed: () => true,
    },
    folderSnapshotManager: { getMtime: () => undefined, isReady: () => false },
    retryQueue: { drainBeforeSync: async () => undefined, shouldSkipScanDelete: () => false, getRecoveryPaths: () => [] },
    isSyncBaselineModeEnabled: () => false,
    cloudAttachmentEviction: {
      initialize: async () => undefined,
      isUsable: evictionUsable,
      isEvicted: (p) => evictedPaths.has(p),
      forget: async (paths) => { forgotten.push(...paths); },
    },
    websocket: {
      ws: { readyState: 1, bufferedAmount: 0 }, isOpen: true,
      SendMessage: async (action, payload, _x, cb) => { sent.push({ action, payload }); cb?.(); },
    },
    app: {
      vault: {
        configDir: '.obsidian',
        adapter: { exists: async () => false },
        getAllLoadedFiles: () => localFiles,
        read: async (f) => `content:${f.path}`,
      },
    },
  };
  return { plugin, sent, forgotten };
}

const operator = loadScanModule('src/lib/sync/operator.ts', scanModules);

// 3a. Journaled path missing locally is not reported; an ordinary missing file still is
{
  const { plugin, sent, forgotten } = makeScanPlugin(['img/evicted.png', 'img/user-deleted.png'], [], new Set(['img/evicted.png']));
  await operator.handleSync(plugin, true);
  const fileSync = sent.find(entry => entry.action === 'FileSync');
  assert.ok(fileSync, 'a FileSync payload is sent');
  const delPaths = Array.from(fileSync.payload.delFiles ?? [], item => item.path);
  assert.deepEqual(delPaths, ['img/user-deleted.png'], 'journaled eviction is suppressed; user deletion is reported');
  assert.deepEqual(forgotten, [], 'a still-missing file keeps its record');
}

// 3b. A journaled file that reappears locally clears its record
{
  const { plugin, sent, forgotten } = makeScanPlugin(['img/evicted.png', 'img/user-deleted.png'], [new ScanTFile('img/evicted.png')], new Set(['img/evicted.png']));
  await operator.handleSync(plugin, true);
  assert.deepEqual(forgotten, ['img/evicted.png'], 'reappeared local file clears the eviction record');
  const fileSync = sent.find(entry => entry.action === 'FileSync');
  const delPaths = Array.from(fileSync.payload.delFiles ?? [], item => item.path);
  assert.deepEqual(delPaths, ['img/user-deleted.png']);
}

// 3c. Unusable journal: no attachment deletion is reported at all this round
{
  const { plugin, sent, forgotten } = makeScanPlugin(
    ['img/evicted.png', 'img/user-deleted.png', 'note.md'],
    [],
    new Set(['img/evicted.png']),
    { evictionUsable: false },
  );
  await operator.handleSync(plugin, true);
  const fileSync = sent.find(entry => entry.action === 'FileSync');
  assert.ok(fileSync, 'a FileSync payload is sent');
  assert.deepEqual(Array.from(fileSync.payload.delFiles ?? [], item => item.path), [],
    'an unusable journal suppresses every attachment deletion');
  const noteSync = sent.find(entry => entry.action === 'NoteSync');
  assert.ok(Array.from(noteSync?.payload?.delNotes ?? [], item => item.path).includes('note.md'),
    'notes are unaffected: the journal only guards attachment deletes');
  assert.deepEqual(forgotten, [], 'records are not touched while the journal is unusable');
}

// 3d. Corrupt journal on disk: load marks it unusable and the real scan stays fail-closed
{
  const corruptDisks = new Map([[journalPath, '{ this is not valid json']]);
  const corruptAdapter = {
    exists: async (p) => corruptDisks.has(p),
    read: async (p) => {
      if (!corruptDisks.has(p)) throw new Error(`missing ${p}`);
      return corruptDisks.get(p);
    },
    write: async (p, data) => { corruptDisks.set(p, data); },
    remove: async (p) => { corruptDisks.delete(p); },
    rename: async (from, to) => {
      if (!corruptDisks.has(from)) throw new Error(`missing ${from}`);
      corruptDisks.set(to, corruptDisks.get(from));
      corruptDisks.delete(from);
    },
  };
  const corruptPlugin = { settings: { api: 'http://server.example', vault: 'vault-a' }, app: { vault: { adapter: corruptAdapter } } };
  const corruptJournal = new CloudAttachmentEviction(corruptPlugin);
  await corruptJournal.initialize();
  assert.equal(corruptJournal.isUsable, false, 'a corrupt journal file is unusable');
  assert.equal(corruptJournal.isEvicted('img/evicted.png'), false);
  await assert.rejects(
    corruptJournal.record({ path: 'img/evicted.png', sha256: 'sha-a', size: 3, evictedAt: clock++ }),
    /unavailable/,
    'cleanup cannot be journaled on a corrupt journal',
  );
  assert.equal(corruptDisks.get(journalPath), '{ this is not valid json', 'the corrupt file is left untouched');
}

console.log('PASS: cloud attachment eviction journal guards local cleanup and offline delete reporting');
