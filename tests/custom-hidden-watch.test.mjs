import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const noop = () => {};
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('src/lib/sync/config_manager.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
vm.runInNewContext(code, { module, exports: module.exports, console,
  require: id => id === 'obsidian' ? { normalizePath: p => p.replace(/\/$/, '') }
    : id.includes('helpers') ? new Proxy({ getConfigSyncCustomDirs: p => p.settings.dirs,
        configIsPathExcluded: p => p.includes('excluded') }, { get: (t, k) => t[k] ?? noop }) : {} });
const watched = [];
const adapter = { watchHiddenRecursive: async function (p) {
  assert.equal(this, adapter, 'adapter method retains its receiver');
  if (p === '.broken') throw new Error('cannot watch');
  watched.push(p);
} };
const ConfigManager = module.exports.ConfigManager;
ConfigManager.prototype.loadEnabledPlugins = async () => {};
ConfigManager.prototype.initializeFileStates = async () => {};
const plugin = { manifest: { dir: '.obsidian/plugins/fast-note-sync' }, settings: { configSyncEnabled: true, dirs: [
  '.agents/', '.agents', 'normal/.hidden', '.broken', '.later', 'normal',
  '.obsidian', '.obsidian/plugins', '.trash', '.git', '.excluded', '../outside', '/outside', '.agents/**',
] }, app: { vault: { adapter, configDir: '.obsidian' } } };
const manager = new ConfigManager(plugin);
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(watched, ['.agents', 'normal/.hidden', '.later'], 'custom hidden directories get recursive raw watchers');
manager.plugin.settings.configSyncEnabled = false;
await manager.watchCustomDirs();
assert.equal(watched.length, 3, 'disabled sync does not register watches');
manager.plugin.settings.configSyncEnabled = true;
delete adapter.watchHiddenRecursive;
await manager.watchCustomDirs();
console.log('Custom hidden watchers: registration, filtering, failure isolation and unsupported adapter passed');
