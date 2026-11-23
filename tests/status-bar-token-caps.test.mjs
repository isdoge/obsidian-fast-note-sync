import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// The status-bar mode indicator must not call a partially write-limited token "read-only".
// A token that is only missing some write bits shows the missing permissions instead, matching
// the menu banner's wording; a genuinely read-only token keeps the "read-only" label.
const root = path.resolve(import.meta.dirname, '..');

function load(relPath, extra = {}) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set, Promise, JSON,
    require: (id) => extra[id] ?? {},
  }, { filename: sourcePath });
  return module.exports;
}

const tokenModule = load('src/lib/api/token_capabilities.ts');
const syncModeModule = load('src/lib/sync/sync_mode_control.ts');

function element() {
  const attributes = new Map();
  return {
    classes: new Set(),
    text: '',
    icon: null,
    addClass(name) { this.classes.add(name); },
    removeClass(name) { this.classes.delete(name); },
    setText(value) { this.text = value; },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
  };
}

const { StatusBarManager } = load('src/lib/ui/status_bar_manager.ts', {
  'obsidian': { setIcon: (target, icon) => { target.icon = icon; } },
  '../sync/sync_mode_control': syncModeModule,
  '../api/token_capabilities': tokenModule,
  '../../i18n/lang': { $: (key, vars) => vars?.perms ? `${key}:${vars.perms}` : key },
});

const ALL_TRUE = {
  noteRead: true, noteWrite: true, fileRead: true, fileWrite: true,
  settingRead: true, settingWrite: true, vaultRead: true, vaultWrite: true,
};

function render(caps, settings = {}) {
  const item = element();
  const icon = element();
  const text = element();
  const manager = new StatusBarManager({
    settings: { vault: 'v1', ...settings },
    tokenCapabilities: { get: () => caps },
  });
  manager.statusBarModeItem = item;
  manager.statusBarModeIcon = icon;
  manager.statusBarModeText = text;
  manager.renderModeIndicators();
  return { item, icon, text };
}

// 1. A token missing only noteWrite (files still writable) is not read-only: report the gap
{
  const caps = tokenModule.parseTokenCapabilities({
    uid: 1, isAdmin: false, tokenId: 't', protocol: 'rest', restricted: false, vaults: [],
    permissions: { ...ALL_TRUE, noteWrite: false }, readOnly: false,
  });
  const { text, item } = render(caps);
  assert.equal(item.classes.has('fns-hidden'), false);
  assert.ok(text.text.includes('ui.mode.token_missing_write'), text.text);
  assert.ok(text.text.includes('noteWrite'), text.text);
  assert.ok(!text.text.includes('ui.mode.status_token_readonly'), 'a partial write limit is not "read-only"');
}

// 2. A genuinely read-only token keeps the read-only label
{
  const caps = tokenModule.parseTokenCapabilities({
    uid: 1, isAdmin: false, tokenId: 't', protocol: 'rest', restricted: false, vaults: [],
    permissions: { ...ALL_TRUE, noteWrite: false, fileWrite: false }, readOnly: true,
  });
  const { text } = render(caps);
  assert.ok(text.text.includes('ui.mode.status_token_readonly'), text.text);
  assert.ok(!text.text.includes('ui.mode.token_missing_write'));
}

// 3. Missing noteWrite/fileWrite without a server readOnly flag reports the missing bits, not "read-only"
{
  const caps = tokenModule.parseTokenCapabilities({
    uid: 1, isAdmin: false, tokenId: 't', protocol: 'rest', restricted: false, vaults: [],
    permissions: { ...ALL_TRUE, noteWrite: false, fileWrite: false }, readOnly: undefined,
  });
  const { text } = render(caps);
  assert.ok(text.text.includes('ui.mode.token_missing_write'), text.text);
  assert.ok(text.text.includes('noteWrite'), text.text);
  assert.ok(!text.text.includes('ui.mode.status_token_readonly'));
}

// 4. No capability info and no modes: the indicator hides itself
{
  const { item, text } = render(null);
  assert.equal(item.classes.has('fns-hidden'), true);
  assert.equal(text.text, '');
}

console.log('PASS: status bar distinguishes a partially write-limited token from a read-only one');
