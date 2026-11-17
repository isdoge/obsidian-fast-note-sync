// #164: when vault lives inside a syncing folder such as OneDrive that locks files/directories
// (EPERM on rmdir / mkdir), clearAllTempChunks must log and continue instead of rejecting with
// an unhandled promise rejection, fall back to removing deletable entries inside temp-chunks,
// and ensure the temp-chunks directory exists afterwards.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const noop = () => {};
const errors = [];
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync("src/lib/sync/operator_file.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
vm.runInNewContext(code, {
  module, exports: module.exports, console, window: { setTimeout: () => 1, clearTimeout: noop },
  require: id => id === "obsidian" ? { normalizePath: p => p, TFile: class {}, Platform: { isMobile: false } }
    : id.includes("helpers") ? new Proxy({
      dump: noop,
      dumpError: (...a) => errors.push(a),
      getPluginDir: () => ".obsidian/plugins/fast-note-sync",
    }, { get: (t, k) => t[k] ?? noop })
    : id.includes("sync_log_manager") ? { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } }
    : id.includes("i18n") ? { $: k => k }
    : {},
});
const { clearAllTempChunks, getTempChunksDir } = module.exports;

// Scenario 1: rmdir(temp-chunks, true) fails with EPERM; one nested file can be deleted, another is locked
{
  errors.length = 0;
  const dirs = new Set([
    ".obsidian/plugins/fast-note-sync/temp-chunks",
    ".obsidian/plugins/fast-note-sync/temp-chunks/sess-ok",
    ".obsidian/plugins/fast-note-sync/temp-chunks/sess-locked",
  ]);
  const files = new Set([
    ".obsidian/plugins/fast-note-sync/temp-chunks/root-deletable.bin",
    ".obsidian/plugins/fast-note-sync/temp-chunks/sess-ok/0.bin",
    ".obsidian/plugins/fast-note-sync/temp-chunks/sess-locked/0.bin",
  ]);
  const eperm = (p, op) => Object.assign(new Error(`EPERM: operation not permitted, ${op} '${p}'`), { code: "EPERM" });
  const adapter = {
    exists: async p => dirs.has(p) || files.has(p),
    list: async p => ({
      files: [...files].filter(f => f.slice(0, f.lastIndexOf("/")) === p),
      folders: [...dirs].filter(d => d !== p && d.slice(0, d.lastIndexOf("/")) === p),
    }),
    remove: async p => {
      if (p.includes("sess-locked")) throw eperm(p, "unlink");
      files.delete(p);
    },
    rmdir: async (p) => {
      if (p === ".obsidian/plugins/fast-note-sync/temp-chunks" || p.includes("sess-locked")) {
        throw eperm(p, "rmdir");
      }
      dirs.delete(p);
    },
    mkdir: async p => { dirs.add(p); },
  };
  const plugin = { app: { vault: { configDir: ".obsidian", adapter } }, manifest: { dir: ".obsidian/plugins/fast-note-sync" } };
  await clearAllTempChunks(plugin);
  assert.equal(dirs.has(getTempChunksDir(plugin)), true, "temp-chunks dir still exists");
  assert.equal(files.has(".obsidian/plugins/fast-note-sync/temp-chunks/root-deletable.bin"), false, "deletable root file removed on fallback");
  assert.equal(files.has(".obsidian/plugins/fast-note-sync/temp-chunks/sess-ok/0.bin"), false, "deletable nested file removed on fallback");
  assert.equal(dirs.has(".obsidian/plugins/fast-note-sync/temp-chunks/sess-ok"), false, "empty unlocked session dir removed");
  assert.equal(files.has(".obsidian/plugins/fast-note-sync/temp-chunks/sess-locked/0.bin"), true, "locked file tolerated");
  assert.ok(errors.length > 0, "EPERM failures are logged");
}

// Scenario 2: rmdir succeeds, but mkdir throws EPERM — must log and not reject
{
  errors.length = 0;
  let exists = true;
  const adapter = {
    exists: async () => exists,
    rmdir: async () => { exists = false; },
    mkdir: async p => { throw Object.assign(new Error(`EPERM: mkdir '${p}'`), { code: "EPERM" }); },
  };
  const plugin = { app: { vault: { configDir: ".obsidian", adapter } }, manifest: { dir: ".obsidian/plugins/fast-note-sync" } };
  await clearAllTempChunks(plugin);
  assert.ok(errors.length > 0, "mkdir failure is logged without throwing");
}

console.log("temp-chunks cleanup tests passed");
