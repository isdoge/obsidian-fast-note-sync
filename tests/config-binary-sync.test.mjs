// #234 / #264: config-channel binary resources must survive a byte-exact round trip through
// the fns-bin-v1 envelopes, without stack overflows on multi-MB files and without changing
// hashes between the bytes on disk and the bytes carried on the wire.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const noop = () => {};

const load = (relPath, sandbox = {}) => {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(relPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, TextDecoder, TextEncoder,
    window: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: noop },
    ...sandbox,
  });
  return module.exports;
};

const codec = load("src/lib/utils/config_codec.ts");

const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature (contains NULs)
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0xff, 0xfe, 0xfd,
]);
const woff2Bytes = new Uint8Array([
  0x77, 0x4f, 0x46, 0x32, // 'wOF2'
  0x00, 0x01, 0x00, 0x00, 0xff, 0xff, 0x80, 0x81,
]);

const toU8 = (buffer) => new Uint8Array(buffer);
const assertRoundTrip = (name, bytes) => {
  const encoded = codec.encodeConfigContent(bytes);
  assert.ok(encoded.startsWith("fns-bin-v1:b64:"), `${name}: binary must use the b64 envelope`);
  const decoded = codec.decodeConfigContent(encoded);
  assert.equal(decoded.kind, "binary", `${name}: decoded kind`);
  assert.deepEqual(Array.from(toU8(decoded.bytes)), Array.from(bytes), `${name}: byte-exact round trip`);
  // Independent Base64 check against Node's implementation
  assert.deepEqual(Array.from(Buffer.from(encoded.slice("fns-bin-v1:b64:".length), "base64")), Array.from(bytes), `${name}: base64 payload`);
};

// 1. PNG / WOFF2 payloads survive byte-for-byte
assertRoundTrip("png", pngBytes);
assertRoundTrip("woff2", woff2Bytes);

// 2. Multi-MB binary arrays must not blow the call stack (chunked conversion)
const big = new Uint8Array(4 * 1024 * 1024 + 7);
for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
big[0] = 0; // ensure the NUL detector picks the binary path
assertRoundTrip("4MB binary", big);

// 3. Text starting with the envelope prefix is escaped, not mistaken for binary
const reservedText = "fns-bin-v1:this is ordinary text\n第二条";
const escaped = codec.encodeConfigContent(new TextEncoder().encode(reservedText));
assert.equal(escaped, `fns-bin-v1:esc:${reservedText}`);
const escapedDecoded = codec.decodeConfigContent(escaped);
assert.equal(escapedDecoded.kind, "text");
assert.equal(escapedDecoded.text, reservedText);

// 4. Plain JSON/CSS text is passed through unchanged
const json = '{\n  "theme": "Minimal",\n  "accentColor": "#ff8800"\n}\n';
assert.equal(codec.encodeConfigContent(new TextEncoder().encode(json)), json);
const jsonDecoded = codec.decodeConfigContent(json);
assert.equal(jsonDecoded.kind, "text");
assert.equal(jsonDecoded.text, json);

// 5. Invalid UTF-8 without NUL still takes the binary path
const invalidUtf8 = new Uint8Array([0x66, 0x6f, 0x6f, 0xff, 0xfe]);
const invalidEncoded = codec.encodeConfigContent(invalidUtf8);
assert.ok(invalidEncoded.startsWith("fns-bin-v1:b64:"));
assert.deepEqual(Array.from(toU8(codec.decodeConfigContent(invalidEncoded).bytes)), Array.from(invalidUtf8));

// 6. Hash consistency: the hash of raw disk bytes equals the hash of the bytes restored after
//    encode/decode, for both binary and text payloads (no ping-pong re-upload).
const helpers = load("src/lib/utils/helpers.ts", {
  require: (id) => {
      if (id.includes("baseline_scope")) return { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) };
    if (id.includes("conflict_store")) return { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" };
        if (id === "obsidian") return { Notice: class {}, normalizePath: (p) => p, TFolder: class {}, Platform: { isMobile: false } };
    if (id.includes("i18n")) return { $: (k) => k };
    if (id.includes("sync_log_manager")) return { SyncLogManager: { getInstance: () => ({ addLog: noop }) } };
    if (id.includes("helpers_obsidian_bypass")) {
      return { nativeFetch: noop, vaultDelete: noop, dump: noop, dumpError: noop, setLogEnabled: noop, logLevel: "off" };
    }
    return {};
  },
});

{
  const original = pngBytes.buffer.slice(0);
  const wire = codec.encodeConfigContent(original);
  const restored = codec.decodeConfigContent(wire);
  assert.equal(restored.kind, "binary");
  const before = await helpers.hashArrayBuffer(original);
  const after = await helpers.hashArrayBuffer(restored.bytes);
  assert.equal(after, before, "binary hash must be identical after the wire round trip");
}
{
  const original = new TextEncoder().encode(json).buffer;
  const wire = codec.encodeConfigContent(original);
  assert.equal(wire, json, "text stays plain");
  const restoredBytes = new TextEncoder().encode(codec.decodeConfigContent(wire).text).buffer;
  const before = await helpers.hashArrayBuffer(original);
  const after = await helpers.hashArrayBuffer(restoredBytes);
  assert.equal(after, before, "text hash must be identical after the wire round trip");
}

// 7. Decode leaves unrecognized plain text untouched and rejects corrupt Base64
const plainDecoded = codec.decodeConfigContent("plain");
assert.equal(plainDecoded.kind, "text");
assert.equal(plainDecoded.text, "plain");
assert.throws(() => codec.decodeConfigContent("fns-bin-v1:b64:@@@@"), /Invalid base64/);

// 8. End-to-end through the config operators: upload sends the envelope while hashing raw
//    bytes; receive restores bytes with writeBinary and records the sender's raw-byte hash.
const ops = load("src/lib/sync/operator_config.ts", {
  require: (id) => {
    if (id === "obsidian") return { normalizePath: (p) => p };
    if (id.includes("config_codec")) return codec;
    if (id.includes("helpers")) {
      return {
        dump: noop, dumpError: noop, showSyncNotice: noop,
        hashContent: (s) => `h:${s}`, hashFileAsync: async () => "raw-byte-hash",
        isPathInConfigSyncDirs: () => true, configIsPathExcluded: () => false,
        isInWhitelist: () => false, getSafeCtime: (s) => s.ctime ?? 1,
        isLargeBinarySyncRisk: () => false, checkAndNotifyCaseConflict: () => false,
        normalizeServerTimestamp: (v) => v,
      };
    }
    if (id.includes("sync_log_manager")) return { SyncLogManager: { getInstance: () => ({ addLog: noop }) } };
    if (id.includes("sync_state")) return { advanceLiveSyncTime: noop };
    if (id.includes("i18n")) return { $: (k) => k };
    if (id.includes("baseline_scope")) return { buildBaselineFields: (plugin, kind, path) => { if (kind === "folder" || !plugin) return {}; const m = kind === "setting" ? plugin.configHashManager : plugin.fileHashManager; const b = m && typeof m.getPathHash === "function" ? m.getPathHash(path) : null; return b !== null && b !== undefined ? { baseHash: b } : { baseHashMissing: true }; }, buildDeleteBaselineFields: () => ({}), baselineFieldsFromDeleteRecord: () => ({}), computeRemoteScope: () => "scope", parseScopedState: () => ({ state: { scope: "scope", revisions: {}, pendingDeletes: {} }, scopeChanged: false }), serializeScopedState: (state) => JSON.stringify(state) }; if (id.includes("conflict_store")) return { storeSyncConflict: async () => false, normalizeConflict: () => null, conflictKindToSyncType: () => "note", conflictReasonLabel: () => "", conflictKindLabel: () => "" }; 
    return {};
  },
});

{
  const target = ".obsidian/plugins/qa/blob.png";
  const sent = [];
  const written = [];
  const hashes = [];
  const adapter = {
    exists: async () => true,
    stat: async () => ({ size: pngBytes.length, mtime: 1234, ctime: 1000 }),
    readBinary: async () => pngBytes.buffer.slice(0),
    writeBinary: async (p, data) => { written.push({ p, bytes: new Uint8Array(data) }); },
    write: async (p, text) => { written.push({ p, text }); },
    mkdir: async () => {},
  };
  const ignored = new Set();
  const plugin = {
    settings: { configSyncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    app: { vault: { configDir: ".obsidian", adapter } },
    ignoredConfigFiles: ignored, addIgnoredConfigFile: (p) => ignored.add(p), removeIgnoredConfigFile: (p) => ignored.delete(p),
    pendingConfigModifies: new Map(), pendingConfigDeleteAcks: new Set(), lastSyncMtime: new Map(),
    localStorageManager: { syncPathPrefix: "__ls__/", savePending: noop },
    configHashManager: { isReady: () => true, getPathHash: () => null, setFileHash: (...args) => hashes.push(args) },
    concurrencyLimiter: { waitForSlot: async () => true },
    websocket: { SendMessage: (_type, data) => sent.push(data) },
    syncState: { pendingConfigPushPageIndex: new Map() },
    configSyncTasks: { failed: 0 }, recordSyncCompleted: noop,
  };

  await ops.configModify(target, plugin, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].content.startsWith("fns-bin-v1:b64:"), "upload carries the binary envelope");
  assert.equal(sent[0].contentHash, "raw-byte-hash", "contentHash still hashes the raw bytes");

  // Simulate the peer device: no local pending edit of its own
  plugin.pendingConfigModifies.clear();
  await ops.receiveConfigSyncModify({ ...sent[0], mtime: 1234, ctime: 1000, pageIndex: 1 }, plugin);
  assert.equal(written.length, 1);
  assert.equal(written[0].p, target);
  assert.deepEqual(Array.from(written[0].bytes), Array.from(pngBytes), "receiver restores the exact bytes with writeBinary");
  assert.equal(hashes.length, 1);
  assert.deepEqual(hashes[0], [target, "raw-byte-hash", 1234, pngBytes.length], "receiver records the raw-byte hash and on-disk size");
  ops.cleanupConfigReloadTimer();
}

console.log("Config binary sync: PNG/WOFF2 byte-exact round trips, 4MB no-stack-overflow, escape/plain passthrough, upload/receive integration and hash consistency passed");
