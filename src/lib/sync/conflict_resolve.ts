import { normalizePath } from "obsidian";

import { dump, dumpError, hashContent, hashContentAsync, hashFileAsync } from "../utils/helpers";
import { CONFLICT_KIND_FOLDER, CONFLICT_KIND_NOTE, CONFLICT_KIND_SETTING, readUnifiedConflictMeta, clearConflictState } from "./conflict_store";
import { conflictBackupPaths, noteDeleteByPath, noteModify } from "./operator_note";
import { fileDeleteByPath, fileModify } from "./operator_file";
import { folderModify } from "./operator_folder";
import { configModify } from "./operator_config";
import type FastSync from "../../main";

/**
 * 四类资源冲突的解决动作（设计稿 §5.3 / 阶段 E）。
 * 全部动作都先复核“检测时的本地哈希”，避免把检测之后的编辑套用到旧决策上；
 * 选择本地时条件提交（isConflictResolved + 用户看到的 serverRevision），选择远端时先备份本地内容。
 *
 * Resolution actions for all four kinds (design §5.3 / stage E). Every action first re-checks the
 * local hash recorded at detection time so a later edit never inherits an old decision. Choosing
 * local performs a conditional submit (isConflictResolved + the serverRevision the user saw);
 * choosing remote backs up the local copy first.
 */
export type ConflictResolveMode = "local" | "remote" | "both";

export interface ConflictResolveResult {
  path: string;
  ok: boolean;
  reason?: "new_edit" | "missing_local" | "missing_remote" | "unsupported" | "error";
}

async function pickVisibleCopyPath(plugin: FastSync, path: string, suffix: string): Promise<string> {
  const dot = path.lastIndexOf(".");
  const base = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  let candidate = `${base}${suffix}${ext}`;
  let index = 2;
  const exists = async (p: string) => !!plugin.app.vault.getAbstractFileByPath?.(normalizePath(p))
    || !!plugin.app.vault.getFileByPath(normalizePath(p))
    || await plugin.app.vault.adapter.exists(normalizePath(p)).catch(() => false);
  while (await exists(candidate)) {
    candidate = `${base}${suffix}.${index}${ext}`;
    index++;
  }
  return candidate;
}

async function confirmBaseline(plugin: FastSync, kind: string, path: string, hash: string, revision: string, mtime = 0, size = 0): Promise<void> {
  if (!hash || !revision) return;
  if (kind === CONFLICT_KIND_SETTING) {
    plugin.configHashManager?.setConfirmedBaseline?.(path, hash, revision, mtime, size);
  } else {
    plugin.fileHashManager?.setConfirmedBaseline?.(path, hash, revision, mtime, size);
  }
}

async function resolveNote(plugin: FastSync, path: string, mode: ConflictResolveMode, meta: NonNullable<Awaited<ReturnType<typeof readUnifiedConflictMeta>>>): Promise<ConflictResolveResult> {
  const { remoteBackupPath, localBackupPath } = conflictBackupPaths(plugin, path);
  const adapter = plugin.app.vault.adapter;
  const file = plugin.app.vault.getFileByPath(normalizePath(path));
  const hasRemote = await adapter.exists(remoteBackupPath);

  if (!file) {
    if (mode === "remote") {
      if (!hasRemote) return { path, ok: false, reason: "missing_remote" };
      const remote = await adapter.read(remoteBackupPath);
      await plugin.app.vault.create(normalizePath(path), remote);
      const created = plugin.app.vault.getFileByPath(normalizePath(path));
      if (meta.serverRevision) await confirmBaseline(plugin, CONFLICT_KIND_NOTE, path, meta.serverHash || await hashContentAsync(remote), meta.serverRevision, created?.stat?.mtime || 0, created?.stat?.size || 0);
      clearConflictState(plugin, path);
      return { path, ok: true };
    }
    // 本地已删除：以本地为准 = 条件删除远端（携带 tombstone revision）
    await noteDeleteByPath(path, plugin, undefined, {
      hash: meta.baseHash || "",
      hashMissing: !meta.baseHash,
      revision: meta.serverRevision || "",
    });
    clearConflictState(plugin, path);
    return { path, ok: true };
  }

  const localContent = await plugin.app.vault.read(file);
  const localHash = await hashContentAsync(localContent);
  if (meta.localHashAtDetection && meta.localHashAtDetection !== localHash) {
    return { path, ok: false, reason: "new_edit" };
  }

  if (mode === "remote") {
    // 先备份本地，再（按墓碑状态）删除或写入远端版本，并更新可信基线
    // Back up the local copy first, then delete (tombstone) or write the remote body, and update
    // the trusted baseline
    await adapter.write(localBackupPath, localContent);
    if (meta.serverDeleted) {
      await plugin.app.fileManager.trashFile(file);
      plugin.fileHashManager?.removeFileHash?.(path);
      clearConflictState(plugin, path, { keepBackup: true });
      return { path, ok: true };
    }
    if (!hasRemote) return { path, ok: false, reason: "missing_remote" };
    const remote = await adapter.read(remoteBackupPath);
    await plugin.app.vault.modify(file, remote);
    const written = plugin.app.vault.getFileByPath(normalizePath(path)) ?? file;
    await confirmBaseline(plugin, CONFLICT_KIND_NOTE, path, meta.serverHash || await hashContentAsync(remote), meta.serverRevision || "", written.stat?.mtime || 0, written.stat?.size || 0);
    plugin.lastSyncMtime.set(path, written.stat?.mtime || 0);
    clearConflictState(plugin, path, { keepBackup: true });
    return { path, ok: true };
  }

  if (mode === "both") {
    if (hasRemote) {
      const remote = await adapter.read(remoteBackupPath);
      const copyPath = await pickVisibleCopyPath(plugin, path, ".remote");
      await plugin.app.vault.create(normalizePath(copyPath), remote);
    }
  }

  // 本地/双份：条件提交本地内容；远端已删时同一条条件恢复上传
  // Local / keep-both: conditional submit of the local body; a tombstone is conditionally restored
  clearConflictState(plugin, path);
  await noteModify(file, plugin, true, {
    isConflictResolved: true,
    baseRevision: meta.serverRevision || "",
  });
  return { path, ok: true };
}

async function resolveSetting(plugin: FastSync, path: string, mode: ConflictResolveMode, meta: NonNullable<Awaited<ReturnType<typeof readUnifiedConflictMeta>>>): Promise<ConflictResolveResult> {
  const adapter = plugin.app.vault.adapter;
  const { remoteBackupPath, localBackupPath } = conflictBackupPaths(plugin, path);
  const isVirtual = path.startsWith(plugin.localStorageManager.syncPathPrefix);
  const fullPath = normalizePath(path);
  const exists = isVirtual
    ? plugin.localStorageManager.getItemValue(plugin.localStorageManager.pathToKey(path) || "") !== null
    : await adapter.exists(fullPath);

  if (!exists) {
    if (mode === "remote") {
      if (!(await adapter.exists(remoteBackupPath))) return { path, ok: false, reason: "missing_remote" };
      const remote = await adapter.read(remoteBackupPath);
      if (isVirtual) void plugin.localStorageManager.handleReceivedUpdate?.(path, remote);
      else await adapter.write(fullPath, remote);
      await confirmBaseline(plugin, CONFLICT_KIND_SETTING, path, meta.serverHash || await hashContentAsync(remote), meta.serverRevision || "", Date.now(), remote.length);
      clearConflictState(plugin, path);
      return { path, ok: true };
    }
    // 本地已删除 → 条件删除远端配置
    if (isVirtual) {
      plugin.configHashManager?.recordPendingDeleteBaseline?.(path);
    }
    plugin.pendingConfigDeleteAcks.add(path);
    void plugin.websocket.SendMessage("SettingDelete", {
      vault: plugin.settings.vault,
      path,
      pathHash: hashContent(path),
      ...(meta.serverRevision ? {
        baseHash: meta.baseHash || "",
        baseHashMissing: !meta.baseHash,
        baseRevision: meta.serverRevision,
      } : { baseHashMissing: true }),
    });
    clearConflictState(plugin, path);
    return { path, ok: true };
  }

  if (mode === "remote") {
    if (meta.serverDeleted) {
      await adapter.write(localBackupPath, isVirtual ? (plugin.localStorageManager.getItemValue(plugin.localStorageManager.pathToKey(path) || "") || "") : await adapter.read(fullPath));
      if (isVirtual) void plugin.localStorageManager.handleReceivedUpdate?.(path, "");
      else await adapter.remove(fullPath);
      plugin.configHashManager?.removeFileHash?.(path);
      clearConflictState(plugin, path, { keepBackup: true });
      return { path, ok: true };
    }
    if (!(await adapter.exists(remoteBackupPath))) return { path, ok: false, reason: "missing_remote" };
    const remote = await adapter.read(remoteBackupPath);
    if (isVirtual) {
      void plugin.localStorageManager.handleReceivedUpdate?.(path, remote);
    } else {
      await adapter.write(localBackupPath, await adapter.read(fullPath));
      await adapter.write(fullPath, remote);
    }
    await confirmBaseline(plugin, CONFLICT_KIND_SETTING, path, meta.serverHash || await hashContentAsync(remote), meta.serverRevision || "", Date.now(), remote.length);
    clearConflictState(plugin, path, { keepBackup: true });
    return { path, ok: true };
  }

  if (mode === "both" && await adapter.exists(remoteBackupPath)) {
    const remote = await adapter.read(remoteBackupPath);
    const copyPath = await pickVisibleCopyPath(plugin, path, ".remote");
    if (isVirtual) void plugin.localStorageManager.handleReceivedUpdate?.(copyPath, remote);
    else await adapter.write(normalizePath(copyPath), remote);
  }

  clearConflictState(plugin, path);
  // 虚拟配置无法从磁盘重读，直接把当前值作为 content 条件提交
  // A virtual config cannot be re-read from disk; submit its current value as content
  const virtualContent = isVirtual
    ? (plugin.localStorageManager.getItemValue(plugin.localStorageManager.pathToKey(path) || "") || undefined)
    : undefined;
  await configModify(path, plugin, false, virtualContent, true, {
    isConflictResolved: true,
    baseRevision: meta.serverRevision || "",
  });
  return { path, ok: true };
}

async function resolveFile(plugin: FastSync, path: string, mode: ConflictResolveMode, meta: NonNullable<Awaited<ReturnType<typeof readUnifiedConflictMeta>>>): Promise<ConflictResolveResult> {
  const adapter = plugin.app.vault.adapter;
  const { localBackupPath } = conflictBackupPaths(plugin, path);
  const fullPath = normalizePath(path);
  const file = plugin.app.vault.getFileByPath(fullPath);

  if (!file) {
    if (mode === "remote") {
      // 远端版本通过既有下载流程取得；清除暂停状态后触发重推
      // The remote version is fetched through the normal download path; clear the pause and re-push
      clearConflictState(plugin, path);
      void plugin.websocket.SendMessage("FileRePush", { vault: plugin.settings.vault, path, pathHash: hashContent(path) });
      return { path, ok: true };
    }
    await fileDeleteByPath(path, plugin, undefined, {
      hash: meta.baseHash || "",
      hashMissing: !meta.baseHash,
      revision: meta.serverRevision || "",
    });
    clearConflictState(plugin, path);
    return { path, ok: true };
  }

  if (meta.localHashAtDetection) {
    const diskHash = await hashFileAsync(plugin.app, fullPath).catch(() => null);
    if (diskHash !== null && diskHash !== meta.localHashAtDetection) return { path, ok: false, reason: "new_edit" };
  }

  if (mode === "remote") {
    const bytes = await adapter.readBinary(fullPath);
    await adapter.writeBinary(localBackupPath, bytes);
    if (meta.serverDeleted) {
      await plugin.app.fileManager.trashFile(file);
      plugin.fileHashManager?.removeFileHash?.(path);
      clearConflictState(plugin, path, { keepBackup: true });
      return { path, ok: true };
    }
    // 删除本地后触发远端重推，由下载流程绑定 serverRevision 落盘
    // Remove the local copy and re-push; the download path binds serverRevision when it lands
    await plugin.app.fileManager.trashFile(file);
    clearConflictState(plugin, path);
    void plugin.websocket.SendMessage("FileRePush", { vault: plugin.settings.vault, path, pathHash: hashContent(path) });
    return { path, ok: true };
  }

  if (mode === "both") {
    const bytes = await adapter.readBinary(fullPath);
    const copyPath = await pickVisibleCopyPath(plugin, path, ".local");
    await adapter.writeBinary(normalizePath(copyPath), bytes);
  }

  clearConflictState(plugin, path);
  await fileModify(file, plugin, true, true, {
    isConflictResolved: true,
    baseRevision: meta.serverRevision || "",
  });
  return { path, ok: true };
}

async function resolveFolder(plugin: FastSync, folderPath: string, mode: ConflictResolveMode, meta: NonNullable<Awaited<ReturnType<typeof readUnifiedConflictMeta>>>): Promise<ConflictResolveResult> {
  const folder = plugin.app.vault.getAbstractFileByPath(normalizePath(folderPath));
  if (mode === "remote") {
    if (folder && meta.serverDeleted) {
      await plugin.app.fileManager.trashFile(folder);
      plugin.folderSnapshotManager?.removeFolder?.(folderPath);
    }
    if (meta.serverRevision) plugin.folderSnapshotManager?.setConfirmedRevision?.(folderPath, meta.serverRevision);
    clearConflictState(plugin, folderPath);
    return { path: folderPath, ok: true };
  }
  let target = folder;
  if (!target) {
    try {
      await plugin.app.vault.createFolder(normalizePath(folderPath));
      target = plugin.app.vault.getAbstractFileByPath(normalizePath(folderPath));
    } catch (error) {
      dump(`[Conflict] Unable to create folder for resolution: ${folderPath}`, error);
    }
  }
  clearConflictState(plugin, folderPath);
  if (target) {
    await folderModify(target as Parameters<typeof folderModify>[0], plugin, true, {
      isConflictResolved: true,
      baseRevision: meta.serverRevision || "",
    });
  }
  return { path: folderPath, ok: true };
}

/** 按资源类型执行一次冲突解决 / Resolve one conflict entry by resource kind */
export async function resolveConflictEntry(plugin: FastSync, rawPath: string, mode: ConflictResolveMode): Promise<ConflictResolveResult> {
  const path = normalizePath(rawPath);
  const meta = await readUnifiedConflictMeta(plugin, path);
  if (!meta) return { path, ok: false, reason: "missing_remote" };
  try {
    if (meta.kind === CONFLICT_KIND_SETTING) return await resolveSetting(plugin, path, mode, meta);
    if (meta.kind === CONFLICT_KIND_FOLDER) return await resolveFolder(plugin, path, mode, meta);
    if (meta.kind === "file") return await resolveFile(plugin, path, mode, meta);
    return await resolveNote(plugin, path, mode, meta);
  } catch (error) {
    dumpError(`[Conflict] Resolution failed (${mode}): ${path}`, error);
    return { path, ok: false, reason: "error" };
  }
}

/** 判断条目是笔记/文本配置（可用差异编辑器）还是附件/目录（用选择框） */
export function conflictSupportsDiffEditor(kind: string | undefined): boolean {
  return kind === CONFLICT_KIND_NOTE || kind === CONFLICT_KIND_SETTING || kind === undefined;
}
