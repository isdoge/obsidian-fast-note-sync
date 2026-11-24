import { blockAliasedRemoteMutation } from "./remote_path_guard";
import { advanceLiveSyncTime } from "./sync_state";
import { firstKeepWithoutBaseline } from "./remote_delete_guard";
import { TFile, TAbstractFile, normalizePath } from "obsidian";

import { ReceiveMessage, ReceiveMtimeMessage, ReceivePathMessage, SyncEndData } from "../utils/types";
import { hashContent, hashContentAsync, dump, dumpError, isPathExcluded, getSafeCtime, checkAndNotifyCaseConflict, getPluginDir, showSyncNotice, normalizeServerTimestamp } from "../utils/helpers";
import { SyncLogManager } from "./sync_log_manager";
import type FastSync from "../../main";
import { $ } from "../../i18n/lang";
import { BaselineDeleteRecord, baselineFieldsFromDeleteRecord, buildBaselineFields, buildDeleteBaselineFields } from "../storage/baseline_scope";
import * as syncDiagnostics from "../utils/sync_diagnostics";

// 同一插件会话中每条失败路径只通知一次；重试仍逐次保留同步错误日志。
const notifiedNoteFailures = new WeakMap<FastSync, Set<string>>();

/** 待对齐来源标记：本地已有内容但没有任何可信基线，不能直接覆盖 */
/** Alignment pending source: local content exists but has no trusted baseline; never overwrite */
export const CONFLICT_REASON_UNALIGNED = "unaligned_no_baseline";

export interface ConflictBackupMeta {
  /** 该条目进入冲突/待对齐的原因 / Why the entry entered conflict/pending alignment */
  reason?: string;
  /** 是否缺少共同祖先；true 时绝不伪造 base 文件 / Whether the common ancestor is missing */
  baseMissing?: boolean;
  /** 远端版本内容哈希 / Remote content hash */
  remoteHash?: string;
  /**
   * 检测当时的本地内容哈希（只存哈希，不存内容），用于批量对齐前的新编辑重检；
   * 持久化保存，使重检在插件重启后仍然有效。
   * Local content hash at detection time (a hash only, never content) used to re-check for new
   * edits before a batch action; persisted so the re-check still works after a restart.
   */
  localHashAtDetection?: string;
  /** 统一冲突资源类型（阶段 E）/ Unified conflict kind (stage E) */
  kind?: string;
  /** 服务端当前版本令牌 / Current server revision */
  serverRevision?: string;
  serverHash?: string;
  serverDeleted?: boolean;
  baseHash?: string;
  /** 是否存有真实远端正文备份 / Whether a real remote body was stashed */
  hasServerContent?: boolean;
}

export interface ConflictBackupPaths {
  dir: string;
  safeName: string;
  pathHash: string;
  baseBackupPath: string;
  remoteBackupPath: string;
  metaPath: string;
  localBackupPath: string;
}

/**
 * 冲突/待对齐条目的内部备份路径（位于插件自身目录，已被同步排除）。
 * Paths for a conflict/pending-alignment entry (inside the plugin dir, excluded from sync).
 */
export function conflictBackupPaths(plugin: FastSync, path: string): ConflictBackupPaths {
  const dir = `${getPluginDir(plugin)}/conflict-notes`;
  const safeName = path.replace(/\.md$/, "").replace(/[/\\]/g, "_");
  const pathHash = hashContent(path);
  return {
    dir,
    safeName,
    pathHash,
    baseBackupPath: `${dir}/${safeName}_${pathHash}.base.md`,
    remoteBackupPath: `${dir}/${safeName}_${pathHash}.remote.md`,
    metaPath: `${dir}/${safeName}_${pathHash}.meta.json`,
    localBackupPath: `${dir}/${safeName}_${pathHash}.local-backup.md`,
  };
}

export async function readConflictMeta(plugin: FastSync, path: string): Promise<ConflictBackupMeta | null> {
  try {
    const { metaPath } = conflictBackupPaths(plugin, path);
    const adapter = plugin.app.vault.adapter;
    if (!(await adapter.exists(metaPath))) return null;
    const raw = await adapter.read(metaPath);
    if (!raw) return null;
    return JSON.parse(raw) as ConflictBackupMeta;
  } catch (error) {
    dump("Failed to read conflict metadata:", error);
    return null;
  }
}

export async function writeConflictMeta(plugin: FastSync, path: string, meta: ConflictBackupMeta): Promise<void> {
  const { dir, metaPath } = conflictBackupPaths(plugin, path);
  const adapter = plugin.app.vault.adapter;
  if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
  await adapter.write(metaPath, JSON.stringify(meta));
}

/**
 * 清理冲突/待对齐的内部备份文件；keepLocalBackup 用于“以远端为准”后保留本地侧备份。
 * Remove internal backups; keepLocalBackup retains the local-side safety copy.
 */
export async function removeConflictBackups(
  plugin: FastSync,
  path: string,
  options: { keepLocalBackup?: boolean } = {}
): Promise<void> {
  try {
    const adapter = plugin.app.vault.adapter;
    const { dir, baseBackupPath, remoteBackupPath, metaPath, localBackupPath } = conflictBackupPaths(plugin, path);
    const targets = [baseBackupPath, remoteBackupPath, metaPath];
    if (!options.keepLocalBackup) targets.push(localBackupPath);
    const removals: Promise<void>[] = [];
    for (const target of targets) {
      if (await adapter.exists(target)) removals.push(adapter.remove(target));
    }
    await Promise.all(removals);
    if (await adapter.exists(dir)) {
      const listed = await adapter.list(dir);
      if (listed && listed.files.length === 0 && listed.folders.length === 0) {
        try {
          await adapter.rmdir(dir, true);
        } catch {
          // EBUSY/locked folder: keeping an empty folder is harmless / 文件夹繁忙时保留空目录无害
        }
      }
    }
  } catch (error) {
    dump("Failed to remove conflict backups:", error);
  }
}

// #205：正在通过 NoteRePush 探测服务端是否已有该笔记的路径 → 本次查询的登记对象（挂在 plugin
// 实例上，每个插件实例独立）。登记超过 EMPTY_NOTE_PROBE_TTL_MS、或消息没有真正发出时允许重新查询；
// 断线重连后由 websocket_manager onClose 统一清空，探测随下一轮事件重发。
// #205: path -> registration of the in-flight NoteRePush probe for whether the server already has
// the note (per plugin instance). A registration older than EMPTY_NOTE_PROBE_TTL_MS, or a send that
// never actually left, allows a fresh probe. Cleared on disconnect by websocket_manager onClose,
// where the next vault event re-issues the probe.
const emptyNoteProbing = new WeakMap<FastSync, Map<string, EmptyNoteProbeEntry>>();

/** 在途探测的登记对象 / In-flight probe registration */
interface EmptyNoteProbeEntry {
  /** 本次查询的登记时间（毫秒） / When this probe was registered (ms) */
  startedAt: number;
}

/**
 * 在途探测的有效期：查询发出后超过该时长仍没有结论（回复丢失、服务端回普通错误等），
 * 允许同一路径重新查询，避免一篇笔记在同一连接内永久卡在“探测在途”。
 * Probe TTL: once a query has been outstanding this long without a verdict (lost reply, plain
 * server error), the same path may be probed again instead of being stuck "in flight" forever
 * within one connection.
 */
const EMPTY_NOTE_PROBE_TTL_MS = 60_000;
// #205：探测结论为"服务端没有该笔记"的路径集合。下一次 noteModify（#277 保留分支的重传）
// 检查到本标记时跳过拦截直接上传，打断"探测→NoteSyncDelete→重传→再探测"的循环；
// 上传发起后标记即清除（一次性），Ack 后 hashManager 建立基线，后续编辑走正常路径。
// #205: paths whose probe verdict was "server doesn't have this note". The next noteModify
// (the #277 keep-branch re-upload) skips the interception and uploads directly, breaking the
// probe -> NoteSyncDelete -> re-upload -> probe loop; the mark is one-shot (cleared once the
// upload is issued), and after the Ack the hashManager baseline makes later edits normal.
const emptyNoteConfirmedAbsent = new WeakMap<FastSync, Set<string>>();

function emptyNoteProbeSet(plugin: FastSync): Map<string, EmptyNoteProbeEntry> {
  let map = emptyNoteProbing.get(plugin);
  if (!map) {
    map = new Map<string, EmptyNoteProbeEntry>();
    emptyNoteProbing.set(plugin, map);
  }
  return map;
}

function emptyNoteConfirmedAbsentSet(plugin: FastSync): Set<string> {
  let set = emptyNoteConfirmedAbsent.get(plugin);
  if (!set) {
    set = new Set<string>();
    emptyNoteConfirmedAbsent.set(plugin, set);
  }
  return set;
}

/**
 * #205：本地空白笔记（如 Obsidian 自动创建的当日日记）在从未同步过（无同步基线）时，
 * 直接上传会覆盖服务端已有内容。满足三条件（内容为空 / 无基线 / 非冲突路径）时拦截上传，
 * 改发 NoteRePush 探测：服务端有 → 回 NoteSyncModify 覆盖本地空文件；没有 → 回
 * NoteSyncDelete，由 receiveNoteSyncDelete 的 #277 保留分支重传空文件完成新建。
 * 服务端证据：ws_note.go NoteRePush（存在且非删除回 NoteSyncModify，否则回 NoteSyncDelete）。
 * 在途登记超过 EMPTY_NOTE_PROBE_TTL_MS 未获结论、或消息没有真正发出时，允许再次查询。
 * 返回 true 表示已拦截（调用方不再上传）。
 *
 * #205: uploading a never-synced empty local note (e.g. Obsidian's auto-created daily note)
 * would overwrite the server copy. When all three conditions hold (empty content / no sync
 * baseline / not a conflicted path), hold the upload and probe with NoteRePush instead:
 * server has it -> NoteSyncModify overwrites the local empty file; server doesn't ->
 * NoteSyncDelete, and receiveNoteSyncDelete's #277 keep-branch re-uploads the empty file as a
 * genuine create. Server evidence: ws_note.go NoteRePush (NoteSyncModify when present and not
 * deleted, NoteSyncDelete otherwise). A registration older than EMPTY_NOTE_PROBE_TTL_MS with no
 * verdict, or a send that never actually left, allows a fresh query. Returns true when the
 * upload was intercepted.
 */
export function probeEmptyNoteInsteadOfUpload(plugin: FastSync, path: string, content: string, baseHash: string | null): boolean {
  if (content.trim().length !== 0) return false
  if (baseHash !== null) return false
  if (plugin.syncState.conflictedPaths.has(path)) return false
  // 探测已确认服务端没有该笔记：本次上传就是探测结论的落地，直接放行
  // Probe already confirmed the server doesn't have this note: this upload lands the verdict
  const confirmedAbsent = emptyNoteConfirmedAbsentSet(plugin)
  if (confirmedAbsent.has(path)) {
    confirmedAbsent.delete(path)
    return false
  }
  const probing = emptyNoteProbeSet(plugin)
  const inFlight = probing.get(path)
  if (inFlight && Date.now() - inFlight.startedAt < EMPTY_NOTE_PROBE_TTL_MS) return true
  // 没有登记或登记已超时：登记本次查询（超时的旧登记被直接覆盖）
  // No registration or a timed-out one: register this attempt (a stale one is overwritten)
  const entry: EmptyNoteProbeEntry = { startedAt: Date.now() }
  probing.set(path, entry)
  dump(`Empty unsynced note, probing server instead of uploading: ${path}`)
  SyncLogManager.getInstance().addLog('send', 'NoteEmptyProbe',
    `本地空白笔记尚未同步，先探测服务端是否已有该笔记: ${path}`, 'cancelled', path)
  // 第四个参数只在消息真正交给连接时才被调用；连接没打开时消息被丢弃、回调不会执行。
  // 发送结束后仍未发出（或被拒绝）就清掉本次登记，让下一次扫描可以重新查询。
  // The 4th argument only runs when the message is really handed to the connection; if the
  // connection is closed the message is dropped and the callback never fires. If the send
  // finishes without it (or rejects), release this registration so the next scan can retry.
  let sent = false
  const release = (): void => { if (probing.get(path) === entry) probing.delete(path) }
  void Promise.resolve(plugin.websocket.SendMessage("NoteRePush", {
    vault: plugin.settings.vault,
    path: path,
    pathHash: hashContent(path),
  }, undefined, () => { sent = true })).then(() => { if (!sent) release() }, () => release())
  return true
}

/** #205：探测结论到达（NoteSyncModify / NoteSyncDelete 处理入口）时清除在途标记 */
/** #205: clear the in-flight probe mark when its verdict arrives (NoteSyncModify / NoteSyncDelete) */
function consumeEmptyNoteProbe(plugin: FastSync, path: string): void {
  emptyNoteProbeSet(plugin).delete(path)
}

/**
 * #205：主动放弃某路径的在途探测登记（服务端回了普通错误等），不影响“已确认缺失”标记。
 * 登记清除后，下一次扫描可以重新查询（在确认服务端没有之前仍不会直接上传空笔记）。
 * #205: drop the in-flight probe registration for a path (e.g. the server replied with a plain
 * error) without touching the confirmed-absent mark. The next scan may probe again; the empty
 * note is still never uploaded before the server is confirmed to lack it.
 */
export function releaseEmptyNoteProbe(plugin: FastSync, path: string): void {
  emptyNoteProbeSet(plugin).delete(path)
}

/**
 * #205：连接断开时清空在途探测与"已确认缺失"标记（由 websocket_manager onClose 调用）。
 * 断线后探测结论不会再到达；在途标记若不清空，重连后同路径的 noteModify 会被
 * 误判为"探测已在途"而静默拦截。"已确认缺失"标记保留至下一次上传落地，断线同样作废
 * （服务端状态可能已变，重新探测更安全）。
 * #205: clear in-flight probe and confirmed-absent marks on disconnect (called from
 * websocket_manager onClose). No verdict can arrive after the drop; a stale in-flight mark
 * would silently intercept the same path's noteModify after reconnect. The confirmed-absent
 * mark is voided too — the server state may have changed, re-probing is safer.
 */
export function clearEmptyNoteProbes(plugin: FastSync): void {
  emptyNoteProbing.get(plugin)?.clear();
  emptyNoteConfirmedAbsent.get(plugin)?.clear();
}

/**
 * 阶段 B：把“本地有内容、远端也有同名内容、但无任何可信基线”的路径转入待对齐。
 * 本地笔记原封不动；远端版本只存在内部目录时无法从下行获取，因此仅在调用方拿到远端内容
 * （NoteSyncModify）时写入 .remote.md；NoteSyncNeedPush 没有远端正文，只登记待对齐，
 * 远端版本留给用户打开对齐面板时的服务端历史。
 *
 * Stage B: move a path with local content, a same-named remote note and no trusted baseline into
 * pending alignment. The local note is untouched; the remote body is stashed only when the caller
 * has it (NoteSyncModify). NeedPush carries no body, so the entry is queued without one and the
 * remote version is taken from server history in the alignment panel.
 */
async function stashUnalignedNote(
  plugin: FastSync,
  file: TFile,
  localContent: string,
  remoteContent?: string,
  remoteContentHash?: string
): Promise<boolean> {
  try {
    const adapter = plugin.app.vault.adapter;
    const { dir, remoteBackupPath, baseBackupPath } = conflictBackupPaths(plugin, file.path);
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    if (typeof remoteContent === "string") {
      await adapter.write(remoteBackupPath, remoteContent);
    }
    // 缺基线是事实：清掉可能残留的伪造 base，并显式记录 baseMissing
    // Missing ancestor is a fact: remove any stale fabricated base and record it
    if (await adapter.exists(baseBackupPath)) await adapter.remove(baseBackupPath);
    await writeConflictMeta(plugin, file.path, {
      reason: CONFLICT_REASON_UNALIGNED,
      baseMissing: true,
      ...(remoteContentHash ? { remoteHash: remoteContentHash } : {}),
      localHashAtDetection: await hashContentAsync(localContent),
    });
  } catch (err) {
    dumpError(`[FastSync] Failed to stash remote version for alignment: ${file.path}`, err);
    return false;
  }

  plugin.syncState.conflictedPaths.add(file.path);
  plugin.syncState.newConflictedPathsThisRound.add(file.path);
  plugin.syncState.newUnalignedPathsThisRound?.add(file.path);
  plugin.localStorageManager.setConflictedPaths(plugin.syncState.conflictedPaths);
  plugin.statusBarManager.updateConflictBadge();
  // 暂停该路径的自动上传，避免反过来立刻把远端覆盖掉
  // Pause uploads for this path so it cannot overwrite the remote copy
  plugin.pendingNoteModifies.delete(file.path);
  plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies);

  SyncLogManager.getInstance().addLog('receive', 'NoteModifyUnaligned',
    `本地已有内容但无可信同步基线，已保留本地版本并暂存远端版本，等待对齐: ${file.path}`, 'cancelled', file.path)
  return true;
}

/**
 * 只读探测远端同名笔记（旧协议兼容模式的首次接入防覆盖）。
 * 使用既有只读接口，绝不走会改状态的 check/sync 请求；拿不到结论时返回 null，
 * 调用方按“远端不可知”处理（不拦截上传，避免把正常新建笔记永久卡住）。
 * 返回值：null = 查询失败/接口不可用；{ path, contentHash } = 远端存活笔记（已排除回收站）。
 *
 * Read-only probe of a same-path remote note (legacy-mode first-attach guard). Uses the existing
 * read-only endpoint only — never a check/sync request that could mutate state. Returns null when
 * the verdict is unavailable; the caller then treats the remote as unknown and does not block the
 * upload (blocking would permanently strand a legitimate new note).
 */
async function probeRemoteNoteState(plugin: FastSync, path: string): Promise<{ path: string; contentHash: string } | null> {
  const api = plugin.api as { getRetryQueueState?: (kind: "note" | "file", path: string) => Promise<{ path: string; contentHash: string } | null> } | null | undefined
  if (!api || typeof api.getRetryQueueState !== "function") return null
  try {
    return await api.getRetryQueueState("note", path)
  } catch (error) {
    dump(`[NoteUpload] Remote probe unavailable for ${path}; uploading with baseHashMissing`, error)
    return null
  }
}

/**
 * 笔记修改事件处理
 */
export const noteModify = async function (file: TAbstractFile, plugin: FastSync, eventEnter: boolean = false, options?: { isConflictResolved?: boolean; baseRevision?: string }) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (!(file instanceof TFile)) return
  if (!file.path.endsWith(".md")) return
  if (eventEnter && plugin.isIgnoredFile(file.path)) {
    // 命中的是祖先目录项时，屏蔽解除后补一次；命中路径自身（远端落盘的自我保护）仍直接丢弃
    // An ancestor-folder hit is retried after the guard clears; a hit on the path itself
    // (remote write self-protection) is still dropped as before
    if (plugin.isIgnoredByAncestor(file.path)) {
      dump(`Note modify deferred (parent folder guarded): ${file.path}`)
      plugin.eventManager?.deferGuardedModify(file)
    }
    return
  }
  if (isPathExcluded(file.path, plugin)) return
  // 冲突未解决的路径暂停上传，否则本端旧稿会覆盖其他端的新内容（#276）；解决冲突时由冲突合并窗口自行推送
  // Uploads of an unresolved conflict are paused, or this device's stale copy overwrites newer content
  // from other devices (#276); the conflict resolve modal pushes the merged result itself
  // 已解决（isConflictResolved）的提交是用户明确拍板的结果，不能因路径仍在冻结集合里被跳过
  // A resolved submit is the user's explicit decision and must not be skipped just because the
  // path is still in the frozen set
  if (plugin.syncState?.conflictedPaths?.has(file.path) && !options?.isConflictResolved) {
    dump(`Note modify paused, unresolved conflict: ${file.path}`)
    return
  }

  await plugin.lockManager.withLock(file.path, async () => {
    plugin.addIgnoredFile(file.path)

    try {
      const baseHash = plugin.fileHashManager.getPathHash(file.path)
      const lastSyncMtime = plugin.lastSyncMtime.get(file.path)

      // --- 优化：先尝试从缓存获取有效哈希 ---
      let contentHash = plugin.fileHashManager.getValidHash(file.path, file.stat.mtime, file.stat.size);
      let content: string | null = null;

      if (contentHash !== null) {
        // 如果哈希有效，且与 baseHash 和最后同步时间一致，则拦截
        if (contentHash === baseHash && (lastSyncMtime !== undefined && lastSyncMtime === file.stat.mtime)) {
          dump(`Note modify intercepted (cache match): ${file.path}`)
          return
        }
      } else {
        // 缓存失效或不存在，计算新哈希
        content = await plugin.app.vault.read(file)
        contentHash = await hashContentAsync(content)
      }

      if (content === null) content = await plugin.app.vault.read(file)

      // #205：空白 + 从未同步 + 非冲突 → 不上传，先探测服务端是否已有该笔记
      // #205: empty + never synced + not conflicted -> hold the upload, probe the server first
      if (probeEmptyNoteInsteadOfUpload(plugin, file.path, content, baseHash)) return

      const data = {
        vault: plugin.settings.vault,
        ctime: getSafeCtime(file.stat),
        mtime: file.stat.mtime,
        path: file.path,
        pathHash: hashContent(file.path),
        content: content,
        contentHash: contentHash,
        // 基线模式携带服务端确认的 {baseHash, baseRevision}；兼容模式保持旧字段
        // Baseline mode carries the server-confirmed {baseHash, baseRevision}; compat mode keeps the old field
        ...buildBaselineFields(plugin, "note", file.path, contentHash),
        ...(options?.baseRevision ? { baseRevision: options.baseRevision } : {}),
        ...(options?.isConflictResolved ? { isConflictResolved: true } : {}),
      }
      // 将 hash 暂存到 pending map，等待服务端 NoteModifyAck 后再写入 hashManager
      // Temporarily store hash in pending map, update hashManager only after server NoteModifyAck
      if (contentHash != baseHash) {
        // 新建操作覆盖删除意图，清除 pending 防止晚到的 Ack 错误删除新文件 hash
        // New create supersedes delete intent; clear pending to prevent stale Ack from removing new hash
        plugin.pendingNoteDeleteAcks.delete(file.path)
        plugin.pendingNoteModifies.set(file.path, contentHash)
        plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
      }
      if (!await plugin.concurrencyLimiter.waitForSlot(file.path)) return
      void plugin.websocket.SendMessage("NoteModify", data)
      dump(`Note modify send`, data.path, data.contentHash, data.mtime, data.pathHash)
    } finally {
      plugin.removeIgnoredFile(file.path)
    }
  }, { maxRetries: 5, retryInterval: 50 });
}

/**
 * 笔记删除事件处理
 */
export const noteDelete = async function (file: TAbstractFile, plugin: FastSync, eventEnter: boolean = false) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (!(file instanceof TFile)) return
  if (!file.path.endsWith(".md")) return
  if (eventEnter && plugin.isIgnoredFile(file.path)) return
  if (isPathExcluded(file.path, plugin)) return

  // --- 新增：删除拦截 ---
  if (plugin.lastSyncPathDeleted.has(file.path)) {
    dump(`Note delete intercepted: ${file.path}`)
    return
  }
  // 冲突冻结的路径不自动上传删除，交给冲突解决窗口决定
  // A frozen conflicted path never auto-uploads a deletion; the resolver decides
  if (plugin.syncState?.conflictedPaths?.has(file.path)) {
    dump(`Note delete paused, unresolved conflict: ${file.path}`)
    return
  }

  await plugin.lockManager.withLock(file.path, async () => {
    // 清理可能存在的待确认上传记录，避免 pending map 内存泄漏
    // Clean up any pending note modify record to avoid memory leak
    plugin.pendingNoteModifies.delete(file.path)
    plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
    plugin.addIgnoredFile(file.path)
    try {
      // 删除前先快照最后确认的基线，供实时删除与断线回放携带
      // Snapshot the last confirmed baseline before deletion so live deletes and replay can carry it
      if (plugin.isSyncBaselineModeEnabled?.() === true) plugin.fileHashManager.recordPendingDeleteBaseline?.(file.path)
      const data = {
        vault: plugin.settings.vault,
        path: file.path,
        pathHash: hashContent(file.path),
        ...buildDeleteBaselineFields(plugin, "note", file.path),
      }
      if (!await plugin.concurrencyLimiter.waitForSlot(file.path)) return
      await plugin.websocket.SendMessage("NoteDelete", data, undefined, () => {
        // 消息真正写入 TCP 缓冲区后加入 pending set，等待 NoteDeleteAck 再删 hash
        // Add to pending set only after message is actually buffered; remove hash only on NoteDeleteAck
        plugin.pendingNoteDeleteAcks.add(file.path)
      })

      dump(`Note delete send`, file.path)
    } finally {
      plugin.removeIgnoredFile(file.path)
    }
  }, { maxRetries: 3, retryInterval: 50 });
}

/**
 * 按路径字符串发送笔记删除消息（用于无法获取 TFile 对象的场景，如 rename 后旧路径已不存在）
 * Send note delete message by path string (for scenarios where TFile object is unavailable, e.g., old path after rename)
 */
export const noteDeleteByPath = async function (filePath: string, plugin: FastSync, retryGuard?: () => boolean, explicitBaseline?: BaselineDeleteRecord) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (!filePath.endsWith(".md")) return
  if (isPathExcluded(filePath, plugin)) return
  if (plugin.lastSyncPathDeleted.has(filePath)) return

  await plugin.lockManager.withLock(filePath, async () => {
    if (retryGuard && !retryGuard()) return
    // 清理可能存在的待确认上传记录，避免 pending map 内存泄漏
    // Clean up any pending note modify record to avoid memory leak
    plugin.pendingNoteModifies.delete(filePath)
    plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
    plugin.addIgnoredFile(filePath)
    try {
      if (plugin.isSyncBaselineModeEnabled?.() === true) plugin.fileHashManager.recordPendingDeleteBaseline?.(filePath)
      if (!await plugin.concurrencyLimiter.waitForSlot(filePath)) return
      if (retryGuard && !retryGuard()) { plugin.concurrencyLimiter.releaseSlot(filePath); return }
      await plugin.websocket.SendMessage("NoteDelete", {
        vault: plugin.settings.vault,
        path: filePath,
        pathHash: hashContent(filePath),
        ...(explicitBaseline ? baselineFieldsFromDeleteRecord(explicitBaseline) : buildDeleteBaselineFields(plugin, "note", filePath)),
      }, () => retryGuard ? !retryGuard() : false, () => {
        // 消息真正写入 TCP 缓冲区后加入 pending set，等待 NoteDeleteAck 再删 hash
        // Add to pending set only after message is actually buffered; remove hash only on NoteDeleteAck
        plugin.pendingNoteDeleteAcks.add(filePath)
      })
      dump(`Note delete by path send`, filePath)
    } finally {
      plugin.removeIgnoredFile(filePath)
    }
  }, { maxRetries: 3, retryInterval: 50 });
}

/**
 * 笔记重命名事件处理
 */
export const noteRename = async function (file: TAbstractFile, oldfile: string, plugin: FastSync, eventEnter: boolean = false, retryGuard?: () => boolean, retryBaselineHash?: string, retryBaselineRevision?: string) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (!(file instanceof TFile)) return
  if (!file.path.endsWith(".md")) return
  if (eventEnter && plugin.isIgnoredFile(file.path)) return
  const newExcluded = isPathExcluded(file.path, plugin)
  const oldExcluded = isPathExcluded(oldfile, plugin)

  // Cross-exclusion-boundary rename handling
  // 跨排除边界重命名处理
  if (newExcluded && !oldExcluded) {
    // Moving from normal folder to excluded folder: delete old path on server
    // 从正常文件夹移至排除文件夹：删除服务端旧路径
    void noteDeleteByPath(oldfile, plugin)
    return
  }
  if (!newExcluded && oldExcluded) {
    // Moving from excluded folder to normal folder: create new note on server
    // 从排除文件夹移至正常文件夹：在服务端创建新笔记
    void noteModify(file, plugin, true)
    return
  }
  if (newExcluded && oldExcluded) {
    // Both paths excluded: do nothing
    // 两个路径均被排除：不处理
    return
  }

  // --- 新增：重命名拦截 ---
  if (plugin.lastSyncPathRenamed.has(file.path)) {
    dump(`Note rename intercepted: ${file.path}`)
    return
  }

  // 基线模式（设计稿 §2.4）：原生 rename 无法携带源路径条件删除，改为
  // 「先在目标路径安全创建/上传成功，再对源路径带源 baseHash + baseRevision 发送条件删除」。
  // 旧模式保持原原生 rename 不变。
  // Baseline mode (§2.4): native rename cannot carry a conditional delete for the source path.
  // Create/upload the target safely first, then conditionally delete the source with its
  // baseline. Compatibility mode keeps the original native rename.
  if (plugin.isSyncBaselineModeEnabled?.() === true) {
    if (retryGuard && !retryGuard()) return;
    const sourceHasBaseline = plugin.fileHashManager.getPathHash(oldfile) !== null;
    await noteModify(file, plugin, true);
    const explicit = retryBaselineHash !== undefined
      ? { hash: retryBaselineHash, hashMissing: false, revision: retryBaselineRevision || "" } as BaselineDeleteRecord
      : undefined;
    if (sourceHasBaseline || explicit) await noteDeleteByPath(oldfile, plugin, undefined, explicit);
    dump(`Note rename converted to create-then-conditional-delete`, oldfile, file.path, sourceHasBaseline);
    return;
  }

  // 重命名涉及两个路径，我们锁定新路径，旧路径由调用方或原子性保证
  await plugin.lockManager.withLock(file.path, async () => {
    if (retryGuard && !retryGuard()) return
    plugin.addIgnoredFile(file.path)
    try {
      let contentHash = retryBaselineHash || plugin.fileHashManager.getPathHash(oldfile)
      if (contentHash == null) {
        const content: string = await plugin.app.vault.read(file)
        contentHash = await hashContentAsync(content)
      }

      const data = {
        vault: plugin.settings.vault,
        path: file.path,
        pathHash: hashContent(file.path),
        oldPath: oldfile,
        oldPathHash: hashContent(oldfile),
      }

      if (retryGuard && !retryGuard()) return
      // 将重命名信息存入 Map（key 为 newPath），等待服务端 NoteRenameAck 按 path 精确匹配后再更新 hashManager
      // Store rename info in Map (keyed by newPath), update hashManager only after server NoteRenameAck matches by path
      plugin.pendingNoteRenames.set(file.path, { oldPath: oldfile, newPath: file.path, contentHash })
      if (!await plugin.concurrencyLimiter.waitForSlot(file.path, true)) return
      if (retryGuard && !retryGuard()) { plugin.concurrencyLimiter.releaseSlot(file.path); return }
      await plugin.websocket.SendMessage("NoteRename", data, () => retryGuard ? !retryGuard() : false)
      dump(`Note rename send`, data.path, data.pathHash)
    } finally {
      plugin.removeIgnoredFile(file.path)
    }
  }, { maxRetries: 5, retryInterval: 50 });
}

/**
 * 接收服务端笔记修改通知
 */
export const receiveNoteSyncModify = async function (data: ReceiveMessage, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return
  if (isPathExcluded(data.path, plugin)) {
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }
  // 服务端历史数据可能存秒级 mtime/ctime（#461），落盘/比较前先归一化为毫秒
  // Legacy server rows may hold second-scale mtime/ctime (#461); normalize to milliseconds
  // before writing to disk or comparing
  const mtime = normalizeServerTimestamp(data.mtime)
  const ctime = normalizeServerTimestamp(data.ctime)
  dump(`Receive note modify:`, data.path, data.contentHash, mtime, data.pathHash)

  const normalizedPath = normalizePath(data.path)
  // #205：NoteSyncModify 可能是空白笔记探测的结论（服务端已有该笔记），清除在途探测标记
  // #205: this NoteSyncModify may be the verdict of an empty-note probe (server has the note);
  // clear the in-flight probe mark
  consumeEmptyNoteProbe(plugin, data.path)

  try {
    const locked = await plugin.lockManager.withLock(normalizedPath, async () => {
      const file = plugin.app.vault.getFileByPath(normalizedPath)
      plugin.addIgnoredFile(normalizedPath)
      try {
        if (file) {
          // Fail-safe：写盘前检查本地是否有未推送的编辑，避免服务端推送盲覆盖用户刚做的改动
          // Fail-safe: before overwriting, check for unsynced local edits so a server push
          // doesn't blindly clobber changes the user just made
          const localContentNow = await plugin.app.vault.read(file);
          const localContentHashNow = await hashContentAsync(localContentNow);
          const remoteContentHashNow = await hashContentAsync(data.content);
          const contentsMatch = localContentHashNow === remoteContentHashNow;
          const baseHashNow = plugin.fileHashManager.getPathHash(normalizedPath);
          // 旧版持久化基线只有当本地内容仍等于记录值时才算可信（阶段 B）
          // A legacy persisted baseline counts only while local content still equals it (stage B)
          const trustedBaseHash = typeof plugin.fileHashManager.getVerifiedPathHash === "function"
            ? plugin.fileHashManager.getVerifiedPathHash(normalizedPath, localContentHashNow)
            : baseHashNow;

          // A replay of the unchanged server baseline is not a two-sided edit. Only a verified
          // baseline proves the replay; an unverified legacy entry must not absorb it either.
          // 只有可信基线才能证明这是服务端未变更的重放；不可信的旧基线不能据此改写 pending。
          if (!contentsMatch && trustedBaseHash !== null && remoteContentHashNow === trustedBaseHash) {
            plugin.pendingNoteModifies.set(normalizedPath, localContentHashNow);
            plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies);
            return;
          }
          const hasPendingLocalEdit = plugin.pendingNoteModifies.has(data.path)
          // 有可信基线时，只要本地当前内容不等于基线就说明本地已偏离（内容哈希比较，与 mtime 无关：
          // 打开 canvas 等只刷新 mtime 的操作不应改变判断，mtime 记录丢失也不应导致误覆盖）
          // With a trusted baseline, any local content that differs from it has diverged. The check
          // is content-based, not mtime-based: refreshed mtimes must not matter and a lost mtime
          // record must not turn a real local edit into a silent overwrite.
          const hasDivergedSinceLastSync = !hasPendingLocalEdit
            && trustedBaseHash !== null
            && localContentHashNow !== trustedBaseHash

          if (!contentsMatch && (hasPendingLocalEdit || hasDivergedSinceLastSync || plugin.syncState.conflictedPaths.has(normalizedPath))) {
            dump(`[FastSync] Skip overwrite, local unsynced edit detected: ${normalizedPath}`)

            // 如果存在未同步的本地修改或已在冲突列表中，将服务端最新推送的内容写入/更新到远端备份文件 xxx.remote.md
            // If local unsynced edit exists or path is in conflict state, write/update the server's latest content into xxx.remote.md
            try {
              const adapter = plugin.app.vault.adapter;
              const { dir, baseBackupPath, remoteBackupPath } = conflictBackupPaths(plugin, normalizedPath);
              const previousMeta = await readConflictMeta(plugin, normalizedPath);

              if (!(await adapter.exists(dir))) {
                await adapter.mkdir(dir);
              }

              // 写入服务端最新推送的内容至 remote 备份文件
              await adapter.write(remoteBackupPath, data.content || "");

              // 只在已有真实 base 时保留它；绝不再用本地当前内容冒充共同祖先
              // Keep an existing real base only; never pass current local content off as an ancestor
              const hasRealBase = await adapter.exists(baseBackupPath);
              await writeConflictMeta(plugin, normalizedPath, {
                reason: previousMeta?.reason ?? (hasRealBase ? "diverged" : "diverged_no_base"),
                baseMissing: !hasRealBase,
                remoteHash: remoteContentHashNow,
                localHashAtDetection: localContentHashNow,
              });

              dump(`[FastSync] Updated remote backup file for conflict: ${remoteBackupPath}`);
            } catch (err) {
              dumpError(`[FastSync] Failed to update remote backup file: ${normalizedPath}`, err);
            }

            // 保持在冲突列表中并刷新状态栏
            plugin.syncState.conflictedPaths.add(normalizedPath);
            plugin.syncState.newConflictedPathsThisRound.add(normalizedPath);
            plugin.localStorageManager.setConflictedPaths(plugin.syncState.conflictedPaths);
            plugin.statusBarManager.updateConflictBadge();

            SyncLogManager.getInstance().addLog('receive', 'NoteModifyConflict', `本地存在未同步的改动，跳过服务端覆盖，等待下一轮同步处理冲突: ${normalizedPath}`, 'cancelled', data.path)
            return
          }

          // 阶段 B：本地已有非空内容，却没有任何可信基线（首次接入、外部写入、本地状态丢失）。
          // 绝不直接覆盖，也不在笔记目录生成冲突文件：保留本地，把远端版本存进插件内部目录，
          // 进入待对齐集合并暂停该路径的自动上传，等用户在冲突与对齐面板统一处理。
          // Stage B: local non-empty content with no trusted baseline (first attach, external write,
          // lost local state). Never overwrite and never drop conflict files into the vault: keep
          // the local copy, stash the remote version inside the plugin dir, queue it for alignment
          // and pause uploads for that path until the user handles it.
          if (!contentsMatch && trustedBaseHash === null && localContentNow.length > 0) {
            dump(`[FastSync] No trusted baseline, keep local and queue alignment: ${normalizedPath}`)
            await stashUnalignedNote(plugin, file, localContentNow, data.content || "", remoteContentHashNow)
            return
          }

          // 无基线且内容一致时只确认基线、不写盘；有可信基线的原有写盘行为保持不变
          // With no baseline and equal content, confirm the baseline without rewriting; existing
          // trusted-baseline behaviour keeps writing as before
          if (!contentsMatch || trustedBaseHash !== null) {
            await plugin.app.vault.modify(file, data.content, { ...(ctime > 0 && { ctime }), ...(mtime > 0 && { mtime }) })
          }
        } else {
          const folder = normalizedPath.split("/").slice(0, -1).join("/")
          if (folder != "") {
            const dirExists = plugin.app.vault.getFolderByPath(folder)
            if (dirExists == null) {
              try {
                await plugin.app.vault.createFolder(folder)
              } catch (e) {
                // 并发竞争时只有一个调用成功，另一方忽略"已存在"错误
                // In concurrent race only one call succeeds; ignore "already exists" error
                if (!plugin.app.vault.getFolderByPath(folder)) throw e
              }
            }
          }
          await plugin.app.vault.create(normalizedPath, data.content, { ...(ctime > 0 && { ctime }), ...(mtime > 0 && { mtime }) })
        }
        advanceLiveSyncTime(plugin, "lastNoteSyncTime", data.lastTime)

        // 服务端推送笔记更新,更新哈希表(使用内容哈希)
        // 注意：由于是服务端推送，我们信任服务端返回的 mtime，并尝试获取本地文件大小
        const updatedFile = plugin.app.vault.getFileByPath(normalizedPath);
        const pushedRevision = (data as { revision?: string }).revision
        if (typeof pushedRevision === "string" && pushedRevision !== "") {
          plugin.fileHashManager.setFileHash(data.path, data.contentHash, mtime || 0, updatedFile?.stat.size || 0, true, pushedRevision)
        } else {
          plugin.fileHashManager.setFileHash(data.path, data.contentHash, mtime || 0, updatedFile?.stat.size || 0)
        }
        // 记录同步后的 mtime 用于拦截
        plugin.lastSyncMtime.set(data.path, mtime || 0)
        // 服务端版本已覆盖本地，清理 pending 避免增量过滤器旁路导致该笔记无限重传
        // Server version overrides local; clear pending to avoid incremental filter bypass loop
        plugin.pendingNoteModifies.delete(data.path)
        plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
        // 服务端推送新内容说明该路径已被创建/更新，清理可能残留 de deleteAck pending
        // Server push means path was created/updated; clear any stale deleteAck pending
        plugin.pendingNoteDeleteAcks.delete(data.path)
      } finally {
        window.setTimeout(() => {
          plugin.removeIgnoredFile(normalizedPath)
        }, 500);
      }
    }, { maxRetries: 5, retryInterval: 100 });
    // 抢锁失败时任务未执行：按失败处理，不能计为完成
    // Lock not acquired means the task never ran: count it as a failure, never as completed
    if (locked === null) throw new Error("Path lock busy")
  } catch (e) {
    dumpError(`[FastSync] Failed to receiveNoteSyncModify: ${normalizedPath}`, e);
    if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'NoteModify')) {
      const message = e instanceof Error ? e.message : String(e);
      SyncLogManager.getInstance().addLog('receive', 'NoteModify', message, 'error', data.path);
      let notifiedPaths = notifiedNoteFailures.get(plugin);
      if (!notifiedPaths) {
        notifiedPaths = new Set();
        notifiedNoteFailures.set(plugin, notifiedPaths);
      }
      if (!notifiedPaths.has(data.path)) {
        notifiedPaths.add(data.path);
        showSyncNotice(`${$('ui.status.failed')}: ${data.path}\n${message}`, 15000);
      }
    }
    plugin.noteSyncTasks.failed++
  } finally {
    plugin.recordSyncCompleted('note', data.pageIndex)
  }
}

/**
 * 接收服务端请求上传笔记
 */
export const receiveNoteUpload = async function (data: ReceivePathMessage, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return
  // 只读门禁：本轮入口快照与实时设置取或（fail-closed）。轮次中途刚打开只读时快照仍可写，
  // 但实时设置已只读，服务端要求的上传必须拦住。
  // Read-only gate: OR the round's entry snapshot with the live setting (fail-closed). If
  // read-only is turned on mid-round the snapshot stays writable, but the live setting must
  // still block the server's upload request.
  if (plugin.syncRoundReadonly || plugin.settings.readonlySyncEnabled) {
    dump(`Read-only mode: Intercepted note upload request for ${data.path}`)
    // 留一份带路径的清单，用户可以只开只读跑一轮看清“本机有、服务端没有”的条目
    // Keep a per-path list so a read-only round shows what exists locally but not on the server
    syncDiagnostics.recordUploadSkippedReadOnly?.(data.path)
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }
  if (isPathExcluded(data.path, plugin)) {
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }
  dump(`Receive note need push:`, data.path)
  if (!data.path.endsWith(".md")) {
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }
  const file = plugin.app.vault.getFileByPath(normalizePath(data.path))
  if (!file) {
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }
  // 冲突未解决：不响应服务端的上传请求，避免旧稿覆盖服务端（#276）
  // Unresolved conflict: do not answer the server's upload request, so the stale copy never overwrites the server (#276)
  if (plugin.syncState?.conflictedPaths?.has(file.path)) {
    SyncLogManager.getInstance().addLog('send', 'NoteModifyConflict', `冲突未解决，暂停上传: ${file.path}`, 'cancelled', data.path)
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }

  // NeedPush 驱动的上传-回执往返：Ack（receiveNoteModifyAck）本身不带 pageIndex，
  // 在此按 path 记下所属页，供 Ack 到达时查表归账（见 sync_state.ts pendingNotePushPageIndex 注释）
  // NeedPush-driven upload/ack round trip: the Ack (receiveNoteModifyAck) carries no pageIndex;
  // record the owning page by path here so the Ack can look it up on arrival (see sync_state.ts
  // pendingNotePushPageIndex comment)
  if (data.pageIndex !== undefined) {
    plugin.syncState.pendingNotePushPageIndex.set(file.path, data.pageIndex)
  }

  plugin.addIgnoredFile(file.path)

  const baseHash = plugin.fileHashManager.getPathHash(file.path)
  // 尝试从缓存获取 (Try to get from cache)
  let contentHash = plugin.fileHashManager.getValidHash(file.path, file.stat.mtime, file.stat.size);
  const content = await plugin.app.vault.read(file);
  if (contentHash === null) contentHash = await hashContentAsync(content);

  // #205：空白 + 从未同步 + 非冲突 → 不响应 NeedPush 上传，先探测服务端是否已有该笔记；
  // 该页条目立即记为完成，探测结论（Modify/Delete）作为非分页项到达，不阻塞翻页
  // #205: empty + never synced + not conflicted -> do not answer the NeedPush upload, probe the
  // server first; the page item is counted complete right away, and the probe verdict
  // (Modify/Delete) arrives as a non-paginated item, never blocking the page flow
  if (probeEmptyNoteInsteadOfUpload(plugin, file.path, content, baseHash)) {
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }
  // 阶段 B：空占位笔记的探测结论会在前面处理。
  // 服务端已明确发 NoteSyncNeedPush（code 200）要求上传，说明该路径在服务端侧不需要冲突拦截：
  // - 基线模式下服务端在 NoteSync 阶段已把“远端存在不同内容且无基线”的路径改走 SyncConflict，
  //   走到这里的只可能是允许上传的新建/恢复；因此这里绝不拦截，直接以“无基线”字段上传。
  //   否则离线新建的笔记永远传不上去（stash 后本地被冻结，NeedPush 每轮重来）。
  // - 旧协议兼容模式下保留“首次接入防覆盖”的最小保护：仅当本机从未成功同步过
  //   （lastNoteSyncTime === 0）、无任何可信基线且本地有内容时，先只读探测远端是否真有同名
  //   存活笔记；只有远端存在且内容哈希不同才转待对齐，远端不存在或常规增量一律正常上传。
  //
  // Stage B: empty-placeholder probes are handled above.
  // A server NoteSyncNeedPush (code 200) means the server itself decided this path may upload:
  // - Baseline mode: NoteSync already routed every "remote differs, no baseline" path to
  //   SyncConflict, so reaching here means a genuine create/restore — never intercept, upload
  //   with explicit "no baseline" fields. Otherwise notes created offline could never be uploaded
  //   (stash freezes the path locally and every round repeats the NeedPush).
  // - Legacy compatibility mode keeps the minimal first-attach guard: only when this device never
  //   synced successfully (lastNoteSyncTime === 0), no trusted baseline exists and local content is
  //   non-empty, do a read-only probe for a live same-path remote note; only a real remote note
  //   with a different hash is moved to pending alignment. Absent remotely, or a normal
  //   incremental round, uploads as usual.
  const baselineMode = plugin.isSyncBaselineModeEnabled?.() === true
  const verifiedBaseForUpload = typeof plugin.fileHashManager.getVerifiedPathHash === "function"
    ? plugin.fileHashManager.getVerifiedPathHash(file.path, contentHash)
    : baseHash
  if (!baselineMode && verifiedBaseForUpload === null && content.length > 0
    && Number(plugin.localStorageManager.getMetadata("lastNoteSyncTime")) === 0) {
    const remote = await probeRemoteNoteState(plugin, file.path)
    if (remote && remote.contentHash !== "" && remote.contentHash !== contentHash) {
      await stashUnalignedNote(plugin, file, content)
      plugin.removeIgnoredFile(file.path)
      plugin.recordSyncCompleted('note', data.pageIndex)
      return
    }
  }

  if (content.length === 0) {
    dump(`Empty note upload: ${data.path}`);
  }

  // 无基线时显式携带 baseHashMissing，服务端据此核验，不把本地内容冒充成服务端基线
  // With no baseline, explicitly carry baseHashMissing so the server verifies instead of
  // treating the local bytes as a server baseline.
  const verifiedBase = typeof plugin.fileHashManager.getVerifiedPathHash === "function"
    ? plugin.fileHashManager.getVerifiedPathHash(file.path, contentHash)
    : baseHash
  const noBaselineFields = verifiedBase === null
    ? { baseHash: "", baseHashMissing: true, baseRevision: "" }
    : {}

  const sendData = {
    vault: plugin.settings.vault,
    ctime: getSafeCtime(file.stat),
    mtime: file.stat.mtime,
    path: file.path,
    pathHash: hashContent(file.path),
    content: content,
    contentHash: contentHash,
    ...buildBaselineFields(plugin, "note", file.path, contentHash),
    ...noBaselineFields,
  }
  // 将 hash 写入 pending map，等待 NoteModifyAck 确认后再写 hashManager
  // 若此路径已有旧 pending（来自中断的 noteModify），覆盖为最新 hash
  // Store hash in pending map; hashManager is written only after NoteModifyAck arrives.
  // Overwrites any stale pending entry left by a previously interrupted noteModify.
  plugin.pendingNoteModifies.set(file.path, contentHash)
  plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
  if (!await plugin.concurrencyLimiter.waitForSlot(file.path)) {
    plugin.removeIgnoredFile(file.path)
    return
  }
  void plugin.websocket.SendMessage("NoteModify", sendData, undefined, () => {
    plugin.removeIgnoredFile(file.path)
  }, (data as ReceivePathMessage & { context?: string }).context)
  dump(`Note modify send`, sendData.path, sendData.contentHash, sendData.mtime, sendData.pathHash)
}

/**
 * 接收服务端笔记元数据(mtime)更新通知
 */
export const receiveNoteSyncMtime = async function (data: ReceiveMtimeMessage, plugin: FastSync, outsideRound = false) {
  if (plugin.settings.syncEnabled == false) return
  const pushPageIndex = outsideRound ? undefined : plugin.syncState.pendingNotePushPageIndex.get(data.path);
  const completionPageIndex = pushPageIndex ?? data.pageIndex;
  if (!outsideRound) plugin.syncState.pendingNotePushPageIndex.delete(data.path);
  plugin.concurrencyLimiter.releaseSlot(data.path);
  if (isPathExcluded(data.path, plugin)) {
    if (!outsideRound) plugin.recordSyncCompleted('note', completionPageIndex)
    return
  }
  // 服务端历史数据可能存秒级 mtime/ctime（#461），落盘/比较前先归一化为毫秒
  // Legacy server rows may hold second-scale mtime/ctime (#461); normalize to milliseconds
  const mtime = normalizeServerTimestamp(data.mtime)
  const ctime = normalizeServerTimestamp(data.ctime)
  dump(`Receive note sync mtime:`, data.path, mtime)

  const normalizedPath = normalizePath(data.path)

  try {
    const locked = await plugin.lockManager.withLock(normalizedPath, async () => {
      const file = plugin.app.vault.getFileByPath(normalizedPath)
      if (file) {
        const content: string = await plugin.app.vault.read(file)
        // 内容一致确认通道：只有本地当前内容仍等于消息内容时才建立可信基线（设计稿 §5.2 第 3 条）
        // Content-equality confirmation: only establish a trusted baseline when the local content
        // still equals the message content (design §5.2 rule 3)
        const localHashNow = typeof data.contentHash === "string" && data.contentHash !== ""
          ? await hashContentAsync(content) : null
        plugin.addIgnoredFile(normalizedPath)
        try {
          await plugin.app.vault.modify(file, content, { ...(ctime > 0 && { ctime }), ...(mtime > 0 && { mtime }) })
          // 记录 mtime
          plugin.lastSyncMtime.set(data.path, mtime || 0)
          // 服务端走 UpdateMtime 说明内容 hash 与客户端发送的一致，提交 pending hash 到 hashManager
          // Server UpdateMtime means content hash matches what client sent; commit pending hash to hashManager
          const pendingHash = plugin.pendingNoteModifies.get(data.path)
          const revision = typeof data.revision === "string" && data.revision !== "" ? data.revision : "";
          const confirmable = localHashNow !== null && localHashNow === data.contentHash;
          if (confirmable && revision !== "" && plugin.fileHashManager.setConfirmedBaseline) {
            plugin.fileHashManager.setConfirmedBaseline(data.path, data.contentHash as string, revision, mtime || 0, file.stat.size);
          }
          if (pendingHash !== undefined && (localHashNow === null || pendingHash === data.contentHash || localHashNow === pendingHash)) {
            if (revision !== "") plugin.fileHashManager.setFileHash(data.path, pendingHash, mtime || 0, file.stat.size, true, revision)
          else plugin.fileHashManager.setFileHash(data.path, pendingHash, mtime || 0, file.stat.size)
            plugin.pendingNoteModifies.delete(data.path)
            plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
          }
          // 更新同步时间
          if (!outsideRound) advanceLiveSyncTime(plugin, "lastNoteSyncTime", data.lastTime)
        } finally {
          plugin.removeIgnoredFile(normalizedPath)
        }
      }
    }, { maxRetries: 5, retryInterval: 100 });
    // 抢锁失败时任务未执行：按失败处理，不能计为完成
    // Lock not acquired means the task never ran: count it as a failure, never as completed
    if (locked === null) throw new Error("Path lock busy")
  } catch (e) {
    dumpError(`[FastSync] Failed to receiveNoteSyncMtime: ${normalizedPath}`, e);
    if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'NoteMtime')) {
      SyncLogManager.getInstance().addLog('receive', 'NoteMtime', e instanceof Error ? e.message : String(e), 'error', data.path);
    }
    if (!outsideRound) plugin.noteSyncTasks.failed++
  } finally {
    if (!outsideRound) plugin.recordSyncCompleted('note', completionPageIndex)
  }
}

/**
 * 接收服务端笔记删除通知
 */
export const receiveNoteSyncDelete = async function (data: ReceiveMessage, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return
  if (isPathExcluded(data.path, plugin)) {
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }
  dump(`Receive note delete:`, data.path, data.mtime, data.pathHash)
  const normalizedPath = normalizePath(data.path)
  let keptLocal: TFile | null = null
  // #205：NoteSyncDelete 可能是空白笔记探测的结论（服务端没有该笔记）。先取走在途标记，
  // 再把"探测在途"并入下面的未同步改动判定——本地空白文件不能被误删，须走保留分支重传
  // #205: this NoteSyncDelete may be the verdict of an empty-note probe (server doesn't have the
  // note). Take the in-flight mark first, then fold "probe in flight" into the unsynced-edit check
  // below — the local empty file must not be deleted, it goes through the keep-branch and re-uploads
  const wasEmptyNoteProbing = emptyNoteProbeSet(plugin).has(data.path)
  if (wasEmptyNoteProbing) {
    consumeEmptyNoteProbe(plugin, data.path)
    // 探测结论：服务端没有该笔记 → 允许下一次（本函数末尾的）重传直接上传空文件
    // Probe verdict: server doesn't have the note -> let the re-upload below send the empty file directly
    emptyNoteConfirmedAbsentSet(plugin).add(data.path)
  }

  try {
    const locked = await plugin.lockManager.withLock(normalizedPath, async () => {
      const file = plugin.app.vault.getFileByPath(normalizedPath)
      if (file instanceof TFile) {
        if (blockAliasedRemoteMutation(plugin, file, data.path, "NoteDelete")) return
        // 本地有未同步的改动时不执行远端删除：保留本地并重新上传（#277）。只读端以服务端为准，照常删除
        // Unsynced local edits win over a remote delete: keep the note and upload it again (#277).
        // A read-only device mirrors the server and still deletes
        // 本判断属于同步轮次内的接收逻辑，与上传门禁同口径 fail-closed 取或；轮次外快照为 false，退化为实时设置
        // This runs inside the sync round's receive flow, so it uses the same fail-closed
        // snapshot-OR-live gate; outside a round the snapshot is false and the live setting decides
        if (!(plugin.syncRoundReadonly || plugin.settings.readonlySyncEnabled)) {
          const baseHash = plugin.fileHashManager.getPathHash(normalizedPath)
          let changed = plugin.pendingNoteModifies.has(normalizedPath) || wasEmptyNoteProbing
          if (!changed && baseHash !== null) {
            const localHash = plugin.fileHashManager.getValidHash(normalizedPath, file.stat.mtime, file.stat.size)
              ?? await hashContentAsync(await plugin.app.vault.read(file))
            changed = localHash !== baseHash
          }
          // 无同步基线：服务端从未确认过这份内容（离线新建、外部工具写入），不能按远端删除处理。
          // 本连接内首次：保留并重新上传；已重传过：只保留（haierkeys/fast-note-sync-service#514 #391）
          // No sync baseline: the server never confirmed this content (created offline, written by an
          // external tool), so a remote delete must not remove it. First time on this connection: keep
          // and upload again; already re-uploaded: keep only
          if (!changed && baseHash === null) {
            if (!firstKeepWithoutBaseline(plugin, normalizedPath)) {
              SyncLogManager.getInstance().addLog('receive', 'NoteDeleteConflict', `本地文件尚未同步且已重新上传，等待服务端确认，保留本地: ${normalizedPath}`, 'cancelled', data.path)
              return
            }
            changed = true
          }
          if (changed) {
            SyncLogManager.getInstance().addLog('receive', 'NoteDeleteConflict', `本地存在未同步的改动，保留本地并重新上传: ${normalizedPath}`, 'cancelled', data.path)
            keptLocal = file
            return
          }
        }
        plugin.addIgnoredFile(normalizedPath)
        // 记录待删除路径，用于拦截本地删除事件
        plugin.lastSyncPathDeleted.add(normalizedPath)
        try {
          await plugin.app.fileManager.trashFile(file)
          // 服务端推送删除,从哈希表中移除
          plugin.fileHashManager.removeFileHash(normalizedPath)
          plugin.lastSyncMtime.delete(normalizedPath)
          // 清理 pending，避免已删除路径的 pending 条目泄漏
          // Clean up pending to prevent memory leak for deleted path
          plugin.pendingNoteModifies.delete(normalizedPath)
          plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
          // 更新同步时间
          advanceLiveSyncTime(plugin, "lastNoteSyncTime", data.lastTime)
        } finally {
          // 延时 500ms 清理拦截集合，确保本地事件已被处理
          window.setTimeout(() => {
            plugin.removeIgnoredFile(normalizedPath)
            plugin.lastSyncPathDeleted.delete(normalizedPath)
          }, 500);
        }
      }
    }, { maxRetries: 5, retryInterval: 100 });
    // 抢锁失败时任务未执行：按失败处理，不能计为完成
    // Lock not acquired means the task never ran: count it as a failure, never as completed
    if (locked === null) throw new Error("Path lock busy")
  } catch (e) {
    dumpError(`[FastSync] Failed to receiveNoteSyncDelete: ${normalizedPath}`, e);
    SyncLogManager.getInstance().addLog('receive', 'NoteDelete', e instanceof Error ? e.message : String(e), 'error', data.path);
    plugin.noteSyncTasks.failed++
  } finally {
    plugin.recordSyncCompleted('note', data.pageIndex)
  }
  if (keptLocal) void noteModify(keptLocal, plugin)
}

/**
 * 接收笔记同步结束通知
 */
export const receiveNoteSyncEnd = async function (data: unknown, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return
  dump(`Receive note end:`, data)

  const syncData = data as SyncEndData
  // 更新任务统计信息，用于进度条计算 (Update task stats for progress bar)
  plugin.noteSyncTasks.needUpload = syncData.needUploadCount || 0
  plugin.noteSyncTasks.needModify = syncData.needModifyCount || 0
  plugin.noteSyncTasks.needSyncMtime = syncData.needSyncMtimeCount || 0
  plugin.noteSyncTasks.needDelete = syncData.needDeleteCount || 0
  // 本轮服务端计数留档，供每轮摘要使用（不改变任何处理行为）
  // Keep this round's server counts for the round summary (no behavior change)
  syncDiagnostics.recordSyncEndCounts?.("note", syncData)

  // End 先于明细到达：暂存 lastTime，待本类型全部完成且无失败时由 settleSyncTimes 落盘
  // End arrives before the details: stash lastTime; settleSyncTimes persists it once the type finished without failures
  plugin.syncState.pendingSyncEndTime.set("lastNoteSyncTime", syncData.lastTime)
  plugin.syncTypeCompleteCount++
}

/**
 * 接收服务端笔记重命名通知
 */
export const receiveNoteSyncRename = async function (data: { path: string, oldPath: string, contentHash: string, mtime?: number, ctime?: number, lastTime?: number, pathHash?: string, pageIndex?: number, revision?: string }, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return
  if (isPathExcluded(data.path, plugin) || isPathExcluded(data.oldPath, plugin)) {
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }

  // 服务端历史数据可能存秒级 mtime/ctime（#461），落盘/比较前先归一化为毫秒
  // Legacy server rows may hold second-scale mtime/ctime (#461); normalize to milliseconds
  const mtime = normalizeServerTimestamp(data.mtime)
  const ctime = normalizeServerTimestamp(data.ctime)

  dump(`Receive note rename:`, data.oldPath, "->", data.path)

  const normalizedOldPath = normalizePath(data.oldPath)
  const normalizedNewPath = normalizePath(data.path)

  try {
    // 对于重命名，我们需要确新路径不被占用。旧路径通常正在被移动，所以锁定新路径。
    const locked = await plugin.lockManager.withLock(normalizedNewPath, async () => {
      const file = plugin.app.vault.getFileByPath(normalizedOldPath)
      if (file instanceof TFile) {
        if (blockAliasedRemoteMutation(plugin, file, data.oldPath, "NoteRename")) return
        if (blockAliasedRemoteMutation(plugin, plugin.app.vault.getFileByPath(normalizedNewPath), data.path, "NoteRename")) return
        plugin.addIgnoredFile(normalizedNewPath)
        plugin.addIgnoredFile(normalizedOldPath)

        // 记录重命名后的新路径，用于拦截本地事件
        plugin.lastSyncPathRenamed.add(normalizedNewPath)

        try {
          // 目标父目录可能尚不存在（改名/移动到新目录）：rename 不建目录，先按 create 路径的
          // 同一模式确保存在，否则 vault.rename 抛 ENOENT、改名被丢弃（两端永久不一致）
          // The target parent folder may not exist yet (rename/move into a new dir): rename
          // creates no folder, so ensure it with the same pattern as the create path, or
          // vault.rename throws ENOENT and the rename is dropped (permanent divergence)
          const targetFolder = normalizedNewPath.split("/").slice(0, -1).join("/")
          if (targetFolder !== "") {
            const dirExists = plugin.app.vault.getFolderByPath(targetFolder)
            if (dirExists == null) {
              try {
                await plugin.app.vault.createFolder(targetFolder)
              } catch (e) {
                // 并发竞争时只有一个调用成功，另一方忽略"已存在"错误
                // In concurrent race only one call succeeds; ignore "already exists" error
                if (!plugin.app.vault.getFolderByPath(targetFolder)) throw e
              }
            }
          }

          // 如果目标路径已存在文件，先尝试删除
          const targetFile = plugin.app.vault.getFileByPath(normalizedNewPath)
          if (targetFile && targetFile !== file) {
            await plugin.app.fileManager.trashFile(targetFile)
          }

          await plugin.app.vault.rename(file, normalizedNewPath)

          // 更新元数据
          if (mtime) {
            const renamedFile = plugin.app.vault.getFileByPath(normalizedNewPath)
            if (renamedFile instanceof TFile) {
              const content = await plugin.app.vault.read(renamedFile)
              const options: { ctime?: number; mtime?: number } = {};
              if (ctime && ctime > 0) options.ctime = ctime;
              if (mtime && mtime > 0) options.mtime = mtime;
              await plugin.app.vault.modify(renamedFile, content, options);
            }
          }

          // 更新哈希表：移除旧路径，添加新路径
          plugin.fileHashManager.removeFileHash(data.oldPath)
          const renamedFile = plugin.app.vault.getFileByPath(normalizedNewPath)
          if (typeof data.revision === "string" && data.revision !== "") {
            plugin.fileHashManager.setFileHash(data.path, data.contentHash, mtime || (renamedFile instanceof TFile ? renamedFile.stat.mtime : 0), renamedFile instanceof TFile ? renamedFile.stat.size : 0, true, data.revision)
          } else {
            plugin.fileHashManager.setFileHash(data.path, data.contentHash, mtime || (renamedFile instanceof TFile ? renamedFile.stat.mtime : 0), renamedFile instanceof TFile ? renamedFile.stat.size : 0)
          }

          // 更新同步时间
          advanceLiveSyncTime(plugin, "lastNoteSyncTime", data.lastTime)
        } finally {
          window.setTimeout(() => {
            plugin.removeIgnoredFile(normalizedNewPath)
            plugin.removeIgnoredFile(normalizedOldPath)
            plugin.lastSyncPathRenamed.delete(normalizedNewPath)
          }, 500);
        }
      } else {
        // 找不到旧文件...
        const targetFile = plugin.app.vault.getFileByPath(normalizedNewPath)
        if (targetFile instanceof TFile) {
          const content = await plugin.app.vault.read(targetFile)
          const localContentHash = await hashContentAsync(content)
          if (localContentHash === data.contentHash) {
            dump(`Target file already exists and matches hash, skipping rename: ${data.path}`)
            plugin.fileHashManager.setFileHash(data.path, data.contentHash)
            return
          }
        }

        dump(`Local file not found for rename, requesting RePush: ${data.oldPath} -> ${data.path}`)
        const rePushData = {
          vault: plugin.settings.vault,
          path: data.path,
          pathHash: data.pathHash,
        }
        void plugin.websocket.SendMessage("NoteRePush", rePushData)
        // 本地还没有这个文件时不能先写同步基线：重推的应答若没到（断线、被丢弃），下一轮扫描
        // 会把"有基线、本地不存在"当成本地删除，把服务端的笔记删掉。基线等内容真正落盘时再写
        // Do not record a sync baseline while the file does not exist locally: if the re-push
        // reply never arrives (disconnect, dropped), the next scan treats "baseline but no local
        // file" as a local delete and removes the note on the server. The baseline is written
        // once the content actually lands
        if (targetFile instanceof TFile) {
          plugin.fileHashManager.setFileHash(data.path, data.contentHash, targetFile.stat.mtime, targetFile.stat.size)
        }
      }
    }, { maxRetries: 10, retryInterval: 100 });
    // 抢锁失败时任务未执行：按失败处理，不能计为完成
    // Lock not acquired means the task never ran: count it as a failure, never as completed
    if (locked === null) throw new Error("Path lock busy")
  } catch (e) {
    dumpError(`[FastSync] Failed to receiveNoteSyncRename: ${normalizedOldPath} -> ${normalizedNewPath}`, e);
    if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'NoteRename')) {
      SyncLogManager.getInstance().addLog('receive', 'NoteRename', e instanceof Error ? e.message : String(e), 'error', data.path);
    }
    plugin.noteSyncTasks.failed++
  } finally {
    plugin.recordSyncCompleted('note', data.pageIndex)
  }
}

// 收到 NoteModifyAck，将 pending hash 转移到正式 hashManager 并更新 lastNoteSyncTime
// Receive NoteModifyAck, move pending hash to formal hashManager and update lastNoteSyncTime
export const receiveNoteModifyAck = async function (data: { lastTime?: number; path?: string; contentHash?: string; revision?: string }, plugin: FastSync, outsideRound = false) {
  // 服务端确认笔记写入成功，将 pending hash 转移到正式 hashManager
  // Server confirmed note write success, move pending hash to formal hashManager
  if (data.path) {
    const file = plugin.app.vault.getFileByPath(normalizePath(data.path))
    const pendingHash = plugin.pendingNoteModifies.get(data.path)
    const ackHash = typeof data.contentHash === "string" && data.contentHash !== "" ? data.contentHash : undefined
    if (ackHash && plugin.isSyncBaselineModeEnabled?.() === true && plugin.fileHashManager.setConfirmedBaseline) {
      // 回执只能确认“发送时的快照”，绝不能把上传途中产生的新编辑当成已同步（设计稿 §5.2）
      // An Ack confirms only the sent snapshot, never an edit made during the upload (§5.2)
      let diskHash: string | null = null
      if (file) {
        try { diskHash = await hashContentAsync(await plugin.app.vault.read(file)) } catch { diskHash = null }
      }
      plugin.fileHashManager.setConfirmedBaseline(data.path, ackHash,
        typeof data.revision === "string" ? data.revision : "",
        file?.stat.mtime || 0, file?.stat.size || 0, diskHash === ackHash)
      if (pendingHash === ackHash) {
        plugin.pendingNoteModifies.delete(data.path)
        plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
      }
      if (diskHash !== null && diskHash !== ackHash) {
        // 上传途中继续编辑：保留新编辑并立即安排携带刚确认基线的后续上传
        // Edited during upload: keep the new edit and immediately schedule a follow-up upload
        // carrying the just-confirmed baseline
        dump(`[Baseline] Ack confirmed ${ackHash}, disk changed to ${diskHash}; scheduling follow-up upload`, data.path)
        plugin.pendingNoteModifies.set(data.path, diskHash)
        plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
        window.setTimeout(() => {
          const current = plugin.app.vault.getFileByPath(normalizePath(data.path as string))
          if (current) void noteModify(current, plugin, true)
        }, 0)
      }
    } else if (pendingHash !== undefined) {
      plugin.fileHashManager.setFileHash(data.path, pendingHash, file?.stat.mtime || 0, file?.stat.size || 0)
      plugin.pendingNoteModifies.delete(data.path)
      plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
    } else {
      dump(`NoteModifyAck received for non-pending path: ${data.path}`)
    }
  }
  if (!outsideRound) advanceLiveSyncTime(plugin, "lastNoteSyncTime", data.lastTime)
  if (data.path) {
    plugin.concurrencyLimiter.releaseSlot(data.path)
  }
  if (outsideRound) return
  // 该 Ack 若对应服务端 NeedPush 驱动的上传，查表取回其所属下载页归账（供 ack 水位线推进）；
  // 查不到说明是本地用户自发编辑触发的 Ack，不属于任何页，走旧路径（现状语义不变）
  // If this Ack corresponds to a server NeedPush-driven upload, look up its owning download page
  // for correct accounting (drives the ack watermark); a miss means a local user-initiated edit
  // triggered it — doesn't belong to any page, falls back to the legacy path (unchanged semantics)
  const pushPageIndex = data.path ? plugin.syncState.pendingNotePushPageIndex.get(data.path) : undefined;
  if (data.path) plugin.syncState.pendingNotePushPageIndex.delete(data.path)
  plugin.recordSyncCompleted('note', pushPageIndex)
}

// 收到 NoteRenameAck，按 data.path 精确匹配待确认条目并更新 hashManager；老服务端不下发 path 时回退 FIFO
// Receive NoteRenameAck, match pending entry precisely by data.path and update hashManager; falls back to FIFO when legacy server omits path
export const receiveNoteRenameAck = function (data: { lastTime?: number; path?: string }, plugin: FastSync) {
  const ackPath = data.path || Array.from(plugin.pendingNoteRenames.keys())[0]
  const retryAck = plugin.retryQueue?.matchesAck("NoteRenameAck", ackPath) ?? false
  let pending: { oldPath: string; newPath: string; contentHash: string } | undefined
  if (data.path) {
    pending = plugin.pendingNoteRenames.get(data.path)
    if (pending) plugin.pendingNoteRenames.delete(data.path)
  } else {
    // 老服务端未下发 path，回退 FIFO（Map 插入顺序取首个）
    // Legacy server omits path, fall back to FIFO (first inserted entry in Map order)
    const firstKey = Array.from(plugin.pendingNoteRenames.keys())[0];
    if (firstKey !== undefined) {
      pending = plugin.pendingNoteRenames.get(firstKey)
      plugin.pendingNoteRenames.delete(firstKey)
    }
  }
  if (pending) {
    plugin.fileHashManager.removeFileHash(pending.oldPath)
    // ACK 只确认服务端基线；本地新路径可能已编辑，必须重新计算缓存。
    plugin.fileHashManager.setFileHash(pending.newPath, pending.contentHash, 0, 0, false)
  }
  if (!retryAck) advanceLiveSyncTime(plugin, "lastNoteSyncTime", data.lastTime)
  if (pending) plugin.concurrencyLimiter.releaseSlot(pending.newPath)
  if (retryAck && pending) plugin.retryQueue.acknowledge("NoteRenameAck", ackPath)
}

// 收到 NoteDeleteAck，仅当路径仍在 pending set 中时才从 hashManager 移除
// Receive NoteDeleteAck; only remove from hashManager if path is still pending
export const receiveNoteDeleteAck = function (data: { lastTime?: number; path?: string }, plugin: FastSync) {
  const retryAck = plugin.retryQueue?.matchesAck("NoteDeleteAck", data.path) ?? false
  if (data.path) {
    // 删除已确认：待删基线完成使命，连同活跃缓存一起清除
    // Delete confirmed: the pre-delete record has served its purpose; drop it with the active cache
    plugin.fileHashManager.clearPendingDeleteBaseline?.(data.path)
  }
  if (data.path && plugin.pendingNoteDeleteAcks.has(data.path)) {
    plugin.fileHashManager.removeFileHash(data.path)
    plugin.pendingNoteDeleteAcks.delete(data.path)
  }
  // 释放并发槽位：与 FileDeleteAck/ConfigDeleteAck 保持一致，仅检查 data.path 是否存在
  // Release concurrency slot: consistent with FileDeleteAck/ConfigDeleteAck, only check data.path
  if (data.path) {
    plugin.concurrencyLimiter.releaseSlot(data.path)
  }
  if (!retryAck) advanceLiveSyncTime(plugin, "lastNoteSyncTime", data.lastTime)
  if (retryAck) plugin.retryQueue.acknowledge("NoteDeleteAck", data.path)
}
