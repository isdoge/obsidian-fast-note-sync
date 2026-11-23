import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 内置系统垃圾文件排除：段精确匹配，不误伤正常文件名，白名单优先。
// Built-in system junk exclusion: segment-exact, no false positives, whitelist wins.

const root = path.resolve(import.meta.dirname, "..");

function loadModule(relPath, requireStub = () => ({}), extraGlobals = {}) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: requireStub,
    console,
    window: { setTimeout, clearTimeout },
    setTimeout,
    clearTimeout,
    Date,
    ...extraGlobals,
  });
  return module.exports;
}

// ─── Load helpers.ts (real path-exclusion logic) ──────────────────────────────
const helpers = loadModule(
  "src/lib/utils/helpers.ts",
  (id) => {
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
        return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: () => undefined, addLog: () => undefined }) } };
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
  },
  { activeDocument: undefined, crypto: { getRandomValues: (a) => a } }
);

const { isSystemJunkPath, isPathExcluded } = helpers;
assert.equal(typeof isSystemJunkPath, "function");
assert.equal(typeof isPathExcluded, "function");

// ─── Standalone predicate: exact segments only ────────────────────────────────
const shouldExclude = [
  ".DS_Store",
  "dir/.DS_Store",
  "dir\\Thumbs.db",
  "folder/desktop.ini",
  "Desktop.INI",
  "._photo.png",
  "folder/._note.md",
  "a/._photo.png",
  "x/._junkdir/note.md",
];
for (const p of shouldExclude) {
  assert.equal(isSystemJunkPath(p), true, `${p} must be treated as system junk`);
}

const shouldKeep = [
  "my._notes.md",
  "foo._.bar.md",
  "notes/.tmp/foo.md",
  ".temporary.md",
  "photo.png",
  "notes/.DS_Store.md",
  "notes/thumbs.db.md",
  "notesThumbs.db",
  "my.desktop.ini.md",
  "readme.md",
];
for (const p of shouldKeep) {
  assert.equal(isSystemJunkPath(p), false, `${p} must NOT be treated as system junk`);
}

// ─── Integration with isPathExcluded ─────────────────────────────────────────
function makePlugin(overrides = {}) {
  return {
    settings: {
      syncExcludeFolders: "",
      syncExcludeExtensions: "",
      syncExcludeWhitelist: "",
      ...overrides,
    },
  };
}

for (const p of shouldExclude) {
  assert.equal(isPathExcluded(p, makePlugin()), true, `isPathExcluded must drop ${p}`);
}
for (const p of shouldKeep) {
  assert.equal(isPathExcluded(p, makePlugin()), false, `isPathExcluded must keep ${p}`);
}

// `.tmp` is intentionally not excluded by default, but a user-configured extension still works.
assert.equal(isPathExcluded("notes/scratch.tmp", makePlugin()), false, ".tmp is not hard-excluded");
assert.equal(isPathExcluded("notes/scratch.tmp", makePlugin({ syncExcludeExtensions: "tmp" })), true, "user extension exclusion still applies");

// Whitelist has priority over the built-in junk rules.
const whitelistPlugin = makePlugin({
  syncExcludeWhitelist: ["dir/.DS_Store", "a/._photo.png", "Thumbs.db"].join("\n"),
});
assert.equal(isPathExcluded("dir/.DS_Store", whitelistPlugin), false, "whitelisted .DS_Store is allowed");
assert.equal(isPathExcluded("a/._photo.png", whitelistPlugin), false, "whitelisted AppleDouble file is allowed");
assert.equal(isPathExcluded("Thumbs.db", whitelistPlugin), false, "whitelisted Thumbs.db is allowed");
assert.equal(isPathExcluded("other/.DS_Store", whitelistPlugin), true, "non-whitelisted junk is still excluded");

console.log("PASS: system junk exclusions are segment-exact, whitelist-aware, and leave normal names alone");
