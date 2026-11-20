import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Stage B: baseline provenance isolation.
// - A startup scan / manual rebuild only fills the disk-hash cache and never fabricates a
//   trusted sync baseline.
// - Baselines written by server-confirmed moments are marked confirmed and stay trusted.
// - Legacy persisted baselines (no provenance table) are trusted only while the local content
//   still equals the recorded value; otherwise the path counts as having no baseline.
const root = path.resolve(import.meta.dirname, "..");

function transpile(relPath) {
  const sourcePath = path.join(root, relPath);
  const source = fs.readFileSync(sourcePath, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
}

function loadModule(relPath, requireStub, extraGlobals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(relPath), {
    require: requireStub, module, exports: module.exports, console,
    window: { setTimeout: () => 1, clearTimeout() {} }, setTimeout, clearTimeout,
    ...extraGlobals,
  });
  return module.exports;
}

const helpers = loadModule("src/lib/utils/helpers.ts", (id) => {
  switch (id) {
    case "obsidian":
      return { Notice: class { setMessage() {} hide() {} }, normalizePath: (p) => p, TFolder: class {}, Platform: { isMobile: false }, App: class {} };
    case "../../i18n/lang":
      return { $: (key) => key };
    case "../../main":
      return {};
    case "../sync/sync_log_manager":
      return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: () => undefined }) } };
    case "../helpers_obsidian_bypass":
      return { nativeFetch: () => undefined, vaultDelete: () => undefined, dump: () => undefined, dumpError: () => undefined, setLogEnabled: () => undefined, logLevel: () => undefined };
    default:
      throw new Error(`Unexpected require in helpers: ${id}`);
  }
}, { activeDocument: undefined, crypto: { getRandomValues: (a) => a } });

const { FileHashManager } = loadModule("src/lib/storage/file_hash_manager.ts", (id) => {
  if (id === "../utils/helpers") return helpers;
  if (id === "../../i18n/lang") return { $: (k) => k };
  if (id === "../../main") return {};
  throw new Error(`Unexpected require in file_hash_manager: ${id}`);
});

function makePlugin(ls, files, vaultFiles = []) {
  return {
    manifest: { id: "fast-note-sync", dir: ".obsidian/plugins/fast-note-sync" },
    settings: {},
    app: {
      loadLocalStorage: (k) => (ls.has(k) ? ls.get(k) : null),
      saveLocalStorage: (k, v) => ls.set(k, String(v)),
      vault: {
        configDir: ".obsidian",
        getName: () => "V",
        getFiles: () => vaultFiles,
        read: async () => "local bytes",
        adapter: {
          exists: async (p) => files.has(p),
          read: async (p) => (files.has(p) ? files.get(p) : (() => { throw new Error("ENOENT"); })()),
          write: async (p, d) => { files.set(p, d); },
        },
      },
    },
  };
}

// 1. Cold scan of a populated vault: disk cache filled, trusted baseline stays empty.
{
  const ls = new Map(), files = new Map();
  const vaultFiles = [
    { path: "notes/alpha.md", extension: "md", stat: { ctime: 1, mtime: 10, size: 11 } },
    { path: "notes/beta.md", extension: "md", stat: { ctime: 1, mtime: 10, size: 11 } },
  ];
  const mgr = new FileHashManager(makePlugin(ls, files, vaultFiles));
  await mgr.initialize();
  mgr.flush();
  assert.equal(mgr.getPathHash("notes/alpha.md"), null, "scan does not fabricate a baseline");
  assert.notEqual(mgr.getValidHash("notes/alpha.md", 10, 11), null, "scan still fills the disk-hash cache");
  assert.equal(mgr.getBaselineProvenance("notes/alpha.md", null), "none", "no provenance without a baseline");
  assert.equal(JSON.parse(ls.get("fns-syncHashMap") || "{}")["notes/alpha.md"], undefined, "baseline table is persisted empty");
}

// 2. Server-confirmed Ack establishes a trusted baseline, and it survives a restart.
{
  const ls = new Map(), files = new Map();
  const first = new FileHashManager(makePlugin(ls, files));
  await first.initialize();
  first.setFileHash("notes/gamma.md", "ack-hash", 42, 5);
  first.flush();
  assert.equal(first.getPathHash("notes/gamma.md"), "ack-hash");
  assert.equal(first.getBaselineProvenance("notes/gamma.md", "something-else"), "confirmed", "confirmed baselines do not need local equality");

  const second = new FileHashManager(makePlugin(ls, files));
  await second.initialize();
  assert.equal(second.getVerifiedPathHash("notes/gamma.md", "different-local"), "ack-hash", "confirmation survives restart");
  assert.equal(second.getBaselineProvenance("notes/gamma.md", "different-local"), "confirmed");
}

// 3. Manual rebuild is not server confirmation.
{
  const ls = new Map(), files = new Map();
  const vaultFiles = [{ path: "notes/delta.md", extension: "md", stat: { ctime: 1, mtime: 3, size: 5 } }];
  const mgr = new FileHashManager(makePlugin(ls, files, vaultFiles));
  await mgr.initialize();
  mgr.setFileHash("notes/old.md", "confirmed-old", 1, 1);
  await mgr.rebuildHashMap();
  assert.equal(mgr.getPathHash("notes/old.md"), "confirmed-old", "rebuild keeps already-confirmed baselines untouched");
  assert.equal(mgr.getPathHash("notes/delta.md"), null, "rebuild does not create baselines from scanned bytes");
}

// 4. Legacy upgrade: persisted syncHashMap without a provenance table. A path whose local
// content still equals the recorded value is trusted (persisted_verified); a path whose local
// content diverged is NOT a trusted baseline, so a remote modify must not overwrite it.
{
  const ls = new Map(), files = new Map();
  ls.set("fns-syncHashMap", JSON.stringify({ "a/same.md": "same-hash", "a/drift.md": "old-hash" }));
  ls.set("fns-fileHashMap", JSON.stringify({
    "a/same.md": { hash: "same-hash", mtime: 1, size: 3 },
    "a/drift.md": { hash: "new-hash", mtime: 2, size: 3 },
  }));
  const mgr = new FileHashManager(makePlugin(ls, files));
  await mgr.initialize();
  assert.equal(mgr.getPathHash("a/same.md"), "same-hash", "legacy baseline is still returned raw for filtering");
  assert.equal(mgr.getVerifiedPathHash("a/same.md", "same-hash"), "same-hash", "equal local content verifies a legacy baseline");
  assert.equal(mgr.getBaselineProvenance("a/same.md", "same-hash"), "persisted_verified");
  assert.equal(mgr.getVerifiedPathHash("a/drift.md", "new-hash"), null, "diverged local content voids the legacy baseline");
  assert.equal(mgr.getBaselineProvenance("a/drift.md", "new-hash"), "unverified");
  assert.equal(mgr.getVerifiedPathHash("a/missing.md", "whatever"), null, "a path absent from the baseline table has no baseline");
}

// 5. Removing a path also clears its provenance (no resurrection as "confirmed").
{
  const ls = new Map(), files = new Map();
  const mgr = new FileHashManager(makePlugin(ls, files));
  await mgr.initialize();
  mgr.setFileHash("n/x.md", "h1", 1, 1);
  mgr.removeFileHash("n/x.md");
  assert.equal(mgr.getPathHash("n/x.md"), null);
  mgr.setFileHash("n/x.md", "h1", 1, 1);
  assert.equal(mgr.getBaselineProvenance("n/x.md", null), "confirmed", "a fresh confirmed write re-establishes provenance");
  mgr.clearAll();
  assert.equal(mgr.getPathHash("n/x.md"), null, "clearAll removes baselines");
  assert.equal(JSON.parse(ls.get("fns-syncHashMapConfirmed") || "[]").length, 0, "clearAll removes provenance too");
}

console.log("baseline-provenance.test.mjs: all scenarios passed");
