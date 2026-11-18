import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// 改名/移动到本地尚不存在的目录时，接收端 rename 前必须先创建目标父目录，
// 否则 vault.rename 抛 ENOENT、改名被丢弃，两端永久不一致（真机 S1 缺陷探针复现）。
// 覆盖 note / file / folder 三个接收 rename 处理器；修复前 rename 抛 ENOENT、renames 计数为 0。
const noop = () => {};
class TFile { constructor(path) { this.path = path; this.stat = { size: 1, mtime: 1 }; } }
class TFolder { constructor(path) { this.path = path; this.children = []; } }
const helpers = { dump: noop, dumpError: noop, isPathExcluded: () => false,
  isFolderSyncPathExcluded: () => false, configIsPathExcluded: () => false,
  isPathInConfigSyncDirs: () => true, waitForFolderEmpty: async () => true,
  checkAndNotifyCaseConflict: () => false, isLargeBinarySyncRisk: () => false,
  hashContent: x => `h(${x})`, hashContentAsync: async x => `h(${x})`, hashFileAsync: async () => 'hash',
  hashArrayBuffer: async () => 'hash',
  normalizeServerTimestamp: t => t === undefined ? undefined : (t > 0 && t < 1e11 ? t * 1000 : t) };
const logEntries = [];
function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console,
    window: { setTimeout: fn => { fn(); return 1; } },
    require: id => id === 'obsidian' ? { TFile, TFolder, normalizePath: x => x.replace(/\\/g, '/') }
      : id.includes('helpers_obsidian_bypass') ? { ...helpers, vaultDelete: async () => {} }
      : id.includes('helpers') ? { ...helpers, vaultDelete: async () => {} }
      : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addLog: (...a) => logEntries.push(a) }) } }
      : id.includes('remote_path_guard') ? { blockAliasedRemoteMutation: () => false }
      : id.includes('remote_delete_guard') ? { firstKeepWithoutBaseline: () => false }
      : {} });
  return module.exports;
}
const note = load('src/lib/sync/operator_note.ts');
const file = load('src/lib/sync/operator_file.ts');
const folder = load('src/lib/sync/operator_folder.ts');

// vault 桩：目录树用 Set 表示；rename 若目标父目录不存在则抛 ENOENT（模拟真实 Vault 行为）。
// createFolder 逐级由调用方实现（真实 Obsidian createFolder 本身会建父目录，这里从严模拟：
// 只创建请求的那个目录层级，从而能分别断言"rename 前目录已存在"这一事实本身）。
function makeVault(initialDirs = new Set()) {
  const dirs = new Set(initialDirs);
  const files = new Map(); // path -> TFile/TFolder 实体（rename 时更新 key）
  const created = [];
  const vault = {
    dirs, created,
    register(path, item) { files.set(path, item); },
    getFileByPath: p => (files.get(p) instanceof TFile ? files.get(p) : null),
    getAbstractFileByPath: p => files.get(p) ?? null,
    getFolderByPath: p => (dirs.has(p) ? new TFolder(p) : null),
    createFolder: async p => {
      if (dirs.has(p)) throw new Error('Folder already exists');
      // 只认直接父目录已存在的创建；更深路径直接抛错（真实 Obsidian createFolder 会建整链，
      // 这里从严：确保修复代码传进来的是"逐级已存在"的那一层）
      const parent = p.split('/').slice(0, -1).join('/');
      if (parent !== '' && !dirs.has(parent)) throw new Error('parent missing');
      dirs.add(p); created.push(p);
    },
    rename: async (item, newPath) => {
      const parent = newPath.split('/').slice(0, -1).join('/');
      if (parent !== '' && !dirs.has(parent)) {
        const err = new Error(`ENOENT: no such file or directory, rename '${item.path}' -> '${newPath}'`);
        err.code = 'ENOENT';
        throw err;
      }
      files.delete(item.path);
      item.path = newPath;
      files.set(newPath, item);
    },
  };
  return { vault, files };
}

function fixture(kind) {
  const oldPath = '笔记/第一篇.md';
  const newPath = kind === 'folder' ? '归档/新目录' : '新目录/第一篇.md';
  const source = kind === 'folder' ? new TFolder('笔记') : new TFile(oldPath);
  const { vault, files } = makeVault(new Set(['笔记']));
  if (kind === 'folder') {
    files.set('笔记', source);
    // folder rename 是整个目录改名：笔记 → 归档/新目录（目标父目录"归档"不存在）
  } else {
    files.set(oldPath, source);
  }
  const renamed = [];
  const realRename = vault.rename;
  vault.rename = async (item, to) => { renamed.push([item.path, to]); return realRename(item, to); };
  const trashed = [];
  const p = {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: 'v' },
    app: { vault,
      fileManager: { trashFile: async f => trashed.push(f.path) } },
    lockManager: { withLock: async (_, fn) => fn() },
    addIgnoredFile: noop, removeIgnoredFile: noop, isIgnoredFile: () => false,
    lastSyncPathRenamed: new Set(),
    fileDownloadSessions: new Map(),
    lastSyncMtime: new Map(), pendingNoteModifies: new Map(), pendingUploadHashes: new Map(),
    pendingFileRenames: [], pendingNoteRenames: new Map(),
    fileHashManager: { removeFileHash: noop, getPathHash: () => null, getValidHash: () => null, setFileHash: noop },
    folderSnapshotManager: { removeFolder: noop, setFolderMtime: noop },
    localStorageManager: { savePending: noop, getMetadata: () => 0, setMetadata: noop },
    concurrencyLimiter: { releaseSlot: noop, releaseFifoSlot: noop },
    noteSyncTasks: { failed: 0 }, fileSyncTasks: { failed: 0 }, folderSyncTasks: { failed: 0 },
    recordSyncCompleted: noop,
    websocket: { SendMessage: async () => {} },
  };
  const oldP = kind === 'folder' ? '笔记' : oldPath;
  const newP = newPath;
  return { p, oldP, newP, vault, renamed, trashed, source };
}

const cases = [
  ['note', note.receiveNoteSyncRename, { oldPath: '笔记/第一篇.md', path: '新目录/第一篇.md', contentHash: 'h' }],
  ['file', file.receiveFileSyncRename, { oldPath: '笔记/第一篇.md', path: '新目录/第一篇.md', contentHash: 'h', size: 1 }],
  ['folder', folder.receiveFolderSyncRename, { oldPath: '笔记', path: '归档/新目录' }],
];
const targetDir = kind => (kind === 'folder' ? '归档' : '新目录');

for (const [kind, handler, msg] of cases) {
  // 修复前：目录不存在 → vault.rename 抛 ENOENT → renamed 为空、handler 计一次 failed
  const f = fixture(kind);
  await handler(msg, f.p);
  assert.equal(f.renamed.length, 1, `${kind}: rename must execute even when target dir was absent`);
  assert.equal(f.vault.dirs.has(targetDir(kind)), true, `${kind}: target parent folder must be created before rename`);
  assert.equal(f.p[`${kind}SyncTasks`].failed, 0, `${kind}: no failure accounting when dir is created`);
}

// 目标父目录已存在时：不多余创建、行为不变（原路径正常走通）
for (const [kind, handler, msg] of cases) {
  const f = fixture(kind);
  f.vault.dirs.add(targetDir(kind));
  await handler(msg, f.p);
  assert.equal(f.renamed.length, 1, `${kind}: existing dir case still renames`);
  assert.equal(f.vault.created.length, 0, `${kind}: existing dir must not be re-created`);
}

// 深层目标：上层目录 a 已由 FolderSyncModify 先行建立，rename 补齐缺失的最后一级 a/b。
// （真机证据 console-B.log 04:34:14：服务端按目录深度逐条下发 FolderSyncModify，逐级建目录；
//  vault.createFolder 为单层，与 create 路径的既有模式一致，故 rename 只需补缺失的最近一级）
{
  const f = fixture('note');
  f.vault.dirs.add('a');
  await note.receiveNoteSyncRename({ oldPath: '笔记/第一篇.md', path: 'a/b/第一篇.md', contentHash: 'h' }, f.p);
  assert.equal(f.renamed.length, 1, 'deep target: rename executes');
  assert.equal(f.vault.dirs.has('a/b'), true, 'deep target: the missing leaf level is created');
}

console.log('PASS: rename into missing target dir creates parent folder first (note/file/folder), deep paths included');
