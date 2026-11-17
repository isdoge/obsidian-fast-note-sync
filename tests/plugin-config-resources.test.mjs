import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const noop = () => {};
const configDir = '.obsidian';
const base = `${configDir}/plugins/offline-spellchecker`;
const files = [
  `${base}/manifest.json`, `${base}/en.dict`, `${base}/en.aff`, `${base}/words.txt`,
  `${base}/dictionaries/fr.dic`, `${base}/nested/settings.json`, `${base}/wallpapers/photo.png`,
  `${base}/node_modules/pkg/data.json`, `${base}/cache/data.json`, `${base}/.git/config.json`,
  `${base}/.cache/data.json`, `${base}/excluded/words.txt`,
];
const directories = new Set([configDir, `${configDir}/plugins`, base]);
for (const file of files) {
  const parts = file.split('/');
  for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
}
const adapter = {
  exists: async p => files.includes(p) || directories.has(p),
  list: async p => ({ files: files.filter(f => f.slice(0, f.lastIndexOf('/')) === p),
    folders: [...directories].filter(f => f.slice(0, f.lastIndexOf('/')) === p && f !== p) }),
};
const cache = new Map();
const helpers = new Proxy({ configIsPathExcluded: p => p.includes('/excluded/'),
  isPathInConfigSyncDirs: () => true, isInWhitelist: () => false,
  getFileName: p => p.split('/').pop(), getDirNameOrEmpty: p => p,
  isLargeBinarySyncRisk: size => size > 50 * 1024 * 1024,
  hashFileAsync: async () => 'dictionary-hash', hashContent: text => `hash:${text}`,
  getSafeCtime: stat => stat.mtime,
}, { get: (t, k) => t[k] ?? noop });
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(`src/lib/sync/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, TextDecoder,
    window: { setTimeout: () => 1, clearTimeout: noop },
    require: id => id === 'obsidian' ? { normalizePath: p => p }
      : id.includes('helpers') ? helpers
      : id === './operator_config' ? load('operator_config')
      : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addLog: noop }) } }
      : id.includes('i18n') ? { $: p => p } : {} });
  cache.set(name, module.exports);
  return module.exports;
}
const ops = load('operator_config');
const plugin = { settings: { configSyncEnabled: true }, app: { vault: { configDir, adapter } } };
const expected = files.slice(0, 6);
const paths = await ops.configAllPaths([configDir], plugin);
assert.deepEqual([...paths].sort(), [...expected].sort(), 'recursively scan dictionary/text resources, excluding binary and generated directories');
const manager = Object.create(load('config_manager').ConfigManager.prototype);
manager.plugin = plugin;
manager.pluginExtsToWatch = ops.CONFIG_PLUGIN_EXTS_TO_WATCH;
manager.themeExtsToWatch = ops.CONFIG_THEME_EXTS_TO_WATCH;
manager.rootFilesExclude = ops.CONFIG_ROOT_FILES_EXCLUDE;
const checked = [];
manager.checkFileChange = async p => checked.push(p);
for (const file of files) await manager.handleRawEvent(file, true);
assert.deepEqual(checked.sort(), expected.sort(), 'raw events follow the same recursive resource policy');

for (const op of ['configModify', 'receiveConfigUpload']) {
  let reads = 0, sends = 0, completed = 0;
  const ignored = new Set();
  const largePlugin = {
    settings: { configSyncEnabled: true }, app: { vault: { configDir, adapter: {
      exists: async () => true, stat: async () => ({ type: 'file', size: 51 * 1024 * 1024, mtime: 1 }),
      readBinary: async () => { reads++; return new ArrayBuffer(1); },
    } } }, ignoredConfigFiles: ignored, addIgnoredConfigFile: p => ignored.add(p), removeIgnoredConfigFile: p => ignored.delete(p),
    localStorageManager: { syncPathPrefix: 'virtual/' }, recordSyncCompleted: () => completed++,
    websocket: { SendMessage: () => sends++ },
  };
  if (op === 'configModify') await ops[op](`${base}/large.dict`, largePlugin, true);
  else await ops[op]({ path: `${base}/large.dict`, pageIndex: 1 }, largePlugin);
  assert.equal(reads, 0, `${op}: size limit checked before reading content`);
  assert.equal(sends, 0);
  assert.equal(ignored.size, 0);
  assert.equal(completed, op === 'receiveConfigUpload' ? 1 : 0);
}
// Dictionary text survives both upload entry points and receive/write without rewriting its contents.
const dictionary = '2\nhello\n自定义词\n';
const bytes = new TextEncoder().encode(dictionary);
for (const op of ['configModify', 'receiveConfigUpload']) {
  const sent = [], written = [];
  const transfer = {
    settings: { configSyncEnabled: true },
    app: { vault: { configDir, adapter: { exists: async () => true,
      stat: async () => ({ size: bytes.length, mtime: 1 }), readBinary: async () => bytes.buffer,
      write: async (p, text) => written.push([p, text]),
    } } },
    ignoredConfigFiles: new Set(), addIgnoredConfigFile: noop, removeIgnoredConfigFile: noop,
    pendingConfigModifies: new Map(), pendingConfigDeleteAcks: new Set(), lastSyncMtime: new Map(),
    configHashManager: { getPathHash: () => null, isReady: () => true, setFileHash: noop },
    localStorageManager: { syncPathPrefix: 'virtual/', savePending: noop },
    syncState: { pendingConfigPushPageIndex: new Map() }, configSyncTasks: { failed: 0 }, recordSyncCompleted: noop,
    concurrencyLimiter: { waitForSlot: async () => true }, websocket: { SendMessage: (_type, data) => sent.push(data) },
  };
  const target = `${base}/dictionaries/custom.dict`;
  if (op === 'configModify') await ops[op](target, transfer, true);
  else await ops[op]({ path: target, pageIndex: 1 }, transfer);
  assert.equal(sent.length, 1, op);
  assert.equal(sent[0].content, dictionary, op);
  assert.equal(sent[0].contentHash, 'dictionary-hash');
  transfer.pendingConfigModifies.clear();
  await ops.receiveConfigSyncModify(sent[0], transfer);
  assert.deepEqual(written, [[target, dictionary]]);
  assert.equal(transfer.configSyncTasks.failed, 0);
}
console.log('Plugin config resources: recursive scan/raw events, exclusions, upload size guards and text round trips passed');
