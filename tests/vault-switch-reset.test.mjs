import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 暗坑 #2：切换「远端笔记库名」时必须彻底清空旧库的同步归属状态，
// 否则连到一个全新的空库时，本地笔记/附件会被当成 server_missing 冲突。
// Pitfall #2: switching the remote vault name must drop every piece of the old vault's
// sync ownership; otherwise a fresh empty vault makes local notes/assets look like
// server_missing conflicts.
const root = path.resolve(import.meta.dirname, "..");

function loadTsModule(relPath, requireStub = () => { throw new Error("Unexpected require"); }) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { require: requireStub, module, exports: module.exports, console, Map, Set, Promise }, { filename: sourcePath });
  return module.exports;
}

const { updateVaultName, clearVaultScopedSyncState } = loadTsModule("src/lib/settings/vault_name.ts");
assert.equal(typeof updateVaultName, "function");
assert.equal(typeof clearVaultScopedSyncState, "function");

/** 记录每次调用的最小桩：任一环节漏清都会在下面的断言里暴露 */
function makePlugin() {
  const calls = {
    clearSyncTime: 0,
    lastSuccessReset: 0,
    clearPending: [],
    fileClear: 0,
    configClear: 0,
    folderClear: 0,
    retryClear: 0,
    conflictBackups: 0,
    saveReload: 0,
    order: [],
  };
  const maps = {
    pendingNoteModifies: new Map([["a.md", "h1"]]),
    pendingUploadHashes: new Map([["a.md", "h2"]]),
    pendingConfigModifies: new Map([["c.json", "h3"]]),
  };
  const sets = {
    pendingNoteDeleteAcks: new Set(["a.md"]),
    pendingFileDeleteAcks: new Set(["img.png"]),
    pendingConfigDeleteAcks: new Set(["c.json"]),
    pendingNoteRenames: new Set(["a.md"]),
    pendingFileRenames: new Set(["img.png"]),
  };
  const syncState = {
    conflictedPaths: new Set(["a.md"]),
    newConflictedPathsThisRound: new Set(["a.md"]),
    newUnalignedPathsThisRound: new Set(["b.md"]),
    conflictCountsThisRound: new Map([["note", 1]]),
    pendingNotePushPageIndex: new Map([["a.md", 0]]),
    pendingFilePushPageIndex: new Map([["img.png", 0]]),
    pendingConfigPushPageIndex: new Map([["c.json", 0]]),
    completedFileUploadSessions: new Set(["img.png"]),
  };
  const plugin = {
    settings: { vault: "Original" },
    wsSettingChange: false,
    localStorageManager: {
      clearSyncTime() { calls.clearSyncTime++; calls.order.push("clearSyncTime"); },
      clearPending(field) { calls.clearPending.push(field); },
      setMetadata(field, value) {
        if (field === "lastSyncSuccessTime" && value === 0) calls.lastSuccessReset++;
      },
    },
    fileHashManager: { clearAll() { calls.fileClear++; calls.order.push("fileClear"); } },
    configHashManager: { clearAll() { calls.configClear++; } },
    folderSnapshotManager: { clearAll() { calls.folderClear++; } },
    retryQueue: { clear() { calls.retryClear++; } },
    syncState,
    pendingNoteModifies: maps.pendingNoteModifies,
    pendingUploadHashes: maps.pendingUploadHashes,
    pendingConfigModifies: maps.pendingConfigModifies,
    pendingNoteDeleteAcks: sets.pendingNoteDeleteAcks,
    pendingFileDeleteAcks: sets.pendingFileDeleteAcks,
    pendingConfigDeleteAcks: sets.pendingConfigDeleteAcks,
    pendingNoteRenames: sets.pendingNoteRenames,
    pendingFileRenames: sets.pendingFileRenames,
    async clearVaultConflictBackups() { calls.conflictBackups++; calls.order.push("conflictBackups"); },
    async saveAndReloadServices() { calls.saveReload++; calls.order.push("saveReload"); },
  };
  return { plugin, calls, maps, sets, syncState };
}

// 1. 同值不触发任何清理
{
  const { plugin, calls } = makePlugin();
  await updateVaultName(plugin, "Original");
  assert.equal(calls.clearSyncTime, 0);
  assert.equal(calls.saveReload, 0);
}

// 2. 切库：清空全部同步归属状态，且清理先于重连
{
  const { plugin, calls, maps, sets, syncState } = makePlugin();
  await updateVaultName(plugin, "my-notes");

  assert.equal(plugin.settings.vault, "my-notes");
  assert.equal(plugin.wsSettingChange, true);

  // 时间戳 / isInitSync / 持久化冲突路径
  assert.equal(calls.clearSyncTime, 1, "sync times, isInitSync and persisted conflicts are cleared");
  assert.equal(calls.lastSuccessReset, 1, "the old vault's last-success time is reset");
  // 崩溃恢复用的在途上传记录
  assert.deepEqual(
    [...calls.clearPending].sort(),
    ["pendingConfigModifies", "pendingNoteModifies", "pendingUploadHashes"],
    "persisted in-flight upload maps are cleared",
  );
  // syncHashMap / fileHashMap / folderSnapshot / 基线 / configHashMap
  assert.equal(calls.fileClear, 1, "file hash + sync baseline cleared");
  assert.equal(calls.configClear, 1, "config hash + baseline cleared");
  assert.equal(calls.folderClear, 1, "folder snapshot + baselines cleared");
  // retryQueue 与冲突备份
  assert.equal(calls.retryClear, 1, "old vault retry queue dropped");
  assert.equal(calls.conflictBackups, 1, "old vault conflict backups dropped");

  // 内存中的在途集合与冲突记录
  for (const [name, map] of Object.entries(maps)) {
    assert.equal(map.size, 0, `${name} is emptied`);
  }
  for (const [name, set] of Object.entries(sets)) {
    assert.equal(set.size, 0, `${name} is emptied`);
  }
  for (const [name, value] of Object.entries(syncState)) {
    assert.equal(value.size, 0, `syncState.${name} is emptied`);
  }

  // 顺序：先清哈希/快照，再清同步时间（clearSyncTime 会落盘 syncState 镜像），最后重连
  assert.ok(
    calls.order.indexOf("fileClear") < calls.order.indexOf("clearSyncTime"),
    "hash baselines are cleared before the syncState mirror is flushed by clearSyncTime",
  );
  assert.ok(
    calls.order.indexOf("saveReload") > calls.order.indexOf("conflictBackups"),
    "cleanup (including conflict backups) happens before reconnecting",
  );
  assert.equal(calls.saveReload, 1);
}

// 3. 缺省可选管理器（老插件状态/最小桩）不崩溃
{
  const plugin = {
    settings: { vault: "A" },
    wsSettingChange: false,
    localStorageManager: { clearSyncTime() {} },
    async saveAndReloadServices() {},
  };
  await updateVaultName(plugin, "B");
  assert.equal(plugin.settings.vault, "B");
}

// 4. 结构契约：FileHashManager 的基线表与确认来源必须被 clearAll 一并清掉
{
  const fileHashSource = fs.readFileSync(path.join(root, "src/lib/storage/file_hash_manager.ts"), "utf8");
  const clearAllBlock = /clearAll\(\): void \{([\s\S]*?)\n  \}/.exec(fileHashSource);
  assert.ok(clearAllBlock, "FileHashManager.clearAll exists");
  for (const field of ["hashMap", "syncHashMap", "confirmedPaths", "revisions", "pendingDeleteBaselines"]) {
    assert.ok(clearAllBlock[1].includes(`${field}.clear()`), `clearAll drops ${field}`);
  }
  for (const rel of ["src/lib/storage/config_hash_manager.ts", "src/lib/storage/folder_snapshot_manager.ts"]) {
    const source = fs.readFileSync(path.join(root, rel), "utf8");
    assert.match(source, /clearAll\(\): void \{[\s\S]*?baselineScope = computeRemoteScope\(this\.plugin\.settings\)/,
      `${rel} re-anchors the baseline scope on clearAll`);
  }
  const folderSource = fs.readFileSync(path.join(root, "src/lib/storage/folder_snapshot_manager.ts"), "utf8");
  assert.match(folderSource, /clearAll\(\): void \{[\s\S]*?this\.snapshotMap\.clear\(\)[\s\S]*?this\.revisions\.clear\(\)/,
    "FolderSnapshotManager.clearAll drops the snapshot and folder revisions");
  const retrySource = fs.readFileSync(path.join(root, "src/lib/sync/retry_queue.ts"), "utf8");
  assert.match(retrySource, /clear\(\): void \{[\s\S]*?this\.entries = \[\]/, "RetryQueue.clear empties entries");
}

// 5. 远端配置页顺序：服务地址 → 远端笔记库名 → 授权令牌
{
  const settingSource = fs.readFileSync(path.join(root, "src/setting.tsx"), "utf8");
  const apiIdx = settingSource.indexOf('setting.remote.api_url"');
  const vaultIdx = settingSource.indexOf('setting.remote.vault_name"');
  const tokenIdx = settingSource.indexOf('setting.remote.api_token"');
  assert.ok(apiIdx > 0 && vaultIdx > 0 && tokenIdx > 0, "remote settings keys are present");
  assert.ok(apiIdx < vaultIdx && vaultIdx < tokenIdx,
    "order is server URL -> remote vault name -> token so a half-filled form cannot connect to the wrong vault");
}

console.log("PASS: switching the remote vault name clears every old-vault sync state before reconnecting");
