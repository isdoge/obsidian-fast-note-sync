import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 暗坑 #4 的前置：服务端回执是英文，界面不能出现中英混杂。
// Server receipts are English; the UI must never mix languages.
const root = path.resolve(import.meta.dirname, "..");

function loadModule(relPath) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console }, { filename: sourcePath });
  return module.exports;
}

const { formatGitSyncReceipt } = loadModule("src/lib/blog/firefly-receipt.ts");
assert.equal(typeof formatGitSyncReceipt, "function");

// 简易翻译器：把 key 与参数拼成可断言的形式
const tr = (key, params) => {
  if (!params) return `[${key}]`;
  return `[${key}]${JSON.stringify(params)}`;
};

// 1. 成功回执
assert.equal(
  formatGitSyncReceipt("Sync completed at 2026-11-20 10:00:00", tr),
  '[ui.firefly.receipt_sync_completed]{"time":"2026-11-20 10:00:00"}',
);

// 2. 跳过无效文章（带与不带明细）
assert.equal(
  formatGitSyncReceipt("skipped 2 invalid post(s): bad.md, worse.md", tr),
  '[ui.firefly.receipt_skipped]{"count":2,"detail":"bad.md, worse.md"}',
);
assert.equal(
  formatGitSyncReceipt("skipped 1 invalid post(s)", tr),
  '[ui.firefly.receipt_skipped_brief]{"count":1}',
);

// 3. 预览部署（带与不带明细，unified 前缀同样识别）
assert.equal(
  formatGitSyncReceipt("Preview deployed: https://blog.example.com", tr),
  '[ui.firefly.receipt_preview_deployed]{"detail":"https://blog.example.com"}',
);
assert.equal(
  formatGitSyncReceipt("Unified preview deployed: ok", tr),
  '[ui.firefly.receipt_preview_deployed]{"detail":"ok"}',
);
assert.equal(
  formatGitSyncReceipt("Preview deployed", tr),
  "[ui.firefly.receipt_preview_deployed_brief]",
);

// 4. 设置中心未确认 + 构建失败
assert.equal(
  formatGitSyncReceipt("Saved settings await confirmation", tr),
  "[ui.firefly.receipt_settings_pending]",
);
assert.equal(
  formatGitSyncReceipt("Preview deployment failed: exit code 1", tr),
  '[ui.firefly.receipt_deploy_failed]{"detail":"exit code 1"}',
);
assert.equal(
  formatGitSyncReceipt("Preview deployment failed.", tr),
  "[ui.firefly.receipt_deploy_failed_brief]",
);

// 5. 未知行原样保留；多行逐行处理；空输入返回空串
assert.equal(formatGitSyncReceipt("build log line", tr), "build log line");
assert.equal(
  formatGitSyncReceipt("Sync completed at 2026-11-20 10:00:00\nnpm WARN deprecated", tr),
  '[ui.firefly.receipt_sync_completed]{"time":"2026-11-20 10:00:00"}\nnpm WARN deprecated',
);
assert.equal(formatGitSyncReceipt("", tr), "");
assert.equal(formatGitSyncReceipt(null, tr), "");

// 6. 五语种都提供这些回执 key，且中文不再出现英文原句
const localeFiles = ["en.ts", "zh-CN.ts", "zh-TW.ts", "ja.ts", "ko.ts"];
const receiptKeys = [
  "ui.firefly.receipt_sync_completed",
  "ui.firefly.receipt_skipped",
  "ui.firefly.receipt_skipped_brief",
  "ui.firefly.receipt_preview_deployed",
  "ui.firefly.receipt_preview_deployed_brief",
  "ui.firefly.receipt_settings_pending",
  "ui.firefly.receipt_deploy_failed",
  "ui.firefly.receipt_deploy_failed_brief",
];
const localeMaps = new Map();
for (const file of localeFiles) {
  const mod = loadModule(`src/i18n/locales/${file}`);
  localeMaps.set(file, mod.default);
  for (const key of receiptKeys) {
    assert.equal(typeof mod.default[key], "string", `${file} has ${key}`);
    assert.ok(mod.default[key].length > 0, `${file} ${key} is non-empty`);
  }
}
assert.ok(localeMaps.get("zh-CN.ts")["ui.firefly.receipt_sync_completed"].includes("同步发布成功"));
assert.ok(!localeMaps.get("zh-CN.ts")["ui.firefly.receipt_sync_completed"].includes("Sync completed"));
assert.ok(localeMaps.get("en.ts")["ui.firefly.receipt_sync_completed"].startsWith("Published at"));

// 7. 发布入口全部经过本地化：状态卡片与 Notice 不再直接拼接英文回执
const modalSource = fs.readFileSync(path.join(root, "src/views/firefly-post-modal.ts"), "utf8");
assert.ok(!modalSource.includes('$("ui.firefly.publish_done", { msg: message || "" })'),
  "publish_done must not wrap a raw English receipt");
assert.ok(modalSource.includes("localizeReceipt("), "the modal localizes receipts");
const settingSource = fs.readFileSync(path.join(root, "src/setting.tsx"), "utf8");
assert.ok(settingSource.includes("formatGitSyncReceipt("), "the settings status card localizes receipts");

console.log("PASS: server Git-sync receipts are localized across all five locales");
