import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// P1-03: Firefly publish polling must read the server's lastStatus enum correctly.
// Server enum: 0 = Idle, 1 = Running, 2 = Success, 3 = Failed, 4 = Shutdown.
// - 1 (or a status/timestamp that has not advanced) -> keep waiting;
// - 2 -> success receipt;
// - 3 / 4 -> failure receipt.
// The old code treated any non-zero status with a message as a receipt and read `< 0` as failure,
// so a running build showed a "success" receipt and a failed build could be reported as success.
const root = path.resolve(import.meta.dirname, "..");

const noop = () => undefined;
const notices = [];
const localeKeys = [];

class Modal {
  constructor() { this.app = {}; }
  onOpen() {}
  onClose() {}
  close() {}
}
class TFile { constructor(p) { this.path = p; this.basename = p.replace(/\.md$/, ""); } }
class TFolder { constructor(p) { this.path = p; } }

// 让 pollStatus 的等待与截止时间都可控： setTimeout 立即回调，Date.now 每次推进 3s
// Make pollStatus' waits and deadline controllable: setTimeout fires immediately, Date.now advances 3s
let clock = 1_700_000_000_000;
class FakeDate extends Date {
  static now() { clock += 3000; return clock; }
}

function loadModule(relPath, requireStub, globals = {}) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    require: requireStub, module, exports: module.exports, console, Map, Set, Date: FakeDate, Promise, Array,
    setTimeout, clearTimeout,
    window: { setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 1; }, clearTimeout() {}, localStorage: { getItem: () => null, setItem() {} } },
    document: { createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }) },
    ...globals,
  });
  return module.exports;
}

const frontmatterStub = new Proxy({}, { get: (_t, key) => (key === "FIREFLY_CATEGORIES" ? [] : () => undefined) });
const assetsStub = new Proxy({}, { get: () => () => undefined });

const moduleExports = loadModule("src/views/firefly-post-modal.ts", (id) => {
  if (id === "obsidian") return { App: class {}, Modal, Setting: class {}, TFile, TFolder, normalizePath: (p) => p };
  if (id === "../i18n/lang") return { $: (key) => { localeKeys.push(key); return key; } };
  if (id === "../lib/utils/helpers") return { showSyncNotice: (message) => { notices.push(message); return { setMessage: (m) => notices.push(m), hide: noop }; }, dump: noop, dumpError: noop };
  if (id === "../lib/api/http_api_service") return {};
  if (id === "../lib/blog/firefly-frontmatter") return frontmatterStub;
  if (id === "../lib/blog/firefly-assets") return assetsStub;
  if (id === "../lib/blog/firefly-receipt") {
    // 回执本地化在 firefly-receipt.test.mjs 单独覆盖；这里只回显 key 便于断言分支
    return { formatGitSyncReceipt: (raw) => raw };
  }
  if (id === "../main") return {};
  if (id === "obsidian") return { Modal, TFile, TFolder, normalizePath: (p) => p };
  throw new Error(`Unexpected require in firefly-post-modal: ${id}`);
});

const { FireflyPostModal } = moduleExports;
assert.ok(FireflyPostModal, "FireflyPostModal is exported");

/** 构造一个只暴露 pollStatus 所需字段的实例 */
function makeModal(statusSequence) {
  let index = 0;
  const plugin = {
    settings: { vault: "v" },
    api: {
      getGitSyncStatus: async () => {
        const item = statusSequence[Math.min(index, statusSequence.length - 1)];
        index++;
        return { ok: true, status: 200, message: "", data: [item] };
      },
    },
  };
  const modal = Object.create(FireflyPostModal.prototype);
  modal.plugin = plugin;
  modal.busy = true;
  modal.lastReceipt = "";
  modal.render = noop;
  return modal;
}

const receipt = { setMessage: (m) => notices.push(m), hide: noop };
const config = (lastStatus, extra = {}) => ({
  id: 7, vault: "v", branch: "main", targetSubdir: "", isEnabled: true,
  lastStatus, lastMessage: "build output", updatedAt: "2026-11-20T10:00:00Z",
  lastSyncTime: "2026-11-20T10:00:00Z", ...extra,
});

// 1. Running (1) -> Success (2): the running poll must not be reported as a receipt.
{
  notices.length = 0;
  const modal = makeModal([config(1), config(2, { updatedAt: "2026-11-20T10:05:00Z" })]);
  await modal.pollStatus(7, { status: 0, updatedAt: "2026-11-20T09:00:00Z", lastSyncTime: "2026-11-20T09:00:00Z" }, receipt);
  assert.ok(notices.includes("ui.firefly.publish_done"), "status 2 ends with the success receipt");
  assert.ok(!notices.includes("ui.firefly.publish_deploy_failed"), "a successful build is not reported as failed");
  assert.equal(modal.lastReceipt, "ui.firefly.publish_done");
}

// 2. Running (1) -> Failed (3): the failure must be surfaced with its reason.
{
  notices.length = 0;
  const modal = makeModal([config(1), config(3, { updatedAt: "2026-11-20T10:06:00Z", lastMessage: "deploy error: bad frontmatter" })]);
  await modal.pollStatus(7, { status: 0, updatedAt: "2026-11-20T09:00:00Z", lastSyncTime: "2026-11-20T09:00:00Z" }, receipt);
  assert.ok(notices.includes("ui.firefly.publish_deploy_failed"), "status 3 ends with the failure receipt");
  assert.ok(!notices.includes("ui.firefly.publish_done"), "a failed build is never reported as success");
}

// 3. Shutdown (4) is a failure too.
{
  notices.length = 0;
  const modal = makeModal([config(1), config(4, { updatedAt: "2026-11-20T10:07:00Z" })]);
  await modal.pollStatus(7, { status: 0, updatedAt: "2026-11-20T09:00:00Z", lastSyncTime: "2026-11-20T09:00:00Z" }, receipt);
  assert.ok(notices.includes("ui.firefly.publish_deploy_failed"), "status 4 (shutdown) is a failure receipt");
}

// 4. A stale pre-trigger success status with unchanged timestamps is NOT this round's receipt.
{
  notices.length = 0;
  const modal = makeModal([config(2, { updatedAt: "2026-11-20T09:00:00Z", lastSyncTime: "2026-11-20T09:00:00Z" })]);
  await modal.pollStatus(7, { status: 2, updatedAt: "2026-11-20T09:00:00Z", lastSyncTime: "2026-11-20T09:00:00Z" }, receipt);
  assert.equal(modal.lastReceipt, "ui.firefly.publish_waiting", "an unchanged old status falls back to waiting");
  assert.ok(!notices.includes("ui.firefly.publish_done"), "the previous round's success is not claimed as this round's");
}

console.log("PASS: Firefly publish polling maps 1->2 success and 1->3/4 failure correctly");
