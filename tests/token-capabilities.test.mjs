// Token capability parsing + online-client failure classification.
// - A read-only token (or one missing a write bit) must be reported so the UI can warn early.
// - A 404 / malformed body from an older server must degrade to null (never a false warning).
// - The online-client list must distinguish "no admin permission" from "genuinely empty".
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(relPath, extra = {}) {
  const code = ts.transpileModule(fs.readFileSync(relPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    console,
    require: (id) => extra[id] ?? {},
  }, { filename: relPath });
  return module.exports;
}

const {
  parseTokenCapabilities,
  describeTokenWriteLimits,
  isVaultAllowedByToken,
  capabilitiesCacheKey,
  classifyWSClientsResponse,
} = load("src/lib/api/token_capabilities.ts");

const ALL_TRUE = {
  noteRead: true, noteWrite: true, fileRead: true, fileWrite: true,
  settingRead: true, settingWrite: true, vaultRead: true, vaultWrite: true,
};
const fullToken = (over = {}) => ({
  uid: 1, isAdmin: false, tokenId: "t1", protocol: "rest", restricted: false,
  vaults: [], permissions: { ...ALL_TRUE }, readOnly: false, ...over,
});

// ── parseTokenCapabilities: well-formed payload ────────────────────────────────
{
  const caps = parseTokenCapabilities(fullToken());
  assert.ok(caps);
  assert.equal(caps.readOnly, false);
  assert.equal(caps.permissions.noteWrite, true);
  assert.equal(caps.vaults.length, 0);
}

// Server-provided readOnly wins even when write bits look present
{
  const caps = parseTokenCapabilities(fullToken({ readOnly: true }));
  assert.equal(caps.readOnly, true);
}

// readOnly omitted → derived from the write bits
{
  const data = fullToken({ readOnly: undefined });
  const caps = parseTokenCapabilities(data);
  assert.equal(caps.readOnly, false);
  const ro = fullToken({ readOnly: undefined, permissions: { ...ALL_TRUE, noteWrite: false, fileWrite: false, settingWrite: false, vaultWrite: false } });
  assert.equal(parseTokenCapabilities(ro).readOnly, true);
}

// ── parseTokenCapabilities: unusable payloads degrade to null ─────────────────
assert.equal(parseTokenCapabilities(null), null);
assert.equal(parseTokenCapabilities(undefined), null);
assert.equal(parseTokenCapabilities("nope"), null);
assert.equal(parseTokenCapabilities({}), null);
assert.equal(parseTokenCapabilities({ permissions: {} }), null);
// A partial permission set must never be mistaken for an all-false read-only token
assert.equal(
  parseTokenCapabilities({ permissions: { noteRead: true, noteWrite: false } }),
  null,
);

// Non-string vault entries are dropped rather than crashing the UI
{
  const caps = parseTokenCapabilities(fullToken({ vaults: ["A", 3, null, "B"] }));
  assert.equal(caps.vaults.join(","), "A,B");
}

// ── describeTokenWriteLimits ─────────────────────────────────────────────────
const limitsOf = (caps) => { const l = describeTokenWriteLimits(caps); return `${l.readOnly}|${l.missingWrite.join(",")}`; };
assert.equal(limitsOf(null), "false|");
assert.equal(limitsOf(parseTokenCapabilities(fullToken())), "false|");

// Token missing only fileWrite: flagged read-only (uploads would be rejected) with the key listed
{
  const caps = parseTokenCapabilities(fullToken({
    permissions: { ...ALL_TRUE, fileWrite: false },
  }));
  assert.equal(limitsOf(caps), "true|fileWrite");
}

// Fully read-only token lists every missing write permission
{
  const caps = parseTokenCapabilities(fullToken({
    permissions: { ...ALL_TRUE, noteWrite: false, fileWrite: false, settingWrite: false, vaultWrite: false },
  }));
  assert.equal(limitsOf(caps), "true|noteWrite,fileWrite,settingWrite,vaultWrite");
}

// ── isVaultAllowedByToken ────────────────────────────────────────────────────
assert.equal(isVaultAllowedByToken(null, "doge"), true);
assert.equal(isVaultAllowedByToken(parseTokenCapabilities(fullToken({ vaults: [] })), "doge"), true);
{
  const caps = parseTokenCapabilities(fullToken({ vaults: ["work", "notes"] }));
  assert.equal(isVaultAllowedByToken(caps, "notes"), true);
  assert.equal(isVaultAllowedByToken(caps, "doge"), false);
}

// ── capabilitiesCacheKey: base URL + token decide the cache slot ─────────────
assert.notEqual(capabilitiesCacheKey("http://a", "t1"), capabilitiesCacheKey("http://a", "t2"));
assert.notEqual(capabilitiesCacheKey("http://a", "t1"), capabilitiesCacheKey("http://b", "t1"));
assert.equal(capabilitiesCacheKey("http://a/", "t1"), capabilitiesCacheKey("http://a", "t1"));

// ── classifyWSClientsResponse (vm realm: compare a flattened summary) ────────
const classify = (status, json) => {
  const r = classifyWSClientsResponse(status, json);
  return `${r.ok}|${r.failure}|${r.clients.length}|${r.clients.map((c) => c.clientName).join(",")}`;
};
// Admin with devices
assert.equal(classify(200, { code: 1, data: [{ uid: 1, clientName: "Mac" }] }), "true|null|1|Mac");

// Admin with no devices: genuinely empty, no failure
assert.equal(classify(200, { code: 1, data: [] }), "true|null|0|");

// Non-admin: server answers HTTP 200 + business code 411
assert.equal(classify(200, { code: 411, message: "Insufficient privileges" }), "false|no_admin|0|");

// Non-admin behind a gateway that returns a real 403
assert.equal(classify(403, null), "false|no_admin|0|");

// Scope-restricted token (315) also means "cannot see the list", not "empty"
assert.equal(classify(200, { code: 315 }), "false|no_admin|0|");

// Expired/invalid token
assert.equal(classify(401, null), "false|not_connected|0|");

// Other server errors are a plain load failure, never "no devices"
assert.equal(classify(500, null), "false|error|0|");
assert.equal(classify(200, { code: 302 }), "false|error|0|");

console.log("token-capabilities.test.mjs: all assertions passed");

// ── TokenCapabilitiesManager: cache, invalidation, silent degradation ────────
{
  const { TokenCapabilitiesManager } = load("src/lib/api/token_capabilities_manager.ts", {
    "./token_capabilities": {
      capabilitiesCacheKey,
      parseTokenCapabilities,
    },
  });
  let calls = 0;
  let nextResult = parseTokenCapabilities(fullToken());
  const plugin = {
    settings: { api: "http://server", apiToken: "token-a" },
    api: {
      getTokenCapabilities: async () => { calls++; return nextResult; },
    },
  };
  const mgr = new TokenCapabilitiesManager(plugin);

  // First call fetches, second call hits the cache
  await mgr.refresh();
  assert.equal(calls, 1);
  assert.ok(mgr.get());
  await mgr.refresh();
  assert.equal(calls, 1, "cached value must not refetch");

  // Switching the token invalidates the cache and refetches
  plugin.settings.apiToken = "token-b";
  mgr.invalidateIfConnectionChanged();
  assert.equal(mgr.get(), null);
  await mgr.refresh();
  assert.equal(calls, 2);

  // Old server (null result) must stay silent: no throw, cached value is null
  nextResult = null;
  plugin.settings.apiToken = "token-c";
  mgr.invalidateIfConnectionChanged();
  assert.equal(await mgr.refresh(), null);
  assert.equal(mgr.get(), null);
  assert.equal(calls, 3);

  // A throwing API also degrades to null without rejecting
  plugin.api.getTokenCapabilities = async () => { calls++; throw new Error("offline"); };
  plugin.settings.apiToken = "token-d";
  mgr.invalidateIfConnectionChanged();
  assert.equal(await mgr.refresh(), null);
  assert.equal(mgr.get(), null);

  // Force refresh bypasses the cache
  const before = calls;
  await mgr.refresh(true);
  assert.equal(calls, before + 1);

  // onChange listeners fire on refresh and clear
  let notified = 0;
  const off = mgr.onChange(() => { notified++; });
  plugin.settings.apiToken = "token-e";
  mgr.invalidateIfConnectionChanged();
  await mgr.refresh();
  assert.ok(notified >= 1);
  const afterRefresh = notified;
  mgr.clear();
  assert.equal(notified, afterRefresh + 1);
  off();
  mgr.clear();
  assert.equal(notified, afterRefresh + 1, "unsubscribed listener must not fire");
}

console.log("token-capabilities.test.mjs: cache/manager assertions passed");
