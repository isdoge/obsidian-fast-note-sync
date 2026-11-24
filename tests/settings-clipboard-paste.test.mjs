import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// #200: differentiate clipboard unavailable / read failed / invalid config,
// and support manual JSON paste through the same parse/validate/save pipeline.
const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "src", "views", "settings-view.tsx");
const source = fs.readFileSync(sourcePath, "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;

function loadSettingsViewModule(navigatorValue = {}) {
  let stateValues = [];
  let hookIndex = 0;
  let refValues = [];
  let refIndex = 0;

  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    console,
    window: { setTimeout: () => 1, clearTimeout() {} },
    navigator: navigatorValue,
    activeDocument: { body: {} },
    require(id) {
      if (id === "react") {
        return {
          useState(initial) {
            const idx = hookIndex++;
            if (!(idx in stateValues)) {
              stateValues[idx] = typeof initial === "function" ? initial() : initial;
            }
            const setState = next => {
              stateValues[idx] = typeof next === "function" ? next(stateValues[idx]) : next;
            };
            return [stateValues[idx], setState];
          },
          useEffect() {},
          useRef(initial) {
            const idx = refIndex++;
            if (!(idx in refValues)) {
              refValues[idx] = { current: initial };
            }
            return refValues[idx];
          },
          useCallback: fn => fn,
        };
      }
      if (id === "react/jsx-runtime") {
        return {
          jsx: (type, props) => ({ type, props }),
          jsxs: (type, props) => ({ type, props }),
          Fragment: Symbol("Fragment"),
        };
      }
      if (id === "react-dom") return { createPortal: node => node };
      if (id === "obsidian") return { setIcon() {} };
      if (id === "src/lib/utils/helpers_image") return { KofiImage: "", WXImage: "" };
      if (id === "src/lib/utils/helpers") return { dump() {} };
      if (id === "src/main") return {};
      if (id === "../lib/api/http_api_service") return {};
      if (id === "./note-history/lucide-icon") return { LucideIcon: () => null };
      if (id === "../lib/sync/conflict_store") return { resetConflictRecords: async () => {} };
      if (id === "../i18n/lang") return { $: key => key, getLocale: () => "en" };
      return {};
    },
  };
  vm.runInNewContext(code, context, { filename: sourcePath });
  return {
    exports: module.exports,
    context,
    renderComponent(Component, props) {
      hookIndex = 0;
      refIndex = 0;
      return Component(props);
    },
  };
}

function findNodes(node, predicate, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, predicate, acc);
    return acc;
  }
  if (predicate(node)) acc.push(node);
  const children = node.props?.children;
  if (children !== undefined) findNodes(children, predicate, acc);
  return acc;
}

function createPluginFixture() {
  let saveCalls = 0;
  let clearSyncTimeCalls = 0;
  let refreshCalls = 0;
  const plugin = {
    settings: {
      api: "https://old.example.com",
      apiToken: "old-token",
      vault: "old-vault",
    },
    wsSettingChange: false,
    clipboardReadTip: "",
    localStorageManager: {
      clearSyncTime() {
        clearSyncTimeCalls += 1;
      },
    },
    async saveAndReloadServices() {
      saveCalls += 1;
    },
    settingTab: {
      refresh() {
        refreshCalls += 1;
      },
    },
    websocket: {
      isConnected: () => false,
      addStatusListener() {},
      removeStatusListener() {},
    },
    api: {
      getUserInfo: async () => ({ username: "u", uid: 1 }),
      getSupportRecordsPage: async () => ({ list: [], pager: { page: 1, pageSize: 10, totalRows: 0 } }),
    },
  };
  return {
    plugin,
    getCounts: () => ({ saveCalls, clearSyncTimeCalls, refreshCalls }),
  };
}

const { exports: mod } = loadSettingsViewModule();

assert.equal(
  typeof mod.pasteRemoteConfigFromClipboard,
  "function",
  "settings-view.tsx must export pasteRemoteConfigFromClipboard"
);
assert.equal(
  typeof mod.importRemoteConfigFromText,
  "function",
  "settings-view.tsx must export importRemoteConfigFromText"
);

// 1. Clipboard API unavailable -> distinct status & tip, allow manual input, no settings change
{
  const { plugin, getCounts } = createPluginFixture();
  const result = await mod.pasteRemoteConfigFromClipboard(plugin, undefined);
  assert.equal(result.status, "clipboard_unavailable");
  assert.equal(result.message, "setting.remote.clipboard_unavailable");
  assert.equal(result.allowManualInput, true);
  assert.deepEqual(getCounts(), { saveCalls: 0, clearSyncTimeCalls: 0, refreshCalls: 0 });
  assert.equal(plugin.settings.api, "https://old.example.com");
}

// 2. Clipboard read denied/failed -> distinct status & tip, allow manual input, no settings change
{
  const { plugin, getCounts } = createPluginFixture();
  const deniedClipboard = {
    async readText() {
      throw new Error("NotAllowedError");
    },
  };
  const result = await mod.pasteRemoteConfigFromClipboard(plugin, deniedClipboard);
  assert.equal(result.status, "clipboard_read_failed");
  assert.equal(result.message, "setting.remote.clipboard_read_failed");
  assert.equal(result.allowManualInput, true);
  assert.deepEqual(getCounts(), { saveCalls: 0, clearSyncTimeCalls: 0, refreshCalls: 0 });
  assert.equal(plugin.settings.api, "https://old.example.com");
}

// 3. Clipboard read succeeded but content is invalid JSON or missing required fields
for (const invalidText of [
  "",
  "   ",
  "not-json",
  "[]",
  JSON.stringify({ api: "https://new.example.com" }),
  JSON.stringify({ api: "https://new.example.com", apiToken: "tok" }),
  JSON.stringify({ api: "", apiToken: "tok", vault: "v" }),
  JSON.stringify({ api: "https://new.example.com", apiToken: "", vault: "v" }),
  JSON.stringify({ api: "https://new.example.com", apiToken: "tok", vault: 123 }),
]) {
  const { plugin, getCounts } = createPluginFixture();
  const clipboard = { async readText() { return invalidText; } };
  const result = await mod.pasteRemoteConfigFromClipboard(plugin, clipboard);
  assert.equal(result.status, "invalid_config", `expected invalid_config for: ${invalidText}`);
  assert.equal(result.message, "setting.remote.invalid_config");
  assert.deepEqual(getCounts(), { saveCalls: 0, clearSyncTimeCalls: 0, refreshCalls: 0 });
}

// 4. Clipboard read valid JSON (including leading UTF-8 BOM + whitespace)
{
  const { plugin, getCounts } = createPluginFixture();
  const validJson = `${String.fromCharCode(0xfeff)}  {"api":"https://sync.example.com","apiToken":"secret-token","vault":"Notes"}  `;
  const result = await mod.pasteRemoteConfigFromClipboard(plugin, {
    async readText() {
      return validJson;
    },
  });
  assert.equal(result.status, "success");
  assert.equal(result.message, "setting.remote.paste_success");
  assert.equal(plugin.settings.api, "https://sync.example.com");
  assert.equal(plugin.settings.apiToken, "secret-token");
  assert.equal(plugin.settings.vault, "Notes");
  assert.equal(plugin.wsSettingChange, true);
  assert.equal(plugin.clipboardReadTip, "setting.remote.paste_success");
  assert.deepEqual(getCounts(), { saveCalls: 1, clearSyncTimeCalls: 1, refreshCalls: 1 });
}

// 5. Manual paste uses the exact same importRemoteConfigFromText validation & save pipeline
{
  const { plugin, getCounts } = createPluginFixture();
  const invalidResult = await mod.importRemoteConfigFromText(plugin, "{bad json");
  assert.equal(invalidResult.status, "invalid_config");
  assert.equal(invalidResult.message, "setting.remote.invalid_config");
  assert.deepEqual(getCounts(), { saveCalls: 0, clearSyncTimeCalls: 0, refreshCalls: 0 });

  const validResult = await mod.importRemoteConfigFromText(
    plugin,
    JSON.stringify({ api: "https://manual.example.com", apiToken: "manual-token", vault: "ManualVault" })
  );
  assert.equal(validResult.status, "success");
  assert.equal(validResult.message, "setting.remote.paste_success");
  assert.equal(plugin.settings.api, "https://manual.example.com");
  assert.equal(plugin.settings.apiToken, "manual-token");
  assert.equal(plugin.settings.vault, "ManualVault");
  assert.equal(plugin.wsSettingChange, true);
  assert.deepEqual(getCounts(), { saveCalls: 1, clearSyncTimeCalls: 1, refreshCalls: 1 });
}

// 6. SettingsView component UI flow: unavailable clipboard opens manual textarea, invalid keeps it open, valid applies & closes
{
  const ui = loadSettingsViewModule({});
  const { plugin, getCounts } = createPluginFixture();

  let tree = ui.renderComponent(ui.exports.SettingsView, { plugin });
  assert.equal(findNodes(tree, n => n.type === "textarea").length, 0, "manual textarea is hidden initially");

  const pasteBtn = findNodes(tree, n => n.type === "button" && n.props?.className === "fns-premium-btn")[0];
  pasteBtn.props.onClick();
  await new Promise(resolve => setImmediate(resolve));

  tree = ui.renderComponent(ui.exports.SettingsView, { plugin });
  const toast1 = findNodes(tree, n => typeof n.props?.className === "string" && n.props.className.includes("fns-paste-toast"))[0];
  assert.equal(toast1.props.children, "setting.remote.clipboard_unavailable");
  assert(toast1.props.className.includes("is-error"));
  const textarea1 = findNodes(tree, n => n.type === "textarea")[0];
  assert(textarea1, "manual textarea appears when clipboard API is unavailable");

  // Type invalid JSON and click Apply -> keeps textarea open & shows invalid_config tip
  textarea1.props.onChange({ target: { value: "{\"api\": \"only-api\"}" } });
  tree = ui.renderComponent(ui.exports.SettingsView, { plugin });
  const applyBtn1 = findNodes(tree, n => n.type === "button" && String(n.props?.className).includes("mod-cta"))[0];
  applyBtn1.props.onClick();
  await new Promise(resolve => setImmediate(resolve));

  tree = ui.renderComponent(ui.exports.SettingsView, { plugin });
  const toast2 = findNodes(tree, n => typeof n.props?.className === "string" && n.props.className.includes("fns-paste-toast"))[0];
  assert.equal(toast2.props.children, "setting.remote.invalid_config");
  const textarea2 = findNodes(tree, n => n.type === "textarea")[0];
  assert.equal(textarea2.props.value, "{\"api\": \"only-api\"}", "manual input text is preserved on invalid config");

  // Fix JSON and click Apply -> saves config, closes manual textarea, updates toast
  textarea2.props.onChange({
    target: { value: JSON.stringify({ api: "https://ui.example.com", apiToken: "ui-tok", vault: "UiVault" }) },
  });
  tree = ui.renderComponent(ui.exports.SettingsView, { plugin });
  const applyBtn2 = findNodes(tree, n => n.type === "button" && String(n.props?.className).includes("mod-cta"))[0];
  applyBtn2.props.onClick();
  await new Promise(resolve => setImmediate(resolve));

  tree = ui.renderComponent(ui.exports.SettingsView, { plugin });
  assert.equal(findNodes(tree, n => n.type === "textarea").length, 0, "manual textarea closes after successful apply");
  const toast3 = findNodes(tree, n => typeof n.props?.className === "string" && n.props.className.includes("fns-paste-toast"))[0];
  assert.equal(toast3.props.children, "setting.remote.paste_success");
  assert(!toast3.props.className.includes("is-error"));
  assert.equal(plugin.settings.api, "https://ui.example.com");
  assert.deepEqual(getCounts(), { saveCalls: 1, clearSyncTimeCalls: 1, refreshCalls: 1 });
}

console.log("Settings clipboard paste: unavailable/denied/invalid distinction, manual import, and UI flow passed");
