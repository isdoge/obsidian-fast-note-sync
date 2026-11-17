import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// #249 #269: a synced plugin data.json must not disable+enable the plugin (it writes device state back
// on load, looping between devices); the plugin is told to re-read settings instead. Code, style and
// manifest changes still reload.
const code = ts.transpileModule(fs.readFileSync("src/lib/sync/operator_config.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
let timer = null;
const module = { exports: {} };
vm.runInNewContext(code, { module, exports: module.exports, console,
  window: { setTimeout: fn => { timer = fn; return 1; }, clearTimeout() {} },
  require: id => id === "obsidian" ? { normalizePath: p => p }
    : id.includes("helpers") ? new Proxy({}, { get: () => () => undefined })
    : id.includes("sync_log_manager") ? { SyncLogManager: { getInstance: () => ({ addLog() {} }) } }
    : id.includes("i18n") ? { $: k => k } : {} });
const { configReload } = module.exports;

async function run(files) {
  const calls = [];
  const plugin = {
    isSyncing: false,
    configManager: { enabledPlugins: new Set(["thino"]) },
    app: { vault: { configDir: ".obsidian", getConfig() {}, setConfig() {} }, plugins: {
      enabledPlugins: new Set(["thino"]),
      plugins: { thino: { onExternalSettingsChange: () => calls.push("external") } },
      disablePlugin: async id => calls.push(`disable:${id}`),
      enablePlugin: async id => calls.push(`enable:${id}`),
    } },
  };
  for (const f of files) await configReload(`.obsidian/plugins/thino/${f}`, plugin, false, "{}");
  timer(); await new Promise(r => setImmediate(r));
  return [...calls];
}
assert.deepEqual(await run(["data.json"]), ["external"], "data.json alone only notifies the plugin");
assert.deepEqual(await run(["cache.json"]), [], "other data files neither reload nor notify");
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  assert.deepEqual(await run([f]), ["disable:thino", "enable:thino"], `${f} reloads`);
}
assert.deepEqual(await run(["data.json", "main.js"]), ["disable:thino", "enable:thino"], "code update with data reloads once");
console.log("config plugin reload tests passed");
