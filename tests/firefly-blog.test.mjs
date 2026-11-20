import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// v2.6.5 Firefly blog support: frontmatter dates, stable slugs, build-blocking
// validation, author-review stripping and image rewriting must all hold without
// touching Obsidian (pure module, loaded here the same way other tests load src).
const root = path.resolve(import.meta.dirname, "..");

function loadModule(relPath) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, Date, Map, Set }, { filename: sourcePath });
  return module.exports;
}

const ff = loadModule("src/lib/blog/firefly-frontmatter.ts");
// Values come from another vm realm; copy them before strict comparison.
const plain = (value) => JSON.parse(JSON.stringify(value));

// ── formatLocalDate ──────────────────────────────────────────────────────────
{
  assert.equal(ff.formatLocalDate(new Date(2026, 10, 20)), "2026-11-20", "local date is zero padded");
  assert.equal(ff.formatLocalDate(new Date(2026, 0, 5)), "2026-01-05", "single digit month/day padded");
  assert.match(ff.formatLocalDate(), /^\d{4}-\d{2}-\d{2}$/, "default argument uses today");
  assert.notEqual(ff.formatLocalDate(), "YYYY-MM-DD", "never emits the literal template placeholder");
}

// ── date validation ──────────────────────────────────────────────────────────
{
  assert.equal(ff.isValidFireflyDate("2026-10-20"), true);
  assert.equal(ff.isValidFireflyDate("YYYY-MM-DD"), false, "template placeholder is rejected");
  assert.equal(ff.isValidFireflyDate(""), false, "empty string is rejected");
  assert.equal(ff.isValidFireflyDate("2026-02-31"), false, "impossible calendar date is rejected");
  assert.equal(ff.isValidFireflyDate("2026-13-01"), false, "month 13 is rejected");
  assert.equal(ff.isValidFireflyDate(new Date(2026, 9, 20)), true, "Date objects are accepted");
}

// ── stable slug generation ──────────────────────────────────────────────────
{
  const a = ff.generateFireflySlug("01-代理与网络", "Clash 新手使用教程：从下载安装到订阅导入");
  const b = ff.generateFireflySlug("01-代理与网络", "Clash 新手使用教程：从下载安装到订阅导入");
  assert.equal(a, b, "same category + title always yields the same slug");
  assert.ok(a.startsWith("experience/"), `slug must start with experience/ (got ${a})`);
  assert.ok(!/[A-Z]/.test(a), "slug is lower-case");
  assert.ok(!/[\s:：、，]/.test(a), "slug has no spaces or CJK punctuation");
  assert.ok(!a.includes("//"), "slug has no empty path segments");
  assert.equal(ff.generateFireflySlug("", ""), "experience/未分类/untitled", "empty inputs fall back safely");
  assert.equal(ff.isExperienceSlug(a), true);
  assert.equal(ff.isExperienceSlug("tools/foo"), false);
}

// ── validation: blocking errors ─────────────────────────────────────────────
{
  const base = "---\ntitle: 测试文章\nslug: experience/topic/x\npublished: 2026-10-20\n---\n正文";

  const ok = ff.validateFireflyPostContent({ titleFromFilename: "测试文章", content: base });
  assert.equal(ok.ok, true, "a well-formed post passes");
  assert.equal(ok.errors.length, 0);

  const placeholder = ff.validateFireflyPostContent({
    titleFromFilename: "测试文章",
    content: base.replace("published: 2026-10-20", "published: YYYY-MM-DD"),
  });
  assert.equal(placeholder.ok, false, "YYYY-MM-DD placeholder blocks the build");
  assert.ok(placeholder.errors.some((i) => i.code === "invalid_published_format"));

  const missingPublished = ff.validateFireflyPostContent({
    titleFromFilename: "测试文章",
    content: base.replace("published: 2026-10-20\n", ""),
  });
  assert.ok(missingPublished.errors.some((i) => i.code === "invalid_published_missing"), "missing published blocks");

  const emptyPublished = ff.validateFireflyPostContent({
    titleFromFilename: "测试文章",
    content: base.replace("published: 2026-10-20", 'published: ""'),
  });
  assert.ok(emptyPublished.errors.some((i) => i.code === "invalid_published_missing"), "empty published blocks");

  const badUpdated = ff.validateFireflyPostContent({
    titleFromFilename: "测试文章",
    content: base.replace("---\n正文", "updated: 2026-02-31\n---\n正文"),
  });
  assert.ok(badUpdated.errors.some((i) => i.code === "invalid_updated_format"), "invalid updated blocks");

  const noTitle = ff.validateFireflyPostContent({
    titleFromFilename: "",
    content: "---\npublished: 2026-10-20\n---\n正文",
  });
  assert.ok(noTitle.errors.some((i) => i.code === "missing_title"), "missing title blocks");

  const filenameFallback = ff.validateFireflyPostContent({
    titleFromFilename: "只有文件名.md",
    content: "---\npublished: 2026-10-20\n---\n正文",
  });
  assert.ok(!filenameFallback.errors.some((i) => i.code === "missing_title"), "filename counts as a title");
}

// ── validation: image references inside vs outside code ─────────────────────
{
  const withCode = [
    "---", "title: 图片", "published: 2026-10-20", "---",
    "```md",
    "![[ignored-in-code.png]]",
    "![alt](../99-Assets/assets/ignored.png)",
    "```",
    "正文图片 ![[real.png]]",
    "![alt](../99-Assets/assets/real.png)",
  ].join("\n");
  const res = ff.validateFireflyPostContent({ titleFromFilename: "图片", content: withCode });
  const wiki = res.fixable.find((i) => i.code === "wiki_image");
  const cross = res.fixable.find((i) => i.code === "cross_dir_image");
  assert.ok(wiki, "wiki embeds outside code are reported");
  assert.ok(cross, "cross-directory images outside code are reported");
  assert.equal(wiki.detail, "real.png", "code-block wiki embeds are ignored");
  assert.equal(cross.detail, "../99-Assets/assets/real.png", "code-block markdown images are ignored");
  assert.equal(res.imageRefs.length, 2, "only real references are scanned");

  const inCodeOnly = ["---", "title: 代码", "published: 2026-10-20", "---", "`![[inline.png]]`"].join("\n");
  const inlineRes = ff.validateFireflyPostContent({ titleFromFilename: "代码", content: inCodeOnly });
  assert.equal(inlineRes.fixable.length, 0, "inline code is ignored too");
}

// ── validation: broken local images ────────────────────────────────────────
{
  const content = [
    "---", "title: 断链", "published: 2026-10-20", "image: ./assets/cover.png", "---",
    "![a](./assets/present.png)", "![b](./assets/missing.png)",
  ].join("\n");
  const exists = new Set(["./assets/present.png"]);
  const res = ff.validateFireflyPostContent({
    titleFromFilename: "断链",
    content,
    resolveImageExists: (ref) => exists.has(ref),
  });
  const missing = res.errors.find((i) => i.code === "missing_image");
  assert.ok(missing, "missing local image blocks the build");
  assert.match(missing.detail, /missing\.png/);
  assert.match(missing.detail, /cover\.png/, "missing cover is checked as well");
  assert.ok(!missing.detail.includes("present.png"), "existing images are not reported");
}

// ── validation: public-only private residue ─────────────────────────────────
{
  const draftPost = [
    "---", "title: 内部稿", "published: 2026-10-20", "draft: true", "scope: 内部", "---",
    "见 [笔记](obsidian://open?vault=doge&file=x)",
    "## 作者审阅意见",
    "<!-- AUTHOR-REVIEW:START -->",
    "待补充",
    "<!-- AUTHOR-REVIEW:END -->",
    "- 作者取材索引（导出前删除）：私人链接",
  ].join("\n");
  const draft = ff.validateFireflyPostContent({ titleFromFilename: "内部稿", content: draftPost });
  assert.equal(draft.isPublic, false);
  assert.equal(draft.hasObsidianProtocol, true, "protocol links are detected regardless of scope");
  assert.ok(!draft.errors.some((i) => i.code.startsWith("public_")), "internal drafts are not blocked for residue");
  assert.ok(!draft.fixable.some((i) => i.code === "public_author_review"), "internal drafts do not need cleanup");

  const publicPost = draftPost.replace("draft: true", "draft: false").replace("scope: 内部", "scope: 公开");
  const pub = ff.validateFireflyPostContent({ titleFromFilename: "公开稿", content: publicPost });
  assert.equal(pub.isPublic, true);
  assert.equal(pub.ok, false, "public post with obsidian:// links is blocked");
  assert.ok(pub.errors.some((i) => i.code === "public_obsidian_protocol"));
  assert.ok(pub.fixable.some((i) => i.code === "public_author_review"));
  assert.ok(pub.fixable.some((i) => i.code === "public_source_index"));
  assert.equal(pub.hasAuthorReview, true);
  assert.equal(pub.hasSourceIndex, true);

  // scope: 公开 alone is enough to be treated as public
  const scopeOnly = ff.validateFireflyPostContent({
    titleFromFilename: "x",
    content: ["---", "title: x", "published: 2026-10-20", "scope: 公开", "---", "obsidian://open"].join("\n"),
  });
  assert.equal(scopeOnly.isPublic, true, "scope 公开 marks the post as public");
  assert.ok(scopeOnly.errors.some((i) => i.code === "public_obsidian_protocol"));
}

// ── stripAuthorReviewBlocks ─────────────────────────────────────────────────
{
  const md = [
    "# 标题",
    "",
    "正文",
    "",
    "## 作者审阅意见",
    "",
    "<!-- AUTHOR-REVIEW:START -->",
    "待作者补充",
    "<!-- AUTHOR-REVIEW:END -->",
    "",
    "## 结尾",
    "保留",
    "",
  ].join("\n");
  const stripped = ff.stripAuthorReviewBlocks(md);
  assert.ok(!stripped.includes("AUTHOR-REVIEW"), "review markers are removed");
  assert.ok(!stripped.includes("待作者补充"), "review content is removed");
  assert.ok(!stripped.includes("作者审阅意见"), "the now-empty review heading is removed too");
  assert.ok(stripped.includes("正文") && stripped.includes("## 结尾"), "surrounding content survives");

  const inCode = ["```md", "<!-- AUTHOR-REVIEW:START -->", "x", "<!-- AUTHOR-REVIEW:END -->", "```"].join("\n");
  assert.equal(ff.stripAuthorReviewBlocks(inCode).includes("AUTHOR-REVIEW:START"), true, "code blocks are untouched");

  const noBlock = "正文没有审阅块";
  assert.ok(ff.stripAuthorReviewBlocks(noBlock).includes("正文没有审阅块"), "no-op when nothing matches");
}

// ── rewriteWikiAndExternalImagesToLocalAssets ───────────────────────────────
{
  const md = [
    "```md",
    "![[code.png]]",
    "![a](../99-Assets/assets/code.png)",
    "```",
    "",
    "![[shot.png]]",
    "![[shot2.png|截图说明]]",
    "![alt](../99-Assets/assets/pic.png)",
    "![already](./assets/keep.png)",
    "![ext](https://example.com/x.png)",
    "`![[inline.png]]`",
  ].join("\n");
  const mapping = new Map([
    ["shot.png", "shot.png"],
    ["shot2.png", "shot2.png"],
    ["../99-Assets/assets/pic.png", "pic.png"],
    ["code.png", "code.png"],
  ]);
  const out = ff.rewriteWikiAndExternalImagesToLocalAssets(md, mapping);

  assert.ok(out.includes("![[code.png]]"), "fenced code keeps wiki syntax");
  assert.ok(out.includes("![a](../99-Assets/assets/code.png)"), "fenced code keeps markdown paths");
  assert.ok(out.includes("![shot](./assets/shot.png)"), "wiki embed becomes a local assets link");
  assert.ok(out.includes("![截图说明](./assets/shot2.png)"), "wiki alias becomes the alt text");
  assert.ok(out.includes("![alt](./assets/pic.png)"), "cross-directory path is rewritten");
  assert.ok(out.includes("![already](./assets/keep.png)"), "existing local links stay untouched");
  assert.ok(out.includes("![ext](https://example.com/x.png)"), "external links stay untouched");
  assert.ok(out.includes("`![[inline.png]]`"), "inline code is untouched");
  assert.equal(out.split("\n")[1], "![[code.png]]", "line structure is preserved");

  const unknown = ff.rewriteWikiAndExternalImagesToLocalAssets("![[nope.png]]", new Map());
  assert.equal(unknown, "![[nope.png]]", "unmapped references are left alone");
}

// ── unquoteFireflyDateFields ────────────────────────────────────────────────
{
  const yaml = ["---", 'published: "2026-10-20"', "updated: '2026-10-21'", 'createTime: "2026-10-20"', 'title: "2026-10-20"', "---"].join("\n");
  const out = ff.unquoteFireflyDateFields(yaml);
  assert.ok(out.includes("published: 2026-10-20"), "quoted published is unquoted for z.date()");
  assert.ok(out.includes("updated: 2026-10-21"), "quoted updated is unquoted");
  assert.ok(out.includes("createTime: 2026-10-20"), "quoted createTime is unquoted");
  assert.ok(out.includes('title: "2026-10-20"'), "non-date fields keep their quotes");
}

// ── buildFireflyPostTemplate ────────────────────────────────────────────────
{
  const today = "2026-11-20";
  const md = ff.buildFireflyPostTemplate({
    title: "我的第一篇文章",
    category: "代理与网络",
    slug: "experience/代理与网络/wo-de-di-yi-pian-wen-zhang",
    sourceVault: "doge",
    today,
  });
  assert.ok(md.startsWith("---\n"), "template starts with frontmatter");
  assert.ok(md.includes(`published: ${today}`), "published uses the real today date");
  assert.ok(!md.includes("YYYY-MM-DD"), "template never ships the placeholder date");
  assert.ok(md.includes("draft: false"), "new posts are public by default");
  assert.ok(md.includes("scope: 内部"), "new posts default to internal");
  assert.ok(md.includes("type: share"), "new posts are experience shares");
  assert.ok(md.includes("comment: false"), "comments default off");
  assert.ok(md.includes("lang: zh-CN"));
  assert.ok(md.includes("  - experience-sharing"), "default tag present");
  assert.ok(md.includes("sourceVault: \"doge\""));
  assert.ok(!md.includes("AUTHOR-REVIEW"), "the minimal template ships no author review block");
  assert.ok(!md.includes("作者取材索引"), "no personal template placeholders are injected");
  assert.ok(md.includes("## 正文"), "the body gives a plain writing starting point");

  const fm = ff.parseFrontmatter(md);
  assert.equal(fm.title, "我的第一篇文章");
  assert.equal(fm.published, today, "published parses back as a plain date string");
  assert.equal(fm.draft, false, "draft parses back as a boolean");
  assert.deepEqual(plain(fm.tags), ["experience-sharing"], "tags parse back as an array");

  // 勾选草稿时写入 draft: true / The draft switch writes draft: true
  const draftPost = ff.buildFireflyPostTemplate({
    title: "草稿文章",
    category: "工具推荐",
    slug: "experience/gong-ju-tui-jian/cao-gao",
    sourceVault: "doge",
    today,
    draft: true,
  });
  assert.ok(draftPost.includes("draft: true"), "the draft switch is honoured");
  assert.equal(ff.parseFrontmatter(draftPost).draft, true, "draft flag parses back");

  const selfCheck = ff.validateFireflyPostContent({ titleFromFilename: "我的第一篇文章", content: md });
  assert.equal(selfCheck.ok, true, "generated template passes its own compliance check");
  assert.equal(selfCheck.errors.length, 0);

  // bad `today` input falls back to a real date instead of leaking the placeholder
  const fallback = ff.buildFireflyPostTemplate({
    title: "x", category: "", slug: "", sourceVault: "", today: "YYYY-MM-DD",
  });
  assert.equal(ff.parseFrontmatter(fallback).category, "", "an empty category stays empty (free-form category)");
  assert.ok(!fallback.includes("YYYY-MM-DD"), "invalid today never leaks into the template");
  assert.match(ff.parseFrontmatter(fallback).published, /^\d{4}-\d{2}-\d{2}$/);
}

// ── frontmatter parsing edge cases ──────────────────────────────────────────
{
  assert.equal(ff.parseFrontmatter("没有 frontmatter"), null);
  const fm = ff.parseFrontmatter([
    "---",
    "title: 带冒号的标题：测试",
    "tags: [experience-sharing, proxy]",
    "draft: false",
    "description: \"引号里的: 冒号\"",
    "---",
    "正文",
  ].join("\n"));
  assert.equal(fm.title, "带冒号的标题：测试", "a colon inside a value is preserved");
  assert.deepEqual(plain(fm.tags), ["experience-sharing", "proxy"], "inline tag arrays parse");
  assert.equal(fm.draft, false, "booleans parse");
  assert.equal(fm.description, "引号里的: 冒号", "quoted values unquote");
}

console.log("Firefly blog: dates, slugs, validation, review stripping, image rewriting and template all passed");
