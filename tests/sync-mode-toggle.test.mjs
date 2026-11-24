// Read-only / manual sync mode quick toggles: toggling must flip exactly one flag, keep the
// settings object as the single source of truth (so the settings page and the menu/commands
// always agree), emit the right notice key, and disable the idle fallback timer in manual mode.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(relPath) {
  const code = ts.transpileModule(fs.readFileSync(relPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console }, { filename: relPath });
  return module.exports;
}

const {
  readSyncModes,
  toggleSyncMode,
  syncModeNoticeKey,
  effectiveIdleSyncMinutes,
} = load("src/lib/sync/sync_mode_control.ts");

// ── readSyncModes: only a literal true counts as enabled ─────────────────────────
// vm objects live in another realm, so compare fields instead of whole objects
const modes = (s) => { const m = readSyncModes(s); return `${m.readonly}/${m.manual}`; };
assert.equal(modes({}), "false/false");
assert.equal(modes(undefined), "false/false");
assert.equal(modes(null), "false/false");
assert.equal(modes({ readonlySyncEnabled: true, manualSyncEnabled: true }), "true/true");
// Truthy non-boolean garbage from a hand-edited data.json must not count as "on"
assert.equal(modes({ readonlySyncEnabled: "yes", manualSyncEnabled: 1 }), "false/false");

// ── toggleSyncMode: flips only the requested flag, returns the new value ────────
{
  const settings = { readonlySyncEnabled: false, manualSyncEnabled: false };
  assert.equal(toggleSyncMode(settings, "readonly"), true);
  assert.equal(settings.readonlySyncEnabled, true);
  assert.equal(settings.manualSyncEnabled, false);
  assert.equal(toggleSyncMode(settings, "manual"), true);
  assert.equal(settings.readonlySyncEnabled, true);
  assert.equal(settings.manualSyncEnabled, true);

  // Toggling back off works and leaves the other mode untouched
  assert.equal(toggleSyncMode(settings, "readonly"), false);
  assert.equal(settings.readonlySyncEnabled, false);
  assert.equal(settings.manualSyncEnabled, true);
  assert.equal(toggleSyncMode(settings, "manual"), false);
  assert.equal(settings.readonlySyncEnabled, false);
  assert.equal(settings.manualSyncEnabled, false);
}

// Missing keys are treated as off, then written as explicit booleans
{
  const settings = {};
  assert.equal(toggleSyncMode(settings, "manual"), true);
  assert.equal(settings.manualSyncEnabled, true);
  assert.equal("readonlySyncEnabled" in settings, false);
}

// ── syncModeNoticeKey: one distinct key per kind × state ───────────────────────
assert.equal(syncModeNoticeKey("readonly", true), "ui.mode.readonly_on");
assert.equal(syncModeNoticeKey("readonly", false), "ui.mode.readonly_off");
assert.equal(syncModeNoticeKey("manual", true), "ui.mode.manual_on");
assert.equal(syncModeNoticeKey("manual", false), "ui.mode.manual_off");

// ── effectiveIdleSyncMinutes: manual mode pauses scheduled triggers ────────────
assert.equal(effectiveIdleSyncMinutes({ manualSyncEnabled: false }, 15), 15);
assert.equal(effectiveIdleSyncMinutes({ manualSyncEnabled: true }, 15), 0);
assert.equal(effectiveIdleSyncMinutes({}, 0), 0);
// Read-only mode does not pause the timer (it still receives remote updates)
assert.equal(effectiveIdleSyncMinutes({ readonlySyncEnabled: true }, 30), 30);

// ── settings page and menu share one state: a toggle is visible to readSyncModes ─
{
  const pluginSettings = { readonlySyncEnabled: false, manualSyncEnabled: false };
  toggleSyncMode(pluginSettings, "readonly");
  // What the settings-page toggle would show (it reads the same field)
  assert.equal(pluginSettings.readonlySyncEnabled, true);
  // What the menu check mark / status bar read
  assert.equal(readSyncModes(pluginSettings).readonly, true);
}

console.log("sync-mode-toggle.test.mjs: all assertions passed");
