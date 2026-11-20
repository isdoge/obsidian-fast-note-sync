/**
 * Firefly 文章附件与封面相关的 Obsidian 侧辅助逻辑。
 * Obsidian-facing helpers for Firefly posts: asset existence, one-click asset
 * collection into the note-local `./assets/` folder, cover image options and
 * stable slug generation (with pinyin for Chinese titles).
 *
 * 这里的所有改写只作用于当前笔记本身；不触碰同步层（`src/lib/sync/*`）。
 */

import { App, TFile, TFolder, normalizePath } from "obsidian";
import { pinyin } from "pinyin-pro";

import {
    FIREFLY_IMAGE_API,
    formatLocalDate,
    generateFireflySlug,
    rewriteWikiAndExternalImagesToLocalAssets,
    scanImageReferences,
} from "./firefly-frontmatter";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"];

export function isImageFile(file: TFile): boolean {
    return IMAGE_EXTS.includes(file.extension.toLowerCase());
}

/** 笔记所在目录（vault 相对路径，根目录返回 ""） */
export function noteDir(notePath: string): string {
    const idx = notePath.lastIndexOf("/");
    return idx === -1 ? "" : notePath.slice(0, idx);
}

export function joinVaultPath(dir: string, ...parts: string[]): string {
    const joined = [dir, ...parts].filter((p) => p !== "").join("/");
    return normalizePath(joined);
}

/** 笔记同目录 `./assets/` 路径 */
export function assetsDirForNote(notePath: string): string {
    return joinVaultPath(noteDir(notePath), "assets");
}

/** 正文图片引用在 vault 中的实际路径；外链 / public 路径返回 null */
export function resolveRefToVaultPath(notePath: string, ref: string): string | null {
    const trimmed = String(ref ?? "").trim();
    if (!trimmed) return null;
    if (/^(?:https?:)?\/\//i.test(trimmed) || /^data:/i.test(trimmed)) return null;
    if (trimmed.startsWith("/")) return null;
    if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
        const baseParts = noteDir(notePath).split("/").filter(Boolean);
        for (const seg of trimmed.split("/")) {
            if (seg === "." || seg === "") continue;
            if (seg === "..") baseParts.pop();
            else baseParts.push(seg);
        }
        return normalizePath(baseParts.join("/"));
    }
    return joinVaultPath(noteDir(notePath), trimmed);
}

/** 校验正文相对图片引用是否在库内存在 */
export function makeImageExistsResolver(app: App, notePath: string): (ref: string) => boolean {
    return (ref: string) => {
        const path = resolveRefToVaultPath(notePath, ref);
        if (!path) return true; // 外链与 public 路径不归本地校验
        return app.vault.getAbstractFileByPath(path) instanceof TFile;
    };
}

/** 在库内按 Wiki 链接语义查找图片（先 linkpath，再全库文件名兜底） */
export function findImageFile(app: App, notePath: string, ref: string): TFile | null {
    const direct = resolveRefToVaultPath(notePath, ref);
    if (direct) {
        const file = app.vault.getAbstractFileByPath(direct);
        if (file instanceof TFile) return file;
    }
    const byLink = app.metadataCache.getFirstLinkpathDest(ref, notePath);
    if (byLink instanceof TFile) return byLink;
    const name = ref.split("/").pop() ?? ref;
    const candidates = app.vault.getFiles().filter((f) => f.name === name || f.path === ref);
    return candidates.length > 0 ? candidates[0] : null;
}

/** 列出笔记同目录 `./assets/` 下的图片 */
export function listLocalAssetImages(app: App, notePath: string): TFile[] {
    const dir = assetsDirForNote(notePath);
    const folder = app.vault.getAbstractFileByPath(dir);
    if (!(folder instanceof TFolder)) return [];
    return folder.children.filter((child): child is TFile => child instanceof TFile && isImageFile(child));
}

/**
 * 把来源文件名消毒成安全的资源文件名：去掉路径分隔符与控制字符，仅保留最后一段，
 * 丢弃以 `.` 开头的隐藏前缀，空名回退为 `image`。剪贴板/外部来源的文件名不可信。
 *
 * Sanitize a source file name into a safe asset name: strip path separators and control
 * characters, keep only the last segment, drop a leading dot, and fall back to `image` when empty.
 * Clipboard/external file names are untrusted.
 */
export function sanitizeAssetFileName(fileName: string): string {
    const base = String(fileName ?? "").split(/[/\\]/).pop() ?? "";
    // 控制字符与隐藏点前缀都不适合作为资源名（按码点过滤，避免正则里的控制字符）
    // Control characters and a hidden dot prefix are not asset names (filtered by code point so
    // the source carries no control characters)
    const withoutControl = Array.from(base)
      .filter((ch) => { const code = ch.charCodeAt(0); return code >= 0x20 && code !== 0x7f; })
      .join("");
    const cleaned = withoutControl.replace(/^\.+/, "").trim();
    if (cleaned === "" || cleaned === "." || cleaned === "..") return "image";
    return cleaned;
}

/**
 * 判断两个资源文件是否逐字节相同（用于同名不同内容的消歧）。
 * 比较大小后按二进制读取比较；任一读取失败按不同处理，宁可多留一份也不覆盖。
 *
 * Whether two asset files are byte-identical (used to disambiguate same-name, different-content
 * files). Compares size then binary content; a read failure counts as different — keep an extra
 * copy rather than overwrite.
 */
async function isSameAssetContent(app: App, a: TFile, b: TFile): Promise<boolean> {
    if (a.stat?.size !== undefined && b.stat?.size !== undefined && a.stat.size !== b.stat.size) return false;
    try {
        const [left, right] = await Promise.all([app.vault.readBinary(a), app.vault.readBinary(b)]);
        const l = new Uint8Array(left);
        const r = new Uint8Array(right);
        if (l.length !== r.length) return false;
        for (let i = 0; i < l.length; i++) {
            if (l[i] !== r[i]) return false;
        }
        return true;
    } catch {
        return false;
    }
}

/** 为一个期望文件名挑选不冲突的资源名：`a.png` → `a-1.png`、`a-2.png` … */
function pickAvailableAssetName(app: App, dir: string, fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : "";
    let candidate = fileName;
    let counter = 1;
    while (app.vault.getAbstractFileByPath(joinVaultPath(dir, candidate)) instanceof TFile) {
        candidate = `${stem}-${counter}${ext}`;
        counter++;
    }
    return candidate;
}

/**
 * 把图片复制进笔记同目录 `./assets/`，返回目标文件名。
 * 目标已存在时：内容逐字节相同则直接复用；内容不同（同名不同内容）则改名 `name-N.ext`
 * 另存，绝不静默沿用已有文件，避免把不同图片当成同一张。
 *
 * Copy an image into the note's `./assets/` and return the target name. When the target already
 * exists: reuse it only if the bytes are identical; otherwise save under `name-N.ext` so a
 * same-name-but-different image is never silently treated as the same asset.
 */
export async function copyImageIntoNoteAssets(app: App, notePath: string, source: TFile): Promise<string> {
    const dir = assetsDirForNote(notePath);
    const targetPath = joinVaultPath(dir, source.name);
    if (source.path === targetPath) return source.name;
    const existing = app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
        if (await isSameAssetContent(app, existing, source)) return source.name;
        const altName = pickAvailableAssetName(app, dir, source.name);
        if (!(app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
            await app.vault.createFolder(dir);
        }
        await app.vault.copy(source, joinVaultPath(dir, altName));
        return altName;
    }
    if (!(app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
        await app.vault.createFolder(dir);
    }
    await app.vault.copy(source, targetPath);
    return source.name;
}

/**
 * 把本地（库外 / 剪贴板）图片写入笔记同目录 `./assets/`，返回目标文件名。
 * 文件名先消毒（剪贴板来源不可信，可能含路径分隔符/控制字符/隐藏前缀），重名自动追加 `-N`。
 *
 * Write an external (device / clipboard) image into the note's `./assets/` and return the target
 * name. The name is sanitized first (clipboard sources are untrusted: path separators, control
 * characters, hidden dot-prefixes) and collisions get a `-N` suffix.
 */
export async function writeImageIntoNoteAssets(app: App, notePath: string, fileName: string, data: ArrayBuffer): Promise<string> {
    const dir = assetsDirForNote(notePath);
    if (!(app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
        await app.vault.createFolder(dir);
    }
    const safeName = sanitizeAssetFileName(fileName);
    const targetName = pickAvailableAssetName(app, dir, safeName);
    await app.vault.createBinary(joinVaultPath(dir, targetName), data);
    return targetName;
}

export interface NormalizeAssetsResult {
    movedCount: number;
    rewrittenCount: number;
    missing: string[];
}

/**
 * 一键汇聚图片：把正文（代码块之外）引用的 Wiki 图片与跨目录图片复制到
 * 当前笔记同目录 `./assets/`，并把正文引用改写为标准 `![alt](./assets/<name>)`。
 * 只改写当前笔记本身。
 */
export async function normalizePostAssets(app: App, note: TFile): Promise<NormalizeAssetsResult> {
    const content = await app.vault.read(note);
    const refs = scanImageReferences(content).filter(
        (r) => r.kind === "wiki" || r.category === "cross-dir" || r.category === "local-assets",
    );
    const mapping = new Map<string, string>();
    const missing: string[] = [];
    let movedCount = 0;

    for (const ref of refs) {
        if (ref.category === "local-assets" && ref.kind === "markdown") {
            // 已经是 ./assets/ 引用：确认文件存在即可，不改写
            const path = resolveRefToVaultPath(note.path, ref.ref);
            if (path && app.vault.getAbstractFileByPath(path) instanceof TFile) {
                mapping.set(ref.ref, ref.ref.split("/").pop() ?? ref.ref);
            } else if (!missing.includes(ref.ref)) {
                missing.push(ref.ref);
            }
            continue;
        }
        const file = findImageFile(app, note.path, ref.ref);
        if (!file) {
            if (!missing.includes(ref.ref)) missing.push(ref.ref);
            continue;
        }
        const before = assetsDirForNote(note.path);
        const name = await copyImageIntoNoteAssets(app, note.path, file);
        if (noteDir(file.path) !== before) movedCount++;
        mapping.set(ref.ref, name);
        mapping.set(file.path, name);
        mapping.set(file.name, name);
    }

    const next = rewriteWikiAndExternalImagesToLocalAssets(content, mapping);
    let rewrittenCount = 0;
    if (next !== content) {
        await app.vault.modify(note, next);
        rewrittenCount = refs.filter((r) => mapping.has(r.ref)).length;
    }
    return { movedCount, rewrittenCount, missing };
}

export interface FireflyCoverOption {
    value: string;
    label: string;
}

export const FIREFLY_COVER_NONE = "";
export const FIREFLY_COVER_API = FIREFLY_IMAGE_API;

/**
 * 生成稳定的 Firefly slug。中文标题转拼音，分类目录去掉前缀序号（`01-代理与网络` → `代理与网络`）。
 */
export function generateSlugForNote(categoryDirOrName: string, title: string): string {
    const category = String(categoryDirOrName ?? "").replace(/^\d+[-_.、\s]+/, "").trim();
    let slugTitle = String(title ?? "").trim();
    if (/[一-鿿]/.test(slugTitle)) {
        try {
            const parts = pinyin(slugTitle, { toneType: "none", type: "array", nonZh: "consecutive" });
            slugTitle = parts.join("-");
        } catch {
            // pinyin 失败时退回原文，仍会经过 slug 清洗
        }
    }
    return generateFireflySlug(category, slugTitle);
}

/** 从笔记路径推断分类目录名（如 `Blog/01-代理与网络/xx.md` → `01-代理与网络`） */
export function inferCategoryFromPath(notePath: string): string {
    const parts = notePath.split("/");
    if (parts.length >= 2) return parts[parts.length - 2];
    return "";
}

/** 今天的 `YYYY-MM-DD`（本地时区） */
export function todayString(): string {
    return formatLocalDate(new Date());
}
