import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");

function loadTsModule(relPath, requireStub, globals = {}) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    require: requireStub,
    module,
    exports: module.exports,
    console,
    Date,
    Map,
    Set,
    URL,
    ...globals,
  }, { filename: sourcePath });
  return module.exports;
}

// 1. URL 规整与安全协议校验
const ff = loadTsModule("src/lib/blog/firefly-frontmatter.ts", () => {
  throw new Error("Unexpected require in firefly-frontmatter");
});

assert.equal(ff.normalizeBlogSiteUrl("  https://blog.example.com///  "), "https://blog.example.com");
assert.equal(ff.normalizeBlogSiteUrl("http://localhost:4321/"), "http://localhost:4321");
assert.equal(ff.normalizeBlogSiteUrl("   "), "");

assert.equal(ff.getSafeHttpUrl("https://blog.example.com/"), "https://blog.example.com");
assert.equal(ff.getSafeHttpUrl("http://127.0.0.1:4321/posts/"), "http://127.0.0.1:4321/posts");
assert.equal(ff.getSafeHttpUrl("javascript:alert(1)"), null, "javascript: scheme must be rejected");
assert.equal(ff.getSafeHttpUrl("file:///etc/passwd"), null, "file: scheme must be rejected");
assert.equal(ff.getSafeHttpUrl("data:text/html,<h1>x</h1>"), null, "data: scheme must be rejected");
assert.equal(ff.getSafeHttpUrl("ftp://example.com"), null, "ftp: scheme must be rejected");
assert.equal(ff.getSafeHttpUrl("https://"), null, "empty host must be rejected");
assert.equal(ff.getSafeHttpUrl("https://blog.example.com/a b"), null, "spaces must be rejected");
assert.equal(ff.getSafeHttpUrl("blog.example.com"), null, "missing scheme must be rejected");

// 2. 发布成功 Notice 联动（带/不带合法 fireflySiteUrl）
const syncNotices = [];
const richNotices = [];
const openedUrls = [];

class FakeNotice {
  constructor(message, duration) {
    richNotices.push({ message, duration });
  }
}

function makeFakeFrag() {
  const links = [];
  const texts = [];
  const frag = {
    links,
    texts,
    createDiv: () => ({
      createSpan: ({ text }) => { texts.push(text); },
      createEl: (tag, opts) => {
        const listeners = {};
        const el = {
          tag,
          ...opts,
          addEventListener: (ev, fn) => { listeners[ev] = fn; },
          click: () => listeners.click?.({ preventDefault() {} }),
        };
        links.push(el);
        return el;
      },
    }),
  };
  return frag;
}

const modalMod = loadTsModule(
  "src/views/firefly-post-modal.ts",
  (id) => {
    if (id === "obsidian") return { App: class {}, Modal: class {}, Notice: FakeNotice, Setting: class {}, TFile: class {}, normalizePath: (p) => p };
    if (id === "../i18n/lang") return { $: (key) => key };
    if (id === "../lib/utils/helpers") return { showSyncNotice: (msg, dur) => { syncNotices.push({ msg, dur }); return { setMessage() {}, hide() {} }; } };
    if (id === "../lib/api/http_api_service") return {};
    if (id === "../lib/blog/firefly-frontmatter") return ff;
    if (id === "../lib/blog/firefly-assets") return new Proxy({}, { get: () => () => undefined });
    if (id === "../main") return {};
    throw new Error(`Unexpected require: ${id}`);
  },
  {
    createFragment: (cb) => {
      const f = makeFakeFrag();
      cb(f);
      return f;
    },
    window: {
      open: (url, target, features) => openedUrls.push({ url, target, features }),
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout() {},
    },
  },
);

// 未配置博客地址 -> 回退普通通知
modalMod.showBlogPublishSuccessNotice({ settings: { fireflySiteUrl: "" } }, "done", 8000);
assert.equal(syncNotices.length, 1);
assert.equal(richNotices.length, 0);

// 非法协议 -> 回退普通通知，不渲染链接
modalMod.showBlogPublishSuccessNotice({ settings: { fireflySiteUrl: "javascript:alert(1)" } }, "done", 8000);
assert.equal(syncNotices.length, 2);
assert.equal(richNotices.length, 0);

// 合法地址 -> 生成带「打开博客」链接的 Notice，点击使用 noopener,noreferrer 打开规整 URL
modalMod.showBlogPublishSuccessNotice({ settings: { fireflySiteUrl: " https://blog.example.com/// " } }, "done", 12000);
assert.equal(richNotices.length, 1);
assert.equal(richNotices[0].duration, 12000);
assert.equal(richNotices[0].message.links.length, 1);
assert.equal(richNotices[0].message.links[0].attr.href, "https://blog.example.com");
richNotices[0].message.links[0].click();
assert.deepEqual(openedUrls, [{ url: "https://blog.example.com", target: "_blank", features: "noopener,noreferrer" }]);

// 3. 五语种 locale 文件 key 完全对齐
const localeFiles = ["en.ts", "zh-CN.ts", "zh-TW.ts", "ja.ts", "ko.ts"];
const localeMaps = new Map();
for (const file of localeFiles) {
  const mod = loadTsModule(`src/i18n/locales/${file}`, () => {
    throw new Error("Unexpected require in locale");
  });
  localeMaps.set(file, mod.default);
}

const enKeys = Object.keys(localeMaps.get("en.ts"));
assert.ok(enKeys.includes("setting.tab.blog"), "en.ts has setting.tab.blog");
assert.ok(enKeys.includes("ui.firefly.open_blog"), "en.ts has ui.firefly.open_blog");
for (const file of localeFiles) {
  const map = localeMaps.get(file);
  for (const key of enKeys) {
    assert.equal(typeof map[key], "string", `${file} is missing i18n key: ${key}`);
    assert.ok(map[key].length > 0, `${file} has empty value for key: ${key}`);
  }
}

// 4. setting.tsx 结构契约检查：页签顺序、搜索集成、从通用页签迁出
const settingSource = fs.readFileSync(path.join(root, "src/setting.tsx"), "utf8");
assert.match(
  settingSource,
  /SETTING_TAB_ORDER[^=]*=\s*\[[^\]]*"CLOUD",\s*"BLOG",\s*"DEBUG"/,
  "BLOG tab must be placed between CLOUD and DEBUG",
);
assert.ok(settingSource.includes("this.renderBlogSettings(contentEl, true)"), "renderAllSettings must include blog settings for search");
assert.ok(!settingSource.includes('setting.general.firefly_section'), "old firefly section must be moved out of General tab");

console.log("PASS: blog settings tab, URL guards, publish notice link, and 5-locale i18n keys verified");
