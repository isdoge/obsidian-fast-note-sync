import { normalizePath } from "obsidian";

import { hashContentAsync, dump } from "../utils/helpers";
import {
  conflictBackupPaths,
  readConflictMeta,
  removeConflictBackups,
  noteModify,
  CONFLICT_REASON_UNALIGNED,
} from "./operator_note";
import type FastSync from "../../main";

/**
 * 批量对齐的执行模式。
 * Batch alignment modes.
 */
export type ConflictAlignMode = "local" | "remote" | "both";

export interface ConflictAlignResult {
  path: string;
  ok: boolean;
  reason?: "new_edit" | "missing_local" | "missing_remote" | "error";
}

function clearConflictedPath(plugin: FastSync, path: string): void {
  plugin.syncState.conflictedPaths.delete(path);
  plugin.localStorageManager.setConflictedPaths(plugin.syncState.conflictedPaths);
  plugin.statusBarManager?.updateConflictBadge?.();
}

/**
 * 为一个待对齐/冲突条目挑选不冲突的可见 `.remote.md` 副本路径。
 * Pick a non-colliding visible `.remote.md` path for "keep both".
 */
function pickVisibleRemoteCopyPath(plugin: FastSync, path: string): string {
  const base = path.replace(/\.md$/i, "");
  let candidate = `${base}.remote.md`;
  let index = 2;
  while (plugin.app.vault.getFileByPath(normalizePath(candidate)) || plugin.app.vault.getAbstractFileByPath?.(normalizePath(candidate))) {
    candidate = `${base}.remote.${index}.md`;
    index++;
  }
  return candidate;
}

/**
 * 对单个条目执行对齐动作。执行前会重新读取本地内容并和目标检测时记录的内容哈希比对：
 * 若条目进入待对齐之后又被用户编辑过，直接跳过，避免批量操作误伤新内容。
 *
 * Align one entry. Before acting, re-read the local content and compare it with the hash
 * recorded at detection time; if the user edited it while it was pending, skip the batch
 * action so fresh edits are never clobbered.
 */
export async function alignConflictEntry(
  plugin: FastSync,
  rawPath: string,
  mode: ConflictAlignMode
): Promise<ConflictAlignResult> {
  const path = normalizePath(rawPath);
  const file = plugin.app.vault.getFileByPath(path);
  if (!file) return { path, ok: false, reason: "missing_local" };

  const adapter = plugin.app.vault.adapter;
  const locked = await plugin.lockManager.withLock(path, async () => {
    // 锁内重新读取，避免检查与写入之间插入编辑
    // Re-read inside the lock so no edit can slip between check and write
    const latestFile = plugin.app.vault.getFileByPath(path);
    if (!latestFile) return { path, ok: false, reason: "missing_local" as const };

    const localContent = await plugin.app.vault.read(latestFile);
    const localHashNow = await hashContentAsync(localContent);
    // 任何批量覆盖/上传前都按检测时的本地哈希重检：远端版本来自更早的下行推送，
    // 若本地在待对齐期间又被编辑，批量动作一律跳过，交给用户单条核对。
    // Re-check the hash recorded at detection time before any batch write/upload: the remote
    // copy comes from an earlier push, so any later local edit makes the batch action unsafe.
    const meta = await readConflictMeta(plugin, path);
    if (meta?.localHashAtDetection && meta.localHashAtDetection !== localHashNow) {
      return { path, ok: false, reason: "new_edit" as const };
    }

    const { dir: conflictDir, remoteBackupPath, localBackupPath } = conflictBackupPaths(plugin, path);
    const hasRemote = await adapter.exists(remoteBackupPath);
    if (!hasRemote && mode !== "local") return { path, ok: false, reason: "missing_remote" as const };
    const remoteContent = hasRemote ? await adapter.read(remoteBackupPath) : "";

    try {
      if (mode === "local") {
        // 保留本地：清理内部备份与待对齐状态，然后主动上传本地版本
        // Keep local: drop internal backups/state, then upload the local version
        clearConflictedPath(plugin, path);
        await removeConflictBackups(plugin, path);
        await noteModify(latestFile, plugin, true);
        return { path, ok: true };
      }

      if (mode === "remote") {
        // 以远端为准：先在本插件内部目录保留本地备份，再落盘远端内容
        // Remote wins: back up the local copy inside the plugin dir first, then write remote
        if (!(await adapter.exists(conflictDir))) await adapter.mkdir(conflictDir);
        await adapter.write(localBackupPath, localContent);
        await plugin.app.vault.modify(latestFile, remoteContent);
        const writtenFile = plugin.app.vault.getFileByPath(path) ?? latestFile;
        const remoteHash = await hashContentAsync(remoteContent);
        plugin.fileHashManager.setFileHash(path, remoteHash, writtenFile.stat?.mtime || 0, writtenFile.stat?.size || 0);
        plugin.lastSyncMtime.set(path, writtenFile.stat?.mtime || 0);
        clearConflictedPath(plugin, path);
        await removeConflictBackups(plugin, path, { keepLocalBackup: true });
        return { path, ok: true };
      }

      // 保留双份：本地原文件不动，远端版本另存为可见的 .remote.md 副本，再上传本地版本
      // Keep both: leave the local note alone, save the remote version as a visible .remote.md
      // copy, then upload the local version
      const copyPath = pickVisibleRemoteCopyPath(plugin, path);
      await plugin.app.vault.create(copyPath, remoteContent);
      clearConflictedPath(plugin, path);
      await removeConflictBackups(plugin, path);
      await noteModify(latestFile, plugin, true);
      return { path, ok: true };
    } catch (error) {
      dump(`[FastSync] Failed to align conflict entry (${mode}): ${path}`, error);
      return { path, ok: false, reason: "error" as const };
    }
  }, { maxRetries: 2, retryInterval: 50 });
  return locked ?? { path, ok: false, reason: "error" };
}

export async function alignConflictEntries(
  plugin: FastSync,
  paths: string[],
  mode: ConflictAlignMode
): Promise<ConflictAlignResult[]> {
  const results: ConflictAlignResult[] = [];
  for (const path of paths) {
    results.push(await alignConflictEntry(plugin, path, mode));
  }
  return results;
}

/**
 * 列出当前处于待对齐状态的路径（其余为普通双端冲突）。
 * List paths currently pending alignment (others are ordinary two-sided conflicts).
 */
export async function listUnalignedPaths(plugin: FastSync, paths?: Iterable<string>): Promise<string[]> {
  const source = paths ?? plugin.syncState.conflictedPaths;
  const unaligned: string[] = [];
  for (const path of source) {
    const meta = await readConflictMeta(plugin, path);
    if (meta?.reason === CONFLICT_REASON_UNALIGNED) unaligned.push(path);
  }
  return unaligned;
}