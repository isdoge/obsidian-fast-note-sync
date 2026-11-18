// #293 retry timers (watcher registration, websocket auth wait, lock requeue) are cleared by
// stop(), which also runs on plugin unload, so nothing fires against an unloaded plugin.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const noop = () => {};
const pending = new Map();
let nextId = 1;
const window = {
  setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { fn, ms }); return id; },
  clearTimeout: id => pending.delete(id),
};
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('src/lib/utils/events_manager.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
vm.runInNewContext(code, { module, exports: module.exports, console, window,
  require: id => id === 'obsidian' ? { Platform: {}, TFile: class {}, TFolder: class {}, Menu: class {}, MenuItem: class {}, normalizePath: x => x }
    : id.includes('helpers') ? { dump: noop, isPathInConfigSyncDirs: () => false }
    : id.includes('i18n') ? { $: k => k } : {} });
const { EventManager } = module.exports;

const unloadHooks = [];
const plugin = {
  fileHashManager: { isReady: () => false },
  register: fn => unloadHooks.push(fn),
  websocket: { isAuth: false },
  settings: {},
};
const em = new EventManager(plugin);
em.registerEvents();
assert.equal(pending.size, 1, 'registration retry scheduled while the hash map loads');
assert.equal(unloadHooks.length, 1, 'unload cleanup registered before registration succeeds');
// Fire one retry: still not ready, a new retry replaces it
const [[firstId, first]] = pending;
pending.delete(firstId);
first.fn();
assert.equal(pending.size, 1);
assert.equal(unloadHooks.length, 1, 'cleanup registered only once');

// Auth-wait retry (watchModify while the socket is not authed)
em.watchModify({ path: 'a.md' });
assert.equal(pending.size, 2, 'auth retry scheduled');

unloadHooks[0]();
assert.equal(pending.size, 0, 'unload clears every retry timer');
console.log('event retry timer cleanup tests passed');
