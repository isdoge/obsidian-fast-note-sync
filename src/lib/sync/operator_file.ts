import { blockAliasedRemoteMutation } from "./remote_path_guard";
import { firstKeepWithoutBaseline } from "./remote_delete_guard";
import { TFile, TAbstractFile, normalizePath, Platform } from "obsidian";

import { ReceiveFileSyncUpdateMessage, FileUploadMessage, FileSyncChunkDownloadMessage, FileDownloadSession, ReceiveMtimeMessage, ReceivePathMessage, SyncEndData } from "../utils/types";
import { hashContent, hashArrayBuffer, getPluginDir, dump, dumpError, sleep, isPathExcluded, getSafeCtime, isLargeBinarySyncRisk, describeBinarySyncLimit, showSyncNotice, checkAndNotifyCaseConflict, logMemorySnapshot, hashFileAsync, vaultDelete, normalizeServerTimestamp } from "../utils/helpers";
import { FileCloudPreview } from "../storage/file_cloud_preview";
import { SyncLogManager } from "./sync_log_manager";
import { advanceLiveSyncTime } from "./sync_state";
import { HttpApiService } from "../api/http_api_service";
import type FastSync from "../../main";
import { BaselineDeleteRecord, baselineFieldsFromDeleteRecord, buildBaselineFields, buildDeleteBaselineFields } from "../storage/baseline_scope";


// Download commit guard. A download may only overwrite the local path if, at commit time, it is
// still the newest request for that path in the current connection and the local file has not
// changed, been deleted or gained pending local work since the request was sent. Only file
// stats are captured (after the concurrency slot is held), so no file is read ahead of time.
const downloadOwners = new WeakMap<FastSync, Map<string, object>>()
const downloadEpochs = new WeakMap<FastSync, number>()

export function invalidateFileDownloads(plugin: FastSync): void {
  downloadEpochs.set(plugin, (downloadEpochs.get(plugin) || 0) + 1)
  downloadOwners.delete(plugin)
  // 旧连接的会话不会再收到分片：直接丢弃，不计页、不计失败；否则重连后 120s 看门狗会把它们记到新一轮的页上
  // Sessions of the closed connection never receive chunks again: drop them without page or failure
  // accounting, otherwise the watchdog would book them onto the next round's pages after reconnect
  for (const session of plugin.fileDownloadSessions.values()) {
    releaseSessionMemory(session)
    session.chunks?.clear()
    const id = session.sessionId || session.tempDir?.split("/").pop()
    if (session.tempDir && id) {
      void clearTempChunksDir(plugin, id).catch(e => dumpError(`Temp chunk cleanup failed for session ${id}`, e))
    }
  }
  plugin.fileDownloadSessions.clear()
}

// 会话属于已断开的连接（epoch 已过期）：其迟到的完成/失败不能记到当前一轮
// The session belongs to a closed connection (stale epoch): its late completion/failure must not count in the current round
function isStaleDownload(plugin: FastSync, session: FileDownloadSession): boolean {
  return !!session.commitGuard && session.commitGuard.epoch !== (downloadEpochs.get(plugin) || 0)
}

function captureDownloadGuard(plugin: FastSync, path: string): NonNullable<FileDownloadSession["commitGuard"]> {
  const owners = downloadOwners.get(plugin) || new Map<string, object>()
  downloadOwners.set(plugin, owners)
  const owner = {}
  owners.set(path, owner)
  const file = plugin.app.vault.getFileByPath(normalizePath(path))
  return { owner, epoch: downloadEpochs.get(plugin) || 0, file, mtime: file?.stat.mtime, size: file?.stat.size }
}

function releaseDownloadOwner(plugin: FastSync, session: FileDownloadSession): void {
  const owners = downloadOwners.get(plugin)
  if (session.commitGuard && owners?.get(session.path) === session.commitGuard.owner) owners.delete(session.path)
}

function assertDownloadCommittable(plugin: FastSync, session: FileDownloadSession): void {
  const guard = session.commitGuard
  if (!guard) return
  if (isPluginUnloading || plugin.settings.syncEnabled === false ||
    plugin.fileDownloadSessions.get(session.sessionId) !== session ||
    downloadOwners.get(plugin)?.get(session.path) !== guard.owner ||
    (downloadEpochs.get(plugin) || 0) !== guard.epoch) {
    throw new Error("Download superseded by a newer request, cancellation or reconnect")
  }
  if (plugin.pendingUploadHashes.has(session.path) || plugin.pendingDeleteFilePaths.has(session.path) ||
    plugin.pendingFileDeleteAcks.has(session.path)) {
    throw new Error("Download skipped: local change pending upload or deletion")
  }
  const current = plugin.app.vault.getFileByPath(normalizePath(session.path))
  if (current !== guard.file || current?.stat.mtime !== guard.mtime || current?.stat.size !== guard.size) {
    throw new Error("Download skipped: local file changed during download")
  }
}

// 下载内存缓冲控制 (20MB 阈值防止 OOM)
let currentDownloadBufferBytes = 0
const MAX_DOWNLOAD_BUFFER_BYTES = 20 * 1024 * 1024

// 上传中的文件追踪，用于删除时取消上传
const activeUploadsMap = new Map<string, { cancelled: boolean; checkpointKey?: string }>()

/** 该路径是否仍在分片上传中（只读，供并发名额清扫把它判为忙）。 / Read-only busy check for the slot sweep. */
export function isAttachmentUploadActive(path: string): boolean {
  return activeUploadsMap.has(path)
}

// 全局中止信号，用于插件卸载时
export let isPluginUnloading = false;

// 会话 ID 到文件路径的映射，用于处理 463 会话不存在错误
const sessionIdToPathMap = new Map<string, string>()
const pathToSessionIdMap = new Map<string, string>()
const uploadAckTimers = new Map<string, number>()
const uploadRetries = new Map<string, number>()
// An ACK has no content/session identity on 3.8/3.7/3.6.1. Keep the actual sent
// snapshot separate from queued work; after a timeout, ACK identity is ambiguous.
const sentUploadContent = new Map<string, { hash: string; mtime: number; size: number }>()
const ambiguousUploadAcks = new Set<string>()
const uploadContexts = new Map<string, string | null>()

function clearUploadTracking(path: string): void {
  const timer = uploadAckTimers.get(path)
  if (timer !== undefined) window.clearTimeout(timer)
  uploadAckTimers.delete(path)
  const active = activeUploadsMap.get(path)
  if (active) active.cancelled = true
  activeUploadsMap.delete(path)
  const id = pathToSessionIdMap.get(path)
  if (id) sessionIdToPathMap.delete(id)
  pathToSessionIdMap.delete(path)
}

/** Cancel an upload superseded by a local delete or rename and settle its sync-page item. */
function cancelActiveUpload(path: string, plugin: FastSync): boolean {
  const active = activeUploadsMap.get(path)
  if (!active && !pathToSessionIdMap.has(path)) return false

  if (active) active.cancelled = true
  plugin.concurrencyLimiter.cancelQueued?.(path)
  sentUploadContent.delete(path)
  ambiguousUploadAcks.add(path)
  const checkpointKey = active?.checkpointKey
  const pageIndex = plugin.syncState.pendingFilePushPageIndex.get(path)
  plugin.syncState.pendingFilePushPageIndex.delete(path)
  clearUploadTracking(path)
  uploadRetries.delete(path)
  uploadContexts.delete(path)
  if (checkpointKey) {
    try { plugin.app.saveLocalStorage(checkpointKey, null) } catch { /* ignore */ }
  }
  plugin.concurrencyLimiter.releaseSlot(path)
  if (pageIndex !== undefined) plugin.recordSyncCompleted('file', pageIndex)
  return true
}

function armUploadAckTimeout(path: string, plugin: FastSync): void {
  const previous = uploadAckTimers.get(path)
  if (previous !== undefined) window.clearTimeout(previous)
  uploadAckTimers.set(path, window.setTimeout(() => recoverUpload(path, plugin), 60000))
}

function recoverUpload(path: string, plugin: FastSync): void {
  const context = uploadContexts.get(path)
  ambiguousUploadAcks.add(path)
  clearUploadTracking(path)
  plugin.concurrencyLimiter.releaseSlot(path)
  if (isPluginUnloading || !plugin.websocket.isOpen || context !== plugin.syncState.activeSyncContext) return
  const attempts = (uploadRetries.get(path) || 0) + 1
  uploadRetries.set(path, attempts)
  const file = plugin.app.vault.getFileByPath(path)
  if (attempts > 2 || !file) {
    plugin.fileSyncTasks.failed++
    const page = plugin.syncState.pendingFilePushPageIndex.get(path)
    plugin.syncState.pendingFilePushPageIndex.delete(path)
    plugin.recordSyncCompleted('file', page)
    SyncLogManager.getInstance().addLog('receive', 'FileUpload', 'Upload acknowledgement unavailable after bounded retries', 'error', path)
    return
  }
  // Recheck current local content; never reuse an expired session or stale bytes.
  void fileModify(file, plugin, false, true).catch(error => {
    dumpError('Upload recovery failed', error)
    recoverUpload(path, plugin)
  })
}

// 大文件跳过同步通知去重：本会话内已提示过的 "path|size"，避免同一文件每轮同步重复弹 toast
const sessionLargeFileNotified = new Set<string>()

/**
 * 大文件跳过同步的通知去重：同一 (path, size) 组合本会话或历史设置中已提示过则只 dump，不再弹 toast
 * Dedup notice for large-file-skip: only dump (no toast) if this (path, size) pair was already notified
 * either in this session or recorded in settings history
 */
function notifyLargeFileSkipped(plugin: FastSync, path: string, size: number, message: string): void {
  const key = `${path}|${size}`
  const shown = plugin.settings.largeFileNoticeShown ?? []
  if (sessionLargeFileNotified.has(key) || shown.includes(key)) {
    dump(`Large file skip notice suppressed (already shown): ${key}`)
    return
  }
  showSyncNotice(message, 5000)
  sessionLargeFileNotified.add(key)
  // 重新赋值而非 push：settings 可能与 DEFAULT_SETTINGS 浅拷贝共享同一数组引用，原地 push 会污染默认值
  const next = [...shown, key]
  if (next.length > 200) next.shift()
  plugin.settings.largeFileNoticeShown = next
  void plugin.saveSettings()
}

/**
 * 获取临时分片目录路径
 */
export const getTempChunksDir = (plugin: FastSync, sessionId?: string) => {
  const base = normalizePath(`${getPluginDir(plugin)}/temp-chunks`)
  return sessionId ? normalizePath(`${base}/${sessionId}`) : base
}

/**
 * 清理指定会话的临时目录
 */
export const clearTempChunksDir = async (plugin: FastSync, sessionId: string) => {
  const path = getTempChunksDir(plugin, sessionId)
  if (await plugin.app.vault.adapter.exists(path)) {
    await plugin.app.vault.adapter.rmdir(path, true)
  }
}

const shouldUseMemoryDownload = (size: number) => Platform.isMobile && size <= MAX_DOWNLOAD_BUFFER_BYTES

const createDownloadStorage = (plugin: FastSync, sessionId: string, size: number): Pick<FileDownloadSession, "chunks" | "downloadedChunks" | "tempDir"> => {
  if (shouldUseMemoryDownload(size)) {
    return { chunks: new Map<number, ArrayBuffer>() }
  }
  return {
    downloadedChunks: new Set<number>(),
    tempDir: getTempChunksDir(plugin, sessionId),
  }
}

const getCompletedDownloadChunks = (session: FileDownloadSession) => {
  return session.tempDir ? session.downloadedChunks?.size || 0 : session.chunks?.size || 0
}

const getSessionMemoryBytes = (session: FileDownloadSession) => {
  if (session.tempDir) return 0
  return Array.from(session.chunks?.values() || []).reduce((sum, c) => sum + c.byteLength, 0)
}

const releaseSessionMemory = (session: FileDownloadSession) => {
  const sessionSize = getSessionMemoryBytes(session)
  if (sessionSize > 0) {
    currentDownloadBufferBytes = Math.max(0, currentDownloadBufferBytes - sessionSize)
  }
}

const formatDownloadError = (e: unknown) => {
  return e instanceof Error ? e.message : String(e)
}

// failed=true 表示本次会话是因下载/写盘失败而清理，需计入 fileSyncTasks.failed，
// 与 completed（驱动完成判定/翻页 ACK，语义不变）区分开，避免失败被状态栏当作成功展示
// failed=true means this session is being cleaned up due to a download/write failure and
// should count toward fileSyncTasks.failed, kept separate from completed (which still drives
// completion detection / page ACK unchanged), so failures aren't surfaced as success in the status bar
const cleanupFileDownloadSession = async (plugin: FastSync, session: FileDownloadSession, failed = false) => {
  releaseSessionMemory(session)
  releaseDownloadOwner(plugin, session)
  plugin.fileDownloadSessions.delete(session.sessionId)
  // 清理临时目录失败不能中断记账：否则会话已移除，但失败计数、页完成与名额释放都会丢失
  // A temp-dir cleanup failure must not abort bookkeeping; otherwise the session is gone but
  // the failure count, page completion and slot release are all lost
  if (session.tempDir) {
    try {
      await clearTempChunksDir(plugin, session.sessionId)
    } catch (e) {
      dumpError(`Temp chunk cleanup failed for session ${session.sessionId}`, e)
    }
  }
  if (isStaleDownload(plugin, session)) return
  if (failed) plugin.fileSyncTasks.failed++
  plugin.recordSyncCompleted('file', session.pageIndex)
}

const failFileDownloadSession = async (plugin: FastSync, session: FileDownloadSession, message: string, releaseSlot = true) => {
  dumpError(`File download failed: ${session.path} (${session.sessionId}) - ${message}`)
  const completedCount = getCompletedDownloadChunks(session)
  SyncLogManager.getInstance().addOrUpdateLog({
    id: session.sessionId,
    type: 'receive',
    action: 'FileDownload',
    path: session.path,
    status: 'error',
    progress: session.totalChunks === 0 ? 0 : Math.floor((completedCount / session.totalChunks) * 100),
    message
  });
  await cleanupFileDownloadSession(plugin, session, true)
  if (releaseSlot && !isStaleDownload(plugin, session)) {
    plugin.concurrencyLimiter.releaseSlot(`download_${session.path}`)
  }
}

// 下载会话看门狗：服务端下载会话会过期（download-session-timeout），分片不再到达时客户端会话
// 会永久占住并发名额，并让 checkSyncCompletion 的 fileDownloadSessions.size === 0 永远不成立。
// 超过闲置期仍无响应/分片的会话按失败处理，释放名额并归账所属页；下一轮同步会重新下载。
// Download watchdog: when the server-side download session expires and chunks stop arriving, the
// client session would hold its concurrency slot forever and keep checkSyncCompletion from ever
// finishing. Fail sessions idle past the limit, releasing the slot and page; the next round retries.
export const DOWNLOAD_SESSION_IDLE_MS = 120000
let lastDownloadSweepAt = 0
export const sweepStalledDownloadSessions = async (plugin: FastSync, idleMs = DOWNLOAD_SESSION_IDLE_MS, now = Date.now()) => {
  if (now - lastDownloadSweepAt < 10000) return 0
  lastDownloadSweepAt = now
  const stalled: Array<[string, FileDownloadSession]> = []
  for (const [key, session] of plugin.fileDownloadSessions) {
    // 已进入提交阶段的会话由提交流程自行记账 / Sessions already committing do their own accounting
    if (session.committing) continue
    if (session.lastActivityAt !== undefined && now - session.lastActivityAt > idleMs) stalled.push([key, session])
  }
  for (const [key, session] of stalled) {
    plugin.fileDownloadSessions.delete(key)
    // 临时会话 sessionId 为空：用其自身临时目录名清理，绝不能以空 id 删除整个 temp-chunks 目录
    // Temp sessions have an empty sessionId: clean up by their own temp dir name, never the whole temp-chunks base
    const sessionId = session.sessionId || session.tempDir?.split("/").pop() || key
    await failFileDownloadSession(plugin, { ...session, sessionId }, `No download data received for ${Math.round(idleMs / 1000)}s`)
  }
  return stalled.length
}

const storeMemoryChunk = (session: FileDownloadSession, chunkIndex: number, chunkData: ArrayBuffer) => {
  if (!session.chunks) session.chunks = new Map<number, ArrayBuffer>()
  const existingChunk = session.chunks.get(chunkIndex)
  session.chunks.set(chunkIndex, chunkData)
  if (existingChunk) {
    currentDownloadBufferBytes = Math.max(0, currentDownloadBufferBytes - existingChunk.byteLength + chunkData.byteLength)
    return false
  }
  currentDownloadBufferBytes += chunkData.byteLength
  return true
}

const fallbackFileDownloadSessionToMemory = async (plugin: FastSync, session: FileDownloadSession, chunkIndex: number, chunkData: ArrayBuffer) => {
  const oldTempDir = session.tempDir
  const downloadedChunks = Array.from(session.downloadedChunks || [])
  session.chunks = new Map<number, ArrayBuffer>()

  if (oldTempDir) {
    for (const index of downloadedChunks) {
      const chunkPath = normalizePath(`${oldTempDir}/${index}.bin`)
      if (await plugin.app.vault.adapter.exists(chunkPath)) {
        const chunk = await plugin.app.vault.adapter.readBinary(chunkPath)
        storeMemoryChunk(session, index, chunk)
      }
    }
  }

  const wasNewChunk = storeMemoryChunk(session, chunkIndex, chunkData)
  session.tempDir = undefined
  session.downloadedChunks = undefined
  if (oldTempDir) await clearTempChunksDir(plugin, session.sessionId)
  return wasNewChunk
}

/**
 * 清理所有残留的临时目录
 */
export const clearAllTempChunks = async (plugin: FastSync) => {
  const adapter = plugin.app.vault.adapter
  const path = getTempChunksDir(plugin)

  const removeEntries = async (dirPath: string) => {
    if (typeof adapter.list !== "function") return
    try {
      const entries = await adapter.list(dirPath)
      for (const file of entries.files || []) {
        try {
          await adapter.remove(file)
        } catch (err) {
          dumpError(`Failed to remove temp chunk file: ${file}`, err)
        }
      }
      for (const folder of entries.folders || []) {
        await removeEntries(folder)
        try {
          await adapter.rmdir(folder, true)
        } catch (err) {
          dumpError(`Failed to remove temp chunk folder: ${folder}`, err)
        }
      }
    } catch (err) {
      dumpError(`Failed to list temp chunk dir: ${dirPath}`, err)
    }
  }

  try {
    if (await adapter.exists(path)) {
      dump(`Cleaning all temp chunks: ${path}`)
      try {
        await adapter.rmdir(path, true)
      } catch (e) {
        dumpError(`Failed to remove temp chunks dir: ${path}`, e)
        await removeEntries(path)
      }
    }
  } catch (e) {
    dumpError(`Failed to clean temp chunks: ${path}`, e)
  }

  // 确保基础目录在清理后立即存在 (Ensure base dir exists immediately after cleanup)
  try {
    if (!(await adapter.exists(path))) {
      await adapter.mkdir(path)
    }
  } catch (e) {
    dumpError(`Failed to ensure temp chunks dir exists: ${path}`, e)
  }
}

/**
 * 冲突（530 / SyncConflict）冻结某条附件时，取消其分片上传并清掉 60s 回执超时定时器：
 * 否则 recoverUpload 到期会把冲突附件当“回执丢失”自动重传，反复撞 530。
 * Cancel an attachment's chunk upload and its 60s ack timeout when a conflict (530 / SyncConflict)
 * freezes the path; otherwise recoverUpload would treat it as a lost ack and retry the conflicting
 * upload on its own.
 */
export const clearUploadTrackingForConflict = (path: string): void => {
  const active = activeUploadsMap.get(path)
  if (active) active.cancelled = true
  clearUploadTracking(path)
  uploadRetries.delete(path)
  uploadContexts.delete(path)
  sentUploadContent.delete(path)
  ambiguousUploadAcks.delete(path)
}

export const clearUploadQueue = () => {
  for (const timer of uploadAckTimers.values()) window.clearTimeout(timer)
  for (const state of activeUploadsMap.values()) state.cancelled = true
  uploadAckTimers.clear()
  uploadContexts.clear()
  uploadRetries.clear()
  sentUploadContent.clear()
  ambiguousUploadAcks.clear()
  activeUploadsMap.clear()
  sessionIdToPathMap.clear()
  pathToSessionIdMap.clear()
}

/**
 * 中止所有进行中的文件操作 (插件卸载时调用)
 */
export const abortAllFileOperations = () => {
  isPluginUnloading = true;
  clearUploadQueue();
  for (const upload of activeUploadsMap.values()) {
    upload.cancelled = true;
  }
  dump("All file operations aborted.");
}

/**
 * 重置文件操作状态 (插件加载时调用)
 */
export const resetFileOperations = () => {
  isPluginUnloading = false;
}

export const BINARY_PREFIX_FILE_SYNC = "00"

/**
 * 文件（非笔记）修改事件处理
 */
export const fileModify = async function (file: TAbstractFile, plugin: FastSync, eventEnter: boolean = false, forceCheck = false, options?: { isConflictResolved?: boolean; baseRevision?: string }) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (!(file instanceof TFile)) return
  if (file.path.endsWith(".md")) return
  if (eventEnter && plugin.isIgnoredFile(file.path)) {
    // 命中的是祖先目录项时，屏蔽解除后补一次；命中路径自身（远端落盘的自我保护）仍直接丢弃
    // An ancestor-folder hit is retried after the guard clears; a hit on the path itself
    // (remote write self-protection) is still dropped as before
    if (plugin.isIgnoredByAncestor(file.path)) {
      dump(`File modify deferred (parent folder guarded): ${file.path}`)
      plugin.eventManager?.deferGuardedModify(file)
    }
    return
  }
  if (isPathExcluded(file.path, plugin)) return
  // 冲突冻结的附件不响应实时写（已解决的提交除外）
  // A frozen conflicted attachment ignores live writes (resolved submits excepted)
  if (plugin.syncState?.conflictedPaths?.has(file.path) && !options?.isConflictResolved) {
    dump(`File modify paused, unresolved conflict: ${file.path}`)
    return
  }

  if (isLargeBinarySyncRisk(file.stat.size, plugin)) {
    dump(`Skip file modify for large attachment (${describeBinarySyncLimit(plugin)} limit): ${file.path}`, file.stat.size)
    notifyLargeFileSkipped(plugin, file.path, file.stat.size, `Fast Note Sync skipped large file: ${file.path}`)
    return
  }

  await plugin.lockManager.withLock(file.path, async () => {
    plugin.addIgnoredFile(file.path)
    try {
      const baseHash = plugin.fileHashManager.getPathHash(file.path)
      const lastSyncMtime = plugin.lastSyncMtime.get(file.path)

      // --- 优化：先尝试从缓存获取有效哈希 ---
      let contentHash = plugin.fileHashManager.getValidHash(file.path, file.stat.mtime, file.stat.size);

      if (contentHash !== null) {
        if (!forceCheck && contentHash === baseHash && (lastSyncMtime !== undefined && lastSyncMtime === file.stat.mtime)) {
          dump(`File modify intercepted (cache match): ${file.path}`)
          return
        }
      } else {
        contentHash = await hashFileAsync(plugin.app, file.path);
        logMemorySnapshot(`after modify hash ${file.path}`)
      }

      // 内容与上次同步一致、只有 mtime 变了（如打开 canvas 时 Obsidian 原样写回）：没有可上传的改动。
      // 若照常上传，较新的 mtime 会让服务端用本地旧内容覆盖其它端的新版本（#256）
      // Content equals the last synced version and only the mtime moved (e.g. Obsidian rewrites a canvas
      // unchanged when opening it): nothing to upload. Uploading anyway lets the newer mtime overwrite
      // another device's newer version on the server with this stale content (#256)
      if (!forceCheck && contentHash === baseHash && !plugin.pendingUploadHashes.has(file.path)) {
        dump(`File modify skipped (content unchanged since last sync): ${file.path}`)
        return
      }

      const data = {
        vault: plugin.settings.vault,
        path: file.path,
        pathHash: hashContent(file.path),
        contentHash: contentHash,
        mtime: file.stat.mtime,
        ctime: getSafeCtime(file.stat),
        size: file.stat.size,
        ...buildBaselineFields(plugin, "file", file.path, contentHash),
        ...(options?.baseRevision ? { baseRevision: options.baseRevision } : {}),
        ...(options?.isConflictResolved ? { isConflictResolved: true } : {}),
      }
      // 将 hash 暂存到 pending map，等待服务端 FileUploadAck 后再写入 hashManager
      // Temporarily store hash in pending map, update hashManager only after server FileUploadAck
      // 新建操作覆盖删除意图，清除 pending 防止晚到的 Ack 错误删除新文件 hash
      // New upload supersedes delete intent; clear pending to prevent stale Ack from removing new hash
      plugin.pendingFileDeleteAcks.delete(file.path)
      plugin.pendingUploadHashes.set(file.path, contentHash)
      plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
      if (!await plugin.concurrencyLimiter.waitForSlot(file.path)) return
      // 排队期间完全相同的 contentHash 可能已被分页上传无歧义地确认并落入基线：
      // 此时基线已等于本题内容、无 pending、也没有超时恢复留下的歧义标记，再发 FileUploadCheck 纯属冗余。
      // 3.7.0 对无需更新的检查不回包，冗余检查会让名额占满 60s 后超时重入（1000 附件测试组合 2 的积压根因）。
      // 三个条件任一不成立都必须照常发送：排队的是新编辑 B（pending 为 B）、ACK 无法证明内容（无 sent 记录）、
      // 或发生过 60s 超时恢复（ambiguous 标记）。
      // While queued, the exact same content may be unambiguously confirmed by a paged upload and
      // land in the baseline. Then this check is pure redundancy: 3.7.0 does not answer checks that
      // need no update, and the slot sits idle for the full 60s before the timeout re-enters.
      // Any of the three conditions failing means we must still send (queued newer edit, ACK that
      // cannot prove content, or an ambiguous post-recovery ACK).
      if (!ambiguousUploadAcks.has(file.path) &&
        !plugin.pendingUploadHashes.has(file.path) &&
        plugin.fileHashManager.getPathHash(file.path) === contentHash) {
        dump(`File modify check skipped (exact content already confirmed while queued): ${file.path}`, contentHash)
        if (!activeUploadsMap.has(file.path)) plugin.concurrencyLimiter.releaseSlot(file.path)
        return
      }
      // Path-only ACKs cannot prove which content was confirmed. Always send this check.
      plugin.pendingUploadHashes.set(file.path, contentHash)
      plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
      uploadContexts.set(file.path, plugin.syncState.activeSyncContext)
      armUploadAckTimeout(file.path, plugin)
      void plugin.websocket.SendMessage("FileUploadCheck", data, undefined, () => {
        sentUploadContent.set(file.path, { hash: contentHash, mtime: data.mtime, size: data.size })
      })
      dump(`File modify check sent`, data.path, data.contentHash)
    } finally {
      plugin.removeIgnoredFile(file.path)
    }
  }, { maxRetries: 5, retryInterval: 50 });
}

/**
 * 文件删除事件处理
 */
export const fileDelete = async function (file: TAbstractFile, plugin: FastSync, eventEnter: boolean = false) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (!(file instanceof TFile)) return
  if (file.path.endsWith(".md")) return
  if (eventEnter && plugin.isIgnoredFile(file.path)) return
  if (isPathExcluded(file.path, plugin)) return


  // --- 新增：删除拦截 ---
  if (plugin.lastSyncPathDeleted.has(file.path)) {
    dump(`File delete intercepted: ${file.path}`)
    return
  }
  // 冲突冻结的附件不自动上传删除 / A frozen conflicted attachment never auto-uploads a deletion
  if (plugin.syncState?.conflictedPaths?.has(file.path)) {
    dump(`File delete paused, unresolved conflict: ${file.path}`)
    return
  }

  await plugin.lockManager.withLock(file.path, async () => {
    // 如果该文件正在上传或在队列中，则标记为取消，且不再发送服务端删除消息
    if (activeUploadsMap.has(file.path)) {
      cancelActiveUpload(file.path, plugin)
      dump(`Upload cancelled due to file deletion: ${file.path}`);
      // 仅清理本地状态
      plugin.fileHashManager.removeFileHash(file.path)
      plugin.pendingUploadHashes.delete(file.path)
      plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
      return
    }

    // 清理可能存在的待确认上传记录，避免 pending map 内存泄漏
    // Clean up any pending upload record to avoid pending map memory leak
    if (pathToSessionIdMap.has(file.path)) cancelActiveUpload(file.path, plugin)
    plugin.pendingUploadHashes.delete(file.path)
    plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)

    plugin.addIgnoredFile(file.path)
    try {
      // 删除前快照最后确认的基线 / Snapshot the last confirmed baseline before deletion
      if (plugin.isSyncBaselineModeEnabled?.() === true) plugin.fileHashManager.recordPendingDeleteBaseline?.(file.path)
      const data = {
        vault: plugin.settings.vault,
        path: file.path,
        pathHash: hashContent(file.path),
        ...buildDeleteBaselineFields(plugin, "file", file.path),
      }
      if (!await plugin.concurrencyLimiter.waitForSlot(file.path)) return
      await plugin.websocket.SendMessage("FileDelete", data, undefined, () => {
        // 消息真正写入 TCP 缓冲区后加入 pending set，等待 FileDeleteAck 再删 hash
        // Add to pending set only after message is actually buffered; remove hash only on FileDeleteAck
        plugin.pendingFileDeleteAcks.add(file.path)
      })
      dump(`File delete send`, file.path)
    } finally {
      plugin.removeIgnoredFile(file.path)
    }
  }, { maxRetries: 3, retryInterval: 50 });
}

/**
 * 按路径字符串发送文件删除消息（用于无法获取 TFile 对象的场景，如 rename 后旧路径已不存在）
 * Send file delete message by path string (for scenarios where TFile object is unavailable, e.g., old path after rename)
 */
export const fileDeleteByPath = async function (filePath: string, plugin: FastSync, retryGuard?: () => boolean, explicitBaseline?: BaselineDeleteRecord) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (filePath.endsWith(".md")) return
  if (isPathExcluded(filePath, plugin)) return

  if (plugin.lastSyncPathDeleted.has(filePath)) return

  await plugin.lockManager.withLock(filePath, async () => {
    if (retryGuard && !retryGuard()) return
    // 如果该文件正在上传或在队列中，则标记为取消，且不再发送服务端删除消息
    // If the file is being uploaded or in the queue, cancel and skip server delete
    if (activeUploadsMap.has(filePath)) {
      cancelActiveUpload(filePath, plugin)
      plugin.fileHashManager.removeFileHash(filePath)
      plugin.pendingUploadHashes.delete(filePath)
      plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
      return
    }

    // 清理可能存在的待确认上传记录，避免 pending map 内存泄漏
    // Clean up any pending upload record to avoid pending map memory leak
    if (pathToSessionIdMap.has(filePath)) cancelActiveUpload(filePath, plugin)
    plugin.pendingUploadHashes.delete(filePath)
    plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)

    plugin.addIgnoredFile(filePath)
    try {
      if (plugin.isSyncBaselineModeEnabled?.() === true) plugin.fileHashManager.recordPendingDeleteBaseline?.(filePath)
      if (!await plugin.concurrencyLimiter.waitForSlot(filePath)) return
      if (retryGuard && !retryGuard()) { plugin.concurrencyLimiter.releaseSlot(filePath); return }
      await plugin.websocket.SendMessage("FileDelete", {
        vault: plugin.settings.vault,
        path: filePath,
        pathHash: hashContent(filePath),
        ...(explicitBaseline ? baselineFieldsFromDeleteRecord(explicitBaseline) : buildDeleteBaselineFields(plugin, "file", filePath)),
      }, () => retryGuard ? !retryGuard() : false, () => {
        // 消息真正写入 TCP 缓冲区后加入 pending set，等待 FileDeleteAck 再删 hash
        // Add to pending set only after message is actually buffered; remove hash only on FileDeleteAck
        plugin.pendingFileDeleteAcks.add(filePath)
      })
      dump(`File delete by path send`, filePath)
    } finally {
      plugin.removeIgnoredFile(filePath)
    }
  }, { maxRetries: 3, retryInterval: 50 });
}

/**
 * 文件重命名事件处理
 */
export const fileRename = async function (file: TAbstractFile, oldfile: string, plugin: FastSync, eventEnter: boolean = false, retryGuard?: () => boolean, retryBaselineHash?: string, retryBaselineRevision?: string) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (file.path.endsWith(".md")) return
  if (plugin.isIgnoredFile(file.path) && eventEnter) return
  const newExcluded = isPathExcluded(file.path, plugin)
  const oldExcluded = isPathExcluded(oldfile, plugin)

  // Cross-exclusion-boundary rename handling
  // 跨排除边界重命名处理
  if (newExcluded && !oldExcluded) {
    // Moving from normal folder to excluded folder: delete old path on server
    // 从正常文件夹移至排除文件夹：删除服务端旧路径
    void fileDeleteByPath(oldfile, plugin)
    return
  }
  if (!newExcluded && oldExcluded) {
    // Moving from excluded folder to normal folder: create new file on server
    // 从排除文件夹移至正常文件夹：在服务端创建新文件
    void fileModify(file, plugin, true)
    return
  }
  if (newExcluded && oldExcluded) {
    // Both paths excluded: do nothing
    // 两个路径均被排除：不处理
    return
  }

  if (!(file instanceof TFile)) return

  // --- 新增：重命名拦截 ---
  if (plugin.lastSyncPathRenamed.has(file.path)) {
    dump(`File rename intercepted: ${file.path}`)
    return
  }

  // 基线模式（设计稿 §2.4）：先确保目标上传成功，再对源路径条件删除；旧模式保持原生 rename
  // Baseline mode (§2.4): upload the target first, then conditionally delete the source;
  // compatibility mode keeps the native rename
  if (plugin.isSyncBaselineModeEnabled?.()) {
    if (retryGuard && !retryGuard()) return;
    const sourceHasBaseline = plugin.fileHashManager.getPathHash(oldfile) !== null;
    await fileModify(file, plugin, true, true);
    const explicit = retryBaselineHash !== undefined
      ? { hash: retryBaselineHash, hashMissing: false, revision: retryBaselineRevision || "" } as BaselineDeleteRecord
      : undefined;
    if (sourceHasBaseline || explicit) await fileDeleteByPath(oldfile, plugin, undefined, explicit);
    dump(`File rename converted to create-then-conditional-delete`, oldfile, file.path, sourceHasBaseline);
    return;
  }

  await plugin.lockManager.withLock(file.path, async () => {
    if (retryGuard && !retryGuard()) return
    plugin.addIgnoredFile(file.path)
    try {
      dump(`File rename`, oldfile, file.path)

      // 如果旧文件正在上传，则取消上传且不发送删除消息
      if (activeUploadsMap.has(oldfile)) {
        cancelActiveUpload(oldfile, plugin)
        // 重新上传
        void fileModify(file, plugin)
        dump(`Upload cancelled due to file rename: ${oldfile}`);
      } else {
        if (pathToSessionIdMap.has(oldfile)) cancelActiveUpload(oldfile, plugin)

        let contentHash = retryBaselineHash || plugin.fileHashManager.getPathHash(oldfile)
        if (contentHash == null) {
          // 尝试新路径哈希缓存 (Try new path cache)
          contentHash = plugin.fileHashManager.getValidHash(file.path, file.stat.mtime, file.stat.size);
          if (contentHash == null) {
            if (isLargeBinarySyncRisk(file.stat.size, plugin)) {
              dump(`Skip rename hash for large attachment (${describeBinarySyncLimit(plugin)} limit): ${file.path}`, file.stat.size)
              return
            }
            contentHash = await hashFileAsync(plugin.app, file.path)
          }
        }

        const data = {
          vault: plugin.settings.vault,
          oldPath: oldfile,
          oldPathHash: hashContent(oldfile),
          path: file.path,
          pathHash: hashContent(file.path),
        }
        if (retryGuard && !retryGuard()) return
        // 将重命名推入待确认队列，等待服务端 FileRenameAck 后再更新 hashManager
        // Push rename to pending queue; hashManager will be updated after server FileRenameAck
        if (!plugin.pendingFileRenames.some(entry => entry.oldPath === oldfile && entry.newPath === file.path)) {
          plugin.pendingFileRenames.push({ oldPath: oldfile, newPath: file.path, contentHash })
        }
        if (!await plugin.concurrencyLimiter.waitForSlot(file.path, true)) return
        if (retryGuard && !retryGuard()) { plugin.concurrencyLimiter.releaseSlot(file.path); return }
        await plugin.websocket.SendMessage("FileRename", data, () => retryGuard ? !retryGuard() : false)
      }
    } finally {
      plugin.removeIgnoredFile(file.path)
    }
  }, { maxRetries: 5, retryInterval: 50 });
}


/** 删除本地副本前完整校验的最大附件大小（含中间字节）/ Largest attachment fully verified before local deletion */
const MAX_VERIFIABLE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** 全量 SHA-256（不能使用带采样的滚动哈希）/ Full SHA-256 (the sampled rolling hash is insufficient) */
async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 「附件云预览 - 上传后删除本地」的安全清理：
 * 1. path / size / mtime / contentHash 仍与刚上传的内容一致；
 * 2. 大小已知且在 20MB 内，读回远端原始字节并用 SHA-256 核对与本地刚读取的字节完全一致；
 * 3. 先把驱逐记录持久化到设备本地日志，再移入回收站；移动失败回滚记录。
 * 任何一步不满足都保留本地文件；没有驱逐日志时不清理（无法保证扫描不误报删除）。
 *
 * Safe cleanup for "cloud preview — delete local after upload":
 * 1. path / size / mtime / contentHash still describe the content just uploaded;
 * 2. size is known and within 20MB, remote bytes are read back and their SHA-256 must equal the
 *    local bytes read moments ago;
 * 3. the device-local eviction record is persisted before the file is moved to the bin, and
 *    rolled back if the move fails.
 * Any failed step keeps the local file; without the journal nothing is deleted, because the
 * offline scan could not tell this cleanup apart from a user deletion.
 */
export async function maybeAutoDeleteUploadedAttachment(plugin: FastSync, file: TFile, contentHash: string): Promise<boolean> {
  if (!plugin.settings.cloudPreviewEnabled || !plugin.settings.cloudPreviewAutoDeleteLocal) return false;
  const ext = file.path.substring(file.path.lastIndexOf(".")).toLowerCase();
  if (plugin.settings.cloudPreviewTypeRestricted && !FileCloudPreview.isRestrictedType(ext)) return false;

  await sleep(2000);
  if (isPluginUnloading) return false;

  try {
    const apiService = new HttpApiService(plugin);
    const serverInfo = await apiService.getFileInfo(file.path);
    if (!serverInfo) return false;

    // 核对 path、size、mtime 是否一致；还要求服务端内容哈希就是本次上传的内容，
    // 大小和时间相同的旧记录不能当作"已收到"（haierkeys/fast-note-sync-service#512）；
    // 服务端历史数据可能存秒级 mtime（#461），比较前归一化为毫秒
    // Besides path, size and mtime the server must hold the content just uploaded; an older
    // record with the same size and mtime does not prove the upload arrived
    // (haierkeys/fast-note-sync-service#512); legacy rows may hold second-scale mtime
    // (#461), normalize before comparing
    if (!(serverInfo.path === file.path &&
      serverInfo.size === file.stat.size &&
      normalizeServerTimestamp(serverInfo.mtime) === file.stat.mtime &&
      serverInfo.contentHash === contentHash)) {
      dump(`Cloud Preview: Auto delete skip, info mismatch for ${file.path}`, { server: serverInfo, local: file.stat });
      return false;
    }

    const size = file.stat.size;
    if (size <= 0 || size > MAX_VERIFIABLE_ATTACHMENT_BYTES) {
      dump(`Cloud Preview: Auto delete skip, unverifiable size for ${file.path}`, size);
      return false;
    }

    const eviction = plugin.cloudAttachmentEviction;
    if (!eviction) {
      dump(`Cloud Preview: Auto delete skip, eviction journal unavailable for ${file.path}`);
      return false;
    }

    if (plugin.app.vault.getFileByPath(file.path) !== file) return false;
    const mtime = file.stat.mtime;

    // 远端拉回失败 / 大小未知 / 哈希不一致：一律取消清理、保留本地文件
    // Remote read-back failure, unknown size or hash mismatch: cancel cleanup and keep the local file
    let remoteBytes: ArrayBuffer;
    try {
      remoteBytes = await apiService.getFileContentForVerification(file.path, size);
    } catch (error) {
      dump(`Cloud Preview: Auto delete skip, remote read-back failed for ${file.path}`, error);
      return false;
    }
    if (remoteBytes.byteLength !== size) {
      dump(`Cloud Preview: Auto delete skip, remote size mismatch for ${file.path}`, remoteBytes.byteLength);
      return false;
    }

    const localBytes = await plugin.app.vault.readBinary(file);
    if (localBytes.byteLength !== size || file.stat.mtime !== mtime || file.stat.size !== size) {
      dump(`Cloud Preview: Auto delete skip, local file changed during verification for ${file.path}`);
      return false;
    }
    if (plugin.app.vault.getFileByPath(file.path) !== file) return false;

    const [localSha256, remoteSha256] = await Promise.all([sha256Hex(localBytes), sha256Hex(remoteBytes)]);
    if (localSha256 !== remoteSha256) {
      dump(`Cloud Preview: Auto delete skip, full content hash mismatch for ${file.path}`);
      return false;
    }

    dump(`Cloud Preview: Auto delete verified file: ${file.path}`);
    plugin.addIgnoredFile(file.path);
    let recorded = false;
    try {
      // 先记账再清理：崩溃/重扫时扫描不会把这次设备本地清理当作离线删除
      // Journal first, then clean up: a crash/rescan cannot mistake this for an offline delete
      await eviction.record({ path: file.path, sha256: localSha256, size, evictedAt: Date.now() });
      recorded = true;
      await vaultDelete(plugin.app.vault, file);
      plugin.fileHashManager.removeFileHash(file.path);
      return true;
    } finally {
      // 移动失败（本地文件仍在）或后续步骤失败：撤销驱逐记录，避免它继续屏蔽真实的用户删除
      // Move failed (local file still exists) or a later step failed: roll the record back so it
      // cannot keep suppressing a genuine user deletion
      if (recorded && plugin.app.vault.getFileByPath(file.path)) {
        try {
          await eviction.remove(file.path);
        } catch (error) {
          dumpError(`Cloud Preview: failed to roll back eviction record for ${file.path}`, error);
        }
      }
      plugin.removeIgnoredFile(file.path);
    }
  } catch (error) {
    dump(`Cloud Preview: Auto delete failed to fetch info for ${file.path}`, error);
    return false;
  }
}

/**
 * 接收服务端文件上传指令 (FileUpload)
 */
export const receiveFileUpload = async function (data: FileUploadMessage, plugin: FastSync, outsideRound = false) {
  if (plugin.settings.syncEnabled == false) return

  // 只读门禁：本轮入口快照与实时设置取或（fail-closed），理由同笔记上传入口
  // Read-only gate: OR the round's entry snapshot with the live setting (fail-closed);
  // same reasoning as the note upload entry
  if (plugin.syncRoundReadonly || plugin.settings.readonlySyncEnabled) {
    dump(`Read-only mode: Intercepted file upload request for ${data.path}`)
    if (!outsideRound) plugin.recordSyncCompleted('file', data.pageIndex)
    return
  }
  if (isPathExcluded(data.path, plugin)) {
    if (!outsideRound) plugin.recordSyncCompleted('file', data.pageIndex)
    return
  }
  // 旧服务端可能复用已确认并移除的会话；只有相同会话 ID 才能直接完成，不能凭基线哈希跳过。
  // Older servers may reuse an acknowledged, removed session; skip only that session ID, never a baseline hash match.
  if (plugin.syncState.completedFileUploadSessions?.has(data.sessionId)) {
    dump(`File upload request targets an already acknowledged session, settled without re-upload: `, data.path, data.sessionId)
    if (!outsideRound) plugin.recordSyncCompleted('file', data.pageIndex)
    return
  }
  dump(`Receive file need upload (queued): `, data.path, data.sessionId)
  const previousSession = pathToSessionIdMap.get(data.path)
  // 同一会话仍在上传时只补登记页归属，由唯一的确认完成记账，不再启动第二路分片。
  // While the same session is uploading, attach page ownership and let its single Ack settle it without resending chunks.
  if (previousSession === data.sessionId) {
    dump(`File upload request duplicates the in-flight session, waiting for its Ack: `, data.path, data.sessionId)
    if (!outsideRound && data.pageIndex !== undefined) {
      plugin.syncState.pendingFilePushPageIndex.set(data.path, data.pageIndex)
    }
    return
  }
  if (previousSession) {
    plugin.concurrencyLimiter.cancelQueued?.(data.path)
    clearUploadTracking(data.path)
  }
  sessionIdToPathMap.set(data.sessionId, data.path)
  pathToSessionIdMap.set(data.path, data.sessionId)

  const file = plugin.app.vault.getFileByPath(normalizePath(data.path))
  if (!file) {
    clearUploadTracking(data.path)
    dump(`File not found for upload: ${data.path} `)
    if (!outsideRound) plugin.recordSyncCompleted('file', data.pageIndex)
    return
  }
  if (isLargeBinarySyncRisk(file.stat.size, plugin)) {
    clearUploadTracking(data.path)
    dump(`Skip file upload for large attachment (${describeBinarySyncLimit(plugin)} limit): ${data.path}`, file.stat.size)
    notifyLargeFileSkipped(plugin, data.path, file.stat.size, `Fast Note Sync skipped large file upload: ${data.path}`)
    if (!outsideRound) plugin.recordSyncCompleted('file', data.pageIndex)
    return
  }

  // NeedPush(FileUpload) 驱动的上传-回执往返：FileUploadAck 本身不带 pageIndex，按 path 记下所属页
  // 供 Ack 到达时查表归账（见 sync_state.ts pendingFilePushPageIndex 注释）
  // NeedPush(FileUpload)-driven upload/ack round trip: FileUploadAck carries no pageIndex; record
  // the owning page by path for the Ack to look up on arrival (see sync_state.ts
  // pendingFilePushPageIndex comment)
  if (!outsideRound && data.pageIndex !== undefined) {
    plugin.syncState.pendingFilePushPageIndex.set(data.path, data.pageIndex)
  }

  const chunkSize = data.chunkSize || 1024 * 1024
  const actualTotalChunks = file.stat.size === 0 ? 1 : Math.ceil(file.stat.size / chunkSize)

  // 始终在进入并发队列前就累加待上传分片总数，以精确驱动进度条
  if (!outsideRound) plugin.totalChunksToUpload += actualTotalChunks

  const runUpload = async () => {
    // 标记该路径进入活跃上传状态
    if (!await plugin.concurrencyLimiter.waitForSlot(data.path, false, 10)) {
      if (pathToSessionIdMap.get(data.path) === data.sessionId) clearUploadTracking(data.path)
      return;
    }
    if (pathToSessionIdMap.get(data.path) !== data.sessionId) return;
    const vaultName = plugin.app.vault.getName()
    const checkpointKey = `fns-${vaultName}-uploadSession-${data.pathHash}`
    const previousTimer = uploadAckTimers.get(data.path)
    if (previousTimer !== undefined) window.clearTimeout(previousTimer)
    uploadAckTimers.delete(data.path)
    const uploadState = { cancelled: false, checkpointKey };
    activeUploadsMap.set(data.path, uploadState);
    uploadContexts.set(data.path, outsideRound ? null : plugin.syncState.activeSyncContext);

    // 断点续传 checkpoint key，提升到 try 外以便 catch 块中也能清除
    // Resume checkpoint key hoisted outside try so the catch block can also remove it
    try {
      // 延迟到任务排到时才读取文件内容, 减少内存积压
      let content: ArrayBuffer | null = null;
      try {
        logMemorySnapshot(`before upload read ${data.path}`)
        content = await plugin.app.vault.readBinary(file)
      } catch (e) {
        dump(`Failed to read file for upload: ${data.path}`, e)
      }
      if (!content) {
        clearUploadTracking(data.path)
        if (!outsideRound) plugin.fileSyncTasks.failed++
        if (!outsideRound) plugin.totalChunksToUpload -= actualTotalChunks
        plugin.concurrencyLimiter.releaseSlot(data.path)
        if (!outsideRound) plugin.recordSyncCompleted('file', data.pageIndex)
        return;
      }

      const contentHash = await hashFileAsync(plugin.app, file.path)
      logMemorySnapshot(`after upload hash ${data.path}`)
      // 将 hash 暂存到 pending map，等待服务端 FileUploadAck 后再写入 hashManager
      // Temporarily store hash in pending map, update hashManager only after server FileUploadAck
      sentUploadContent.set(data.path, { hash: contentHash, mtime: file.stat.mtime, size: file.stat.size })
      plugin.pendingUploadHashes.set(data.path, contentHash)
      plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
      // 记录当前文件的 mtime/size 到缓存，以便后续利用。只写缓存：同步基线要等 FileUploadAck，
      // 否则上传中断后基线会声称服务端已有这份内容（haierkeys/fast-note-sync-service#512）
      // Cache only: the sync baseline waits for FileUploadAck, or an interrupted upload leaves a
      // baseline claiming the server already has this content
      plugin.fileHashManager.setFileHashes([[data.path, contentHash]], () => file.stat)

      // 使用外层计算好的 actualTotalChunks

      // 断点续传：从 localStorage 读取上次中断的 checkpoint
      // Resume upload: read checkpoint from localStorage for the last interrupted upload
      let startChunkIndex = 0
      try {
        const cpRaw = plugin.app.loadLocalStorage(checkpointKey) as string | undefined;
        if (cpRaw) {
          const cp = JSON.parse(cpRaw) as { sessionId?: string; lastChunkIndex?: number; contentHash?: string }
          if (cp.sessionId === data.sessionId &&
            cp.contentHash === contentHash &&
            typeof cp.lastChunkIndex === 'number' &&
            cp.lastChunkIndex >= 0 &&
            cp.lastChunkIndex < actualTotalChunks - 1) {
            startChunkIndex = cp.lastChunkIndex + 1
            dump(`Resume upload from chunk ${startChunkIndex}/${actualTotalChunks}: ${data.path}`)
          }
        }
      } catch (e) {
        dump(`Failed to read upload checkpoint for ${data.path}`, e)
      }

      // 如从断点恢复，则同步累加已上传计数以对齐进度
      if (startChunkIndex > 0) {
        if (!outsideRound) plugin.uploadedChunksCount += startChunkIndex
      }

      // 打印上传信息表格
      dump([
        {
          操作: "文件上传",
          路径: data.path,
          文件大小: `${(content.byteLength / 1024 / 1024).toFixed(2)} MB`,
          分片大小: `${(chunkSize / 1024).toFixed(0)} KB`,
          分片数量: actualTotalChunks,
          SessionID: data.sessionId.substring(0, 8) + "...",
        },
      ])

      const sleepTime = Platform.isMobile ? 10 : 2;

      for (let i = startChunkIndex; i < actualTotalChunks; i++) {
        const start = i * chunkSize
        const end = Math.min(start + chunkSize, content.byteLength)
        const length = end - start;

        // 使用 Uint8Array 视图代替 slice 拷贝，减少内存翻倍
        const chunk = new Uint8Array(content, start, length)

        const sessionIdBytes = new TextEncoder().encode(data.sessionId)
        const chunkIndexBytes = new Uint8Array(4)
        const view = new DataView(chunkIndexBytes.buffer)
        view.setUint32(0, i, false)

        const frame = new Uint8Array(36 + 4 + chunk.byteLength)
        frame.set(sessionIdBytes, 0)
        frame.set(chunkIndexBytes, 36)
        frame.set(chunk, 40)

        // 在 before 回调中检查是否已被取消,这样可以在数据真正进入 WebSocket 缓冲区之前拦截
        const sendResult = await plugin.websocket.SendBinary(
          frame,
          BINARY_PREFIX_FILE_SYNC,
          () => {
            // before: 检查是否已被取消(例如由于文件在上传过程中被删除)
            if (isPluginUnloading || uploadState.cancelled) {
              dump(`Upload aborted for ${data.path} (cancelled before send)`);
              return true; // 返回 true 表示应该取消发送
            }
            return false;
          },
          () => {
            // after: 发送成功后更新计数和日志
            if (!outsideRound) plugin.uploadedChunksCount++
            const currentProgress = Math.floor(((i + 1) / actualTotalChunks) * 100);
            const isLastChunk = (i + 1) === actualTotalChunks;

            // 更新断点续传 checkpoint（发送成功后，非最后一块）
            // Update resume checkpoint after successful send (not the last chunk)
            if (!isLastChunk) {
              try {
                plugin.app.saveLocalStorage(checkpointKey, JSON.stringify({
                  sessionId: data.sessionId,
                  lastChunkIndex: i,
                  contentHash: contentHash,
                  timestamp: Date.now(),
                }))
              } catch (e) {
                dump(`Failed to save upload checkpoint for ${data.path}`, e)
              }
            }

            // 更新日志进度
            SyncLogManager.getInstance().addOrUpdateLog({
              id: data.sessionId,
              type: 'send',
              action: 'FileUpload',
              path: data.path,
              status: isLastChunk ? 'success' : 'pending',
              progress: currentProgress
            });
          }
        )

        // 连接不可用：分片未真正发出，立即中断循环，保留断点续传 checkpoint（不清除、不标记完成任务数），
        // 等重连后由后续同步轮次从 checkpoint 处续传，避免"分片假成功"（空转跑完循环但数据未真正传完）
        // Connection unavailable: the chunk was never actually sent. Break immediately and keep the
        // resume checkpoint intact (don't clear it, don't bump the completed counter) so the next
        // sync round can resume from the checkpoint after reconnect.
        if (sendResult === 'closed') {
          clearUploadTracking(data.path)
          dump(`Upload interrupted for ${data.path} at chunk ${i}/${actualTotalChunks} (connection closed), will resume after reconnect`);
          SyncLogManager.getInstance().addOrUpdateLog({
            id: data.sessionId,
            type: 'send',
            action: 'FileUpload',
            path: data.path,
            status: 'pending',
            message: '连接已断开，等待重连后续传'
          });
          plugin.concurrencyLimiter.releaseSlot(data.path);
          return;
        }

        // 每真正发出一个分片就续期，避免大文件上传被名额清扫误判为无人归还
        // Refresh on every chunk actually sent so a long upload is not swept as abandoned
        plugin.concurrencyLimiter.touch(data.path);

        // 如果被取消,立即退出循环并释放槽位
        if (uploadState.cancelled) {
          // Deletion/recovery settled the old task. A delayed send callback may
          // have written its checkpoint after cleanup; clear it unless a newer
          // session for this path now owns that checkpoint.
          const currentSessionId = pathToSessionIdMap.get(data.path)
          if (!currentSessionId || currentSessionId === data.sessionId) {
            try { plugin.app.saveLocalStorage(checkpointKey, null) } catch { /* ignore */ }
          }
          return; // The cancellation owner already released or replaced this slot.
        }
        if (sendResult === 'cancelled' || isPluginUnloading) {
          clearUploadTracking(data.path)
          // 取消时清除 checkpoint，避免使用已失效的会话
          // Clear checkpoint on cancel to avoid stale session reuse
          try { plugin.app.saveLocalStorage(checkpointKey, null) } catch { /* ignore */ }
          plugin.concurrencyLimiter.releaseSlot(data.path)
          if (!outsideRound) plugin.recordSyncCompleted('file', data.pageIndex)
          return;
        }

        // 让出主线程，手机端给更多呼吸时间
        await sleep(sleepTime)
      }

      // 手动置空辅助 GC
      content = null;
      if (!uploadState.cancelled && sessionIdToPathMap.has(data.sessionId)) armUploadAckTimeout(data.path, plugin);

      // 上传完成后，如果开启了附件云预览 - 上传后删除，则在完整校验与记账后清理本地附件
      // After upload, "cloud preview — delete local" removes the local attachment only after
      // full content verification and the eviction record is persisted
      if (plugin.settings.cloudPreviewEnabled && plugin.settings.cloudPreviewAutoDeleteLocal) {
        void maybeAutoDeleteUploadedAttachment(plugin, file, contentHash);
      }
    } catch (e) {
      dump(`Upload process error for ${data.path}`, e);
      // 异常退出时清除 checkpoint，避免下次用无效的 sessionId 继续
      try { plugin.app.saveLocalStorage(checkpointKey, null) } catch { /* ignore */ }
      clearUploadTracking(data.path)
      if (!outsideRound) plugin.fileSyncTasks.failed++
      if (!outsideRound) plugin.totalChunksToUpload -= actualTotalChunks
      plugin.concurrencyLimiter.releaseSlot(data.path);
      if (!outsideRound) plugin.recordSyncCompleted('file', data.pageIndex)
    } finally {
      // 任务结束（完成或取消/失败），移除活跃标记
      // Keep the session mapping until ACK/error, which arrives after the send loop.
      if (activeUploadsMap.get(data.path) === uploadState) activeUploadsMap.delete(data.path);
    }
  }

  // 任务立即执行，受外部 ConcurrencyLimiter 控制
  void runUpload()
}

/**
 * 接收服务端文件更新通知 (FileSyncUpdate)
 */
export const receiveFileSyncUpdate = async function (data: ReceiveFileSyncUpdateMessage, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return

  // 服务端推送说明该路径已有新内容，清除可能残留的 deleteAck pending 防止 Ack 删除新 hash
  // Server push means path has new content; clear stale deleteAck pending to protect newly-written hash
  plugin.pendingFileDeleteAcks.delete(data.path)
  if (isPathExcluded(data.path, plugin)) {
    plugin.recordSyncCompleted('file', data.pageIndex);
    return
  }
  if (isLargeBinarySyncRisk(data.size, plugin)) {
    dump(`Skip file download for large attachment (${describeBinarySyncLimit(plugin)} limit): ${data.path}`, data.size)
    notifyLargeFileSkipped(plugin, data.path, data.size, `Fast Note Sync skipped large file download: ${data.path}`)
    plugin.recordSyncCompleted('file', data.pageIndex);
    return
  }

  // 按需预览从首次同步起生效，不能依赖首次同步已经成功完成。
  if (plugin.settings.cloudPreviewEnabled) {
    if (plugin.settings.cloudPreviewTypeRestricted) {
      // 开启了类型限制：仅跳过受限类型 (图片、视频、音频、PDF)
      const ext = data.path.substring(data.path.lastIndexOf(".")).toLowerCase();
      if (FileCloudPreview.isRestrictedType(ext)) {
        dump(`Cloud Preview: Skipping restricted file download: ${data.path}`);
        plugin.recordSyncCompleted('file', data.pageIndex);
        return;
      }
    } else {
      // 未开启类型限制：由于启用了云预览，跳过所有附件下载
      dump(`Cloud Preview: Skipping all file downloads: ${data.path}`);
      plugin.recordSyncCompleted('file', data.pageIndex);
      return;
    }
  }

  // 等待并发槽位，防止大量并发下载导致内存耗尽
  const slotKey = `download_${data.path}`
  if (!await plugin.concurrencyLimiter.waitForSlot(slotKey, false, -10)) return;

  try {
    // 等待并发槽位时用户可能开启云预览，旧排队任务也必须遵守当前设置。
    if (plugin.settings.cloudPreviewEnabled && (!plugin.settings.cloudPreviewTypeRestricted ||
      FileCloudPreview.isRestrictedType(data.path.substring(data.path.lastIndexOf(".")).toLowerCase()))) {
      plugin.concurrencyLimiter.releaseSlot(slotKey);
      plugin.recordSyncCompleted('file', data.pageIndex);
      return;
    }
    // 下载内存缓冲控制：如果当前内存中待写盘的分块过多，由于下载是异步触发的，此处等待
    while (currentDownloadBufferBytes > MAX_DOWNLOAD_BUFFER_BYTES) {
      await sleep(200);
    }

    dump(`Receive file sync update(download): `, data.path)
    const tempKey = `temp_${data.path}`
    // 服务端历史数据可能存秒级 mtime/ctime（#461），落盘/比较前先归一化为毫秒
    // Legacy server rows may hold second-scale mtime/ctime (#461); normalize to milliseconds
    const tempSession: FileDownloadSession = {
      commitGuard: captureDownloadGuard(plugin, data.path),
      path: data.path,
      contentHash: data.contentHash,
      revision: data.revision,
      ctime: normalizeServerTimestamp(data.ctime),
      mtime: normalizeServerTimestamp(data.mtime),
      lastTime: data.lastTime,
      sessionId: "",
      totalChunks: 0,
      size: data.size,
      pageIndex: data.pageIndex,
      initialSlotKey: slotKey,
      lastActivityAt: Date.now(),
      ...createDownloadStorage(plugin, `init_${data.pathHash}`, data.size),
    }
    plugin.fileDownloadSessions.set(tempKey, tempSession)

    const requestData = {
      vault: plugin.settings.vault,
      path: data.path,
      pathHash: data.pathHash,
    }
    void plugin.websocket.SendMessage("FileChunkDownload", requestData)
    plugin.totalFilesToDownload++
    // lastFileSyncTime advances when the download commits, so a failed download stays eligible.
  } catch (e) {
    plugin.concurrencyLimiter.releaseSlot(slotKey)
    throw e;
  }
}

/**
 * 接收服务端文件删除通知
 */
export const receiveFileSyncDelete = async function (data: ReceivePathMessage, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return

  if (isPathExcluded(data.path, plugin)) {
    plugin.recordSyncCompleted('file', data.pageIndex);
    return
  }

  // Cloud preview only avoids downloading attachments. A server deletion must still remove a
  // local copy; skipping it left deleted attachments on the device to be uploaded again.

  dump(`Receive file delete: `, data.path)
  const normalizedPath = normalizePath(data.path)
  let keptLocal: TFile | null = null

  await plugin.lockManager.withLock(normalizedPath, async () => {
    const file = plugin.app.vault.getFileByPath(normalizedPath)
    if (file instanceof TFile) {
      if (blockAliasedRemoteMutation(plugin, file, data.path, "FileDelete")) return
      // 本地有未同步的改动时不执行远端删除：保留本地并重新上传（#277）。只读端以服务端为准，照常删除；
      // 超大附件不读内容，统计信息与已同步记录不符即视为有改动
      // Unsynced local edits win over a remote delete: keep the file and upload it again (#277).
      // A read-only device still deletes; large attachments are not read, a stat mismatch counts as changed
      // 轮次内接收逻辑：快照与实时设置 fail-closed 取或；轮次外快照为 false，退化为实时设置
      // In-round receive logic: fail-closed snapshot-OR-live; outside a round the snapshot is
      // false and the live setting decides
      if (!(plugin.syncRoundReadonly || plugin.settings.readonlySyncEnabled)) {
        const baseHash = plugin.fileHashManager.getPathHash(normalizedPath)
        let changed = plugin.pendingUploadHashes.has(normalizedPath)
        if (!changed && baseHash !== null) {
          let localHash = plugin.fileHashManager.getValidHash(normalizedPath, file.stat.mtime, file.stat.size)
          if (localHash === null && !isLargeBinarySyncRisk(file.stat.size, plugin)) localHash = await hashFileAsync(plugin.app, normalizedPath)
          changed = localHash !== baseHash
        }
        // 无同步基线：服务端从未确认过这份内容，不能按远端删除处理。本连接内首次：保留并重新上传；
        // 已重传过：只保留（haierkeys/fast-note-sync-service#514 #391）
        // No sync baseline: the server never confirmed this content, so a remote delete must not remove
        // it. First time on this connection: keep and upload again; already re-uploaded: keep only
        if (!changed && baseHash === null) {
          if (!firstKeepWithoutBaseline(plugin, normalizedPath)) {
            SyncLogManager.getInstance().addLog('receive', 'FileDeleteConflict', `本地文件尚未同步且已重新上传，等待服务端确认，保留本地: ${normalizedPath}`, 'cancelled', data.path)
            return
          }
          changed = true
        }
        if (changed) {
          SyncLogManager.getInstance().addLog('receive', 'FileDeleteConflict', `本地存在未同步的改动，保留本地并重新上传: ${normalizedPath}`, 'cancelled', data.path)
          keptLocal = file
          return
        }
      }
      plugin.addIgnoredFile(normalizedPath)
      // 记录待删除路径
      plugin.lastSyncPathDeleted.add(normalizedPath)
      try {
        await plugin.app.fileManager.trashFile(file)
        // 服务端推送删除,从哈希表中移除
        plugin.fileHashManager.removeFileHash(normalizedPath)
        plugin.lastSyncMtime.delete(normalizedPath)
        // 更新同步时间
        advanceLiveSyncTime(plugin, "lastFileSyncTime", data.lastTime)
      } finally {
        // 延时 500ms 清理
        window.setTimeout(() => {
          plugin.removeIgnoredFile(normalizedPath)
          plugin.lastSyncPathDeleted.delete(normalizedPath)
        }, 500);
      }
    }
  }, { maxRetries: 5, retryInterval: 100 }).then(locked => {
    // 抢锁失败时任务未执行：按失败处理，不能计为完成
    // Lock not acquired means the task never ran: count it as a failure, never as completed
    if (locked === null) throw new Error("Path lock busy")
  }).catch(e => {
    dumpError(`[FastSync] Failed to receiveFileSyncDelete: ${normalizedPath}`, e);
    SyncLogManager.getInstance().addLog('receive', 'FileDelete', e instanceof Error ? e.message : String(e), 'error', data.path);
    plugin.fileSyncTasks.failed++
  });

  plugin.recordSyncCompleted('file', data.pageIndex)
  if (keptLocal) void fileModify(keptLocal, plugin)
}

/**
 * 接收服务端文件元数据(mtime)更新通知
 */
export const receiveFileSyncMtime = async function (data: ReceiveMtimeMessage, plugin: FastSync, outsideRound = false) {
  if (plugin.settings.syncEnabled == false) return
  const pendingPage = outsideRound ? undefined : plugin.syncState.pendingFilePushPageIndex.get(data.path)
  const completionPage = pendingPage ?? data.pageIndex
  clearUploadTracking(data.path)
  uploadContexts.delete(data.path)
  uploadRetries.delete(data.path)
  if (!outsideRound) plugin.syncState.pendingFilePushPageIndex.delete(data.path)
  plugin.concurrencyLimiter.releaseSlot(data.path)

  if (isPathExcluded(data.path, plugin)) {
    if (!outsideRound) plugin.recordSyncCompleted('file', completionPage);
    return
  }

  // Cloud preview does not skip mtime updates: the handler only touches files that already
  // exist locally, and skipping left their mtime stale so every round re-checked them.

  // 服务端历史数据可能存秒级 mtime/ctime（#461），落盘/比较前先归一化为毫秒
  // Legacy server rows may hold second-scale mtime/ctime (#461); normalize to milliseconds
  const mtime = normalizeServerTimestamp(data.mtime)
  const ctime = normalizeServerTimestamp(data.ctime)
  dump(`Receive file sync mtime: `, data.path, mtime)
  const normalizedPath = normalizePath(data.path)

  await plugin.lockManager.withLock(normalizedPath, async () => {
    const file = plugin.app.vault.getFileByPath(normalizedPath)
    if (file) {
      if (isLargeBinarySyncRisk(file.stat.size, plugin)) {
        dump(`Skip binary mtime rewrite for large attachment (${describeBinarySyncLimit(plugin)} limit): ${normalizedPath}`, file.stat.size)
        plugin.lastSyncMtime.set(data.path, mtime || 0)
        if (!outsideRound) advanceLiveSyncTime(plugin, "lastFileSyncTime", data.lastTime)
        return
      }
      const content = await plugin.app.vault.readBinary(file)
      // 内容一致确认：本地仍是消息内容时才建立可信基线（设计稿 §5.2 第 3 条）
      // Content-equality confirmation: only when the local bytes are still the message content
      const msgHash = typeof data.contentHash === "string" && data.contentHash !== "" ? data.contentHash : "";
      const revision = typeof data.revision === "string" && data.revision !== "" ? data.revision : "";
      const confirmable = msgHash !== "" && revision !== ""
        && (typeof plugin.fileHashManager.setConfirmedBaseline !== "function"
          || (await hashArrayBuffer(content)) === msgHash)
        && typeof plugin.fileHashManager.setConfirmedBaseline === "function"
      plugin.addIgnoredFile(normalizedPath)
      try {
        await plugin.app.vault.modifyBinary(file, content, { ...(ctime > 0 && { ctime }), ...(mtime > 0 && { mtime }) })
        if (confirmable) {
          plugin.fileHashManager.setConfirmedBaseline?.(data.path, msgHash, revision, mtime || 0, file.stat.size)
        }
        const pendingHash = plugin.pendingUploadHashes.get(data.path)
        if (pendingHash !== undefined) {
          plugin.fileHashManager.setFileHash(data.path, pendingHash, mtime || 0, file.stat.size)
          plugin.pendingUploadHashes.delete(data.path)
          plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
        }
        // 记录 mtime
        plugin.lastSyncMtime.set(data.path, mtime || 0)
        // 更新同步时间
        if (!outsideRound) advanceLiveSyncTime(plugin, "lastFileSyncTime", data.lastTime)
      } finally {
        window.setTimeout(() => {
          plugin.removeIgnoredFile(normalizedPath)
        }, 500);
      }
    }
  }, { maxRetries: 5, retryInterval: 100 }).then(locked => {
    // 抢锁失败时任务未执行：按失败处理，不能计为完成
    // Lock not acquired means the task never ran: count it as a failure, never as completed
    if (locked === null) throw new Error("Path lock busy")
  }).catch(e => {
    dumpError(`[FastSync] Failed to receiveFileSyncMtime: ${normalizedPath}`, e);
    if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'FileMtime')) {
      SyncLogManager.getInstance().addLog('receive', 'FileMtime', e instanceof Error ? e.message : String(e), 'error', data.path);
    }
    if (!outsideRound) plugin.fileSyncTasks.failed++
  });

  // FileSyncMtime 表示文件已在服务端存在（无需上传），释放 fileModify 中获取的并发槽位
  // FileSyncMtime indicates file already exists on server (no upload needed), release slot acquired by fileModify
  if (data.path) plugin.concurrencyLimiter.releaseSlot(data.path)
  if (!outsideRound) plugin.recordSyncCompleted('file', completionPage)
}

/**
 * 接收服务端分片下载响应 (FileSyncChunkDownload)
 */
export const receiveFileSyncChunkDownload = async function (data: FileSyncChunkDownloadMessage, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return

  dump(`Receive file chunk download: `, data.path, data.sessionId, `totalChunks: ${data.totalChunks}`)

  // 打印下载信息 (Print download info)
  dump(
    "文件下载",
    {
      路径: data.path,
      文件大小: `${(data.size / 1024 / 1024).toFixed(2)} MB`,
      分片大小: `${(data.chunkSize / 1024).toFixed(0)} KB`,
      分片数量: data.totalChunks,
      SessionID: data.sessionId.substring(0, 8) + "...",
    }
  )

  const tempKey = `temp_${data.path}`
  const tempSession = plugin.fileDownloadSessions.get(tempKey)
  // A reply without a pending request (e.g. one sent before a reconnect) must not write to disk.
  // The reply's metadata describes the server's current version and is used as is.
  if (!tempSession) {
    dump(`Ignore unsolicited file chunk download reply: ${data.path}`)
    return
  }
  // 服务端历史数据可能存秒级 mtime/ctime（#461），落盘/比较前先归一化为毫秒
  // Legacy server rows may hold second-scale mtime/ctime (#461); normalize to milliseconds
  const session: FileDownloadSession = {
    commitGuard: tempSession.commitGuard,
    path: data.path,
    contentHash: data.contentHash,
    // 就绪消息可能不带 revision（旧服务端/服务端未下发就绪字段）；Protobuf 映射在字段缺省时
    // 会给出空串而不是 undefined，所以这里按空值回退，沿用 FileSyncUpdate 建临时会话时拿到的
    // 令牌，否则下载完成后会退化成只写哈希、建不起已确认基线。
    // The ready message may omit revision (legacy server / field only added later). Protobuf
    // mapping yields an empty string instead of undefined for a missing field, so treat empty as
    // absent and keep the token captured from FileSyncUpdate; otherwise the commit degrades to a
    // plain hash with no confirmed baseline.
    revision: data.revision || tempSession.revision,
    ctime: normalizeServerTimestamp(data.ctime),
    mtime: normalizeServerTimestamp(data.mtime),
    lastTime: tempSession.lastTime,
    sessionId: data.sessionId,
    totalChunks: data.totalChunks,
    size: data.size,
    pageIndex: tempSession.pageIndex,
    initialSlotKey: tempSession.initialSlotKey,
    lastActivityAt: Date.now(),
    ...createDownloadStorage(plugin, data.sessionId, data.size),
  }
  plugin.fileDownloadSessions.set(data.sessionId, session)
  plugin.fileDownloadSessions.delete(tempKey)

  // 确保临时目录存在 (Ensure temp directory exists)
  // 并发下多个下载会话可能同时 mkdir 同一目录而抛错：catch 后复验是否已存在（并发创建属正常，吞掉）；
  // 真正未创建成功则不在此处兜底，交给首个分片写入时的既有失败路径处理（handleFileChunkDownload 的内存 fallback / failFileDownloadSession）
  if (data.totalChunks > 0 && session.tempDir) {
    const baseDir = getTempChunksDir(plugin)
    try {
      if (!(await plugin.app.vault.adapter.exists(baseDir))) {
        await plugin.app.vault.adapter.mkdir(baseDir)
      }
      if (!(await plugin.app.vault.adapter.exists(session.tempDir))) {
        await plugin.app.vault.adapter.mkdir(session.tempDir)
      }
    } catch (e) {
      if (!(await plugin.app.vault.adapter.exists(session.tempDir))) {
        dumpError(`Temp dir creation failed for session ${session.sessionId}, will retry on first chunk`, e)
      }
    }
  }

  // 仅在非同步期间(实时监听时)手动增加分片计数。同步期间由 SyncEnd 包装器统一预估
  if (!plugin.isSyncing) {
    plugin.totalChunksToDownload += data.totalChunks
  }

  // 创建初始日志记录
  const isTotalChunksZero = data.totalChunks === 0
  SyncLogManager.getInstance().addOrUpdateLog({
    id: data.sessionId,
    type: 'receive',
    action: 'FileDownload',
    path: data.path,
    status: isTotalChunksZero ? 'success' : 'pending',
    progress: isTotalChunksZero ? 100 : 0
  });

  // 如果分片数为 0（空文件），立即触发完成逻辑1
  if (data.totalChunks === 0) {
    const finalSession = plugin.fileDownloadSessions.get(data.sessionId);
    if (finalSession) {
      await handleFileChunkDownloadComplete(finalSession, plugin);
    }
  }
}



/**
 * 接收文件同步结束通知
 */
export const receiveFileSyncEnd = async function (data: unknown, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return
  dump(`Receive file sync end:`, data)

  const syncData = data as SyncEndData
  // 更新任务统计信息，用于进度条计算 (Update task stats for progress bar)
  plugin.fileSyncTasks.needUpload = syncData.needUploadCount || 0
  plugin.fileSyncTasks.needModify = syncData.needModifyCount || 0
  plugin.fileSyncTasks.needSyncMtime = syncData.needSyncMtimeCount || 0
  plugin.fileSyncTasks.needDelete = syncData.needDeleteCount || 0

  // End 先于明细到达：暂存 lastTime，待本类型全部完成且无失败时由 settleSyncTimes 落盘
  // End arrives before the details: stash lastTime; settleSyncTimes persists it once the type finished without failures
  plugin.syncState.pendingSyncEndTime.set("lastFileSyncTime", syncData.lastTime)
  plugin.syncTypeCompleteCount++
}

/**
 * 检查并上传附件 (用于开启云预览后的首次同步后)
 */
export const checkAndUploadAttachments = async function (plugin: FastSync) {
  if (!plugin.settings.cloudPreviewEnabled || plugin.settings.readonlySyncEnabled) return;

  const apiService = new HttpApiService(plugin);
  const files = plugin.app.vault.getFiles();

  dump(`Cloud Preview: Start checking ${files.length} files for server status...`);

  let checkedCount = 0;
  let uploadCount = 0;

  for (const file of files) {
    if (file.extension === "md") continue;
    if (isPathExcluded(file.path, plugin)) continue;

    checkedCount++;
    try {
      const res = await apiService.getFileInfo(file.path);

      // 如果没有数据，说明服务端不存在
      if (!res) {
        dump(`Cloud Preview: File missing on server, starting upload: ${file.path}`);
        await fileModify(file, plugin, false);
        uploadCount++;
      } else if (file.stat.mtime > (normalizeServerTimestamp(res.mtime) ?? 0)) {
        // 服务端已有但本地更新：云预览附件不参与常规扫描，离线期间的修改只能在这里补传。
        // 是否真有改动由 fileModify 判断，内容与同步基线一致（只是 mtime 变了，#256）不会上传；
        // 服务端历史数据可能存秒级 mtime（#461），比较前归一化为毫秒
        // The server has it but the local copy is newer: cloud preview attachments skip the regular
        // scan, so an edit made while offline can only be uploaded here. fileModify decides whether
        // anything changed; content equal to the sync baseline (mtime only, #256) is not uploaded;
        // legacy server rows may hold second-scale mtime (#461), normalize before comparing
        dump(`Cloud Preview: Local copy newer than server, checking upload: ${file.path}`);
        await fileModify(file, plugin, false);
        uploadCount++;
      }
    } catch (e) {
      dump(`Cloud Preview: Failed to check file status for ${file.path}`, e);
    }

    // 适当延迟，避免接口频率过高
    if (checkedCount % 10 === 0) {
      await sleep(50);
    }
  }

  dump(`Cloud Preview: Check complete. Total attachment files: ${checkedCount}, Uploaded: ${uploadCount}`);
}

/**
 * 处理接收到的二进制文件分片
 */
export const handleFileChunkDownload = async function (buf: ArrayBuffer | Blob, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false || isPluginUnloading) return

  const binaryData = buf instanceof Blob ? await buf.arrayBuffer() : buf
  if (binaryData.byteLength < 40 || isPluginUnloading) {
    dump(`File chunk download dropped: invalid payload length ${binaryData.byteLength}`)
    return
  }

  const sessionIdBytes = new Uint8Array(binaryData, 0, 36)
  const sessionId = new TextDecoder().decode(sessionIdBytes)
  const chunkIndexBytes = new Uint8Array(binaryData, 36, 4)
  const view = new DataView(chunkIndexBytes.buffer, chunkIndexBytes.byteOffset, 4)
  const chunkIndex = view.getUint32(0, false)
  const chunkData = binaryData.slice(40)

  const session = plugin.fileDownloadSessions.get(sessionId)
  if (!session) {
    const message = `File download chunk dropped: session not found (${sessionId}), chunk ${chunkIndex}`
    dumpError(message)
    SyncLogManager.getInstance().addOrUpdateLog({
      id: sessionId,
      type: 'receive',
      action: 'FileDownload',
      status: 'error',
      progress: 0,
      message
    });
    return
  }
  session.lastActivityAt = Date.now()
  // 每收到一个分片就为下载名额续期（下载会话本身也由 isBusy 排除，双保险）
  // Refresh the download slot on every received chunk (download sessions are also kept busy)
  plugin.concurrencyLimiter.touch(session.initialSlotKey || `download_${session.path}`)

  try {
    if (chunkIndex >= session.totalChunks) {
      await failFileDownloadSession(plugin, session, `Invalid chunk index ${chunkIndex}, total chunks ${session.totalChunks}`)
      return
    }

    let isNewChunk = false

    if (session.tempDir) {
      try {
        if (!(await plugin.app.vault.adapter.exists(session.tempDir))) {
          const baseDir = getTempChunksDir(plugin)
          try {
            if (!(await plugin.app.vault.adapter.exists(baseDir))) {
              await plugin.app.vault.adapter.mkdir(baseDir)
            }
            await plugin.app.vault.adapter.mkdir(session.tempDir)
          } catch (mkdirErr) {
            // 并发下多个分片会话可能同时 mkdir 同一目录：复验已存在则吞掉；
            // 仍不存在说明是真实创建失败，交给外层 catch 走既有失败路径（内存 fallback / failFileDownloadSession）
            if (!(await plugin.app.vault.adapter.exists(session.tempDir))) {
              throw mkdirErr
            }
          }
        }
        const chunkPath = normalizePath(`${session.tempDir}/${chunkIndex}.bin`)
        isNewChunk = !session.downloadedChunks?.has(chunkIndex)
        await plugin.app.vault.adapter.writeBinary(chunkPath, chunkData)
        session.downloadedChunks?.add(chunkIndex)
      } catch (e) {
        if (session.size <= MAX_DOWNLOAD_BUFFER_BYTES) {
          dumpError(`File chunk temp write failed, fallback to memory: ${session.path} chunk ${chunkIndex}`, e)
          isNewChunk = await fallbackFileDownloadSessionToMemory(plugin, session, chunkIndex, chunkData)
        } else {
          await failFileDownloadSession(plugin, session, `Failed to write temp chunk ${chunkIndex}: ${formatDownloadError(e)}`)
          return
        }
      }
    } else {
      isNewChunk = storeMemoryChunk(session, chunkIndex, chunkData)
    }

    if (isNewChunk) {
      plugin.downloadedChunksCount++
    }

    // 更新日志进度
    const completedCount = getCompletedDownloadChunks(session)
    SyncLogManager.getInstance().addOrUpdateLog({
      id: sessionId,
      type: 'receive',
      action: 'FileDownload',
      path: session.path,
      status: completedCount === session.totalChunks ? 'success' : 'pending',
      progress: session.totalChunks === 0 ? 100 : Math.floor((completedCount / session.totalChunks) * 100)
    });


    if (completedCount === session.totalChunks && !session.committing) {
      await handleFileChunkDownloadComplete(session, plugin)
    }
  } catch (e) {
    await failFileDownloadSession(plugin, session, `Failed to receive chunk ${chunkIndex}: ${formatDownloadError(e)}`)
  }
}

/**
 * 接收服务端文件重命名通知
 */
export const receiveFileSyncRename = async function (data: { oldPath: string; path: string; mtime?: number; ctime?: number; contentHash?: string; lastTime?: number; size?: number; pathHash?: string; pageIndex?: number; revision?: string }, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return

    if (isPathExcluded(data.path, plugin) || isPathExcluded(data.oldPath, plugin)) {
    plugin.recordSyncCompleted('file', data.pageIndex);
    return
  }

  dump(`Receive file rename:`, data.oldPath, "->", data.path)

  // 服务端历史数据可能存秒级 mtime/ctime（#461），落盘/比较前先归一化为毫秒
  // Legacy server rows may hold second-scale mtime/ctime (#461); normalize to milliseconds
  const mtime = normalizeServerTimestamp(data.mtime)
  const ctime = normalizeServerTimestamp(data.ctime)

  const normalizedOldPath = normalizePath(data.oldPath)
  const normalizedNewPath = normalizePath(data.path)

  // Check if there is an active file download session for this old path
  // 检查本地是否存在该旧路径的活跃下载会话
  let downloadingSession: FileDownloadSession | undefined
  for (const sess of plugin.fileDownloadSessions.values()) {
    if (normalizePath(sess.path) === normalizedOldPath) {
      downloadingSession = sess
      break
    }
  }

  if (downloadingSession) {
    dump(`Redirecting active file download session: ${downloadingSession.path} -> ${data.path}`)
    downloadingSession.path = data.path
    if (data.contentHash) {
      downloadingSession.contentHash = data.contentHash
    }
    // Session redirected, bypass the rename execution and skip RePush
    // 会话已成功重定向，直接跳过重命名执行和 RePush
    plugin.recordSyncCompleted('file', data.pageIndex)
    return
  }

  await plugin.lockManager.withLock(normalizedNewPath, async () => {
    const file = plugin.app.vault.getFileByPath(normalizedOldPath)
    if (file instanceof TFile) {
      if (blockAliasedRemoteMutation(plugin, file, data.oldPath, "FileRename")) return
      if (blockAliasedRemoteMutation(plugin, plugin.app.vault.getFileByPath(normalizedNewPath), data.path, "FileRename")) return
      plugin.addIgnoredFile(normalizedNewPath)
      plugin.addIgnoredFile(normalizedOldPath)

      // 记录新路径
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

        const targetFile = plugin.app.vault.getFileByPath(normalizedNewPath)
        if (targetFile && targetFile !== file) {
          await plugin.app.fileManager.trashFile(targetFile)
        }

        await plugin.app.vault.rename(file, normalizedNewPath)

        if (mtime) {
          const renamedFile = plugin.app.vault.getFileByPath(normalizedNewPath)
          if (renamedFile instanceof TFile) {
            if (isLargeBinarySyncRisk(renamedFile.stat.size, plugin)) {
              dump(`Skip renamed binary mtime rewrite for large attachment (${describeBinarySyncLimit(plugin)} limit): ${normalizedNewPath}`, renamedFile.stat.size)
            } else {
              const content = await plugin.app.vault.readBinary(renamedFile)
              await plugin.app.vault.modifyBinary(renamedFile, content, { ...((ctime ?? 0) > 0 && { ctime }), ...((mtime ?? 0) > 0 && { mtime }) })
            }
          }
        }

        plugin.fileHashManager.removeFileHash(data.oldPath)
        const renamedFile = plugin.app.vault.getFileByPath(normalizedNewPath)
        plugin.fileHashManager.setFileHash(data.path, data.contentHash || "", renamedFile instanceof TFile ? renamedFile.stat.mtime : 0, renamedFile instanceof TFile ? renamedFile.stat.size : 0)

        // 更新同步时间
        advanceLiveSyncTime(plugin, "lastFileSyncTime", data.lastTime)
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
        const sizeMatch = data.size === undefined || targetFile.stat.size === data.size
        if (sizeMatch) {
          if (isLargeBinarySyncRisk(targetFile.stat.size, plugin)) {
            dump(`Skip rename target hash for large attachment (${describeBinarySyncLimit(plugin)} limit): ${data.path}`, targetFile.stat.size)
            plugin.recordSyncCompleted('file', data.pageIndex)
            return
          }
          const localContentHash = await hashFileAsync(plugin.app, targetFile.path)
          if (localContentHash === data.contentHash) {
            dump(`Target attachment already exists and matches hash, skipping rename: ${data.path}`)
            plugin.fileHashManager.setFileHash(data.path, data.contentHash, targetFile.stat.mtime, targetFile.stat.size)
            plugin.recordSyncCompleted('file', data.pageIndex)
            return
          }
        }
      }

      dump(`Local attachment not found for rename, requesting RePush: ${data.oldPath} -> ${data.path}`)
      const rePushData = {
        vault: plugin.settings.vault,
        path: data.path,
        pathHash: data.pathHash,
      }
      void plugin.websocket.SendMessage("FileRePush", rePushData)
      if (data.contentHash) {
        const targetFile = plugin.app.vault.getFileByPath(normalizePath(data.path))
        plugin.fileHashManager.setFileHash(data.path, data.contentHash, targetFile instanceof TFile ? targetFile.stat.mtime : 0, targetFile instanceof TFile ? targetFile.stat.size : 0)
      }
    }
  }, { maxRetries: 10, retryInterval: 100 }).then(locked => {
    // 抢锁失败时任务未执行：按失败处理，不能计为完成
    // Lock not acquired means the task never ran: count it as a failure, never as completed
    if (locked === null) throw new Error("Path lock busy")
  }).catch(e => {
    dumpError(`[FastSync] Failed to receiveFileSyncRename: ${normalizedOldPath} -> ${normalizedNewPath}`, e);
    if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'FileRename')) {
      SyncLogManager.getInstance().addLog('receive', 'FileRename', e instanceof Error ? e.message : String(e), 'error', data.path);
    }
    plugin.fileSyncTasks.failed++
  });

  plugin.recordSyncCompleted('file', data.pageIndex)
}

/**
 * 完成文件下载
 */
const handleFileChunkDownloadComplete = async function (session: FileDownloadSession, plugin: FastSync) {
  const slotKey = session.initialSlotKey || `download_${session.path}`;
  session.committing = true
  try {
    if (isLargeBinarySyncRisk(session.size, plugin)) {
      dump(`Skip assembling large downloaded attachment (${describeBinarySyncLimit(plugin)} limit): ${session.path}`, session.size)
      await cleanupFileDownloadSession(plugin, session)
      return
    }
    // 逐片读入后立即写入目标缓冲区并释放分片引用，避免 chunks 数组与整份 buffer 同时驻留内存 (2x 峰值)
    // Write each chunk into the target buffer as it is read, then drop the reference immediately,
    // instead of accumulating a chunks array alongside the full assembled buffer (avoids the 2x peak).
    // let 而非 const：服务端元数据陈旧时会把它替换为按实际字节数截断后的缓冲区（见下方 size mismatch 分支）
    // let instead of const: replaced with a truncated-to-actual-bytes buffer when the server metadata
    // is stale (see the size mismatch branch below).
    let completeFile = new Uint8Array(session.size)
    let offset = 0
    for (let i = 0; i < session.totalChunks; i++) {
      let chunk: ArrayBuffer | undefined;
      if (session.tempDir) {
        const chunkPath = normalizePath(`${session.tempDir}/${i}.bin`)
        if (await plugin.app.vault.adapter.exists(chunkPath)) {
          chunk = await plugin.app.vault.adapter.readBinary(chunkPath)
        }
      } else {
        chunk = session.chunks?.get(i)
      }

      if (!chunk) {
        await failFileDownloadSession(plugin, session, `Missing downloaded chunk ${i}`, false)
        return
      }
      if (offset + chunk.byteLength > completeFile.byteLength) {
        await failFileDownloadSession(plugin, session, `Downloaded file size mismatch: exceeds expected ${session.size}`, false)
        return
      }
      completeFile.set(new Uint8Array(chunk), offset)
      offset += chunk.byteLength
    }

    if (offset !== session.size) {
      // 服务端 size 元数据可能陈旧：此时服务端下发的字节就是真实内容，而 session.size /
      // session.contentHash 仍是旧值（实测两个字段同时陈旧）。若无条件按截断失败，
      // 客户端会在每一轮完整同步重复同一次下载，pending 永远无法收敛。
      //
      // 判据：把已组装的字节与本地已有文件用同一种哈希比较 —— 相等说明不是传输截断，
      // 而是服务端元数据陈旧，此时接受实际字节；不相等仍走原有失败分支，
      // 因此真正的传输截断不会被掩盖。
      //
      // The server's size metadata can be stale: the bytes it just sent are the real content,
      // while session.size / session.contentHash still hold the old values (observed together).
      // Failing unconditionally makes the client retry the same download on every full sync
      // round, so pending never converges.
      //
      // Criterion: hash the assembled bytes and the local existing file with the same function.
      // Equal means this is not a truncated transfer but stale server metadata, so the actual
      // bytes are accepted; otherwise the original failure branch runs, so genuine truncation
      // is still caught.
      let staleServerMetadata = false
      try {
        const localHash = await hashFileAsync(plugin.app, normalizePath(session.path))
        const receivedHash = await hashArrayBuffer(completeFile.buffer.slice(0, offset))
        staleServerMetadata = !!localHash && localHash !== "0" && localHash === receivedHash
      } catch {
        staleServerMetadata = false
      }
      if (!staleServerMetadata) {
        await failFileDownloadSession(plugin, session, `Downloaded file size mismatch: got ${offset}, expected ${session.size}`, false)
        return
      }
      dump(`Stale server metadata, accepting actual bytes: ${session.path} declared=${session.size} actual=${offset}`)
      // 缓冲区按实际字节数截断，避免写文件时把声明长度带来的尾部补零一起写进去
      // Truncate the buffer to the actual byte count so trailing zero-fill implied by the
      // declared size is never written out.
      completeFile = new Uint8Array(completeFile.buffer.slice(0, offset))
      session.size = offset
    }

    const normalizedPath = normalizePath(session.path)
    const committed = await plugin.lockManager.withLock(normalizedPath, async () => {
      assertDownloadCommittable(plugin, session)
      plugin.addIgnoredFile(normalizedPath)
      try {
        const file = plugin.app.vault.getFileByPath(normalizedPath)
        if (file) {
          await plugin.app.vault.modifyBinary(file, completeFile.buffer, { ...(session.ctime > 0 && { ctime: session.ctime }), ...(session.mtime > 0 && { mtime: session.mtime }) })
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
          // Folder creation yields; a local create or cancellation may have won meanwhile.
          assertDownloadCommittable(plugin, session)
          await plugin.app.vault.createBinary(normalizedPath, completeFile.buffer, { ...(session.ctime > 0 && { ctime: session.ctime }), ...(session.mtime > 0 && { mtime: session.mtime }) })
        }
      } finally {
        window.setTimeout(() => {
          plugin.removeIgnoredFile(normalizedPath)
        }, 500);
      }

      advanceLiveSyncTime(plugin, "lastFileSyncTime", session.lastTime)

      // 下载完成后自动计算哈希并更新缓存 (如果服务器传了内容哈希就直接使用，否则重新计算以兼容旧版本)
      let contentHash = session.contentHash
      if (!contentHash) {
        contentHash = await hashArrayBuffer(completeFile.buffer)
        dump(`Download complete: server missing hash, local calculated: ${session.path}`, contentHash)
      } else {
        dump(`Download complete: using server provided hash: ${session.path}`, contentHash)
      }
      if (session.revision && plugin.fileHashManager.setConfirmedBaseline) {
        plugin.fileHashManager.setConfirmedBaseline(session.path, contentHash, session.revision, session.mtime, session.size)
      } else {
        plugin.fileHashManager.setFileHash(session.path, contentHash, session.mtime, session.size)
      }
      // 记录同步后的 mtime
      plugin.lastSyncMtime.set(session.path, session.mtime)
      dump(`Download complete and hash updated for: ${session.path}`, contentHash)
      return true
    }, { maxRetries: 5, retryInterval: 100 });
    // 抢锁失败时任务未执行，文件未写入：按失败处理，不能计为完成
    // Lock not acquired means nothing was written: treat as a failure, never as completed
    if (!committed) throw new Error("Download not committed: path lock busy")

    // 释放内存计数
    releaseSessionMemory(session)

    plugin.fileDownloadSessions.delete(session.sessionId)
    if (session.tempDir) await clearTempChunksDir(plugin, session.sessionId)
    releaseDownloadOwner(plugin, session)
    plugin.downloadedFilesCount++
    plugin.recordSyncCompleted('file', session.pageIndex)
  } catch (e) {
    dumpError(`Error completing file download for ${session.path}`, e)
    if (!checkAndNotifyCaseConflict(e, session.path, plugin, 'FileDownload')) {
      SyncLogManager.getInstance().addOrUpdateLog({
        id: session.sessionId,
        type: 'receive',
        action: 'FileDownload',
        path: session.path,
        status: 'error',
        progress: session.totalChunks === 0 ? 0 : Math.floor((getCompletedDownloadChunks(session) / session.totalChunks) * 100),
        message: `Failed to complete download: ${formatDownloadError(e)}`
      });
    }
    await cleanupFileDownloadSession(plugin, session, true)
  } finally {
    if (!isStaleDownload(plugin, session)) plugin.concurrencyLimiter.releaseSlot(slotKey)
  }
}

// 收到 FileRenameAck，按 data.path（服务端下发的新路径）精确匹配待确认条目并更新 hashManager；
// 老服务端不下发 path 时回退 FIFO；匹配不到时不误删队列其它项，仅记日志（haierkeys/fast-note-sync-service#312）
// Receive FileRenameAck, match the pending entry precisely by data.path (the new path the server
// echoes) and update hashManager; falls back to FIFO for legacy servers that omit path; a miss
// never removes another entry, it just logs (haierkeys/fast-note-sync-service#312)
export const receiveFileRenameAck = function (data: { lastTime?: number; path?: string }, plugin: FastSync) {
  const ackPath = data.path || plugin.pendingFileRenames[0]?.newPath
  const retryAck = plugin.retryQueue?.matchesAck("FileRenameAck", ackPath) ?? false
  let pending: { oldPath: string; newPath: string; contentHash: string } | undefined
  if (data.path) {
    const index = plugin.pendingFileRenames.findIndex(entry => entry.newPath === data.path)
    if (index !== -1) {
      pending = plugin.pendingFileRenames[index]
      plugin.pendingFileRenames.splice(index, 1)
    } else {
      dump(`FileRenameAck: no pending rename matches path ${data.path}, leaving the queue intact`)
    }
  } else {
    // 老服务端未下发 path，回退 FIFO 出队
    // Legacy server omits path, fall back to FIFO dequeue
    pending = plugin.pendingFileRenames.shift()
  }
  if (pending) {
    plugin.fileHashManager.setFileHash(pending.newPath, pending.contentHash, 0, 0, false)
    plugin.fileHashManager.removeFileHash(pending.oldPath)
  }
  if (!retryAck) advanceLiveSyncTime(plugin, "lastFileSyncTime", data.lastTime)
  dump(`FileRenameAck: lastFileSyncTime updated to`, data.lastTime)
  if (pending) plugin.concurrencyLimiter.releaseSlot(pending.newPath)
  if (retryAck && pending) plugin.retryQueue.acknowledge("FileRenameAck", ackPath)
}

// 收到 FileUploadAck，将 pending hash 转移到正式 hashManager 并更新 lastFileSyncTime
// Receive FileUploadAck, move pending hash to formal hashManager and update lastFileSyncTime
export const receiveFileUploadAck = async function (data: { lastTime?: number; path?: string; pathHash?: string; contentHash?: string; revision?: string }, plugin: FastSync, outsideRound = false) {
  // 服务端确认上传成功，将 pending hash 转移到正式 hashManager
  // Server confirmed upload success, move pending hash to formal hashManager
  if (data.path) {
    const sent = sentUploadContent.get(data.path)
    if (sent && ambiguousUploadAcks.has(data.path)) {
      // A path-only ACK after recovery may belong to the expired upload. Existing HTTP
      // metadata on legacy servers can establish which content actually reached storage.
      try {
        const remote = await new HttpApiService(plugin).getFileInfo(data.path)
        if (sentUploadContent.get(data.path) !== sent || remote?.contentHash !== sent.hash) return
      } catch { return } // Keep the pending upload and its bounded recovery timer.
      ambiguousUploadAcks.delete(data.path)
    }
    // 清理映射前记住已确认会话，供随后到达的分页上传请求去重；按插入顺序淘汰最早项。
    // Remember the acknowledged session before clearing mappings for later paged requests; evict oldest entries first.
    const sessionId = pathToSessionIdMap.get(data.path)
    if (sessionId && !ambiguousUploadAcks.has(data.path)) {
      const completedSessions = plugin.syncState.completedFileUploadSessions ??= new Set<string>()
      completedSessions.add(sessionId)
      if (completedSessions.size > 5000) {
        const [oldestSession] = completedSessions
        completedSessions.delete(oldestSession)
      }
    }
    clearUploadTracking(data.path)
    uploadRetries.delete(data.path)
    uploadContexts.delete(data.path)
    if (sent && !ambiguousUploadAcks.has(data.path)) {
      // 基线模式：只确认发送时的快照哈希 + 服务端 revision；上传途中被继续编辑时，
      // 当前磁盘内容绝不标为已同步，并立即安排携带新基线的后续上传（设计稿 §5.2）
      // Baseline mode: confirm only the sent snapshot hash + the server revision. If the file was
      // edited during the upload, never mark the current bytes as synced; schedule a follow-up
      // upload carrying the new baseline.
      const ackHash = typeof data.contentHash === "string" && data.contentHash !== "" ? data.contentHash : sent.hash
      const revision = typeof data.revision === "string" ? data.revision : ""
      const baselineMode = plugin.isSyncBaselineModeEnabled?.() === true
      if (baselineMode && plugin.fileHashManager.setConfirmedBaseline) {
        let diskHash: string | null = null
        try { diskHash = await hashFileAsync(plugin.app, normalizePath(data.path)) } catch { diskHash = null }
        plugin.fileHashManager.setConfirmedBaseline(data.path, ackHash, revision, sent.mtime, sent.size, diskHash === ackHash)
        if (plugin.pendingUploadHashes.get(data.path) === ackHash) {
          plugin.pendingUploadHashes.delete(data.path)
          plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
        }
        if (diskHash !== null && diskHash !== ackHash) {
          dump(`[Baseline] File Ack confirmed ${ackHash}, disk changed to ${diskHash}; scheduling follow-up upload`, data.path)
          plugin.pendingUploadHashes.set(data.path, diskHash)
          plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
          window.setTimeout(() => {
            const current = plugin.app.vault.getFileByPath(normalizePath(data.path as string))
            if (current) void fileModify(current, plugin, false, true)
          }, 0)
        }
      } else {
        // Cache the stat captured with the sent content, never today's edited file stat.
        plugin.fileHashManager.setFileHash(data.path, sent.hash, sent.mtime, sent.size)
        if (plugin.pendingUploadHashes.get(data.path) === sent.hash) {
          plugin.pendingUploadHashes.delete(data.path)
          plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
        }
      }
    }
    sentUploadContent.delete(data.path)
  }
  // 上传完成，清除断点续传 checkpoint
  // Upload complete, clear resume checkpoint
  if (data.pathHash) {
    const vaultName = plugin.app.vault.getName()
    try { plugin.app.saveLocalStorage(`fns-${vaultName}-uploadSession-${data.pathHash}`, null) } catch { /* ignore */ }
  }
  if (!outsideRound) advanceLiveSyncTime(plugin, "lastFileSyncTime", data.lastTime)
  dump(`FileUploadAck: lastFileSyncTime updated to`, data.lastTime)
  if (data.path) {
    plugin.concurrencyLimiter.releaseSlot(data.path)
  }
  // 本轮按路径等待的页必须消费确认，即使该确认来自空闲请求；轮外且无等待页时仍不记账。
  // Settle the round's pending page by path even for an idle-request Ack; outside-round misses still do not count.
  const pushPageIndex = data.path ? plugin.syncState.pendingFilePushPageIndex.get(data.path) : undefined;
  if (outsideRound && pushPageIndex === undefined) return
  if (data.path) plugin.syncState.pendingFilePushPageIndex.delete(data.path)
  plugin.recordSyncCompleted('file', pushPageIndex)
}

// 收到 FileDeleteAck，仅当路径仍在 pending set 中时才从 hashManager 移除
// Receive FileDeleteAck; only remove from hashManager if path is still pending
export const receiveFileDeleteAck = function (data: { lastTime?: number; path?: string }, plugin: FastSync) {
  const retryAck = plugin.retryQueue?.matchesAck("FileDeleteAck", data.path) ?? false
  if (data.path) {
    // 删除已确认：清除待删基线记录
    // Delete confirmed: drop the pre-delete baseline record
    plugin.fileHashManager.clearPendingDeleteBaseline?.(data.path)
  }
  if (data.path && plugin.pendingFileDeleteAcks.has(data.path)) {
    plugin.fileHashManager.removeFileHash(data.path)
    plugin.pendingFileDeleteAcks.delete(data.path)
  }
  if (!retryAck) advanceLiveSyncTime(plugin, "lastFileSyncTime", data.lastTime)
  if (data.path) {
    plugin.concurrencyLimiter.releaseSlot(data.path)
  }
  if (retryAck) plugin.retryQueue.acknowledge("FileDeleteAck", data.path)
}

/**
 * 收到服务端 463 错误（上传附件会话不存在），清理该文件的活跃上传状态并增加完成计数
 */
export const receiveFileUploadSessionNotFound = function (sessionId: string, plugin: FastSync) {
  const path = sessionIdToPathMap.get(sessionId)
  if (path) recoverUpload(path, plugin)
}
