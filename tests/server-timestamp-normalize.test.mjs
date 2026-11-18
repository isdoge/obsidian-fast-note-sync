import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// haierkeys/fast-note-sync-service#461: legacy server rows may store ctime/mtime in seconds while
// the protocol (and Obsidian's vault API) expects milliseconds. A seconds value passed straight
// through makes the file look like a 1970 relic and forever "older" than any local copy. The
// receive-side guard multiplies (0, 1e11) by 1000 — the same threshold as the server's
// timex.NormalizeMilli — and leaves 0, negative, millisecond-scale and undefined values alone.
const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "src/lib/utils/helpers.ts"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(code, {
  module, exports: module.exports, console,
  window: { setTimeout: () => 1, clearTimeout: () => undefined },
  require(id) {
    if (id.includes("helpers_obsidian_bypass")) return { dump: () => undefined, dumpError: () => undefined, nativeFetch: async () => ({}), vaultDelete: async () => undefined, setLogEnabled: () => undefined, logLevel: "off" };
    return {};
  },
});
const { normalizeServerTimestamp } = module.exports;

assert.equal(normalizeServerTimestamp(0), 0, "zero stays zero (no mtime sentinel meaning)");
assert.equal(normalizeServerTimestamp(-5), -5, "negative values pass through untouched");
assert.equal(normalizeServerTimestamp(1651719914), 1651719914000, "a seconds-scale value is lifted to milliseconds");
assert.equal(normalizeServerTimestamp(1), 1000, "the smallest positive second normalizes");
assert.equal(normalizeServerTimestamp(99_999_999_999), 99_999_999_999_000, "just below the threshold still counts as seconds and is lifted");
assert.equal(normalizeServerTimestamp(100_000_000_000), 100_000_000_000, "the threshold itself is milliseconds (1973-03-03), unchanged");
assert.equal(normalizeServerTimestamp(1794558275139), 1794558275139, "a real millisecond timestamp passes through unchanged");
assert.equal(normalizeServerTimestamp(undefined), undefined, "undefined stays undefined (optional fields)");

console.log("server timestamp normalization tests passed");
