import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 冒烟测试：移动端 localStorage 被清除后，FileHashManager 应从文件镜像恢复而非全量重建
// Smoke test: after mobile localStorage eviction, FileHashManager restores from the file mirror
// instead of rebuilding (and re-notifying) from scratch.

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
    window: { setTimeout, clearTimeout },
    setTimeout,
    clearTimeout,
    ...extraGlobals,
  });
  return module.exports;
}

// --- 载入 helpers.ts（提供 LocalStateFileMirror / debounce 等） ---
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

// --- 载入 file_hash_manager.ts ---
const fhmRequireStub = (id) => {
  switch (id) {
    case "../utils/helpers":
      return helpers;
    case "../../i18n/lang":
      return { $: (key) => key };
    case "../../main":
      return {};
    default:
      if (id.includes("baseline_scope")) return { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) };
    if (id.includes("conflict_store")) return { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" };
    if (id.includes("conflict_reset_scheduler")) return { scheduleConflictRecordReset: () => {} };
    throw new Error(`Unexpected require in file_hash_manager: ${id}`);
  }
};
const { FileHashManager } = loadModule("src/lib/storage/file_hash_manager.ts", fhmRequireStub);

// --- 假 plugin：localStorage 用 Map，vault.adapter 用 Map（内存文件系统） ---
function makeFakePlugin(localStorageMap, fileMap, { onGetFiles } = {}) {
  return {
    manifest: { id: "fast-note-sync", dir: ".obsidian/plugins/fast-note-sync" },
    settings: {},
    app: {
      loadLocalStorage: (key) => (localStorageMap.has(key) ? localStorageMap.get(key) : null),
      saveLocalStorage: (key, value) => {
        if (value === null || value === undefined) localStorageMap.delete(key);
        else localStorageMap.set(key, String(value));
      },
      vault: {
        configDir: ".obsidian",
        getName: () => "TestVault",
        getFiles: () => {
          if (onGetFiles) onGetFiles();
          return [];
        },
        adapter: {
          exists: async (p) => fileMap.has(p),
          read: async (p) => {
            if (!fileMap.has(p)) throw new Error("ENOENT: " + p);
            return fileMap.get(p);
          },
          write: async (p, data) => {
            fileMap.set(p, data);
          },
        },
      },
    },
  };
}

const MIRROR_PATH = ".obsidian/plugins/fast-note-sync/fileHashMap.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// === 场景 A：写入哈希 → flush → localStorage 与镜像文件都有数据 ===
{
  const ls = new Map();
  const filesA = new Map();
  const plugin = makeFakePlugin(ls, filesA);
  const mgr = new FileHashManager(plugin);
  await mgr.initialize(); // 双空 → 走重建（getFiles 返回空数组，静默完成）

  mgr.setFileHash("notes/a.md", "hash-a", 111, 10);
  mgr.setFileHash("img/b.png", "hash-b", 222, 20);
  mgr.flush();
  await sleep(20); // 等 adapter.write 异步落盘

  assert.equal(ls.has("fns-fileHashMap"), true, "localStorage 应有稳定 key 数据");
  assert.equal(filesA.has(MIRROR_PATH), true, "镜像文件应已写入");
  const mirrored = JSON.parse(filesA.get(MIRROR_PATH));
  assert.equal(mirrored["notes/a.md"].hash, "hash-a");
  assert.equal(mirrored["img/b.png"].hash, "hash-b");

  // === 场景 B：模拟移动端 localStorage 被系统清除 → 新实例应从镜像恢复，不重建 ===
  ls.clear();
  let rebuilt = false;
  const plugin2 = makeFakePlugin(ls, filesA, { onGetFiles: () => { rebuilt = true; } });
  const mgr2 = new FileHashManager(plugin2);
  await mgr2.initialize();

  assert.equal(rebuilt, false, "镜像命中时不应触发全量重建（不应调用 vault.getFiles）");
  assert.equal(mgr2.getPathHash("notes/a.md"), "hash-a", "应从镜像恢复哈希");
  assert.equal(mgr2.getValidHash("img/b.png", 222, 20), "hash-b", "mtime/size 应一并恢复");
  assert.equal(ls.has("fns-fileHashMap"), true, "恢复后应回写 localStorage");
}

// === 场景 C：localStorage 与镜像均无 → 走重建路径（getFiles 被调用），不报错 ===
{
  const ls = new Map();
  const files = new Map();
  let rebuilt = false;
  const plugin = makeFakePlugin(ls, files, { onGetFiles: () => { rebuilt = true; } });
  const mgr = new FileHashManager(plugin);
  await mgr.initialize();
  assert.equal(rebuilt, true, "双空时应触发重建");
  assert.equal(mgr.isReady(), true);
}

// === 场景 D：旧版绑定库名的 key 迁移到稳定 key ===
{
  const ls = new Map();
  const files = new Map();
  ls.set("fns-TestVault-fileHashMap", JSON.stringify({ "old/n.md": { hash: "h-old", mtime: 1, size: 2 } }));
  const plugin = makeFakePlugin(ls, files);
  const mgr = new FileHashManager(plugin);
  await mgr.initialize();
  // 阶段 B：旧 key 迁移只恢复磁盘缓存，不伪造可信同步基线
  // Stage B: legacy-key migration restores the disk cache only, never a trusted baseline
  assert.equal(mgr.getValidHash("old/n.md", 1, 2), "h-old", "旧 key 数据应可读到");
  assert.equal(mgr.getPathHash("old/n.md"), null, "旧 key 数据不冒充可信基线");
  assert.equal(ls.has("fns-fileHashMap"), true, "旧 key 数据应迁移到稳定 key");
}

console.log("file-mirror-restore.test.mjs: all scenarios passed");
