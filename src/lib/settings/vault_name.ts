/**
 * 切换「远端笔记库名」时的旧库状态清理。
 * Clearing the previous remote vault's sync ownership when the user switches
 * the remote note-vault name.
 *
 * 关键点：哈希管理器的 `syncHashMap` 是“服务端确认过的基线”。切库后若不清空，
 * 连接一个全新的空库时，本地笔记会带着旧库的基线去比对——服务端没有这些条目，
 * 于是被判定为 `server_missing`（服务端缺少该条目），整库笔记与附件被塞进
 * `conflict-notes/` 并暂停上传。必须在连接新库之前把旧库的全部同步归属状态清干净。
 *
 * The hash managers' `syncHashMap` holds server-confirmed baselines. If it survives a
 * vault switch, a fresh empty vault looks like "server lost every file" and locally
 * existing notes/attachments are reported as `server_missing` conflicts. Every piece of
 * the old vault's sync ownership must be dropped before connecting to the new vault.
 */

interface VaultScopedStorage {
  clearSyncTime(): void
  clearPending?(field: "pendingNoteModifies" | "pendingUploadHashes" | "pendingConfigModifies"): void
  setMetadata?(field: "lastSyncSuccessTime", value: unknown): void
}

interface VaultScopedHashManager {
  clearAll(): void
  flush?(): void
}

interface VaultScopedRetryQueue {
  clear?(): void
}

interface VaultScopedEvictionJournal {
  /** 当前远端作用域指纹 / Current remote-scope fingerprint */
  currentScope?(): string
  /** 按作用域清理本地驱逐记录 / Clear device-local eviction records for a scope */
  clearScope?(scope?: string): void | Promise<void>
}

interface VaultScopedSyncState {
  conflictedPaths?: Set<string>
  newConflictedPathsThisRound?: Set<string>
  newUnalignedPathsThisRound?: Set<string>
  conflictCountsThisRound?: Map<string, number>
  pendingNotePushPageIndex?: Map<string, number>
  pendingFilePushPageIndex?: Map<string, number>
  pendingConfigPushPageIndex?: Map<string, number>
  completedFileUploadSessions?: Set<string>
}

export interface VaultNameSettingsOwner {
  settings: { vault: string }
  wsSettingChange: boolean
  localStorageManager: VaultScopedStorage
  saveAndReloadServices(): Promise<void>
  fileHashManager?: VaultScopedHashManager
  configHashManager?: VaultScopedHashManager
  folderSnapshotManager?: VaultScopedHashManager
  retryQueue?: VaultScopedRetryQueue
  /** 设备本地「云附件已驱逐」日志 / Device-local cloud-attachment eviction journal */
  cloudAttachmentEviction?: VaultScopedEvictionJournal
  syncState?: VaultScopedSyncState
  pendingNoteModifies?: Map<string, string>
  pendingUploadHashes?: Map<string, string>
  pendingConfigModifies?: Map<string, string>
  pendingNoteDeleteAcks?: Set<string>
  pendingFileDeleteAcks?: Set<string>
  pendingConfigDeleteAcks?: Set<string>
  /** 待确认的重命名（Map / Set / 数组形态都只是待确认记录，清空即可） */
  /** Pending renames (Map, Set or array — all are just pending records to drop) */
  pendingNoteRenames?: ClearableCollection
  pendingFileRenames?: ClearableCollection
  /** 删除旧库遗留的冲突备份（插件目录 conflict-notes/）/ Drop old conflict backups */
  clearVaultConflictBackups?(): void | Promise<void>
}

type ClearableCollection = { clear?(): void; length?: number; splice?(start: number, deleteCount: number): unknown[] }

/** 清空 Map / Set / 数组三种形态的待确认记录 */
function clearCollection(collection: ClearableCollection | undefined): void {
  if (!collection) return
  if (typeof collection.clear === "function") {
    collection.clear()
    return
  }
  if (typeof collection.length === "number" && typeof collection.splice === "function" && collection.length > 0) {
    collection.splice(0, collection.length)
  }
}

/**
 * 彻底清空旧库的全部同步归属状态：
 * syncHashMap / fileHashMap / folderSnapshot / fileBaselineState / folderBaselineState /
 * configHashMap / syncState（时间戳与 isInitSync）/ retryQueue / 待处理冲突与在途上传。
 *
 * Drop all sync state owned by the previous remote vault: syncHashMap / fileHashMap /
 * folderSnapshot / fileBaselineState / folderBaselineState / configHashMap / syncState
 * timestamps and isInitSync / retryQueue / pending conflicts and in-flight uploads.
 */
export async function clearVaultScopedSyncState(plugin: VaultNameSettingsOwner): Promise<void> {
  const storage = plugin.localStorageManager

  // 顺序很重要：先清哈希/快照/重试队列，再清同步时间——clearSyncTime 会顺带把
  // syncState.json 镜像落盘，必须让这次快照看到的是已清空的基线指纹。
  // Order matters: clear hashes/snapshot/queue first, then the sync times — clearSyncTime
  // also flushes the syncState.json mirror, which must snapshot the already-cleared digests.
  plugin.fileHashManager?.clearAll()
  plugin.fileHashManager?.flush?.()
  plugin.configHashManager?.clearAll()
  plugin.configHashManager?.flush?.()
  plugin.folderSnapshotManager?.clearAll()
  plugin.folderSnapshotManager?.flush?.()
  // 删除/改名重试队列（旧库路径）
  plugin.retryQueue?.clear?.()

  // 时间戳、isInitSync=false、持久化冲突路径；同步落盘 syncState 镜像
  storage.clearSyncTime()
  // 上次成功时间也属于旧库：留着会让新库的首轮被当成“刚同步过”，离线保护误判
  // The last-success time belongs to the old vault too; keeping it makes the new vault's
  // first round look "already synced" and misleads the offline guard
  storage.setMetadata?.("lastSyncSuccessTime", 0)
  // 崩溃恢复用的在途上传记录也属于旧库，不能带到新库
  storage.clearPending?.("pendingNoteModifies")
  storage.clearPending?.("pendingUploadHashes")
  storage.clearPending?.("pendingConfigModifies")

  // 内存中的在途状态
  plugin.pendingNoteModifies?.clear()
  plugin.pendingUploadHashes?.clear()
  plugin.pendingConfigModifies?.clear()
  plugin.pendingNoteDeleteAcks?.clear()
  plugin.pendingFileDeleteAcks?.clear()
  plugin.pendingConfigDeleteAcks?.clear()
  // 笔记的重命名待确认是 Map，附件的是数组：两种形态都清空
  // Pending note renames are a Map, pending file renames an array: empty both shapes
  clearCollection(plugin.pendingNoteRenames)
  clearCollection(plugin.pendingFileRenames)

  const state = plugin.syncState
  state?.conflictedPaths?.clear()
  state?.newConflictedPathsThisRound?.clear()
  state?.newUnalignedPathsThisRound?.clear()
  state?.conflictCountsThisRound?.clear()
  state?.pendingNotePushPageIndex?.clear()
  state?.pendingFilePushPageIndex?.clear()
  state?.pendingConfigPushPageIndex?.clear()
  state?.completedFileUploadSessions?.clear()

  // 旧库遗留的冲突/待对齐备份文件
  await plugin.clearVaultConflictBackups?.()

  // 旧库的设备本地驱逐记录：按作用域清理，绝不把旧库附件状态带到新库
  // Device-local eviction records of the old vault: clear by scope, never carry them into a new vault
  await plugin.cloudAttachmentEviction?.clearScope?.()
}

export async function updateVaultName(plugin: VaultNameSettingsOwner, value: string): Promise<void> {
  if (value === plugin.settings.vault) return

  // 切库前先记下旧作用域，用于清理该库的设备本地驱逐记录
  // Capture the old scope before switching so its eviction records can be cleared
  const previousEvictionScope = plugin.cloudAttachmentEviction?.currentScope?.()
  plugin.wsSettingChange = true
  plugin.settings.vault = value
  // 先清干净旧库状态，再重连；新库会走一次干净的首次同步，本地笔记与附件直接上传
  if (previousEvictionScope) await plugin.cloudAttachmentEviction?.clearScope?.(previousEvictionScope)
  await clearVaultScopedSyncState(plugin)
  await plugin.saveAndReloadServices()
}
