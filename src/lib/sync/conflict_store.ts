import { normalizePath } from "obsidian";

import { $ } from "../../i18n/lang";
import { dump, dumpError } from "../utils/helpers";
import type { SyncConflictPayload } from "../utils/types";
import { SyncLogManager } from "./sync_log_manager";
import { conflictBackupPaths, readConflictMeta, writeConflictMeta, ConflictBackupMeta } from "./operator_note";
import type FastSync from "../../main";

/**
 * 统一基线冲突（设计稿 §2.6）的持久化与状态管理。
 * 四类资源（note/file/setting/folder）共用同一份载荷与内部隔离目录中的元数据。
 *
 * Persistence and state management for the unified baseline conflict (design §2.6).
 * All four resource kinds (note/file/setting/folder) share one payload and one metadata file
 * inside the plugin's excluded directory.
 */

export const CONFLICT_KIND_NOTE = "note";
export const CONFLICT_KIND_FILE = "file";
export const CONFLICT_KIND_SETTING = "setting";
export const CONFLICT_KIND_FOLDER = "folder";

/** 资源类型（保持 string 以便向前兼容）/ Resource kind (kept as string for forward compatibility) */
export type ConflictKind = string;

export const CONFLICT_REASON_BOTH_MODIFIED = "both_modified";
export const CONFLICT_REASON_REMOTE_DELETED = "remote_deleted";
export const CONFLICT_REASON_LOCAL_DELETED = "local_deleted";
export const CONFLICT_REASON_NO_BASELINE = "no_baseline";
export const CONFLICT_REASON_BASELINE_UNVERIFIED = "baseline_unverified";
export const CONFLICT_REASON_SERVER_MISSING = "server_missing";
export const CONFLICT_REASON_REVISION_CHANGED = "revision_changed";

const KNOWN_KINDS = new Set<string>([CONFLICT_KIND_NOTE, CONFLICT_KIND_FILE, CONFLICT_KIND_SETTING, CONFLICT_KIND_FOLDER]);

/** 冲突元数据（扩展阶段 B 的 ConflictBackupMeta）/ Conflict metadata extending stage-B's ConflictBackupMeta */
export interface UnifiedConflictMeta extends ConflictBackupMeta {
  kind?: ConflictKind;
  serverRevision?: string;
  serverHash?: string;
  serverDeleted?: boolean;
  baseHash?: string;
  /** 是否有真实远端内容写入 remote 备份 / Whether a real remote body was stashed */
  hasServerContent?: boolean;
}

export type ConflictSyncKind = "note" | "file" | "setting" | "folder";

/** 把任意载荷归一为统一冲突结构；未知字段保持字符串空值，绝不猜测。 */
export function normalizeConflict(raw: unknown): SyncConflictPayload | null {
  if (raw === null || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const text = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  };
  const flag = (value: unknown): boolean => value === true;
  const pick = (lower: string, upper: string): unknown => src[lower] ?? src[upper];
  const baseHash = text(pick("baseHash", "BaseHash"));
  const baseMissing = flag(pick("baseMissing", "BaseMissing")) || baseHash === "";
  const path = text(pick("path", "Path"));
  let kind = text(pick("kind", "Kind"));
  if (!KNOWN_KINDS.has(kind)) kind = inferKindFromPath(path);
  return {
    kind,
    path,
    pathHash: text(pick("pathHash", "PathHash")),
    reason: text(pick("reason", "Reason")),
    serverHash: text(pick("serverHash", "ServerHash")),
    serverRevision: text(pick("serverRevision", "ServerRevision")),
    serverDeleted: flag(pick("serverDeleted", "ServerDeleted")),
    baseHash: baseMissing ? "" : baseHash,
    baseContent: text(pick("baseContent", "BaseContent")),
    baseMissing,
    serverContent: text(pick("serverContent", "ServerContent")),
  };
}

function inferKindFromPath(path: string): ConflictKind {
  if (path.endsWith(".md")) return CONFLICT_KIND_NOTE;
  // 配置目录下的文件按 setting 处理；附件默认 file
  if (/(^|\/)\.obsidian\//.test(path) || path.startsWith("/_localStorage/")) return CONFLICT_KIND_SETTING;
  return CONFLICT_KIND_FILE;
}

export function conflictKindToSyncType(kind: string): ConflictSyncKind {
  if (kind === CONFLICT_KIND_SETTING) return "setting";
  if (kind === CONFLICT_KIND_FOLDER) return "folder";
  if (kind === CONFLICT_KIND_FILE) return "file";
  return "note";
}

function pauseUploadsForPath(plugin: FastSync, path: string): void {
  if (plugin.pendingNoteModifies?.delete(path)) {
    plugin.localStorageManager.savePending("pendingNoteModifies", plugin.pendingNoteModifies);
  }
  if (plugin.pendingUploadHashes?.delete(path)) {
    plugin.localStorageManager.savePending("pendingUploadHashes", plugin.pendingUploadHashes);
  }
  if (plugin.pendingConfigModifies?.delete(path)) {
    plugin.localStorageManager.savePending("pendingConfigModifies", plugin.pendingConfigModifies);
  }
}

/**
 * 持久化一条统一冲突，并把路径加入暂停自动上传集合。
 * 返回 false 表示载荷无效（无路径），调用方不应据此记账。
 *
 * Persist one unified conflict and pause automatic uploads for the path.
 * Returns false for an invalid payload (no path); callers must not account for it.
 */
export async function storeSyncConflict(plugin: FastSync, raw: unknown): Promise<boolean> {
  const conflict = normalizeConflict(raw);
  if (!conflict || conflict.path === "") {
    dump("[Conflict] Ignoring SyncConflict without a path", raw);
    return false;
  }
  const path = normalizePath(conflict.path);
  const kind = conflict.kind;
  dump("[Conflict] Store unified conflict", { kind, path, reason: conflict.reason, serverDeleted: conflict.serverDeleted });

  try {
    const adapter = plugin.app.vault.adapter;
    const { dir, baseBackupPath, remoteBackupPath } = conflictBackupPaths(plugin, path);
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);

    // 只有“有真实远端内容”时才写 remote 备份；墓碑不写空正文冒充版本
    // Stash a remote body only when one really exists; a tombstone is never faked as empty content
    const hasServerContent = !conflict.serverDeleted && (kind === CONFLICT_KIND_NOTE || kind === CONFLICT_KIND_SETTING);
    if (hasServerContent) {
      await adapter.write(remoteBackupPath, conflict.serverContent);
    } else if (await adapter.exists(remoteBackupPath)) {
      await adapter.remove(remoteBackupPath);
    }

    // 真实空 base（baseMissing=false 且 baseContent=""）必须写空文件，绝不伪造祖先；
    // baseMissing=true 时清除任何残留 base
    // A real empty base is written as an empty file; baseMissing=true removes any stale base
    if (!conflict.baseMissing) {
      await adapter.write(baseBackupPath, conflict.baseContent);
    } else if (await adapter.exists(baseBackupPath)) {
      await adapter.remove(baseBackupPath);
    }

    const previous = await readConflictMeta(plugin, path);
    const meta: UnifiedConflictMeta = {
      reason: conflict.reason || (conflict.baseMissing ? CONFLICT_REASON_NO_BASELINE : CONFLICT_REASON_BOTH_MODIFIED),
      kind,
      baseMissing: conflict.baseMissing,
      remoteHash: conflict.serverHash || undefined,
      serverHash: conflict.serverHash,
      serverRevision: conflict.serverRevision,
      serverDeleted: conflict.serverDeleted,
      baseHash: conflict.baseHash,
      hasServerContent,
      ...(previous?.localHashAtDetection ? { localHashAtDetection: previous.localHashAtDetection } : {}),
    };
    await writeConflictMeta(plugin, path, meta);
  } catch (error) {
    dumpError(`[Conflict] Failed to persist conflict metadata: ${path}`, error);
  }

  plugin.syncState.conflictedPaths.add(path);
  plugin.syncState.newConflictedPathsThisRound.add(path);
  plugin.localStorageManager.setConflictedPaths(plugin.syncState.conflictedPaths);
  plugin.statusBarManager?.updateConflictBadge?.();
  pauseUploadsForPath(plugin, path);

  const counts = plugin.syncState.conflictCountsThisRound;
  const type = conflictKindToSyncType(kind);
  counts?.set(type, (counts.get(type) ?? 0) + 1);

  SyncLogManager.getInstance().addLog(
    "receive",
    "SyncConflict",
    JSON.stringify({ kind, reason: conflict.reason, serverRevision: conflict.serverRevision, serverDeleted: conflict.serverDeleted }),
    "error",
    path,
    plugin.settings.vault,
  );
  return true;
}

export async function readUnifiedConflictMeta(plugin: FastSync, path: string): Promise<UnifiedConflictMeta | null> {
  return readConflictMeta(plugin, path);
}

/** 清除一条冲突的记录状态（不动本地/远端内容）/ Clear the recorded state (does not touch content) */
export function clearConflictState(plugin: FastSync, rawPath: string, options: { keepBackup?: boolean } = {}): void {
  const path = normalizePath(rawPath);
  plugin.syncState.conflictedPaths.delete(path);
  plugin.localStorageManager.setConflictedPaths(plugin.syncState.conflictedPaths);
  plugin.statusBarManager?.updateConflictBadge?.();
  if (!options.keepBackup) {
    void import("./operator_note").then(({ removeConflictBackups }) => removeConflictBackups(plugin, path)).catch(() => undefined);
  }
}

/** 冲突列表展示用的原因标签（五语种）/ Reason label for the conflict list (five locales) */
export function conflictReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case CONFLICT_REASON_BOTH_MODIFIED: return $("ui.conflict.reason_both_modified");
    case CONFLICT_REASON_REMOTE_DELETED: return $("ui.conflict.reason_remote_deleted");
    case CONFLICT_REASON_LOCAL_DELETED: return $("ui.conflict.reason_local_deleted");
    case CONFLICT_REASON_NO_BASELINE: return $("ui.conflict.reason_no_baseline");
    case CONFLICT_REASON_BASELINE_UNVERIFIED: return $("ui.conflict.reason_baseline_unverified");
    case CONFLICT_REASON_SERVER_MISSING: return $("ui.conflict.reason_server_missing");
    case CONFLICT_REASON_REVISION_CHANGED: return $("ui.conflict.reason_revision_changed");
    default: return $("ui.conflict.reason_unknown");
  }
}

export function conflictKindLabel(kind: string | undefined): string {
  switch (kind) {
    case CONFLICT_KIND_FILE: return $("ui.conflict.kind_file");
    case CONFLICT_KIND_SETTING: return $("ui.conflict.kind_setting");
    case CONFLICT_KIND_FOLDER: return $("ui.conflict.kind_folder");
    default: return $("ui.conflict.kind_note");
  }
}
