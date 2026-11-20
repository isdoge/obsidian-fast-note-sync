/**
 * Firefly 博客文章 Frontmatter 纯逻辑模块。
 * Firefly post frontmatter helpers — pure logic only, no Obsidian DOM/API imports,
 * so the core rules can be unit-tested directly from Node (.mjs).
 *
 * 契约来源：Astro Firefly `src/content.config.ts`、`/Users/doge/Obsidian/blog/docs/writing/写作规范.md`
 * 与 `文章模板.md`。经验分享文章的 slug 以 `experience/` 开头，才能命中 NAS 内网预览
 * （`content-utils.ts` 的 `id.startsWith("experience/")`）草稿渲染规则。
 */

/** Astro Firefly 文章元数据（与 content.config.ts / 写作规范 对齐） */
export interface FireflyPostMeta {
    title: string;
    slug: string;
    published: string;
    updated?: string;
    description?: string;
    category?: string;
    tags?: string[];
    lang?: string;
    draft?: boolean;
    comment?: boolean;
    image?: string;
    type?: string;
    scope?: string;
    sourceVault?: string;
    createTime?: string;
    updateTime?: string;
}

/** Firefly 常用主题分类（与博客仓库 `src/content/posts/经验分享/` 目录一致） */
export const FIREFLY_CATEGORIES = [
    "代理与网络",
    "多设备与访问",
    "自托管与运维",
    "AI工具与模型",
    "Agent协作与记忆",
    "知识库与文档",
    "工具推荐",
];

/** 封面随机图 API 约定值 */
export const FIREFLY_IMAGE_API = "api";

/** 默认标签：经验分享文章约定包含 experience-sharing */
export const FIREFLY_DEFAULT_TAGS = ["experience-sharing"];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 格式化为本地 `YYYY-MM-DD`（绝不输出字面量 "YYYY-MM-DD" 占位符）。
 * Format a Date as a local `YYYY-MM-DD` string.
 */
export function formatLocalDate(d: Date = new Date()): string {
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return formatLocalDate(new Date());
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/**
 * 校验是否为真实存在的 `YYYY-MM-DD` 日期。
 * 拒绝缺失、空串、`YYYY-MM-DD` 占位符以及 2026-02-31 这类不存在的日期。
 */
export function isValidFireflyDate(value: unknown): boolean {
    if (value instanceof Date) return !isNaN(value.getTime());
    if (typeof value !== "string") return false;
    const m = DATE_RE.exec(value.trim());
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const probe = new Date(Date.UTC(y, mo - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/** 把 Date / ISO 字符串归一为 `YYYY-MM-DD`；无法识别时返回空串 */
export function normalizeDateValue(value: unknown): string {
    if (value instanceof Date) return isNaN(value.getTime()) ? "" : formatLocalDate(value);
    if (typeof value !== "string") return "";
    const s = value.trim();
    if (isValidFireflyDate(s)) return s;
    const parsed = new Date(s);
    return isNaN(parsed.getTime()) ? "" : formatLocalDate(parsed);
}

/** 单个 slug 片段清洗：保留汉字/字母/数字，其余转为连字符 */
function cleanSlugSegment(input: string): string {
    let s = String(input ?? "").trim();
    // 去掉路径分隔符，避免 slug 里出现嵌套目录歧义
    s = s.replace(/[\\/]+/g, " ");
    s = s.toLowerCase();
    s = s.replace(/[^\p{Letter}\p{Number}]+/gu, "-");
    s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    if (s.length > 60) s = s.slice(0, 60).replace(/-+$/g, "");
    return s;
}

/**
 * 生成稳定、合规的 Firefly 经验分享 slug：`experience/<分类>/<清洗后短名>`。
 * 同一分类 + 标题始终得到同一结果（改标题才会变，故面板默认锁定已存在的 slug）。
 */
export function generateFireflySlug(categoryDirOrName: string, title: string): string {
    const category = cleanSlugSegment(categoryDirOrName) || "未分类";
    const short = cleanSlugSegment(title) || "untitled";
    return `experience/${category}/${short}`;
}

/** 判断 slug 是否命中 Firefly 内网预览的 experience/ 前缀规则 */
export function isExperienceSlug(slug: string): boolean {
    return /^experience\//.test(String(slug ?? "").trim());
}

/** 双引号 YAML 字符串 */
export function yamlQuote(value: string): string {
    return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function splitInlineList(raw: string): string[] {
    const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (!inner.trim()) return [];
    return inner
        .split(",")
        .map((item) => item.trim().replace(/^"([\s\S]*)"$/, "$1").replace(/^'([\s\S]*)'$/, "$1"))
        .filter((item) => item.length > 0);
}

function scalarToString(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    return "";
}

function parseScalar(raw: string): unknown {
    const s = raw.trim();
    if (s === "") return "";
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
        return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
        return s.slice(1, -1).replace(/''/g, "'");
    }
    if (s.startsWith("[") && s.endsWith("]")) return splitInlineList(s);
    if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
    if (/^(null|~)$/i.test(s)) return null;
    return s;
}

/**
 * 解析 Markdown 顶部 YAML Frontmatter（覆盖 Firefly 用到的标量、布尔与列表形态）。
 * 解析失败或没有 frontmatter 时返回 null。
 */
export function parseFrontmatter(markdown: string): Record<string, unknown> | null {
    const text = String(markdown ?? "").replace(/^\uFEFF/, "");
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m) return null;
    const lines = m[1].split(/\r?\n/);
    const result: Record<string, unknown> = {};
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
        if (!kv) continue;
        const key = kv[1];
        const rest = kv[2];
        if (rest.trim() === "") {
            const items: string[] = [];
            let j = i + 1;
            while (j < lines.length) {
                const item = /^\s*-\s+(.*)$/.exec(lines[j]);
                if (!item) break;
                items.push(scalarToString(parseScalar(item[1])));
                j++;
            }
            if (items.length > 0) {
                result[key] = items;
                i = j - 1;
            } else {
                result[key] = "";
            }
            continue;
        }
        result[key] = parseScalar(rest);
    }
    return result;
}

/** 取 Frontmatter 中的文本值（Date 归一为 YYYY-MM-DD） */
function metaText(fm: Record<string, unknown>, key: string): string {
    const value = fm[key];
    if (value === undefined || value === null) return "";
    if (value instanceof Date) return normalizeDateValue(value);
    if (Array.isArray(value)) return value.map((v) => scalarToString(v)).join(", ");
    return scalarToString(value).trim();
}

export interface CodeSegment {
    text: string;
    code: boolean;
}

/**
 * 把 Markdown 切成「代码 / 非代码」片段：围栏代码块（``` / ~~~）与行内代码都算代码。
 * 片段按行切分后用 "\n" 重新拼接即可无损还原原文。
 */
export function splitMarkdownCodeSegments(markdown: string): CodeSegment[] {
    const lines = String(markdown ?? "").split("\n");
    const raw: CodeSegment[] = [];
    let fence: { ch: string; len: number } | null = null;
    let buffer: string[] = [];
    const flush = (code: boolean) => {
        if (buffer.length > 0) {
            raw.push({ text: buffer.join("\n"), code });
            buffer = [];
        }
    };
    for (const line of lines) {
        const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fence) {
            buffer.push(line);
            if (fenceMatch && fenceMatch[1][0] === fence.ch && fenceMatch[1].length >= fence.len) {
                flush(true);
                fence = null;
            }
            continue;
        }
        if (fenceMatch) {
            flush(false);
            fence = { ch: fenceMatch[1][0], len: fenceMatch[1].length };
            buffer.push(line);
            continue;
        }
        buffer.push(line);
    }
    flush(fence !== null);

    // 再把非代码片段按行内代码继续切分
    const out: CodeSegment[] = [];
    for (const seg of raw) {
        if (seg.code) {
            out.push(seg);
            continue;
        }
        const inline = /(`+)([^`]*?)\1/g;
        let last = 0;
        let match: RegExpExecArray | null;
        while ((match = inline.exec(seg.text)) !== null) {
            if (match.index > last) out.push({ text: seg.text.slice(last, match.index), code: false });
            out.push({ text: match[0], code: true });
            last = match.index + match[0].length;
        }
        if (last < seg.text.length) out.push({ text: seg.text.slice(last), code: false });
    }
    return out;
}

/** 仅在非代码片段上执行文本变换（保护代码块与行内代码不被改写） */
export function transformMarkdownOutsideCode(markdown: string, transform: (text: string) => string): string {
    return splitMarkdownCodeSegments(markdown)
        .map((seg) => (seg.code ? seg.text : transform(seg.text)))
        .join("\n");
}

export type ImageRefKind = "wiki" | "markdown" | "frontmatter";

export interface ImageReference {
    kind: ImageRefKind;
    /** 原始写法，如 `![[a.png]]` / `![x](../99-Assets/assets/a.png)` */
    raw: string;
    /** 引用目标，如 `a.png` / `../99-Assets/assets/a.png` */
    ref: string;
    /** 替代文字 */
    alt: string;
    /** 引用分类 */
    category: "external" | "public" | "local-assets" | "cross-dir" | "wiki";
}

function isExternalRef(ref: string): boolean {
    return /^(?:https?:)?\/\//i.test(ref) || /^data:/i.test(ref) || /^mailto:/i.test(ref);
}

function isLocalAssetsRef(ref: string): boolean {
    return /^\.?\/?assets\//i.test(ref);
}

function baseName(ref: string): string {
    const clean = ref.split(/[?#]/)[0];
    const parts = clean.split("/");
    return parts[parts.length - 1] || clean;
}

/** 替代文字默认值：文件名去掉扩展名（比整段文件名更适合当 alt） */
function altFromRef(ref: string): string {
    const name = baseName(ref);
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}

/** 扫描正文（代码块之外）中的图片引用 */
export function scanImageReferences(markdown: string): ImageReference[] {
    const refs: ImageReference[] = [];
    transformMarkdownOutsideCode(String(markdown ?? ""), (text) => {
        const wiki = /!\[\[([^\]\n]+)\]\]/g;
        let m: RegExpExecArray | null;
        while ((m = wiki.exec(text)) !== null) {
            const inner = m[1];
            const pipe = inner.indexOf("|");
            const ref = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
            const alt = (pipe >= 0 ? inner.slice(pipe + 1) : altFromRef(ref)).trim();
            refs.push({ kind: "wiki", raw: m[0], ref, alt, category: "wiki" });
        }
        const md = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
        while ((m = md.exec(text)) !== null) {
            const ref = m[2].trim();
            let category: ImageReference["category"] = "cross-dir";
            if (isExternalRef(ref)) category = "external";
            else if (ref.startsWith("/")) category = "public";
            else if (isLocalAssetsRef(ref)) category = "local-assets";
            refs.push({ kind: "markdown", raw: m[0], ref, alt: m[1].trim(), category });
        }
        return text;
    });
    return refs;
}

export type FireflyIssueSeverity = "error" | "warning" | "fixable";

export interface FireflyCheckIssue {
    code: string;
    severity: FireflyIssueSeverity;
    /** 附加信息（文件名、引用路径等），用于 UI 展示 */
    detail?: string;
}

export interface FireflyCheckResult {
    ok: boolean;
    isPublic: boolean;
    issues: FireflyCheckIssue[];
    errors: FireflyCheckIssue[];
    warnings: FireflyCheckIssue[];
    fixable: FireflyCheckIssue[];
    hasAuthorReview: boolean;
    hasSourceIndex: boolean;
    hasObsidianProtocol: boolean;
    imageRefs: ImageReference[];
}

export interface ValidateFireflyParams {
    titleFromFilename: string;
    content: string;
    frontmatter?: Record<string, unknown>;
    /** 校验正文图片引用（如 `./assets/a.png`）在库内是否存在 */
    resolveImageExists?: (refPath: string) => boolean;
}

const AUTHOR_REVIEW_RE = /<!--\s*AUTHOR-REVIEW:START\s*-->[\s\S]*?<!--\s*AUTHOR-REVIEW:END\s*-->/;
const SOURCE_INDEX_RE = /作者取材索引/;
const OBSIDIAN_PROTOCOL_RE = /obsidian:\/\//i;

/**
 * 校验一篇文章能否安全交给 Astro Firefly 构建 / 公开。
 * 阻断错误（errors）会让构建失败；可一键修复项（fixable）由面板按钮处理；
 * 警告（warnings）不阻断发布。
 */
export function validateFireflyPostContent(params: ValidateFireflyParams): FireflyCheckResult {
    const content = String(params.content ?? "");
    const fm = params.frontmatter ?? parseFrontmatter(content) ?? {};
    const issues: FireflyCheckIssue[] = [];
    const add = (code: string, severity: FireflyIssueSeverity, detail?: string) =>
        issues.push({ code, severity, detail });

    // ── 必填与日期 ────────────────────────────────────────────────
    const titleValue = metaText(fm, "title");
    const filenameTitle = String(params.titleFromFilename ?? "").replace(/\.md$/i, "").trim();
    if (!titleValue && !filenameTitle) add("missing_title", "error");

    const publishedRaw = fm.published;
    const publishedText = metaText(fm, "published");
    if (publishedRaw === undefined || publishedRaw === null || publishedText === "") {
        add("invalid_published_missing", "error");
    } else if (!isValidFireflyDate(publishedRaw)) {
        add("invalid_published_format", "error", publishedText);
    }

    const updatedRaw = fm.updated;
    const updatedText = metaText(fm, "updated");
    if (updatedRaw !== undefined && updatedRaw !== null && updatedText !== "" && !isValidFireflyDate(updatedRaw)) {
        add("invalid_updated_format", "error", updatedText);
    }

    const slug = metaText(fm, "slug");
    if (!slug) {
        add("missing_slug", "warning");
    } else if (!isExperienceSlug(slug)) {
        add("slug_not_experience", "warning", slug);
    }

    // ── 图片引用 ──────────────────────────────────────────────────
    const imageRefs = scanImageReferences(content);
    const wikiRefs = imageRefs.filter((r) => r.kind === "wiki");
    const crossRefs = imageRefs.filter((r) => r.category === "cross-dir");
    const missing: string[] = [];

    if (wikiRefs.length > 0) {
        add("wiki_image", "fixable", wikiRefs.map((r) => r.ref).join(", "));
    }
    if (crossRefs.length > 0) {
        add("cross_dir_image", "fixable", crossRefs.map((r) => r.ref).join(", "));
    }

    if (params.resolveImageExists) {
        const checkLocal = (ref: string) => {
            const exists = params.resolveImageExists!(ref);
            if (!exists && !missing.includes(ref)) missing.push(ref);
        };
        for (const ref of imageRefs) {
            if (ref.category === "local-assets") checkLocal(ref.ref);
        }
        const cover = metaText(fm, "image");
        if (cover && cover !== FIREFLY_IMAGE_API && !isExternalRef(cover) && !cover.startsWith("/")) {
            checkLocal(cover);
        }
    }
    if (missing.length > 0) {
        add("missing_image", "error", missing.join(", "));
    }

    // ── 公开前的私密残留 ──────────────────────────────────────────
    const draftValue = fm.draft;
    const isPublic = metaText(fm, "scope") === "公开" || draftValue === false || String(draftValue) === "false";
    const outsideCode = splitMarkdownCodeSegments(content)
        .filter((seg) => !seg.code)
        .map((seg) => seg.text)
        .join("\n");
    const hasAuthorReview = AUTHOR_REVIEW_RE.test(outsideCode);
    const hasSourceIndex = SOURCE_INDEX_RE.test(outsideCode);
    const hasObsidianProtocol = OBSIDIAN_PROTOCOL_RE.test(outsideCode);

    if (isPublic) {
        if (hasObsidianProtocol) add("public_obsidian_protocol", "error");
        if (hasAuthorReview) add("public_author_review", "fixable");
        if (hasSourceIndex) add("public_source_index", "fixable");
    }

    const errors = issues.filter((i) => i.severity === "error");
    return {
        ok: errors.length === 0,
        isPublic,
        issues,
        errors,
        warnings: issues.filter((i) => i.severity === "warning"),
        fixable: issues.filter((i) => i.severity === "fixable"),
        hasAuthorReview,
        hasSourceIndex,
        hasObsidianProtocol,
        imageRefs,
    };
}

const AUTHOR_REVIEW_WITH_HEADING_RE =
    /(?:^|\n)[ \t]*#{1,6}[ \t]*作者审阅意见[^\n]*\r?\n(?:[ \t]*\r?\n)*<!--\s*AUTHOR-REVIEW:START\s*-->[\s\S]*?<!--\s*AUTHOR-REVIEW:END\s*-->/g;

/**
 * 安全移除 `<!-- AUTHOR-REVIEW:START -->...<!-- AUTHOR-REVIEW:END -->` 审阅块
 * （连同紧邻的「作者审阅意见」标题）。代码块内出现的同名文本不受影响。
 */
export function stripAuthorReviewBlocks(markdown: string): string {
    const stripped = transformMarkdownOutsideCode(String(markdown ?? ""), (text) =>
        text.replace(AUTHOR_REVIEW_WITH_HEADING_RE, "\n").replace(AUTHOR_REVIEW_RE, ""),
    );
    return stripped.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").replace(/\s*$/, "\n");
}

/** 移除「作者取材索引」整行（导出 / 公开前的私人取材说明） */
export function stripSourceIndexLines(markdown: string): string {
    return transformMarkdownOutsideCode(String(markdown ?? ""), (text) =>
        text
            .split("\n")
            .filter((line) => !SOURCE_INDEX_RE.test(line))
            .join("\n"),
    )
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\s*$/, "\n");
}

/**
 * 把正文中的 Obsidian Wiki 图片嵌入与跨目录图片引用改写为标准 Markdown
 * `![alt](./assets/<fileName>)`。代码块与行内代码保持不变。
 *
 * @param mapping 图片引用（原路径或文件名）→ `./assets/` 下的文件名
 */
export function rewriteWikiAndExternalImagesToLocalAssets(
    markdown: string,
    mapping: Map<string, string>,
): string {
    const lookup = (ref: string): string | null => {
        const normalized = ref.trim().replace(/^<|>$/g, "");
        const candidates = [normalized, normalized.replace(/^\.\//, ""), baseName(normalized)];
        for (const candidate of candidates) {
            if (mapping.has(candidate)) {
                const value = String(mapping.get(candidate) ?? "");
                return value.replace(/^\.?\/?assets\//i, "");
            }
        }
        return null;
    };

    return transformMarkdownOutsideCode(String(markdown ?? ""), (text) =>
        text
            .replace(/!\[\[([^\]\n]+)\]\]/g, (raw, inner: string) => {
                const pipe = inner.indexOf("|");
                const ref = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
                const alt = (pipe >= 0 ? inner.slice(pipe + 1) : altFromRef(ref)).trim();
                const target = lookup(ref);
                if (!target) return raw;
                return `![${alt}](./assets/${target})`;
            })
            .replace(/!\[([^\]\n]*)\]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g, (raw, alt: string, ref: string) => {
                const trimmed = ref.trim();
                if (isExternalRef(trimmed) || trimmed.startsWith("/")) return raw;
                const target = lookup(trimmed);
                if (!target) return raw;
                return `![${alt || altFromRef(trimmed)}](./assets/${target})`;
            }),
    );
}

/**
 * 把 `published` / `updated` / `createTime` / `updateTime` 的带引号日期改回 YAML 原生日期，
 * 避免 Obsidian 的 YAML 序列化写成字符串导致 Firefly Zod `z.date()` 校验失败。
 */
export function unquoteFireflyDateFields(markdown: string): string {
    return String(markdown ?? "").replace(
        /^((?:published|updated|createTime|updateTime)[ \t]*:[ \t]*)(["'])(\d{4}-\d{2}-\d{2})\2[ \t]*$/gm,
        "$1$3",
    );
}

export interface FireflyTemplateOptions {
    title: string;
    category: string;
    slug: string;
    sourceVault: string;
    today: string;
    /** 是否作为草稿创建；默认 false（直接公开发表） */
    draft?: boolean;
}

/**
 * 生成一篇可直接通过 Firefly 校验的新文章（Frontmatter + 简洁写作骨架）。
 * 默认 `draft: false`（公开发表）、`scope: 内部`、`type: share`、`comment: false`、
 * `lang: zh-CN`。正文只保留标题、导语与正文起点，不塞入个人模板占位或审阅块，
 * 新手打开即可直接写，合规检查直接全绿。
 *
 * Build a Firefly-ready new post (frontmatter + a minimal writing skeleton). `draft`
 * defaults to false (public). The body only carries a title, a short lead-in and a body
 * starting point — no personal template placeholders or review blocks — so a first-time
 * user can start writing immediately and pass the compliance check as-is.
 */
export function buildFireflyPostTemplate(opts: FireflyTemplateOptions): string {
    const today = isValidFireflyDate(opts.today) ? opts.today : formatLocalDate();
    const title = String(opts.title ?? "").trim();
    const category = String(opts.category ?? "").trim();
    const slug = String(opts.slug ?? "").trim() || generateFireflySlug(category, title);
    const sourceVault = String(opts.sourceVault ?? "").trim() || "doge";
    const draft = opts.draft === true;

    const frontmatter = [
        "---",
        `title: ${yamlQuote(title)}`,
        `slug: ${yamlQuote(slug)}`,
        `published: ${today}`,
        `updated: ${today}`,
        'description: ""',
        `category: ${yamlQuote(category)}`,
        "lang: zh-CN",
        `draft: ${draft ? "true" : "false"}`,
        "comment: false",
        `sourceVault: ${yamlQuote(sourceVault)}`,
        "type: share",
        "scope: 内部",
        `createTime: ${today}`,
        `updateTime: ${today}`,
        "tags:",
        "  - experience-sharing",
        "---",
    ].join("\n");

    const body = [
        "",
        `# ${title}`,
        "",
        "（用一两句话写下导语：这篇讲什么、适合谁看。）",
        "",
        "## 正文",
        "",
        "（从这里开始写。需要小标题时继续使用 ##。）",
        "",
    ].join("\n");

    return `${frontmatter}\n${body}`;
}

/**
 * 规整用户填写的博客访问地址：去首尾空格并移除多余末尾斜杠。
 * Normalize a user-supplied blog site URL: trim whitespace and trailing slashes.
 */
export function normalizeBlogSiteUrl(raw: string): string {
    return String(raw ?? "").trim().replace(/\/+$/, "");
}

/**
 * 校验并返回安全的 http(s) URL；非法协议（如 javascript:、file:、data:）或无效地址返回 null。
 * Validate and return a safe http(s) URL; returns null for invalid URLs or non-HTTP(S) schemes.
 */
export function getSafeHttpUrl(raw: string): string | null {
    const normalized = normalizeBlogSiteUrl(raw);
    if (!normalized) return null;
    for (let i = 0; i < normalized.length; i++) {
        const code = normalized.charCodeAt(i);
        if (code <= 0x20 || code === 0x7f) return null;
    }
    if (!/^https?:\/\//i.test(normalized)) return null;

    if (typeof URL === "function") {
        try {
            const parsed = new URL(normalized);
            if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0) {
                return normalized;
            }
            return null;
        } catch {
            return null;
        }
    }

    const hostMatch = normalized.match(/^https?:\/\/([^/?#]+)/i);
    return hostMatch && hostMatch[1].length > 0 ? normalized : null;
}

