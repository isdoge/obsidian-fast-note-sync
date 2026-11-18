import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 验证同步时间等同步状态的文件镜像写入、恢复、配对校验、多库/服务端隔离、排除规则与损坏回退

const root = path.resolve(import.meta.dirname, "..");

function transpile(relPath) {
  const sourcePath = path.join(root, relPath);
  const source = fs.readFileSync(sourcePath, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;
}

function loadModule(relPath, requireStub, extraGlobals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(relPath), {
    require: requireStub,
    module,
    exports: module.exports,
    console,
    window: {
      setTimeout,
      clearTimeout,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    setTimeout,
    clearTimeout,
    ...extraGlobals,
  });
  return module.exports;
}

const helpersRequireStub = (id) => {
  switch (id) {
    case "obsidian":
      return {
        Notice: class { setMessage() {} hide() {} },
        normalizePath: (p) => p,
        TFolder: class {},
        Platform: { isMobile: false },
        App: class {},
      };
    case "../../i18n/lang":
      return { $: (key) => key };
    case "../../main":
      return {};
    case "../sync/sync_log_manager":
      return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: () => undefined }) } };
    case "../helpers_obsidian_bypass":
      return {
        nativeFetch: () => undefined,
        vaultDelete: () => undefined,
        dump: () => undefined,
        dumpError: () => undefined,
        setLogEnabled: () => undefined,
        logLevel: () => undefined,
      };
    default:
      throw new Error(`Unexpected require in helpers: ${id}`);
  }
};

const helpers = loadModule("src/lib/utils/helpers.ts", helpersRequireStub, {
  activeDocument: undefined,
  crypto: { getRandomValues: (a) => a },
});

const fhmRequireStub = (id) => {
  switch (id) {
    case "../utils/helpers":
      return helpers;
    case "../../i18n/lang":
      return { $: (key) => key };
    case "../../main":
      return {};
    default:
      throw new Error(`Unexpected require in file_hash_manager: ${id}`);
  }
};
const { FileHashManager } = loadModule("src/lib/storage/file_hash_manager.ts", fhmRequireStub);

const chmRequireStub = (id) => {
  switch (id) {
    case "obsidian":
      return { normalizePath: (p) => p };
    case "../utils/helpers":
      return helpers;
    case "../sync/operator_config":
      return { configAllPaths: async () => [] };
    case "../../i18n/lang":
      return { $: (key) => key };
    case "../../main":
      return {};
    default:
      throw new Error(`Unexpected require in config_hash_manager: ${id}`);
  }
};
const { ConfigHashManager } = loadModule("src/lib/storage/config_hash_manager.ts", chmRequireStub);

const fsmRequireStub = (id) => {
  switch (id) {
    case "obsidian":
      return { TFolder: class {} };
    case "../utils/helpers":
      return helpers;
    case "../../main":
      return {};
    default:
      throw new Error(`Unexpected require in folder_snapshot_manager: ${id}`);
  }
};
const { FolderSnapshotManager } = loadModule("src/lib/storage/folder_snapshot_manager.ts", fsmRequireStub);

const lsmRequireStub = (id) => {
  switch (id) {
    case "../utils/helpers":
      return helpers;
    case "../sync/operator_config":
      return { configModify: async () => undefined };
    case "../../main":
      return {};
    default:
      throw new Error(`Unexpected require in local_storage_manager: ${id}`);
  }
};
const { LocalStorageManager } = loadModule("src/lib/storage/local_storage_manager.ts", lsmRequireStub);

const MIRROR_DIR = ".obsidian/plugins/fast-note-sync";
const SYNC_STATE_MIRROR = `${MIRROR_DIR}/syncState.json`;
const SYNC_HASH_MIRROR = `${MIRROR_DIR}/syncHashMap.json`;
const CONFIG_HASH_MIRROR = `${MIRROR_DIR}/configHashMap.json`;
const FOLDER_SNAPSHOT_MIRROR = `${MIRROR_DIR}/folderSnapshot.json`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makePlugin(ls, files, { api = "https://sync.example.com", vault = "VaultMain", apiToken = "demo-auth-credential", configSyncEnabled = true, syncExcludeWhitelist = "", onWrite } = {}) {
  const plugin = {
    manifest: { id: "fast-note-sync", dir: MIRROR_DIR },
    settings: {
      api,
      vault,
      apiToken,
      configSyncEnabled,
      syncExcludeFolders: "",
      syncExcludeWhitelist,
    },
    app: {
      loadLocalStorage: (key) => (ls.has(key) ? ls.get(key) : null),
      saveLocalStorage: (key, value) => {
        if (value === null || value === undefined) ls.delete(key);
        else ls.set(key, String(value));
      },
      vault: {
        configDir: ".obsidian",
        getName: () => "LocalVault",
        getFiles: () => [],
        getAllLoadedFiles: () => [],
        adapter: {
          exists: async (p) => files.has(p),
          read: async (p) => {
            if (!files.has(p)) throw new Error("ENOENT: " + p);
            return files.get(p);
          },
          write: async (p, data) => {
            if (onWrite) onWrite(p, data);
            files.set(p, data);
          },
          stat: async () => null,
        },
      },
    },
  };
  plugin.localStorageManager = new LocalStorageManager(plugin);
  plugin.fileHashManager = new FileHashManager(plugin);
  plugin.configHashManager = new ConfigHashManager(plugin);
  plugin.folderSnapshotManager = new FolderSnapshotManager(plugin);
  return plugin;
}

async function initManagers(plugin) {
  await Promise.all([
    plugin.fileHashManager.initialize(),
    plugin.configHashManager.initialize(),
    plugin.folderSnapshotManager.initialize(),
  ]);
  await plugin.localStorageManager.restoreSyncStateFromMirror();
}

// === 场景 A：写入并 flush 后清空 localStorage，能从镜像恢复全套同步状态，且不泄漏 token、不被配置同步 ===
{
  const ls = new Map();
  const files = new Map();
  const p1 = makePlugin(ls, files, { syncExcludeWhitelist: JSON.stringify([{ pattern: ".obsidian/*", caseSensitive: false }]) });
  await initManagers(p1);

  p1.fileHashManager.setFileHash("notes/a.md", "h-a", 100, 10);
  p1.fileHashManager.setFileHash("img/b.png", "h-b", 200, 20);
  p1.configHashManager.setFileHash(".obsidian/app.json", "h-cfg", 300, 30);
  p1.folderSnapshotManager.setFolderMtime("notes", 400);

  p1.localStorageManager.setMetadata("lastNoteSyncTime", 1700000001000);
  p1.localStorageManager.setMetadata("lastFileSyncTime", 1700000002000);
  p1.localStorageManager.setMetadata("lastConfigSyncTime", 1700000003000);
  p1.localStorageManager.setMetadata("lastFolderSyncTime", 1700000004000);
  p1.localStorageManager.setMetadata("isInitSync", true);
  p1.localStorageManager.setMetadata("lastSyncSuccessTime", 1700000005000);

  p1.localStorageManager.flushSyncStateMirror();
  await sleep(30);

  assert.equal(files.has(SYNC_STATE_MIRROR), true, "应生成 syncState.json 镜像文件");
  assert.equal(files.get(SYNC_STATE_MIRROR).includes(p1.settings.apiToken), false, "镜像文件不得包含明文 apiToken");
  assert.equal(helpers.configIsPathExcluded(SYNC_STATE_MIRROR, p1), true, "syncState.json 必须被配置同步排除（含白名单开启时）");

  assert.equal(helpers.configIsPathExcluded(`${MIRROR_DIR}/retryQueue.json`, p1), true, "retryQueue.json 必须被配置同步排除（含白名单开启时）");

  // 模拟 iOS 清空 localStorage
  ls.clear();
  const p2 = makePlugin(ls, files);
  await initManagers(p2);

  assert.equal(p2.localStorageManager.getMetadata("lastNoteSyncTime"), 1700000001000, "应恢复 lastNoteSyncTime");
  assert.equal(p2.localStorageManager.getMetadata("lastFileSyncTime"), 1700000002000, "应恢复 lastFileSyncTime");
  assert.equal(p2.localStorageManager.getMetadata("lastConfigSyncTime"), 1700000003000, "应恢复 lastConfigSyncTime");
  assert.equal(p2.localStorageManager.getMetadata("lastFolderSyncTime"), 1700000004000, "应恢复 lastFolderSyncTime");
  assert.equal(p2.localStorageManager.getMetadata("isInitSync"), true, "应恢复 isInitSync");
  assert.equal(p2.localStorageManager.getMetadata("lastSyncSuccessTime"), 1700000005000, "应恢复 lastSyncSuccessTime");
  assert.equal(ls.get("fns-lastNoteSyncTime"), "1700000001000", "恢复后应回写 localStorage");
}

// === 场景 B：同步时间频繁推进应节流，不立即写盘；flush 时才立即写最新值 ===
{
  const ls = new Map();
  const files = new Map();
  let syncStateWrites = 0;
  const p = makePlugin(ls, files, {
    onWrite: (target) => {
      if (target === SYNC_STATE_MIRROR) syncStateWrites++;
    },
  });
  await initManagers(p);
  p.fileHashManager.setFileHash("notes/a.md", "h-a", 100, 10);

  p.localStorageManager.setMetadata("lastNoteSyncTime", 1000);
  p.localStorageManager.setMetadata("lastNoteSyncTime", 2000);
  p.localStorageManager.setMetadata("lastNoteSyncTime", 3000);
  await sleep(30);
  assert.equal(syncStateWrites, 0, "高频推进同步时间应走防抖节流，不得每次都立即写盘");

  p.localStorageManager.flushSyncStateMirror();
  await sleep(30);
  assert.equal(syncStateWrites, 1, "flush 后应立即合并写入 1 次");
  const saved = JSON.parse(files.get(SYNC_STATE_MIRROR));
  assert.equal(saved.lastNoteSyncTime, 3000, "写入镜像的应是最新同步时间");
}

// === 场景 C1：镜像中的同步时间与哈希表不配对（哈希表较旧）→ 对应同步时间按 0 处理 ===
{
  const ls = new Map();
  const files = new Map();
  const p1 = makePlugin(ls, files);
  await initManagers(p1);
  p1.fileHashManager.setFileHash("notes/a.md", "h-a", 100, 10);
  p1.localStorageManager.setMetadata("lastNoteSyncTime", 1000);
  p1.localStorageManager.flushSyncStateMirror();
  await sleep(30);
  const oldSyncHashContent = files.get(SYNC_HASH_MIRROR);

  // 推进到新状态并落盘
  p1.fileHashManager.setFileHash("notes/b.md", "h-b", 200, 20);
  p1.localStorageManager.setMetadata("lastNoteSyncTime", 2000);
  p1.localStorageManager.setMetadata("lastFileSyncTime", 2000);
  p1.localStorageManager.setMetadata("isInitSync", true);
  p1.localStorageManager.setMetadata("lastSyncSuccessTime", 2500);
  p1.localStorageManager.flushSyncStateMirror();
  await sleep(30);

  // 模拟同步时间已落盘为 2000，但 syncHashMap.json 仍停留在旧版本
  files.set(SYNC_HASH_MIRROR, oldSyncHashContent);
  ls.clear();

  const p2 = makePlugin(ls, files);
  await initManagers(p2);
  assert.equal(p2.localStorageManager.getMetadata("lastNoteSyncTime"), 0, "哈希表与同步时间不配对时 lastNoteSyncTime 必须按 0 处理");
  assert.equal(p2.localStorageManager.getMetadata("lastFileSyncTime"), 0, "哈希表与同步时间不配对时 lastFileSyncTime 必须按 0 处理");
  assert.equal(p2.localStorageManager.getMetadata("isInitSync"), false, "全部同步时间无效时 isInitSync 应回退为 false");
  assert.equal(p2.localStorageManager.getMetadata("lastSyncSuccessTime"), 0, "全部同步时间无效时 lastSyncSuccessTime 应回退为 0");
}

// === 场景 C2：哈希表镜像缺失/空（冷建）但 syncState.json 存在 → 按 0 处理 ===
{
  const ls = new Map();
  const files = new Map();
  const p1 = makePlugin(ls, files);
  await initManagers(p1);
  p1.fileHashManager.setFileHash("notes/a.md", "h-a", 100, 10);
  p1.localStorageManager.setMetadata("lastNoteSyncTime", 5000);
  p1.localStorageManager.setMetadata("isInitSync", true);
  p1.localStorageManager.flushSyncStateMirror();
  await sleep(30);

  files.delete(SYNC_HASH_MIRROR);
  files.delete(`${MIRROR_DIR}/fileHashMap.json`);
  ls.clear();

  const p2 = makePlugin(ls, files);
  await initManagers(p2);
  assert.equal(p2.localStorageManager.getMetadata("lastNoteSyncTime"), 0, "哈希表缺失冷建时同步时间必须按 0 处理");
  assert.equal(p2.localStorageManager.getMetadata("isInitSync"), false, "全部同步时间无效时 isInitSync 应为 false");
}

// === 场景 C3：仅配置哈希损坏时，只将 lastConfigSyncTime 归零，不误伤正常的 note/file/folder 时间 ===
{
  const ls = new Map();
  const files = new Map();
  const p1 = makePlugin(ls, files);
  await initManagers(p1);
  p1.fileHashManager.setFileHash("notes/a.md", "h-a", 100, 10);
  p1.configHashManager.setFileHash(".obsidian/app.json", "h-cfg", 300, 30);
  p1.folderSnapshotManager.setFolderMtime("notes", 400);
  p1.localStorageManager.setMetadata("lastNoteSyncTime", 6000);
  p1.localStorageManager.setMetadata("lastFileSyncTime", 6100);
  p1.localStorageManager.setMetadata("lastConfigSyncTime", 6200);
  p1.localStorageManager.setMetadata("lastFolderSyncTime", 6300);
  p1.localStorageManager.setMetadata("isInitSync", true);
  p1.localStorageManager.flushSyncStateMirror();
  await sleep(30);

  files.set(CONFIG_HASH_MIRROR, "{corrupted-json");
  ls.clear();

  const p2 = makePlugin(ls, files);
  await initManagers(p2);
  assert.equal(p2.localStorageManager.getMetadata("lastConfigSyncTime"), 0, "配置哈希损坏时 lastConfigSyncTime 应按 0 处理");
  assert.equal(p2.localStorageManager.getMetadata("lastNoteSyncTime"), 6000, "正常的笔记同步时间应保留恢复");
  assert.equal(p2.localStorageManager.getMetadata("lastFileSyncTime"), 6100, "正常的附件同步时间应保留恢复");
  assert.equal(p2.localStorageManager.getMetadata("lastFolderSyncTime"), 6300, "正常的目录同步时间应保留恢复");
  assert.equal(p2.localStorageManager.getMetadata("isInitSync"), true);
}

// === 场景 D：多库 / 更换服务端地址 / 更换账号 token → 不能误用旧同步时间 ===
{
  const ls = new Map();
  const files = new Map();
  const p1 = makePlugin(ls, files, { api: "https://s1.example.com", vault: "Vault1", apiToken: "tok1" });
  await initManagers(p1);
  p1.fileHashManager.setFileHash("notes/a.md", "h-a", 100, 10);
  p1.localStorageManager.setMetadata("lastNoteSyncTime", 7000);
  p1.localStorageManager.setMetadata("isInitSync", true);
  p1.localStorageManager.flushSyncStateMirror();
  await sleep(30);

  for (const override of [
    { api: "https://s2.example.com", vault: "Vault1", apiToken: "tok1" },
    { api: "https://s1.example.com", vault: "Vault2", apiToken: "tok1" },
    { api: "https://s1.example.com", vault: "Vault1", apiToken: "tok2" },
  ]) {
    ls.clear();
    const p2 = makePlugin(ls, files, override);
    await initManagers(p2);
    assert.equal(p2.localStorageManager.getMetadata("lastNoteSyncTime"), 0, `切换配置 ${JSON.stringify(override)} 后不应恢复旧同步时间`);
    assert.equal(p2.localStorageManager.getMetadata("isInitSync"), false);
  }
}

// === 场景 E：镜像文件损坏时安全回退（不抛异常、按 0 处理） ===
for (const badContent of [
  "{not-valid-json",
  "",
  "[]",
  "null",
  JSON.stringify({ version: 99, lastNoteSyncTime: 9999 }),
  JSON.stringify({ version: 1, scope: "wrong", lastNoteSyncTime: "bad", isInitSync: "bad" }),
]) {
  const ls = new Map();
  const files = new Map();
  files.set(SYNC_STATE_MIRROR, badContent);
  const p = makePlugin(ls, files);
  await initManagers(p);
  assert.equal(p.localStorageManager.getMetadata("lastNoteSyncTime"), 0);
  assert.equal(p.localStorageManager.getMetadata("lastFileSyncTime"), 0);
  assert.equal(p.localStorageManager.getMetadata("lastConfigSyncTime"), 0);
  assert.equal(p.localStorageManager.getMetadata("lastFolderSyncTime"), 0);
  assert.equal(p.localStorageManager.getMetadata("isInitSync"), false);
  assert.equal(p.localStorageManager.getMetadata("lastSyncSuccessTime"), 0);
}

// === 场景 F：clearSyncTime 应同步清空镜像，防止重启后复活 ===
{
  const ls = new Map();
  const files = new Map();
  const p1 = makePlugin(ls, files);
  await initManagers(p1);
  p1.fileHashManager.setFileHash("notes/a.md", "h-a", 100, 10);
  p1.localStorageManager.setMetadata("lastNoteSyncTime", 8000);
  p1.localStorageManager.setMetadata("isInitSync", true);
  p1.localStorageManager.flushSyncStateMirror();
  await sleep(30);

  p1.localStorageManager.clearSyncTime();
  await sleep(30);

  ls.clear();
  const p2 = makePlugin(ls, files);
  await initManagers(p2);
  assert.equal(p2.localStorageManager.getMetadata("lastNoteSyncTime"), 0, "clearSyncTime 后重启恢复应仍为 0");
  assert.equal(p2.localStorageManager.getMetadata("isInitSync"), false, "clearSyncTime 后重启恢复应仍为 false");
}

console.log("sync-time-mirror-restore.test.mjs: all scenarios passed");
