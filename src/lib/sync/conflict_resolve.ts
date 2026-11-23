import { normalizePath } from "obsidian";

import { dump, dumpError, hashContent, hashContentAsync, hashFileAsync } from "../utils/helpers";
import { CONFLICT_KIND_FOLDER, CONFLICT_KIND_NOTE, CONFLICT_KIND_SETTING, readUnifiedConflictMeta, clearConflictState } from "./conflict_store";
import { conflictBackupPaths, noteDeleteByPath, noteModify } from "./operator_note";
import { fileDeleteByPath, fileModify } from "./operator_file";
import { folderDeleteByPath, folderModify } from "./operator_folder";
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
  reason?: "new_edit" | "missing_local" | "missing_remote" | "unsupported" | "readonly" | "error";
}

/**
 * 冲突解决里的上行动作（条件删除 / 重推 / 条件提交）在只读模式下整体不执行。
 * 判断口径 fail-closed：本轮入口快照或实时设置任一为只读即拦截（轮次外快照为 false，退化为实时设置）。
 * 拦截必须发生在任何本地副作用之前，避免「本地已删除/已覆盖/冲突状态已清、远端却没发」的半截状态。
 * 只在本地落远端内容、不改远端的动作（例如采用远端墓碑）不走这个判断。
 *
 * Uplink resolution actions (conditional delete / re-push / conditional submit) never run in
 * read-only mode. The gate is fail-closed: either the round entry snapshot or the live setting
 * blocks it (outside a round the snapshot is false and the live setting decides). It must fire
 * before any local side effect so the local copy and conflict state can never diverge from the
 * remote. Local-only actions that never change the remote are not gated.
 */
export function readonlyResolutionBlocked(plugin: FastSync): boolean {
  return !!(plugin.syncRoundReadonly || plugin.settings.readonlySyncEnabled);
}

function readonlyResult(path: string): ConflictResolveResult {
  return { path, ok: false, reason: "readonly" };
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

/**
 * 取远端版本正文：优先读冲突检测时落盘的 .remote 备份；未内联正文（hasServerContent=false）
 * 时通过只读 HTTP 接口拉取远端内容，并校验哈希等于检测时的 serverHash 才返回。
 * 拿不到（接口不可用 / 哈希不符 / 远端已不存在）返回 null，调用方必须拒绝清空本地，提示先同步刷新。
 *
 * Fetch the remote body: prefer the .remote backup written at detection; when the body was not
 * inlined (hasServerContent=false), pull it through the read-only HTTP endpoint and accept it only
 * when its hash matches the serverHash recorded at detection. Returns null when unavailable
 * (endpoint down / hash mismatch / remote gone); callers must then refuse to clear the local copy
 * and ask the user to sync first.
 */
export async function loadRemoteNoteBody(
  plugin: FastSync,
  path: string,
  meta: NonNullable<Awaited<ReturnType<typeof readUnifiedConflictMeta>>>,
): Promise<{ body: string; hash: string } | null> {
  const { remoteBackupPath } = conflictBackupPaths(plugin, path);
  const adapter = plugin.app.vault.adapter;
  if (meta.hasServerContent !== false && await adapter.exists(remoteBackupPath)) {
    const body = await adapter.read(remoteBackupPath);
    return { body, hash: meta.serverHash || await hashContentAsync(body) };
  }
  const api = plugin.api as { getNoteContent?: (path: string) => Promise<{ content: string; contentHash: string } | null> } | null | undefined;
  if (!api || typeof api.getNoteContent !== "function") return null;
  try {
    const remote = await api.getNoteContent(path);
    if (!remote) return null;
    if (meta.serverHash && remote.contentHash !== meta.serverHash) {
      dump(`[Conflict] Remote body changed since detection (${path}): expected ${meta.serverHash}, got ${remote.contentHash}`);
      return null;
    }
    return { body: remote.content, hash: remote.contentHash };
  } catch (error) {
    dump(`[Conflict] Unable to fetch remote body for ${path}`, error);
    return null;
  }
}

async function resolveNote(plugin: FastSync, path: string, mode: ConflictResolveMode, meta: NonNullable<Awaited<ReturnType<typeof readUnifiedConflictMeta>>>): Promise<ConflictResolveResult> {
  const { localBackupPath } = conflictBackupPaths(plugin, path);
  const adapter = plugin.app.vault.adapter;
  const file = plugin.app.vault.getFileByPath(normalizePath(path));

  if (!file) {
    if (mode === "remote") {
      const remote = await loadRemoteNoteBody(plugin, path, meta);
      if (!remote) return { path, ok: false, reason: "missing_remote" };
      await plugin.app.vault.create(normalizePath(path), remote.body);
      const created = plugin.app.vault.getFileByPath(normalizePath(path));
      if (meta.serverRevision) await confirmBaseline(plugin, CONFLICT_KIND_NOTE, path, meta.serverHash || remote.hash, meta.serverRevision, created?.stat?.mtime || 0, created?.stat?.size || 0);
      clearConflictState(plugin, path);
      return { path, ok: true };
    }
    // 条件删除远端属于上行动作：只读下整体不执行（先于仓库操作与冲突状态清理）
    // Conditional remote delete is an uplink: never run it in read-only mode (before any vault
    // operation or conflict-state cleanup)
    if (readonlyResolutionBlocked(plugin)) return readonlyResult(path);

    // 本地已删除：以本地为准 = 条件删除远端。基线必须用用户刚刚确认的远端状态
    // （serverHash/serverRevision），服务端据此原子核对后删除；沿用旧 baseHash 会 530 死循环。
    // Local deleted, keep local => conditionally delete the remote. The baseline must be the remote
    // state the user just confirmed (serverHash/serverRevision) so the server can atomically verify
    // and delete; reusing the stale baseHash loops on 530 forever.
    await noteDeleteByPath(path, plugin, undefined, {
      hash: meta.serverHash || "",
      hashMissing: !meta.serverHash,
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
    const remote = await loadRemoteNoteBody(plugin, path, meta);
    // 远端正文拿不到时绝不把空串写进用户笔记：拒绝并提示先同步刷新
    // Never write an empty body into the user's note when the remote is unavailable
    if (!remote) return { path, ok: false, reason: "missing_remote" };
    await plugin.app.vault.modify(file, remote.body);
    const written = plugin.app.vault.getFileByPath(normalizePath(path)) ?? file;
    await confirmBaseline(plugin, CONFLICT_KIND_NOTE, path, meta.serverHash || remote.hash, meta.serverRevision || "", written.stat?.mtime || 0, written.stat?.size || 0);
    plugin.lastSyncMtime.set(path, written.stat?.mtime || 0);
    clearConflictState(plugin, path, { keepBackup: true });
    return { path, ok: true };
  }

  // “保留双份 / 采用本地”都会条件提交本地内容到远端：只读下整体不执行，
  // 拦截放在生成本地副本之前，避免留下副本却发不出去的半截状态。
  // "Keep both / use local" both conditionally submit the local body to the remote: never run
  // in read-only mode, and gate before creating the local copy so no half state is left behind.
  if (readonlyResolutionBlocked(plugin)) return readonlyResult(path);

  if (mode === "both") {
    const remote = await loadRemoteNoteBody(plugin, path, meta);
    if (remote) {
      const copyPath = await pickVisibleCopyPath(plugin, path, ".remote");
      await plugin.app.vault.create(normalizePath(copyPath), remote.body);
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

/** 配置通道远端正文的本地形态：虚拟项是字符串，磁盘项是原始字节（二进制安全） */
type SettingRemoteBody = { kind: "virtual"; text: string; hash: string } | { kind: "binary"; bytes: ArrayBuffer; hash: string } | { kind: "text"; text: string; hash: string };

/**
 * 读取配置通道的远端版本，二进制逐字节保留。
 * 未内联正文（hasServerContent=false）或 .remote 缺失时返回 null，调用方不得清空本地配置。
 *
 * Read the remote setting body keeping binary bytes intact. Returns null when the body was not
 * inlined (hasServerContent=false) or the .remote copy is missing; callers must then refuse to
 * clear the local setting.
 */
async function loadRemoteSettingBody(plugin: FastSync, path: string, meta: NonNullable<Awaited<ReturnType<typeof readUnifiedConflictMeta>>>): Promise<SettingRemoteBody | null> {
  const { remoteBackupPath } = conflictBackupPaths(plugin, path);
  const adapter = plugin.app.vault.adapter;
  if (meta.hasServerContent === false) return null;
  if (!(await adapter.exists(remoteBackupPath))) return null;
  const isVirtual = path.startsWith(plugin.localStorageManager.syncPathPrefix);
  if (isVirtual) {
    const text = await adapter.read(remoteBackupPath);
    return { kind: "virtual", text, hash: meta.serverHash || await hashContentAsync(text) };
  }
  if (meta.isBinary) {
    const bytes = await adapter.readBinary(remoteBackupPath);
    return { kind: "binary", bytes, hash: meta.serverHash || await hashFileAsync(plugin.app, remoteBackupPath) };
  }
  const text = await adapter.read(remoteBackupPath);
  return { kind: "text", text, hash: meta.serverHash || await hashContentAsync(text) };
}

/** 把远端配置正文写回本地（虚拟项走 localStorage，磁盘项按二进制/文本分别写） */
async function applyRemoteSettingBody(plugin: FastSync, path: string, body: SettingRemoteBody): Promise<{ mtime: number; size: number }> {
  const adapter = plugin.app.vault.adapter;
  const fullPath = normalizePath(path);
  if (body.kind === "virtual") {
    void plugin.localStorageManager.handleReceivedUpdate?.(path, body.text);
    return { mtime: Date.now(), size: body.text.length };
  }
  if (body.kind === "binary") {
    await adapter.writeBinary(fullPath, body.bytes);
    const stat = await adapter.stat(fullPath).catch(() => null);
    return { mtime: stat?.mtime || Date.now(), size: body.bytes.byteLength };
  }
  await adapter.write(fullPath, body.text);
  const stat = await adapter.stat(fullPath).catch(() => null);
  return { mtime: stat?.mtime || Date.now(), size: body.text.length };
}

/** 本地配置在解决侧的复核哈希（虚拟项按字符串，磁盘项按原始字节） */
async function localSettingHash(plugin: FastSync, path: string): Promise<string | null> {
  const adapter = plugin.app.vault.adapter;
  if (path.startsWith(plugin.localStorageManager.syncPathPrefix)) {
    const value = plugin.localStorageManager.getItemValue(plugin.localStorageManager.pathToKey(path) || "");
    return value === null ? null : await hashContentAsync(value);
  }
  const fullPath = normalizePath(path);
  if (!(await adapter.exists(fullPath))) return null;
  return await hashFileAsync(plugin.app, fullPath);
}

async function resolveSetting(plugin: FastSync, path: string, mode: ConflictResolveMode, meta: NonNullable<Awaited<ReturnType<typeof readUnifiedConflictMeta>>>): Promise<ConflictResolveResult> {
  const adapter = plugin.app.vault.adapter;
  const { localBackupPath } = conflictBackupPaths(plugin, path);
  const isVirtual = path.startsWith(plugin.localStorageManager.syncPathPrefix);
  const fullPath = normalizePath(path);
  const exists = isVirtual
    ? plugin.localStorageManager.getItemValue(plugin.localStorageManager.pathToKey(path) || "") !== null
    : await adapter.exists(fullPath);

  // 检测后本地又被改过：拒绝把旧决策套到新内容上（与笔记一致）
  // Local copy edited after detection: never apply an old decision to new content
  if (exists && meta.localHashAtDetection) {
    const currentHash = await localSettingHash(plugin, path);
    if (currentHash !== null && currentHash !== meta.localHashAtDetection) return { path, ok: false, reason: "new_edit" };
  }

  if (!exists) {
    if (mode === "remote") {
      if (meta.serverDeleted) {
        // 远端已是墓碑：本地本就不存在，直接清状态即可
        // Remote is already a tombstone and the local copy is gone: just clear the state
        clearConflictState(plugin, path);
        return { path, ok: true };
      }
      const remote = await loadRemoteSettingBody(plugin, path, meta);
      if (!remote) return { path, ok: false, reason: "missing_remote" };
      const applied = await applyRemoteSettingBody(plugin, path, remote);
      await confirmBaseline(plugin, CONFLICT_KIND_SETTING, path, remote.hash, meta.serverRevision || "", applied.mtime, applied.size);
      clearConflictState(plugin, path);
      return { path, ok: true };
    }
    // 本地已删除 → 条件删除远端配置。基线用用户确认过的远端状态（serverHash/serverRevision），
    // 避免沿用旧 baseHash 造成 530 死循环。
    // Local deleted => conditionally delete the remote using the confirmed remote state, so the
    // stale baseHash cannot loop on 530.
    // 条件删除远端配置属于上行动作：只读下整体不执行（先于 pending/冲突状态等本地副作用）
    // Conditional remote setting delete is an uplink: never run in read-only mode (before the
    // pending baseline / pending ack / conflict-state side effects)
    if (readonlyResolutionBlocked(plugin)) return readonlyResult(path);

    if (isVirtual) {
      plugin.configHashManager?.recordPendingDeleteBaseline?.(path);
    }
    plugin.pendingConfigDeleteAcks.add(path);
    void plugin.websocket.SendMessage("SettingDelete", {
      vault: plugin.settings.vault,
      path,
      pathHash: hashContent(path),
      baseHash: meta.serverHash || "",
      baseHashMissing: !meta.serverHash,
      ...(meta.serverRevision ? { baseRevision: meta.serverRevision } : {}),
    });
    clearConflictState(plugin, path);
    return { path, ok: true };
  }

  if (mode === "remote") {
    if (meta.serverDeleted) {
      if (isVirtual) {
        await adapter.write(localBackupPath, plugin.localStorageManager.getItemValue(plugin.localStorageManager.pathToKey(path) || "") || "");
        void plugin.localStorageManager.handleReceivedUpdate?.(path, "");
      } else {
        await adapter.writeBinary(localBackupPath, await adapter.readBinary(fullPath));
        await adapter.remove(fullPath);
      }
      plugin.configHashManager?.removeFileHash?.(path);
      clearConflictState(plugin, path, { keepBackup: true });
      return { path, ok: true };
    }
    const remote = await loadRemoteSettingBody(plugin, path, meta);
    // 远端正文拿不到时拒绝清空本地配置，提示先同步刷新
    // Never clear the local setting when the remote body is unavailable
    if (!remote) return { path, ok: false, reason: "missing_remote" };
    if (isVirtual) {
      await adapter.write(localBackupPath, plugin.localStorageManager.getItemValue(plugin.localStorageManager.pathToKey(path) || "") || "");
    } else {
      await adapter.writeBinary(localBackupPath, await adapter.readBinary(fullPath));
    }
    const applied = await applyRemoteSettingBody(plugin, path, remote);
    await confirmBaseline(plugin, CONFLICT_KIND_SETTING, path, remote.hash, meta.serverRevision || "", applied.mtime, applied.size);
    clearConflictState(plugin, path, { keepBackup: true });
    return { path, ok: true };
  }

  // “保留双份 / 采用本地”都会条件提交配置到远端：只读下整体不执行，
  // 拦截放在写本地副本之前。
  // "Keep both / use local" both conditionally submit the setting to the remote: never run in
  // read-only mode, and gate before writing the local copy.
  if (readonlyResolutionBlocked(plugin)) return readonlyResult(path);

  if (mode === "both") {
    const remote = await loadRemoteSettingBody(plugin, path, meta);
    if (remote) {
      const copyPath = await pickVisibleCopyPath(plugin, path, ".remote");
      if (remote.kind === "virtual") {
        void plugin.localStorageManager.handleReceivedUpdate?.(copyPath, remote.text);
      } else if (remote.kind === "binary") {
        await adapter.writeBinary(normalizePath(copyPath), remote.bytes);
      } else {
        await adapter.write(normalizePath(copyPath), remote.text);
      }
    }
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
    // 该分支两条路都是上行动作（请求重推 / 条件删除远端），只读下整体不执行，
    // 拦截先于冲突状态清理。
    // Both paths here are uplinks (re-push request / conditional remote delete): never run in
    // read-only mode, and gate before the conflict state is cleared.
    if (readonlyResolutionBlocked(plugin)) return readonlyResult(path);
    if (mode === "remote") {
      // 远端版本通过既有下载流程取得；清除暂停状态后触发重推
      // The remote version is fetched through the normal download path; clear the pause and re-push
      clearConflictState(plugin, path);
      void plugin.websocket.SendMessage("FileRePush", { vault: plugin.settings.vault, path, pathHash: hashContent(path) });
      return { path, ok: true };
    }
    // 本地已删除、保留本地 => 以用户确认过的远端状态作基线条件删除，避免旧 baseHash 的 530 死循环
    // Local deleted, keep local => conditionally delete using the confirmed remote state, avoiding
    // the stale-baseHash 530 loop
    await fileDeleteByPath(path, plugin, undefined, {
      hash: meta.serverHash || "",
      hashMissing: !meta.serverHash,
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
    if (meta.serverDeleted) {
      // 远端已是墓碑、只删本地：不动远端，属于纯本地动作，只读下照常允许
      // Remote is already a tombstone and only the local copy is removed: local-only, so it
      // stays allowed in read-only mode
      const bytes = await adapter.readBinary(fullPath);
      await adapter.writeBinary(localBackupPath, bytes);
      await plugin.app.fileManager.trashFile(file);
      plugin.fileHashManager?.removeFileHash?.(path);
      clearConflictState(plugin, path, { keepBackup: true });
      return { path, ok: true };
    }
    // 采用远端要先删本地再请求服务端重推：只读下整体不执行，拦截放在备份/删除本地之前
    // "Use remote" deletes the local copy then requests a remote re-push: never run in
    // read-only mode, and gate before the local backup/delete
    if (readonlyResolutionBlocked(plugin)) return readonlyResult(path);
    const bytes = await adapter.readBinary(fullPath);
    await adapter.writeBinary(localBackupPath, bytes);
    // 删除本地后触发远端重推，由下载流程绑定 serverRevision 落盘
    // Remove the local copy and re-push; the download path binds serverRevision when it lands
    await plugin.app.fileManager.trashFile(file);
    clearConflictState(plugin, path);
    void plugin.websocket.SendMessage("FileRePush", { vault: plugin.settings.vault, path, pathHash: hashContent(path) });
    return { path, ok: true };
  }

  // 双份/本地都会条件提交附件到远端：只读下整体不执行，拦截放在生成本地副本之前
  // "both"/"local" conditionally submit the attachment to the remote: never run in read-only
  // mode, and gate before creating the local copy
  if (readonlyResolutionBlocked(plugin)) return readonlyResult(path);

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
  const snapshot = plugin.folderSnapshotManager;
  // 本地目录不存在（local_deleted）时两个分支都不能写反：
  // - 保留本地已删状态（local）=> 条件删除远端目录，并清掉本地快照；
  // - 采用远端目录（remote）=> 远端未删就本地建回并写入快照；远端已删则只清快照。
  //
  // When the local folder is missing (local_deleted) neither branch may be inverted:
  // - keep the local deletion (local) => conditionally delete the remote folder and drop the snapshot;
  // - adopt the remote folder (remote) => recreate it locally and record the snapshot when the
  //   remote still exists; when the remote is a tombstone only the snapshot is dropped.
  if (!folder) {
    if (mode === "local") {
      // 条件删除远端目录属于上行动作：只读下整体不执行（先于快照与冲突状态清理）
      // Conditional remote folder delete is an uplink: never run in read-only mode (before the
      // snapshot / conflict-state side effects)
      if (readonlyResolutionBlocked(plugin)) return readonlyResult(folderPath);
      // 目录没有内容哈希：只要拿到检测时的 serverRevision 就必须保留它，
      // 不能用恒为空的 serverHash 把 revision 一起丢掉。
      // Folders have no content hash: whenever the detection-time serverRevision is known it must
      // survive, otherwise the always-empty serverHash would silently drop the revision too.
      await folderDeleteByPath(folderPath, plugin, undefined, {
        hash: "",
        hashMissing: !meta.serverRevision,
        revision: meta.serverRevision || "",
      });
      snapshot?.removeFolder?.(folderPath);
      clearConflictState(plugin, folderPath);
      return { path: folderPath, ok: true };
    }
    if (mode === "remote") {
      if (meta.serverDeleted) {
        snapshot?.removeFolder?.(folderPath);
        clearConflictState(plugin, folderPath);
        return { path: folderPath, ok: true };
      }
      try {
        await plugin.app.vault.createFolder(normalizePath(folderPath));
      } catch (error) {
        dump(`[Conflict] Unable to create folder for resolution: ${folderPath}`, error);
        return { path: folderPath, ok: false, reason: "error" };
      }
      if (meta.serverRevision) {
        snapshot?.setFolderMtime?.(folderPath, Date.now());
        snapshot?.setConfirmedRevision?.(folderPath, meta.serverRevision);
      }
      clearConflictState(plugin, folderPath);
      return { path: folderPath, ok: true };
    }
    // both：本地已删，没有可保留的本地目录，等同采用远端
    // both: nothing local survives, so it degenerates to adopting the remote folder
    if (meta.serverDeleted) {
      snapshot?.removeFolder?.(folderPath);
    } else {
      try {
        await plugin.app.vault.createFolder(normalizePath(folderPath));
        if (meta.serverRevision) {
          snapshot?.setFolderMtime?.(folderPath, Date.now());
          snapshot?.setConfirmedRevision?.(folderPath, meta.serverRevision);
        }
      } catch (error) {
        dump(`[Conflict] Unable to create folder for resolution: ${folderPath}`, error);
      }
    }
    clearConflictState(plugin, folderPath);
    return { path: folderPath, ok: true };
  }

  if (mode === "remote") {
    if (meta.serverDeleted) {
      await plugin.app.fileManager.trashFile(folder);
      snapshot?.removeFolder?.(folderPath);
    }
    if (meta.serverRevision) snapshot?.setConfirmedRevision?.(folderPath, meta.serverRevision);
    clearConflictState(plugin, folderPath);
    return { path: folderPath, ok: true };
  }
  // “保留双份 / 采用本地”都会条件提交目录到远端：只读下整体不执行，
  // 拦截放在建回本地目录与冲突状态清理之前。
  // "Keep both / use local" conditionally submit the folder to the remote: never run in
  // read-only mode, and gate before recreating the local folder and clearing the state.
  if (readonlyResolutionBlocked(plugin)) return readonlyResult(folderPath);

  let target: ReturnType<typeof plugin.app.vault.getAbstractFileByPath> = folder;
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
