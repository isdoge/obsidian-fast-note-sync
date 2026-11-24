import { normalizePath } from "obsidian";

import { $ } from "../../i18n/lang";
import { dump, dumpError, getPluginDir, hashContentAsync, hashFileAsync } from "../utils/helpers";
import { decodeConfigContent } from "../utils/config_codec";
import { recordDiagBufferOnly } from "../utils/sync_diagnostics";
import type { SyncConflictPayload } from "../utils/types";
import { SyncLogManager } from "./sync_log_manager";
import { clearUploadTrackingForConflict } from "./operator_file";
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
  /** 远端配置正文是否为二进制（fns-bin-v1 信封，写进 .remote 的是原始字节） / Whether the remote setting body was binary (fns-bin-v1 envelope; .remote holds raw bytes) */
  isBinary?: boolean;
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

/**
 * 计算一条冲突在检测时的本地内容哈希；本地不存在或读取失败时返回 null。
 * 配置（含 `_localStorage/` 虚拟项）按真实存储取值，笔记/附件按原始字节，保证与解决侧的复核口径一致。
 * Compute the local content hash at detection time; null when the local copy is missing or
 * unreadable. Settings (including `_localStorage/` virtual items) read their real store, notes and
 * attachments hash raw bytes, so the resolver's re-check uses the same measure.
 */
async function detectLocalHash(plugin: FastSync, path: string, kind: ConflictKind): Promise<string | null> {
  try {
    if (kind === CONFLICT_KIND_SETTING) {
      if (path.startsWith(plugin.localStorageManager.syncPathPrefix)) {
        const key = plugin.localStorageManager.pathToKey(path) || "";
        const value = plugin.localStorageManager.getItemValue(key);
        return value === null ? null : await hashContentAsync(value);
      }
      const exists = await plugin.app.vault.adapter.exists(normalizePath(path));
      if (!exists) return null;
      return await hashFileAsync(plugin.app, normalizePath(path));
    }
    if (kind === CONFLICT_KIND_NOTE) {
      const file = plugin.app.vault.getFileByPath(normalizePath(path));
      if (!file) return null;
      return await hashContentAsync(await plugin.app.vault.read(file));
    }
    if (kind === CONFLICT_KIND_FILE) {
      const exists = await plugin.app.vault.adapter.exists(normalizePath(path));
      if (!exists) return null;
      return await hashFileAsync(plugin.app, normalizePath(path));
    }
  } catch (error) {
    dump(`[Conflict] Unable to hash local copy at detection: ${path}`, error);
  }
  return null;
}

/**
 * 冻结一条冲突路径的全部在途上传状态：
 * - 笔记/配置的待确认 hash、待确认删除集合；
 * - 附件的分片上传与其 60s 回执超时定时器（否则 recoverUpload 会自动重传冲突附件）；
 * - 并发名额与页归属（避免占着名额且页码永远等不到回执）。
 * 只清理“在途”，不动 hashManager 的已确认基线。
 *
 * Freeze every in-flight upload state for a conflicted path: pending note/config hashes, pending
 * delete acks, the attachment chunk upload and its 60s ack timeout (otherwise recoverUpload
 * retries the conflicting attachment), the concurrency slot and the page attribution. Only
 * in-flight state is cleared; confirmed baselines in the hash managers stay untouched.
 */
export function freezeConflictPath(plugin: FastSync, path: string): void {
  pauseUploadsForPath(plugin, path);
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
  plugin.pendingNoteDeleteAcks?.delete(path);
  plugin.pendingFileDeleteAcks?.delete(path);
  plugin.pendingConfigDeleteAcks?.delete(path);
  plugin.syncState.pendingNotePushPageIndex?.delete(path);
  plugin.syncState.pendingFilePushPageIndex?.delete(path);
  plugin.syncState.pendingConfigPushPageIndex?.delete(path);
  try {
    clearUploadTrackingForConflict(path);
  } catch (error) {
    dump(`[Conflict] Unable to clear attachment upload tracking for ${path}`, error);
  }
  plugin.concurrencyLimiter?.releaseSlot?.(path);
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

    // 只有“有真实远端内容”时才写 remote 备份；墓碑不写空正文冒充版本。
    // 远端非空但正文未内联（serverContent === ""，serverHash 却指向真实内容）时同样不写空
    // .remote，并记 hasServerContent=false，解决侧改为按需从服务端拉取后再落盘。
    // 配置通道的二进制以 fns-bin-v1 信封传输，这里解包后写原始字节并标记 isBinary。
    //
    // Stash a remote body only when one really exists; a tombstone is never faked as empty
    // content. A non-empty remote whose body was not inlined (serverContent === "" while
    // serverHash names real content) also gets no empty .remote, with hasServerContent=false, so
    // the resolver fetches it from the server instead. Binary settings travel in fns-bin-v1
    // envelopes: unwrap, write the raw bytes and mark isBinary.
    const serverHashText = conflict.serverHash || "";
    const hashNamesContent = serverHashText !== "" && serverHashText !== "0";
    const bodyInlined = conflict.serverContent !== "";
    let hasServerContent = false;
    let isBinary = false;
    if (!conflict.serverDeleted && (kind === CONFLICT_KIND_NOTE || kind === CONFLICT_KIND_SETTING)) {
      if (bodyInlined) {
        if (kind === CONFLICT_KIND_SETTING) {
          const decoded = decodeConfigContent(conflict.serverContent);
          if (decoded.kind === "binary") {
            await adapter.writeBinary(remoteBackupPath, decoded.bytes);
            isBinary = true;
          } else {
            await adapter.write(remoteBackupPath, decoded.text);
          }
        } else {
          await adapter.write(remoteBackupPath, conflict.serverContent);
        }
        hasServerContent = true;
      } else if (!hashNamesContent) {
        // 空文本是合法的远端版本（哈希 "0"）：写一个空文件，绝不当成“没有内容”
        // An empty body is a legal remote version (hash "0"): write an empty file, never "absent"
        await adapter.write(remoteBackupPath, "");
        hasServerContent = true;
      }
    }
    if (!hasServerContent && await adapter.exists(remoteBackupPath)) {
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

    // 检测时的本地哈希：配置要按磁盘原始字节算（虚拟配置按字符串），笔记/附件按当前内容算。
    // 解决动作据此复核“检测后是否又改过”，避免把旧决策套到新内容上。
    // Local hash at detection: settings hash raw on-disk bytes (virtual settings hash the string),
    // notes/attachments hash the current content. Resolvers re-check it before applying a decision.
    const previous = await readConflictMeta(plugin, path);
    const localHashAtDetection = await detectLocalHash(plugin, path, kind);
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
      ...(isBinary ? { isBinary: true } : {}),
      ...(localHashAtDetection !== null
        ? { localHashAtDetection }
        : (previous?.localHashAtDetection ? { localHashAtDetection: previous.localHashAtDetection } : {})),
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

/**
 * 失效冲突记录自愈：集合里有路径、但没有对应 meta 的记录无法再展示类型与原因，也无法解决
 * （常见于只清掉插件目录状态文件、没清到 localStorage 里 `fns-conflicted-paths` 的情况）。
 * 只从集合中移除并落盘，不动本地/远端备份文件；读取失败时不误删，留待下次判断。
 *
 * Self-heal invalid conflict records: a path in the set without meta cannot show its kind or
 * reason and cannot be resolved (e.g. the plugin-dir state files were cleared but the
 * localStorage `fns-conflicted-paths` set survived). Drop and persist only the record; local
 * and remote backups are left alone. A failed existence check keeps the record for next time.
 *
 * Returns the number of removed records.
 */
export async function pruneInvalidConflictRecords(plugin: FastSync): Promise<number> {
  const paths = plugin.syncState.conflictedPaths;
  if (!paths || paths.size === 0) return 0;
  const adapter = plugin.app.vault.adapter;
  const dir = `${getPluginDir(plugin)}/conflict-notes`;
  // 一次列举目录，而不是逐条 exists()：事故里的集合有 2315 条，逐条探测会明显拖慢启动。
  // 目录本身不存在时说明元数据全被清掉，集合里的记录全部失效。
  // List once instead of one exists() per path: the incident had 2315 entries, and per-path
  // probes visibly slow startup. A missing directory means every record lost its metadata.
  let existing: Set<string>;
  try {
    if (!(await adapter.exists(dir))) {
      existing = new Set();
    } else {
      const listed = await adapter.list(dir);
      existing = new Set(listed?.files ?? []);
    }
  } catch (error) {
    // 列举失败时保守保留全部记录，留待下次启动再判断
    // On a failed listing keep every record and try again next startup
    dump("[Conflict] Unable to list conflict metadata, keeping all records", error);
    return 0;
  }
  const invalid: string[] = [];
  for (const path of Array.from(paths)) {
    try {
      const { metaPath } = conflictBackupPaths(plugin, path);
      if (!existing.has(metaPath)) invalid.push(path);
    } catch (error) {
      dump(`[Conflict] Unable to resolve conflict metadata, keeping record: ${path}`, error);
    }
  }
  if (invalid.length === 0) return 0;
  for (const path of invalid) paths.delete(path);
  plugin.localStorageManager.setConflictedPaths(paths);
  plugin.statusBarManager?.updateConflictBadge?.();
  // 只记数量，避免一次启动刷出几千条日志 / Count only, never one line per path
  recordDiagBufferOnly("warn", "ConflictState", `${invalid.length} conflicted path(s) had no metadata and were removed from the list`);
  return invalid.length;
}

/**
 * 重置同步状态时清空冲突记录：内存集合、localStorage 集合与 conflict-notes 的元数据。
 * 备份正文（.base/.remote/.local-backup）默认保留，便于用户仍能找回内容；
 * 切换远端库名的完整清理由 clearVaultConflictBackups 负责。
 *
 * Clear conflict records when resetting sync state: the in-memory set, the localStorage set
 * and the conflict-notes metadata. Backup bodies (.base/.remote/.local-backup) are kept by
 * default so content can still be recovered; a vault switch clears the whole folder separately.
 */
export async function resetConflictRecords(plugin: FastSync): Promise<void> {
  const paths = plugin.syncState.conflictedPaths;
  paths?.clear();
  plugin.localStorageManager.setConflictedPaths(new Set());
  plugin.statusBarManager?.updateConflictBadge?.();
  try {
    const adapter = plugin.app.vault.adapter;
    const dir = `${getPluginDir(plugin)}/conflict-notes`;
    if (!(await adapter.exists(dir))) return;
    const listed = await adapter.list(dir);
    const metas = (listed?.files ?? []).filter((file) => file.endsWith(".meta.json"));
    await Promise.all(metas.map((file) => adapter.remove(file)));
    if (metas.length > 0) {
      recordDiagBufferOnly("info", "ConflictState", `${metas.length} conflict metadata file(s) removed by a sync-state reset`);
    }
  } catch (error) {
    dump("[Conflict] Unable to clear conflict metadata on reset", error);
  }
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
