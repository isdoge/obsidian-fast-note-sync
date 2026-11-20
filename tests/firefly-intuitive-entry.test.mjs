import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 人类直觉入口：文件夹右键新建、Markdown/编辑器右键、FNS 菜单与设置页按钮，
// 以及新建弹窗的自由分类 + 草稿开关。
// Human-intuitive entries: folder right-click, Markdown/editor menus, FNS menu, settings
// buttons, plus the free-form category and draft switch in the create dialog.
const root = path.resolve(import.meta.dirname, "..");

const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// ── 1. 新建弹窗：自由分类（datalist）+ 草稿开关（默认关闭） ───────────────────
{
  const source = read("src/views/firefly-post-modal.ts");
  assert.ok(source.includes("attachCategorySuggestions"), "create/meta dialogs offer category suggestions");
  assert.ok(source.includes('createEl("datalist"'), "suggestions are a native datalist, so any category can be typed");
  assert.ok(source.includes("FIREFLY_CATEGORIES"), "common categories are still offered as suggestions");
  assert.ok(source.includes("initialDir?: string"), "the create dialog accepts a preset folder from the context menu");
  assert.ok(source.includes("this.dir = preset ||"), "the preset folder overrides the default blog dir");
  assert.ok(source.includes("private draft = false"), "the draft switch defaults to off");
  assert.ok(source.includes('$("ui.firefly.create_draft_desc")'), "the draft switch explains itself in plain words");
  assert.ok(source.includes("draft: this.draft"), "the switch is passed into the template");
  assert.ok(!source.includes("categoryCustom"), "the old locked-down category dropdown is gone");
  assert.ok(source.includes('$("ui.firefly.draft_hint")'), "draft posts get a gentle publish hint");
  assert.ok(source.includes("warnIfActivePostIsDraft"), "the hint is exported for the settings tab");
}

// ── 2. 右键菜单：文件夹 / Markdown / 编辑器 ─────────────────────────────────
{
  const source = read("src/lib/utils/events_manager.ts");
  assert.ok(source.includes("watchFolderMenu"), "folders get their own menu branch");
  assert.ok(/file instanceof TFolder[\s\S]*watchFolderMenu/.test(source), "file-menu routes TFolder to the folder branch");
  assert.ok(source.includes('$("ui.firefly.menu_create_in_folder")'), "folder menu offers 'new post here'");
  assert.ok(source.includes("new CreateFireflyPostModal(this.plugin.app, this.plugin, folder.path)"),
    "the folder path is prefilled into the create dialog");
  assert.ok(source.includes('app.workspace.on("editor-menu"'), "editor-menu is registered");
  assert.ok(source.includes("addFireflyFileMenuItems"), "file and editor menus share one item set");
  assert.ok(source.includes('$("ui.firefly.menu_create_in_dir")'), "Markdown menu offers 'new post in this directory'");
  assert.ok(source.includes("this.parentDirOf(file)"), "the note's parent directory is prefilled");
  for (const key of ["ui.firefly.menu_edit_meta", "ui.firefly.menu_check_post", "ui.firefly.menu_trigger_publish"]) {
    assert.ok(source.includes(key), `${key} is present in the file/editor menu`);
  }
  assert.ok(source.includes("fireflyMenuEnabled === false"), "all new entries respect the menu toggle");
}

// ── 3. FNS 菜单（状态栏 / 功能区） ─────────────────────────────────────────
{
  const source = read("src/lib/ui/menu_manager.ts");
  assert.ok(source.includes('$("ui.firefly.menu_create_post")'), "FNS menu offers 'new blog post'");
  assert.ok(source.includes("new CreateFireflyPostModal(this.plugin.app, this.plugin).open()"), "FNS menu opens the create dialog");
  assert.ok(source.includes("triggerFireflyPublish(this.plugin)"), "FNS menu offers 'publish now'");
}

// ── 4. 设置 → 博客发布页签：常用操作按钮 + 新手指引 ────────────────────────
{
  const source = read("src/setting.tsx");
  assert.ok(source.includes("renderBlogQuickActions"), "the blog tab renders a common-actions block");
  for (const key of [
    "setting.blog.action_create_post",
    "setting.blog.action_check_post",
    "setting.blog.action_publish_now",
    "setting.blog.action_open_blog",
    "setting.blog.action_open_webgui",
  ]) {
    assert.ok(source.includes(key), `${key} button is rendered`);
  }
  assert.ok(source.includes('$("setting.blog.tab_intro")'), "the tab explains the right-click workflow");
  assert.ok(source.includes('$("setting.blog.tab_intro_webhook")'), "the tab clarifies Webhook behaviour");
  assert.ok(source.includes("setting.blog.source_all"), "an empty sourceDir is labelled 'whole vault'");
  assert.ok(source.includes("setting.blog.filter_label"), "requireFrontmatter is shown as a labelled filter tag");
}

// ── 5. 五语种：所有新增 key 齐备且非空 ─────────────────────────────────────
{
  const newKeys = [
    "ui.firefly.menu_create_in_folder",
    "ui.firefly.menu_create_in_dir",
    "ui.firefly.menu_create_post",
    "ui.firefly.field_category_desc",
    "ui.firefly.create_category_placeholder",
    "ui.firefly.create_draft",
    "ui.firefly.create_draft_desc",
    "ui.firefly.draft_hint",
    "setting.blog.tab_intro",
    "setting.blog.tab_intro_webhook",
    "setting.blog.quick_actions",
    "setting.blog.action_create_post",
    "setting.blog.action_check_post",
    "setting.blog.action_publish_now",
    "setting.blog.action_open_blog",
    "setting.blog.action_open_webgui",
    "setting.blog.source_all",
    "setting.blog.filter_label",
  ];
  for (const file of ["en.ts", "zh-CN.ts", "zh-TW.ts", "ja.ts", "ko.ts"]) {
    const sourcePath = path.join(root, `src/i18n/locales/${file}`);
    const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, { module, exports: module.exports }, { filename: sourcePath });
    for (const key of newKeys) {
      assert.equal(typeof module.exports.default[key], "string", `${file} has ${key}`);
      assert.ok(module.exports.default[key].length > 0, `${file} ${key} is non-empty`);
    }
  }
}

console.log("PASS: intuitive blog entries (folders, files, editor, FNS menu, settings) and create dialog are wired");
