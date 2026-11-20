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

/** 把图片复制进笔记同目录 `./assets/`，返回目标文件名（重名时沿用已有文件） */
export async function copyImageIntoNoteAssets(app: App, notePath: string, source: TFile): Promise<string> {
    const dir = assetsDirForNote(notePath);
    const targetPath = joinVaultPath(dir, source.name);
    if (source.path === targetPath) return source.name;
    const existing = app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) return source.name;
    if (!(app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
        await app.vault.createFolder(dir);
    }
    await app.vault.copy(source, targetPath);
    return source.name;
}

/** 把本地（库外）图片写入笔记同目录 `./assets/`，返回目标文件名 */
export async function writeImageIntoNoteAssets(app: App, notePath: string, fileName: string, data: ArrayBuffer): Promise<string> {
    const dir = assetsDirForNote(notePath);
    if (!(app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
        await app.vault.createFolder(dir);
    }
    let targetName = fileName;
    let targetPath = joinVaultPath(dir, targetName);
    let counter = 1;
    while (app.vault.getAbstractFileByPath(targetPath) instanceof TFile) {
        const dot = fileName.lastIndexOf(".");
        const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
        const ext = dot > 0 ? fileName.slice(dot) : "";
        targetName = `${stem}-${counter}${ext}`;
        targetPath = joinVaultPath(dir, targetName);
        counter++;
    }
    await app.vault.createBinary(targetPath, data);
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
