import type { FileDownloadSession } from "../utils/types";

export type SyncTimeField = "lastNoteSyncTime" | "lastFileSyncTime" | "lastConfigSyncTime" | "lastFolderSyncTime";

/**
 * 单条消息/单条 Ack 的游标统一推进入口（service#101 止损，替代各处理器里散落的
 * `if (data.lastTime > 当前值) setMetadata(...)`）：
 * - 轮次进行中（isSyncing 或 activeSyncContext 非空）不落盘：收尾由 settleSyncTimes 统一
 *   提交本轮 End 时间（服务端查询开始时刻），期间任何单条落盘都会在中途崩溃时留下越过
 *   未拉取条目的游标（settleSyncTimes 的回滚只在走到 onClose/cancelSync 时生效）；
 * - 本连接尚未正常完成过一轮同步不落盘：离线增量还没对齐，实时广播/编辑 Ack 把游标推到
 *   "现在"会掩盖整段离线变更（#101：点同步也拉不回，服务端只查 updated_timestamp >= 游标）；
 * - 其余情况（空闲在线、已完成首轮）且处理本身成功时才单调递增推进——避免重启后把刚
 *   处理过的实时变更再拉一遍。
 * Unified cursor-advance entry for single messages and single Acks (service#101 guard,
 * replacing the scattered `if (data.lastTime > current) setMetadata(...)` in handlers):
 * - Never persist while a round is active (isSyncing or activeSyncContext): settlement is
 *   owned by settleSyncTimes with the round's End time (the server's query start); any
 *   per-item persist mid-round survives a crash and leaves a cursor past un-pulled items
 *   (settleSyncTimes' rollback only runs when onClose/cancelSync is reached);
 * - Never persist before this connection completed one clean round: the offline backlog
 *   is unaligned, and a live broadcast / edit Ack pushing the cursor to "now" hides the
 *   whole offline window (#101: even a manual sync can't pull it back — the server only
 *   queries updated_timestamp >= cursor);
 * - Otherwise (idle online, first round done) advance monotonically after the handler
 *   itself succeeded — avoids re-pulling just-handled live changes after a restart.
 */
export function advanceLiveSyncTime(plugin: { isSyncing?: boolean; localStorageManager: { getMetadata(k: string): unknown; setMetadata(k: string, v: unknown): void }; syncState: { activeSyncContext: string | null; hasSyncedThisConnection: boolean } }, field: SyncTimeField, lastTime: number | undefined): void {
  if (!lastTime) return;
  if (plugin.isSyncing || plugin.syncState.activeSyncContext !== null) return;
  if (!plugin.syncState.hasSyncedThisConnection) return;
  if (lastTime > Number(plugin.localStorageManager.getMetadata(field))) {
    plugin.localStorageManager.setMetadata(field, lastTime);
  }
}

/**
 * Stats for a single sync type (notes / files / configs / folders).
 * 单类同步任务的统计数据（笔记 / 文件 / 配置 / 文件夹）。
 */
export interface SyncTaskStats {
  needUpload: number;   // 需要上传 / Need to upload
  needModify: number;   // 需要修改 / Need to modify
  needSyncMtime: number; // 需要同步时间戳 / Need to sync mtime
  needDelete: number;   // 需要删除 / Need to delete
  completed: number;    // 已处理数量（含成功与失败，驱动完成判定/翻页 ACK，语义不变） / Processed count (success + failure; drives completion detection / page ACK, semantics unchanged)
  failed: number;       // 其中处理失败的数量，仅用于统计展示，不参与完成判定 / Subset that failed; stats-only, does not affect completion detection
}

/**
 * Centralised container for all runtime sync-session state.
 * Eliminates the need to scatter 30+ fields across the FastSync plugin class.
 *
 * 集中管理同步会话的运行时状态，避免在 FastSync 插件类中散落 30+ 个字段。
 */
export class SyncState {
  /** 发生冲突且等待手动解决的笔记路径集合，用于在解决前抑制重复上传和弹窗 / Paths with pending conflict resolution */
  public conflictedPaths: Set<string> = new Set();
  /** 本轮同步中新捕获到的需要手动解决的冲突路径集合，用以在同步结束时判定是否弹出冲突列表框 / New conflicted paths detected in this round */
  public newConflictedPathsThisRound: Set<string> = new Set();
  /**
   * 本轮因“本地有内容但无任何可信基线”而进入待对齐的路径，用于同步结束时合并提示一次。
   * Paths queued for alignment this round because local content had no trusted baseline;
   * used to show one aggregated notice when the round completes.
   */
  public newUnalignedPathsThisRound: Set<string> = new Set();
  /**
   * 本轮已持久化的基线冲突数（按类型）。SyncConflict 既可能作为分页条目到达，
   * 也可能由条件写 530 拒绝返回；两者都必须计入本轮冲突提示，不能混入上传成功计数。
   * Baseline conflicts persisted this round by type. A SyncConflict may arrive as a paged item
   * or as a 530 rejection of a conditional write; both must count toward the round's conflict
   * notice and never toward upload success.
   */
  public conflictCountsThisRound: Map<"note" | "file" | "setting" | "folder", number> = new Map();

  // ─── Chunk size settings from server ─────────────────────────────────────────
  /** 上传分片数量 / Upload chunk size from server */
  syncUpChunkNum = 100;
  /** 下载分片数量 / Download chunk size from server */
  syncDownChunkNum = 50;
  /** 上行流水线窗口（协商值），0 = stop-and-wait（默认关闭，等 auth 协商块覆盖） / Upload pipeline window (negotiated), 0 = stop-and-wait */
  pipelineWindowUp = 0;
  /** 下行流水线窗口（协商值），0 = stop-and-wait（默认关闭，等 auth 协商块覆盖） / Download pipeline window (negotiated), 0 = stop-and-wait */
  pipelineWindowDown = 0;
  /** 本次连接是否已完成 pv2 协商（auth 响应携带协商块）/ Whether this connection completed pv2 negotiation (auth response carried a negotiation block) */
  negotiated = false;

  // ─── 同步基线能力协商（设计稿 §2.1，阶段 C 只建闸门）─────────────────────────
  /**
   * 服务端在鉴权应答里广告的最高基线版本（缺省 0）。它只是能力广告，不能据此启用新模式。
   * Highest baseline version advertised in the auth reply (0 when absent). This is only an
   * advertisement and must never switch this connection to the new mode by itself.
   */
  serverAdvertisedBaselineVersion = 0;
  /**
   * 本连接经 ClientInfo 应答确认的基线版本：0 = 兼容模式，>=1 = 基线模式。
   * 每次新建连接/断线都重置为 0；后台版本广播不得修改它。
   * Baseline version confirmed for this connection via the ClientInfo reply: 0 = compatibility
   * mode, >=1 = baseline mode. Reset to 0 on every new connection / disconnect; background
   * version broadcasts must never change it.
   */
  negotiatedSyncBaselineVersion = 0;
  /**
   * 本连接是否已完成一次 ClientInfo 应答确认。未确认前闸门阻塞（服务端广告 >=1 时）。
   * Whether this connection completed one ClientInfo reply confirmation. The gate blocks until
   * then when the server advertises >= 1.
   */
  clientInfoConfirmed = false;
  /** 客户端请求的基线版本（阶段 C 固定为 1）/ Baseline version requested by the client (fixed at 1 in stage C) */
  requestedSyncBaselineVersion = 1;

  /**
   * 重置连接级基线协商状态。新建连接与断线都必须调用，避免上一条连接的结论泄漏。
   * Resets connection-level baseline negotiation state. Must be called on every new connection
   * and disconnect so the previous connection's verdict cannot leak.
   */
  resetSyncBaselineNegotiation(): void {
    this.serverAdvertisedBaselineVersion = 0;
    this.negotiatedSyncBaselineVersion = 0;
    this.clientInfoConfirmed = false;
  }

  /**
   * 记录鉴权应答广告（仅能力广告）/ Records the auth-reply advertisement (advertisement only).
   */
  applyServerBaselineAdvertisement(advertised: unknown): void {
    this.serverAdvertisedBaselineVersion = typeof advertised === "number" && advertised > 0
      ? Math.floor(advertised) : 0;
  }

  /**
   * 记录 ClientInfo 应答确认结果并关闭闸门。缺省（老服务端）视为 0，立即进入兼容模式。
   * Records the ClientInfo reply verdict and opens the gate. An absent value (old server) means
   * 0 and enters compatibility mode immediately.
   */
  confirmSyncBaseline(accepted: unknown): void {
    const value = typeof accepted === "number" && accepted > 0 ? Math.floor(accepted) : 0;
    this.negotiatedSyncBaselineVersion = value;
    this.clientInfoConfirmed = true;
  }

  /**
   * 基线模式是否启用（协商成功且版本 >= 1）。
   * Whether baseline mode is active (negotiation succeeded and version >= 1).
   */
  isSyncBaselineModeEnabled(): boolean {
    return this.clientInfoConfirmed && this.negotiatedSyncBaselineVersion >= 1;
  }

  /**
   * 闸门：服务端广告 >= 1 但本连接尚未确认时，不得开始同步或实时写。
   * 老服务端广告 0 时立即放行，不阻塞兼容模式。
   * Gate: when the server advertises >= 1 but this connection is not yet confirmed, sync and
   * live writes must not start. A server advertising 0 lets the client through immediately.
   */
  isSyncBaselineGateOpen(): boolean {
    return this.serverAdvertisedBaselineVersion < 1 || this.clientInfoConfirmed;
  }

  // ─── C3 多页在途归属：completed 计数的 pageIndex 透传通道 ─────────────────────
  /**
   * 瞬时字段：FastSync.recordSyncCompleted() 在自增 xxxSyncTasks.completed 前写入，
   * 由 onCompletedChange（同一同步调用栈内触发，无 await 间隙）读取后立即清空，
   * 用于把 pageIndex 从调用点"смuggle"到 Proxy 的 set trap 回调里，无需改动 Proxy 签名。
   * Transient field: FastSync.recordSyncCompleted() writes it right before incrementing
   * xxxSyncTasks.completed; onCompletedChange (fired synchronously in the same call stack, no
   * await in between) reads and clears it immediately. Smuggles pageIndex from the call site into
   * the Proxy's set-trap callback without changing the Proxy's signature.
   */
  pendingCompletionPageIndex: number | undefined = undefined;

  /**
   * NeedPush 驱动的上传-回执往返（NoteSyncNeedPush/FileUpload/SettingSyncNeedUpload → 对应 Ack）
   * 中，Ack 消息本身不携带 pageIndex（它是响应客户端自己发起的上传请求，不是服务端下行页推送）。
   * 在 NeedPush 明细到达时按 path 记下其所属 pageIndex，等对应 Ack 到达时查表消费，
   * 从而把该条目的完成正确归账到发起它的下载页（供 ack 水位线正确推进）。
   * 查不到（本地用户自发编辑触发的 Ack，非服务端 NeedPush 驱动）时退回不带 pageIndex 的旧路径，
   * 语义正确（这类条目本就不属于任何页）。
   *
   * In the NeedPush-driven upload/ack round trip, the Ack message itself carries no pageIndex (it
   * responds to the client's own upload request, not a server-side page push). Record the
   * originating pageIndex by path when the NeedPush detail arrives; consume it when the matching
   * Ack arrives, so the completion is attributed to the correct download page (needed for the ack
   * watermark to advance correctly). A miss (Ack from a local user-initiated edit, not server
   * NeedPush) correctly falls back to the pageIndex-less legacy path — such items never belonged to
   * a page in the first place.
   */
  pendingNotePushPageIndex = new Map<string, number>();
  // 文件页归属只在轮次边界清空；即使 Ack 来自空闲请求，也须按路径消费本轮等待项。
  // File page ownership is cleared at round boundaries; even idle-request Acks must settle pending paths.
  pendingFilePushPageIndex = new Map<string, number>();
  pendingConfigPushPageIndex = new Map<string, number>();

  // 首次上传确认时按需创建，最多保留 5000 个会话，并在文件页归属清空时一并清空。
  // Created on the first upload Ack, capped at 5000 sessions and cleared with file page ownership.
  completedFileUploadSessions?: Set<string>;

  // ─── Sync-session control flags ──────────────────────────────────────────────
  /** 是否正在执行同步流程 / Whether sync process is running */
  isSyncing = false;
  /** 是否正在发起同步请求 / Whether sync request is being initiated */
  isSyncRequesting = false;
  /**
   * 本轮由空闲连接兜底触发：抑制开始/完成提示，保持静默（服务端 #503）。
   * This round was triggered by the idle fallback: suppress start/completion notices
   * so it stays silent (server #503).
   */
  silentSync = false;
  /** 是否为首次同步 / Whether this is the first sync */
  isFirstSync = false;
  /** 是否正在等待清理确认以便后续同步 / Whether waiting for clear-sync confirmation */
  isWaitClearSync = false;
  /**
   * 本连接是否已至少正常完成过一轮同步（service#101 游标止损）。
   * 连接鉴权成功与断线时置 false；checkSyncCompletion 判定一轮正常完成（无失败、未被离线
   * 保护拦截）时置 true。轮次未参与的类型不算未完成：advanceLiveSyncTime 只推进当前处理
   * 类型自己的游标，参与类型完成的轮次已把该类型离线增量对齐；未参与类型的单条实时消息
   * 仍会被标志挡住（它们发生在参与类型完成之前或之后的空闲期——参与类型完成前 isSyncing
   * 仍为 true）。保守规则：取消/失败/离线保护拦截/停滞重启的轮次一律不置 true。
   * Whether this connection has completed at least one round normally (service#101 cursor
   * guard). Set false on auth success and on disconnect; set true in checkSyncCompletion
   * when a round completes cleanly (no failures, not intercepted by the offline guard).
   * Types not participating in a round don't count as unfinished: advanceLiveSyncTime only
   * advances the cursor of the type being handled, and the participating types' offline
   * backlog was aligned by that round. Conservative rule: cancelled / failed / offline-guard
   * intercepted / stall-restarted rounds never set the flag.
   */
  hasSyncedThisConnection = false;
  /** 当前同步类型 / Current sync type */
  currentSyncType: "full" | "incremental" = "incremental";
  /**
   * 本机已作废的历史同步 context（最近 16 个）。活跃 context 被置空或被新轮替换时，
   * 旧值进此集合：websocket_manager 据此区分「本机上一轮的迟到应答」（照旧丢弃）与
   * 「其它设备的实时广播 / 无 context 应答」（延后到本轮结束再处理）。
   * Recently retired sync contexts of this client (last 16). When the active context is
   * cleared or superseded, the old value lands here so websocket_manager can tell late
   * replies of this client's own old rounds (discard) apart from other devices' live
   * broadcasts and contextless replies (defer until the round ends).
   */
  retiredSyncContexts = new Set<string>();
  /**
   * 活跃 context 被置空/替换时触发一次（在置空的调用栈里同步调用）；回放方必须异步调度，
   * 不能在该调用栈里同步重入消息分发。由 websocket_manager 构造时注册。
   * Fired once when the active context is cleared or superseded (synchronously in the
   * clearing call stack); the replay side must schedule asynchronously and must not
   * re-enter message dispatch synchronously. Registered by websocket_manager.
   */
  onSyncContextRetired?: () => void;

  private _activeSyncContext: string | null = null;
  /** 当前活跃的同步上下文 UUID / Current active sync context UUID */
  get activeSyncContext(): string | null { return this._activeSyncContext; }
  set activeSyncContext(value: string | null) {
    const old = this._activeSyncContext;
    this._activeSyncContext = value;
    if (old !== null && old !== value) {
      this.retiredSyncContexts.add(old);
      // Set 迭代序即插入序：重复 add 不改变位置，淘汰最旧的即近似 FIFO / Set iteration
      // order is insertion order: re-adding keeps position, evicting the first is approx. FIFO
      while (this.retiredSyncContexts.size > 16) {
        const oldest = this.retiredSyncContexts.values().next().value as string | undefined;
        if (oldest === undefined) break;
        this.retiredSyncContexts.delete(oldest);
      }
      this.onSyncContextRetired?.();
    }
  }
  /** 用户通过 ribbon 手动触发的待执行同步类型（断开时暂存，重连成功后执行）
   *  Pending sync type triggered manually via ribbon (stored when disconnected, executed after reconnect) */
  pendingSyncType: 'incremental' | 'full' | null = null;
  /**
   * C9: 本轮同步中是否有类型被离线超墓碑期保护拦截（用户点击「取消」）。
   * checkSyncCompletion 需据此判断本轮是否可信地"完成"，避免无条件刷新 lastSyncSuccessTime
   * 导致离线时长被清零、下一轮保护形同虚设。
   * C9: whether any type was intercepted by the offline tombstone-retention guard this round
   * (user clicked "Cancel"). checkSyncCompletion uses this to decide whether the round can be
   * trusted as genuinely "complete", so it doesn't unconditionally refresh lastSyncSuccessTime and
   * silently reset the offline duration, defeating the guard on the very next round.
   */
  offlineGuardSkippedThisRound = false;

  /**
   * 本轮各类型同步请求所带的 lastTime（回滚基线），以及 XxxSyncEnd 下发、尚未落盘的 lastTime。
   * 服务端先发 End 再分页下发明细，End 到达时明细还没处理；只有该类型全部完成且 failed=0 才把
   * End 时间落盘，否则回到基线（连同本轮逐条推进的时间），下一轮按旧时间重拉。
   * Per-type lastTime sent with this round's request (rollback baseline) and the XxxSyncEnd
   * lastTime not yet persisted. The server sends End before the paged details, so End arrives
   * before any detail is applied; it is persisted only when the type finished with failed=0,
   * otherwise the stored time returns to the baseline and the next round re-pulls from there.
   */
  syncTimeBaseline = new Map<SyncTimeField, number>();
  pendingSyncEndTime = new Map<SyncTimeField, number>();
  /**
   * 本轮扫描因达到 hashSyncLimit 而被截断跳过部分文件的同步字段集合。
   * settleSyncTimes 会跳过这些字段的游标推进，防止被截断的已修改文件在下一轮因 mtime < 新游标而被永久跳过。
   * Sync time fields whose vault scan was truncated by hashSyncLimit in this round.
   * settleSyncTimes keeps them at baseline so skipped modified files aren't permanently bypassed next round.
   */
  truncatedSyncFields = new Set<SyncTimeField>();
  /** 本轮单文件哈希超时数，按类型冻结游标，轮末统一提示。 / Per-type hash timeouts, reported at round end. */
  hashTimeoutCounts = new Map<SyncTimeField, number>();

  // ─── Per-type sync task statistics ───────────────────────────────────────────
  onCompletedChange?: (type: "note" | "file" | "setting" | "folder") => void;

  private createStatsProxy(type: "note" | "file" | "setting" | "folder", initVal: SyncTaskStats): SyncTaskStats {
    return new Proxy(initVal, {
      set: (target, prop, value, receiver) => {
        const oldVal = Reflect.get(target, prop, receiver) as number;
        const success = Reflect.set(target, prop, value, receiver);
        if (success && prop === "completed" && value !== oldVal) {
          if (this.onCompletedChange) {
            this.onCompletedChange(type);
          }
        }
        return success;
      }
    });
  }

  private _noteSyncTasks = this.createStatsProxy("note", { needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 });
  get noteSyncTasks() { return this._noteSyncTasks; }
  set noteSyncTasks(v: SyncTaskStats) { this._noteSyncTasks = this.createStatsProxy("note", v); }

  private _fileSyncTasks = this.createStatsProxy("file", { needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 });
  get fileSyncTasks() { return this._fileSyncTasks; }
  set fileSyncTasks(v: SyncTaskStats) { this._fileSyncTasks = this.createStatsProxy("file", v); }

  private _configSyncTasks = this.createStatsProxy("setting", { needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 });
  get configSyncTasks() { return this._configSyncTasks; }
  set configSyncTasks(v: SyncTaskStats) { this._configSyncTasks = this.createStatsProxy("setting", v); }

  private _folderSyncTasks = this.createStatsProxy("folder", { needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 });
  get folderSyncTasks() { return this._folderSyncTasks; }
  set folderSyncTasks(v: SyncTaskStats) { this._folderSyncTasks = this.createStatsProxy("folder", v); }

  // ─── Overall progress counters ────────────────────────────────────────────────
  syncTypeCompleteCount = 0;  // 已完成同步的类型计数 / Completed sync type count
  expectedSyncCount = 0;      // 预期的同步类型计数 / Expected sync type count
  totalFilesToDownload = 0;   // 待下载文件总数 / Total files to download
  downloadedFilesCount = 0;   // 已下载文件计数 / Downloaded files count
  totalChunksToDownload = 0;  // 待下载分片总数 / Total chunks to download
  downloadedChunksCount = 0;  // 已下载分片计数 / Downloaded chunks count
  totalChunksToUpload = 0;    // 待上传分片总数 / Total chunks to upload
  uploadedChunksCount = 0;    // 已上传分片计数 / Uploaded chunks count
  lastStatusBarPercentage = 0; // 上次状态栏进度百分比 / Last status bar percentage

  // ─── Per-type sync-end flags ─────────────────────────────────────────────────
  noteSyncEnd = false;    // 笔记同步是否完成 / Note sync completed
  fileSyncEnd = false;    // 文件同步是否完成 / File sync completed
  configSyncEnd = false;  // 配置同步是否完成 / Config sync completed
  folderSyncEnd = false;  // 文件夹同步是否完成 / Folder sync completed

  // ─── Pending queues (waiting for server ACK) ──────────────────────────────────
  /**
   * 待确认的文件重命名队列，等待服务端 FileRenameAck 后再更新 hashManager
   * Pending file rename queue, wait for server FileRenameAck before updating hashManager
   */
  pendingFileRenames: { oldPath: string; newPath: string; contentHash: string }[] = [];
  /**
   * 待确认的笔记重命名映射，key 为 newPath，等待服务端 NoteRenameAck（按 path 精确匹配）后再更新 hashManager；
   * 老服务端不下发 path 时回退 FIFO（按 Map 插入顺序取首个）
   * Pending note rename map keyed by newPath, update hashManager only after server NoteRenameAck
   * (matched precisely by path); falls back to FIFO (first inserted entry) when legacy server omits path
   */
  pendingNoteRenames: Map<string, { oldPath: string; newPath: string; contentHash: string }> = new Map();
  /**
   * 待确认的文件上传 hash 映射，等待服务端 FileUploadAck 后再写入 hashManager
   * Pending upload hash map, update hashManager only after server FileUploadAck
   */
  pendingUploadHashes = new Map<string, string>();
  /**
   * 待确认的笔记上传 hash 映射，等待服务端 NoteModifyAck 后再写入 hashManager
   * Pending note upload hash map, update hashManager only after server NoteModifyAck
   */
  pendingNoteModifies = new Map<string, string>();
  /** 待服务端 NoteDeleteAck 确认的路径集合 / Paths pending NoteDeleteAck */
  pendingNoteDeleteAcks = new Set<string>();
  /** 待服务端 FileDeleteAck 确认的路径集合 / Paths pending FileDeleteAck */
  pendingFileDeleteAcks = new Set<string>();
  /** 待服务端 SettingDeleteAck 确认的路径集合 / Paths pending SettingDeleteAck */
  pendingConfigDeleteAcks = new Set<string>();
  /**
   * 待确认的配置上传 hash 映射，等待服务端 SettingModifyAck 后再写入 configHashManager
   * Pending config upload hash map, update configHashManager only after server SettingModifyAck
   */
  pendingConfigModifies = new Map<string, string>();

  // ─── Pending delete path sets (cleared on SyncEnd) ───────────────────────────
  /**
   * 待服务端确认删除的路径集合，SyncEnd 到达后再从 hashManager/snapshotManager 移除
   * Pending delete path sets, remove from hashManager/snapshotManager only after SyncEnd
   */
  pendingDeleteNotePaths = new Set<string>();
  pendingDeleteFilePaths = new Set<string>();
  pendingDeleteFolderPaths = new Set<string>();
  pendingDeleteConfigPaths = new Set<string>();

  // ─── Scanned hash caches (committed to HashManager on SyncEnd) ───────────────
  /**
   * 暂存本轮同步扫描过程中新计算出的哈希，待同步结束（SyncEnd）时统一持久化到 HashManager
   * Temporarily store newly calculated hashes during scan, commit to HashManager on SyncEnd
   */
  scannedNoteHashes = new Map<string, { hash: string; mtime: number; size: number }>();
  scannedFileHashes = new Map<string, { hash: string; mtime: number; size: number }>();
  scannedConfigHashes = new Map<string, { hash: string; mtime: number; size: number }>();

  // ─── Watch / tracking sets ────────────────────────────────────────────────────
  /** 忽略的文件集合 / Ignored files set */
  ignoredFiles = new Set<string>();
  /** 忽略的配置文件集合 / Ignored config files set */
  ignoredConfigFiles = new Set<string>();
  /** 最后同步的修改时间 / Last sync mtime map */
  lastSyncMtime = new Map<string, number>();
  /** 通过同步删除的路径 / Paths deleted via sync */
  lastSyncPathDeleted = new Set<string>();
  /** 通过同步重命名的路径 / Paths renamed via sync */
  lastSyncPathRenamed = new Set<string>();
  /** 自动同步定时器 / Auto-sync timer */
  syncTimer: number | null = null;
  /** 进度检测定时器 ID，供取消同步时使用 / Progress check interval ID for sync cancellation */
  progressCheckIntervalId: number | null = null;
  /** 文件下载会话管理 / File download session map */
  fileDownloadSessions = new Map<string, FileDownloadSession>();

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * 重置所有任务统计与本轮会话状态
   * Reset all per-session task statistics and sync-end flags
   */
  resetSession() {
    if (this.progressCheckIntervalId !== null) {
      window.clearInterval(this.progressCheckIntervalId);
      this.progressCheckIntervalId = null;
    }
    this.noteSyncTasks = { needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 };
    this.fileSyncTasks = { needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 };
    this.configSyncTasks = { needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 };
    this.folderSyncTasks = { needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, completed: 0, failed: 0 };
    this.lastStatusBarPercentage = 0;
    this.noteSyncEnd = false;
    this.fileSyncEnd = false;
    this.configSyncEnd = false;
    this.folderSyncEnd = false;
    this.offlineGuardSkippedThisRound = false;
    this.truncatedSyncFields.clear();
    this.hashTimeoutCounts.clear();
    this.conflictCountsThisRound.clear();
    // 注意：不再清空 scannedXxxHashes。这些哈希是扫描期实打实算出来的，条目自带 mtime/size 校验，
    // 留到下一轮同步结束时提交依然有效；在这里清空会把上一轮（可能仍在收尾）算出的哈希白白丢掉，
    // 导致同一批文件每次同步都要重算。提交由 operator.ts 的 commitScannedHashes 按键移除。
    // Note: scannedXxxHashes are intentionally NOT cleared here. They are real computed hashes
    // carrying their own mtime/size for validation, so they stay valid for the next commit.
    // Clearing them here threw away work from a round that was still finishing, forcing the same
    // files to be re-hashed on every sync. Entries are removed per-key by commitScannedHashes.
  }

  /**
   * 计算总任务数 / Calculate total task count
   */
  getTotalTasks(): number {
    const sum = (t: SyncTaskStats) => t.needUpload + t.needModify + t.needSyncMtime + t.needDelete;
    return sum(this.noteSyncTasks) + sum(this.fileSyncTasks) + sum(this.configSyncTasks) + sum(this.folderSyncTasks);
  }

  /**
   * 计算已完成任务数 / Calculate completed task count
   */
  getCompletedTasks(): number {
    return this.noteSyncTasks.completed + this.fileSyncTasks.completed
      + this.configSyncTasks.completed + this.folderSyncTasks.completed;
  }
}
