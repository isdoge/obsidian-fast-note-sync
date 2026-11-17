// F-5: an external settings change arriving while one is being applied is applied afterwards,
// not dropped; the follow-up run saves only if the settings still differ.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const noop = () => {};
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('src/main.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
// Every import resolves to an inert stub; only the method under test is exercised.
const stub = new Proxy(function () {}, { get: (t, k) => k === 'prototype' ? {} : stub, apply: () => stub, construct: () => ({}) });
vm.runInNewContext(code, { module, exports: module.exports, console, window: {},
  require: id => id === 'obsidian' ? { Plugin: class {}, Platform: {}, Notice: class {}, normalizePath: x => x, moment: stub }
    : new Proxy({}, { get: (_, k) => k === '__esModule' ? false : stub }) });
const FastSync = module.exports.default;
const { onExternalSettingsChange } = FastSync.prototype;

let disk = { a: 1 };
const saves = [];
let release;
const self = {
  settings: { a: 1 }, applyingExternalSettings: false, externalSettingsDirty: false,
  async loadSettings() {
    this.settings = { ...disk };
    if (!release) await new Promise(r => { release = r; });
  },
  async saveSettings() { saves.push({ ...this.settings }); },
};
disk = { a: 2 };
const first = onExternalSettingsChange.call(self);
await new Promise(r => setTimeout(r, 0));
// Second external change lands while the first is still loading
disk = { a: 3 };
await onExternalSettingsChange.call(self);
assert.equal(self.externalSettingsDirty, true, 'change during apply is remembered');
release();
await first;
assert.deepEqual(self.settings, { a: 3 }, 'the later external change is applied');
assert.deepEqual(saves, [{ a: 2 }, { a: 3 }]);
assert.equal(self.applyingExternalSettings, false);
// No further change: a call applies nothing new and does not save
await onExternalSettingsChange.call(self);
assert.equal(saves.length, 2, 'unchanged settings are not saved again');
console.log('external settings change tests passed');
