import { hashContentAsync, dump, isPathExcluded, showSyncNotice, isLargeBinarySyncRisk, describeBinarySyncLimit, logMemorySnapshot, hashFileAsync, debounce, LocalStateFileMirror, computeMirrorDigest } from "../utils/helpers";
import { $ } from "../../i18n/lang";
import type FastSync from "../../main";
import { BaselineDeleteRecord, computeRemoteScope, parseScopedState, serializeScopedState, ScopedBaselineState } from "./baseline_scope";
import { scheduleConflictRecordReset } from "../sync/conflict_reset_scheduler";


/**
 * 哈希缓存结构
 */
interface HashCache {
  hash: string;
  mtime: number;
  size: number;
}

/**
 * 可信基线的来源标记（阶段 B）。
 * - confirmed: 由服务端确认（Ack / 下载落盘 / 推送内容与本地一致）建立的基线；
 * - persisted_verified: 升级自旧版持久化基线，仅当本地当前内容与记录值相等时按“未偏离”接受；
 * - none / unverified: 没有可信基线，或旧版基线无法用当前本地内容自证。
 *
 * Provenance of a trusted baseline (stage B):
 * - confirmed: established at a server-confirmed moment (Ack / downloaded content / push that
 *   equals local content);
 * - persisted_verified: legacy persisted baseline accepted only because local content still
 *   matches the recorded value;
 * - none / unverified: no trustworthy baseline, or a legacy baseline the current local content
 *   cannot vouch for.
 */
export type BaselineProvenance = "confirmed" | "persisted_verified" | "unverified" | "none";

/**
 * 文件哈希管理器
 * 负责管理文件路径与哈希值的映射关系,存储在 localStorage 中
 *
 * 两张表职责严格分离（阶段 B 核心不变量）：
 * - hashMap: 本地磁盘当前内容的哈希缓存，启动扫描 / 扫描结果只允许写入这里；
 * - syncHashMap: 已同步可信基线，只允许在服务端确认、远端落盘或内容相等核验时写入。
 * 启动扫描绝不允许把本地算出的哈希直接复制成可信基线。
 *
 * The two tables have strictly separate duties (stage-B invariant):
 * - hashMap: cache of the content currently on disk; startup/local scans may only write here;
 * - syncHashMap: trusted sync baseline, written only when the server confirms, remote content
 *   lands on disk, or content equality is verified. Scans must never promote themselves.
 */
export class FileHashManager {
  private plugin: FastSync;
  private hashMap: Map<string, HashCache> = new Map();
  private syncHashMap: Map<string, string> = new Map(); // path -> baseHash
  /** 服务端确认过的基线路径；升级自旧版时缺失，只能按内容相等自证 */
  /** Paths whose baseline was confirmed by the server; absent for legacy data (equality-only) */
  private confirmedPaths: Set<string> = new Set();
  private storageKey: string;
  private syncStorageKey: string;
  private confirmedStorageKey: string;
  // 服务端确认的 revision 令牌与待删基线，按远端作用域隔离持久化（设计稿 §5.1）
  // Server-confirmed revision tokens and pre-delete baselines, persisted per remote scope (§5.1)
  private baselineStorageKey: string;
  private revisions: Map<string, string> = new Map();
  private pendingDeleteBaselines: Map<string, BaselineDeleteRecord> = new Map();
  private baselineScope: string = "";
  // 诊断用：本次启动加载基线状态时是否发现远端目标变化（旧令牌已被丢弃）
  // Diagnostics: whether startup found a changed remote target (old tokens discarded)
  private baselineScopeChangedAtLoad: boolean = false;
  private baselineMirror: LocalStateFileMirror;
  private isInitialized: boolean = false;
  // 脏标记 + 防抖落盘：高频单条写入（下载/Ack 路径）不再逐条同步整表 JSON.stringify，
  // 避免高频写 localStorage 阻塞主线程导致界面白屏
  private isDirty: boolean = false;
  private debouncedFlush: () => void;
  // 文件镜像：localStorage 被移动端系统清除后的兜底恢复
  private mirror: LocalStateFileMirror;
  private syncMirror: LocalStateFileMirror;
  private syncBaselineRestoredFromPersisted: boolean = false;
  private syncDigest: string = "";

  constructor(plugin: FastSync) {
    this.plugin = plugin;
    // 与 vault 名无关的稳定存储键：iCloud 手机端会把库文件夹改名，绑定 vault 名的旧 key 会失效
    // (与 local_storage_manager.ts getInternalKey 的修复同理)，历史键迁移见 loadFromStorage
    this.storageKey = `fns-fileHashMap`;
    this.syncStorageKey = `fns-syncHashMap`;
    this.confirmedStorageKey = `fns-syncHashMapConfirmed`;
    this.baselineStorageKey = `fns-fileBaselineState`;
    this.debouncedFlush = debounce(() => this.flush(), 500);
    this.mirror = new LocalStateFileMirror(plugin, "fileHashMap.json");
    this.syncMirror = new LocalStateFileMirror(plugin, "syncHashMap.json");
    this.baselineMirror = new LocalStateFileMirror(plugin, "fileBaselineState.json");
    this.baselineScope = computeRemoteScope(plugin.settings);
  }

  /**
   * 标记为脏并安排一次防抖落盘（用于高频单条写入路径）
   */
  private scheduleSave(): void {
    this.isDirty = true;
    this.debouncedFlush();
  }

  /**
   * 立即将脏数据落盘（用于同步结束、插件卸载等需要保证持久化的时机）
   */
  flush(): void {
    if (this.isDirty) {
      this.isDirty = false;
      this.saveToStorage();
    }
    // 最后冲镜像：既包含 saveToStorage 刚安排的一份，也包含与 isDirty 无关的防抖中镜像写
    this.mirror.flush();
    this.syncMirror.flush();
    this.baselineMirror.flush();
  }

  /**
   * 初始化哈希表
   * 只在 localStorage 不存在时执行完整的文件遍历；localStorage 未命中时先尝试文件镜像恢复，
   * 镜像也没有才真正重建 (移动端 localStorage 被系统清除时避免每次启动全量重建 + 弹通知)
   */
  async initialize(): Promise<void> {
    dump("FileHashManager: starting init");

    // 1. 先恢复云端确认同步基准表 (syncHashMap)。
    // Restore the acknowledged baseline first: restoring the computed cache below may call
    // saveToStorage(), which also persists syncHashMap. Saving before this step overwrote the
    // saved baseline (localStorage and syncHashMap.json) with the constructor-empty map, so a
    // restart after iOS evicted localStorage lost every acknowledgement.
    let hasRestoredSync = this.loadSyncFromStorage();
    if (hasRestoredSync) {
      dump(`FileHashManager: loaded sync baseline from localStorage (${this.syncHashMap.size} files)`);
    }
    if (!hasRestoredSync || this.syncHashMap.size === 0) {
      // An empty localStorage baseline must not win over a populated mirror.
      const mirroredSync = await this.syncMirror.read();
      if (mirroredSync && this.parseAndLoadSync(mirroredSync) && this.syncHashMap.size > 0) {
        dump(`FileHashManager: restored sync baseline from file mirror (${this.syncHashMap.size} files)`);
        this.saveSyncToStorage();
        hasRestoredSync = true;
      }
    }
    // 确认来源表单独恢复：旧版没有这张表，所有旧基线一律按“需内容相等自证”处理
    // Restore the confirmation table separately: legacy installs lack it, so every old baseline
    // is treated as needing an equality check before it can be trusted.
    this.loadConfirmedFromStorage();
    // revision 令牌与待删基线：绑定远端作用域恢复；切换目标后旧令牌作废
    // Revision tokens and pre-delete baselines: restored per remote scope; old tokens are void
    // after a target switch
    await this.loadBaselineState();
    if (hasRestoredSync && this.syncHashMap.size > 0) {
      dump(`FileHashManager: ${this.confirmedPaths.size} of ${this.syncHashMap.size} baselines are server-confirmed`);
    }

    // 2. 恢复本地最新计算哈希缓存表 (hashMap)
    const loaded = this.loadFromStorage();
    let hasRestoredMap = false;

    if (loaded) {
      dump(`FileHashManager: loaded local hash cache from localStorage (${this.hashMap.size} files)`);
      hasRestoredMap = true;
    } else {
      const mirrored = await this.mirror.read();
      if (mirrored && this.parseAndLoad(mirrored)) {
        dump("FileHashManager: restored local hash cache from file mirror");
        this.saveToStorage();
        hasRestoredMap = true;
      }
    }

    if (!hasRestoredMap) {
      dump("FileHashManager: no local cache in localStorage or file mirror, building hash map");
      await this.buildFileHashMap();
    }

    // 3. 阶段 B 核心不变量：启动扫描（hashMap）绝不复制为可信基线。
    // 旧实现会在首次启动/旧版升级时把整个扫描结果迁移进 syncHashMap，等于把“本地磁盘当前
    // 内容”冒充成“服务端确认过的已同步基线”；已有内容的库首次接入远端同名库时，远端修改
    // 会因此被直接覆盖。现在宁可让这些条目显示为“无基线”，交给相等内容自动核验或首次对齐。
    // Stage-B invariant: the startup scan (hashMap) is never promoted to a trusted baseline. The
    // old migration copied every scanned hash into syncHashMap on first install / upgrade, which
    // turned "current local content" into a fake "server-confirmed baseline" and let a remote
    // modify silently overwrite an existing local note on first attach. Such paths now have no
    // baseline until equality is verified or the user aligns them.
    this.syncBaselineRestoredFromPersisted = hasRestoredSync;

    this.isInitialized = true;
  }

  private loadConfirmedFromStorage(): void {
    this.confirmedPaths.clear();
    try {
      const raw = this.plugin.app.loadLocalStorage(this.confirmedStorageKey) as string | null;
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const path of parsed) {
        if (typeof path === "string" && this.syncHashMap.has(path)) this.confirmedPaths.add(path);
      }
    } catch (error) {
      dump("FileHashManager: failed to load confirmed baseline provenance", error);
    }
  }

  private loadSyncFromStorage(): boolean {
    try {
      const data = this.plugin.app.loadLocalStorage(this.syncStorageKey) as string | null;
      if (!data) return false;
      return this.parseAndLoadSync(data);
    } catch (error) {
      dump("FileHashManager: failed to load sync baseline from localStorage", error);
      return false;
    }
  }

  private parseAndLoadSync(data: string): boolean {
    try {
      const parsed = JSON.parse(data) as Record<string, string>;
      this.syncHashMap = new Map(Object.entries(parsed));
      this.syncDigest = computeMirrorDigest(JSON.stringify(Object.fromEntries(this.syncHashMap)));
      return true;
    } catch (error) {
      dump("FileHashManager: failed to parse sync baseline hash data", error);
      return false;
    }
  }

  /**
   * 本次初始化的同步基准表是否走过重建/迁移（未从持久化基准恢复）
   */
  wasSyncRebuilt(): boolean {
    return !this.syncBaselineRestoredFromPersisted;
  }

  /**
   * 获取当前同步基准表（syncHashMap）的配对指纹
   */
  getSyncBaselineDigest(): string {
    if (this.isDirty || !this.syncDigest) {
      this.syncDigest = computeMirrorDigest(JSON.stringify(Object.fromEntries(this.syncHashMap)));
    }
    return this.syncDigest;
  }

  /**
   * 检查是否已初始化
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  private async buildFileHashMap(): Promise<void> {
    const notice = showSyncNotice($("ui.notice.file_hash_init_start"), 0);

    try {
      const files = this.plugin.app.vault.getFiles();

      const totalFiles = files.length;
      let processedFiles = 0;

      dump(`FileHashManager: scanning ${totalFiles} files`);

      // --- PERF: bounded concurrency for cold-build read+hash ---
      // 冷建路径原先完全串行 read+hash，参照 operator.ts 扫描阶段的 6 路有限并发改造
      const MAX_CONCURRENT_HASH = 6;
      const hashInFlight = new Set<Promise<void>>();
      const scheduleHashTask = async (task: () => Promise<void>) => {
        let p: Promise<void>;
        p = task().finally(() => hashInFlight.delete(p));
        hashInFlight.add(p);
        if (hashInFlight.size >= MAX_CONCURRENT_HASH) {
          await Promise.race(hashInFlight);
        }
      };

      for (const file of files) {
        // 跳过已排除的文件
        if (isPathExcluded(file.path, this.plugin)) {
          processedFiles++;
          continue;
        }

        if (file.extension !== "md" && isLargeBinarySyncRisk(file.stat.size, this.plugin)) {
          dump(`FileHashManager: skip large binary hash (${describeBinarySyncLimit(this.plugin)} limit): ${file.path}`, file.stat.size);
          processedFiles++;
          continue;
        }

        await scheduleHashTask(async () => {
          try {
            let contentHash: string;

            // 根据文件类型选择不同的哈希计算方式
            if (file.extension === "md") {
              // md 文件使用文本内容计算哈希
              let content: string | null = await this.plugin.app.vault.read(file);
              contentHash = await hashContentAsync(content);
              content = null; // 显式释放引用 (Explicitly release reference)
            } else {
              contentHash = await hashFileAsync(this.plugin.app, file.path);
              logMemorySnapshot(`after hash ${file.path}`);
            }

            this.hashMap.set(file.path, {
              hash: contentHash,
              mtime: file.stat.mtime,
              size: file.stat.size
            });
          } catch (error) {
            // 单个文件哈希计算失败不应中断整个构建过程
            const msg = error instanceof Error ? error.message : String(error);
            dump(`FileHashManager: hash failed, skipping file: ${file.path}`, error);
            console.warn(`[FastNoteSync] skipping file ${file.path}: ${msg}`);
          }
        });

        processedFiles++;

        // 每处理 50 个文件更新一次进度 (Update progress every 50 files)
        if (processedFiles % 50 === 0) {
          notice.setMessage($("ui.notice.file_hash_init_progress", { done: processedFiles, total: totalFiles }));
          // 让出主线程,避免阻塞 UI
          await new Promise(resolve => window.setTimeout(resolve, 0));
        }
      }

      // 等待所有并发哈希任务收尾，确保后续落盘基于完整结果
      if (hashInFlight.size > 0) {
        await Promise.all(Array.from(hashInFlight));
      }

      // 保存到 localStorage
      this.saveToStorage();

      notice.setMessage($("ui.notice.file_hash_init_done", { total: totalFiles }));
      window.setTimeout(() => notice.hide(), 3000);

      dump(`FileHashManager: build complete, ${totalFiles} files`);
    } catch (error) {
      notice.hide();
      const msg = error instanceof Error ? error.message : String(error);
      showSyncNotice($("ui.notice.file_hash_init_failed", { msg }));
      dump("FileHashManager: build failed", error);
      throw error;
    }
  }

  /**
   * 获取有效的哈希值
   * 如果缓存存在且 mtime/size 匹配，则返回缓存的哈希，否则返回 null
   */
  getValidHash(path: string, mtime: number, size: number): string | null {
    const cache = this.hashMap.get(path);
    if (cache && cache.mtime === mtime && cache.size === size) {
      return cache.hash;
    }
    return null;
  }

  /**
   * 获取指定路径的同步基准哈希值 (提供给同步作为 baseHash 的唯一来源)
   */
  getPathHash(path: string): string | null {
    return this.syncHashMap.get(path) || null;
  }

  /**
   * 判断某条基线在当前本地内容下是否可信（阶段 B）。
   * 服务端确认过的基线直接可信；升级自旧版的持久化基线只有在本地内容仍等于记录值时才可信
   * （“未偏离”）；不相等或没有记录即视为无可信基线。远端下行修改的覆盖保护必须用这个判断，
   * 不能用裸的 getPathHash。
   *
   * Whether a baseline is trustworthy for the current local content (stage B). A
   * server-confirmed baseline is trusted unconditionally; a legacy persisted baseline is trusted
   * only while the local content still equals the recorded value; otherwise there is no trusted
   * baseline. Remote-modify overwrite protection must use this, never raw getPathHash.
   */
  getVerifiedPathHash(path: string, localContentHash: string | null): string | null {
    const stored = this.syncHashMap.get(path);
    if (stored === undefined) return null;
    if (this.confirmedPaths.has(path)) return stored;
    return localContentHash !== null && localContentHash === stored ? stored : null;
  }

  /**
   * 查询某条基线的来源，供诊断与测试使用。
   * Report a baseline's provenance for diagnostics and tests.
   */
  getBaselineProvenance(path: string, localContentHash: string | null): BaselineProvenance {
    const stored = this.syncHashMap.get(path);
    if (stored === undefined) return "none";
    if (this.confirmedPaths.has(path)) return "confirmed";
    return localContentHash !== null && localContentHash === stored ? "persisted_verified" : "unverified";
  }

  // ─── 阶段 E：服务端确认的 revision 与待删基线（设计稿 §5.1）──────────────────
  // ─── Stage E: server-confirmed revisions and pre-delete baselines (§5.1) ─────

  /** 远端目标变化时立即隔离旧令牌；旧目标的可信结论降级为内容相等自证 */
  /** Isolate old tokens when the remote target changes; confirmed provenance degrades to equality-only */
  private ensureBaselineScope(): void {
    const scope = computeRemoteScope(this.plugin.settings);
    if (scope === this.baselineScope) return;
    this.baselineScope = scope;
    this.revisions.clear();
    this.pendingDeleteBaselines.clear();
    this.confirmedPaths.clear();
    dump("FileHashManager: remote scope changed; revisions and confirmed provenance cleared");
    this.saveBaselineState();
    this.saveSyncToStorage();
    // 旧目标的冲突记录不再有意义（路径可能在新目标上不存在）。登记成待执行的清理，
    // 下一轮同步开始 / 写入新冲突前会等待它完成，失败则保留标志重试。
    // Conflict records of the old target are meaningless. Register a tracked cleanup: the next
    // sync round / conflict write awaits it, and failures keep a retry flag.
    scheduleConflictRecordReset(this.plugin, "note/file baseline scope changed");
  }

  private async loadBaselineState(): Promise<void> {
    const scope = computeRemoteScope(this.plugin.settings);
    this.baselineScope = scope;
    let raw = this.plugin.app.loadLocalStorage(this.baselineStorageKey) as string | null;
    if (!raw) {
      raw = await this.baselineMirror.read();
      if (raw) this.plugin.app.saveLocalStorage(this.baselineStorageKey, raw);
    }
    const { state, scopeChanged } = parseScopedState(raw, scope);
    this.baselineScopeChangedAtLoad = scopeChanged;
    this.revisions = new Map(Object.entries(state.revisions));
    this.pendingDeleteBaselines = new Map(Object.entries(state.pendingDeletes));
    if (scopeChanged) {
      // 旧目标的令牌绝不能发往新目标；哈希表保留，用作内容相等自证
      // Old-target tokens must never reach the new target; hashes stay for equality checks
      this.revisions.clear();
      this.pendingDeleteBaselines.clear();
      this.confirmedPaths.clear();
      dump("FileHashManager: stored baseline belongs to another remote target; tokens discarded");
      this.saveBaselineState();
      this.saveSyncToStorage();
      // 启动即发现换过目标：先把旧目标的冲突记录清掉，再让主流程读回集合。
      // 失败时保留重试标志，下一轮同步开始前会再清一次。
      // Target changed since last session: clear the old conflicts before main reads the set.
      // On failure keep the retry flag so the next sync round tries again.
      try {
        const { resetConflictRecords } = await import("../sync/conflict_store");
        if (!(await resetConflictRecords(this.plugin))) this.plugin.conflictResetFailed = true;
      } catch {
        // Conflict cleanup is best-effort; startup must continue, the next round retries
        this.plugin.conflictResetFailed = true;
      }
    }
  }

  private saveBaselineState(): void {
    const state: ScopedBaselineState = {
      scope: this.baselineScope,
      revisions: Object.fromEntries(this.revisions),
      pendingDeletes: Object.fromEntries(this.pendingDeleteBaselines),
    };
    const data = serializeScopedState(state);
    try {
      this.plugin.app.saveLocalStorage(this.baselineStorageKey, data);
    } catch (error) {
      dump("FileHashManager: failed to save baseline state", error);
    }
    this.baselineMirror.scheduleWrite(data);
  }

  /** 该路径服务端确认过的 revision 令牌 / Server-confirmed revision token for a path */
  getBaselineRevision(path: string): string | null {
    this.ensureBaselineScope();
    return this.revisions.get(path) ?? null;
  }

  /**
   * 服务端确认过的可信 `{hash, revision}`；旧版持久化基线不算。
   * Server-confirmed trusted `{hash, revision}`; legacy persisted baselines don't qualify.
   */
  getConfirmedBaseline(path: string, localContentHash: string | null = null): { hash: string; revision: string } | null {
    this.ensureBaselineScope();
    if (!this.confirmedPaths.has(path)) return null;
    const hash = this.getVerifiedPathHash(path, localContentHash);
    const revision = this.revisions.get(path);
    if (hash === null || !revision) return null;
    return { hash, revision };
  }

  /** 是否已有服务端确认的 revision（扫描增量过滤用） / Whether a confirmed revision exists (scan filter) */
  isBaselineConfirmed(path: string): boolean {
    this.ensureBaselineScope();
    return this.confirmedPaths.has(path) && this.revisions.has(path);
  }

  /**
   * 建立/前移服务端确认的基线。只允许在 Ack、远端落盘或内容一致确认后调用。
   * Establish/advance a server-confirmed baseline. Only Ack / remote landing / equality may call this.
   */
  setConfirmedBaseline(path: string, hash: string, revision: string, mtime: number = 0, size: number = 0, cacheContent = true): void {
    this.ensureBaselineScope();
    if (cacheContent) this.hashMap.set(path, { hash, mtime, size });
    this.syncHashMap.set(path, hash);
    this.confirmedPaths.add(path);
    if (revision !== "") this.revisions.set(path, revision);
    this.scheduleSave();
  }

  /**
   * 删除前快照：在清掉活跃缓存前记录最后确认的基线，供实时删除、回放与批量删除携带。
   * Pre-delete snapshot: capture the last confirmed baseline before active cache is cleared, so
   * live deletes, replay and batch deletes can carry it.
   */
  recordPendingDeleteBaseline(path: string): BaselineDeleteRecord {
    this.ensureBaselineScope();
    const confirmed = this.confirmedPaths.has(path);
    const revision = confirmed ? (this.revisions.get(path) ?? "") : "";
    const record: BaselineDeleteRecord = {
      hash: confirmed ? (this.syncHashMap.get(path) ?? "") : "",
      hashMissing: !confirmed || revision === "",
      revision,
    };
    this.pendingDeleteBaselines.set(path, record);
    this.scheduleSave();
    return record;
  }

  getPendingDeleteBaseline(path: string): BaselineDeleteRecord | null {
    this.ensureBaselineScope();
    return this.pendingDeleteBaselines.get(path) ?? null;
  }

  clearPendingDeleteBaseline(path: string): void {
    if (this.pendingDeleteBaselines.delete(path)) this.scheduleSave();
  }

  clearPendingDeleteBaselines(paths: Iterable<string>): void {
    let changed = false;
    for (const path of paths) changed = this.pendingDeleteBaselines.delete(path) || changed;
    if (changed) this.scheduleSave();
  }

  getAllPendingDeleteBaselines(): BaselineDeleteRecord[] {
    this.ensureBaselineScope();
    return Array.from(this.pendingDeleteBaselines.values());
  }

  /**
   * 内容仍是同步基准时，返回缓存记录的同步时 mtime（没有则 undefined）。
   * 打开 canvas 等只改写 mtime 不改内容时，用它代替被刷新的本地 mtime 上报（#256）
   * While the content is still the sync baseline, return the mtime cached at sync time (undefined if
   * none); reported instead of a refreshed local mtime when e.g. opening a canvas rewrites only the mtime (#256)
   */
  getSyncedMtime(path: string): number | undefined {
    const cache = this.hashMap.get(path);
    const base = this.syncHashMap.get(path);
    return cache && base !== undefined && cache.hash === base && cache.mtime > 0 ? cache.mtime : undefined;
  }

  /**
   * 获取已成功同步的所有文件路径 (用于检测离线删除与拉取缺失文件)
   */
  getAllPaths(): string[] {
    return Array.from(this.syncHashMap.keys());
  }

  /**
   * 添加或更新单个文件的对齐基准哈希值 (在 Ack 确认或收到推送时调用)
   */
  setFileHash(path: string, hash: string, mtime: number = 0, size: number = 0, cacheContent = true, revision?: string): void {
    this.ensureBaselineScope();
    // A rename confirms the server baseline, not the current local bytes.
    if (cacheContent) this.hashMap.set(path, { hash, mtime, size });
    else this.hashMap.delete(path);
    const previousHash = this.syncHashMap.get(path);
    this.syncHashMap.set(path, hash);
    // 只有服务端确认过的写入才能把基线标为 confirmed；扫描/本地缓存路径不经过这里
    // Only server-confirmed writes reach here, so the baseline is marked confirmed. Scans and
    // local-cache-only paths never call this method.
    this.confirmedPaths.add(path);
    if (revision !== undefined && revision !== "") {
      this.revisions.set(path, revision);
    } else if (previousHash !== undefined && previousHash !== hash) {
      // 内容已变但本次确认没有令牌：旧 revision 已对应旧内容，必须丢弃
      // Content changed without a token: the old revision describes old content, drop it
      this.revisions.delete(path);
    }
    this.scheduleSave();
  }

  /**
   * SyncEnd 兜底补偿写入 (仅更新本地缓存, 绝不更新同步基准表)
   * SyncEnd fallback cannot prove server confirmed the write; only Ack path may update syncHashMap
   */
  setFileHashes(entries: Iterable<[string, string]>, getStat?: (path: string) => { mtime?: number; size?: number } | null | undefined): void {
    let changed = false;
    for (const [path, hash] of entries) {
      const stat = getStat?.(path);
      this.hashMap.set(path, { hash, mtime: stat?.mtime || 0, size: stat?.size || 0 });
      changed = true;
    }
    if (changed) this.saveToStorage();
  }

  /**
   * 删除指定路径的哈希
   */
  removeFileHash(path: string): void {
    const deleted1 = this.hashMap.delete(path);
    const deleted2 = this.syncHashMap.delete(path);
    this.confirmedPaths.delete(path);
    this.revisions.delete(path);
    if (deleted1 || deleted2) {
      this.scheduleSave();
    }
  }

  removeFileHashes(paths: Iterable<string>): void {
    let changed = false;
    for (const path of paths) {
      changed = this.hashMap.delete(path) || changed;
      changed = this.syncHashMap.delete(path) || changed;
      this.confirmedPaths.delete(path);
      this.revisions.delete(path);
    }
    if (changed) this.scheduleSave();
  }

  /**
   * 从 localStorage 加载哈希映射
   */
  private loadFromStorage(): boolean {
    try {
      let data = this.plugin.app.loadLocalStorage(this.storageKey) as string | null;

      // 迁移逻辑：如果新键无数据，按由新到旧依次回溯历史键格式
      if (!data) {
        const vaultName = this.plugin.app.vault.getName();
        const legacyKeys = [
          `fns-${vaultName}-fileHashMap`,                      // 上一版：绑定本地库名的稳定前缀
          `fast-note-sync-${vaultName}-fileHashMap`,           // 更早版
          `fast-note-sync-${vaultName}-file-hash-map`,         // 更更早版
          `fast-note-sync-file-hash-map-${vaultName}`,         // 最原始格式
        ];
        for (const legacyKey of legacyKeys) {
          data = this.plugin.app.loadLocalStorage(legacyKey) as string | null;
          if (data) break;
        }

        if (data) {
          dump("FileHashManager: legacy hash map data found, migrating");
          this.plugin.app.saveLocalStorage(this.storageKey, data);
        } else {
          return false;
        }
      }

      return this.parseAndLoad(data);
    } catch (error) {
      dump("FileHashManager: failed to load from localStorage", error);
      return false;
    }
  }

  /**
   * 解析哈希表数据并装入 this.hashMap，兼容旧版仅存哈希字符串的格式
   * Parse hash map data and load it into this.hashMap, compatible with the old hash-only string format
   */
  private parseAndLoad(data: string): boolean {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      // 数据迁移逻辑：如果值是字符串，说明是旧版数据，需要重新构建或设为默认值
      // Data migration: if value is string, it's old version data; need to migrate or default
      const migratedMap = new Map<string, HashCache>();
      let needsSave = false;

      for (const [path, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          // 旧版数据：只有哈希。由于缺失 mtime/size，我们将它们设为 0，
          // 这样下次同步时会重新触发计算并更新为新格式。
          // Old data: hash only. Set mtime/size to 0 so next sync triggers recalculation and updates to new format.
          migratedMap.set(path, { hash: value, mtime: 0, size: 0 });
          needsSave = true;
        } else {
          migratedMap.set(path, value as HashCache);
        }
      }

      this.hashMap = migratedMap;
      if (needsSave) this.saveToStorage();

      return true;
    } catch (error) {
      dump("FileHashManager: failed to parse hash map data", error);
      return false;
    }
  }

  /**
   * 保存哈希映射到 localStorage，同时镜像写入文件 (兜底移动端 localStorage 被清除)
   */
  private saveToStorage(): void {
    let data: string;
    try {
      const obj = Object.fromEntries(this.hashMap);
      data = JSON.stringify(obj);
    } catch (error) {
      dump("FileHashManager: failed to serialize hash map", error);
      return;
    }

    try {
      this.plugin.app.saveLocalStorage(this.storageKey, data);
    } catch (error) {
      dump("FileHashManager: failed to save to localStorage", error);
      const msg = error instanceof Error ? error.message : String(error);
      showSyncNotice($("ui.notice.file_hash_save_failed", { msg }));
    }

    // 即使 localStorage 写入失败 (如配额)，镜像写入也照常进行
    this.mirror.scheduleWrite(data);

    // 同步保存基准哈希表与 revision/待删基线
    this.saveSyncToStorage();
    this.saveBaselineState();
  }

  private saveSyncToStorage(): void {
    let data: string;
    try {
      const obj = Object.fromEntries(this.syncHashMap);
      data = JSON.stringify(obj);
      this.syncDigest = computeMirrorDigest(data);
    } catch (error) {
      dump("FileHashManager: failed to serialize sync baseline hash map", error);
      return;
    }

    try {
      this.plugin.app.saveLocalStorage(this.syncStorageKey, data);
      // 来源表只记录 confirmed 路径；旧版没有这张表时，重启后一律回退为“需内容相等自证”
      // Persist only confirmed paths. A legacy install lacks this table, so after a restart all
      // its entries fall back to equality-only verification.
      this.plugin.app.saveLocalStorage(this.confirmedStorageKey, JSON.stringify(Array.from(this.confirmedPaths)));
    } catch (error) {
      dump("FileHashManager: failed to save sync baseline hash map to localStorage", error);
    }

    this.syncMirror.scheduleWrite(data);
  }

  /**
   * 手动重建哈希表
   * 用于命令面板
   */
  /**
   * 手动重建哈希表
   * 用于命令面板
   */
  async rebuildHashMap(): Promise<void> {
    dump("FileHashManager: manual hash map rebuild");
    // 只重建“本地磁盘哈希缓存”。手动重建同样不是服务端确认，绝不生成可信基线。
    // Rebuild only the local disk-hash cache. A manual rebuild is not a server confirmation and
    // must never create trusted baselines.
    this.hashMap.clear();
    await this.buildFileHashMap();
    this.scheduleSave();
  }

  /**
   * 清理所有哈希表内容
   */
  clearAll(): void {
    this.hashMap.clear();
    this.syncHashMap.clear();
    this.confirmedPaths.clear();
    this.revisions.clear();
    this.pendingDeleteBaselines.clear();
    // 基线作用域跟随最新设置后再落盘：切库后若沿用旧 scope，镜像里的旧令牌会被当成新库的
    // Re-anchor the baseline scope to the current settings before persisting: after a vault
    // switch a stale scope would make mirrored old tokens look like the new vault's
    this.baselineScope = computeRemoteScope(this.plugin.settings);
    this.saveToStorage();
  }

  /**
   * Bulk-set hashes from a scanned hash map and persist once.
   * Used to eagerly commit computed hashes during scan, breaking the
   * Catch-22 where hashes are never persisted because SyncEnd is never received.
   */
  /**
   * 批量更新扫描得出的哈希值 (仅写入本地缓存以优化性能，绝不更新同步基准表)
   */
  bulkSetFromScanned(scanned: Map<string, { hash: string; mtime: number; size: number }>): void {
    if (scanned.size === 0) return;
    let changed = false;
    for (const [path, cache] of scanned) {
      const existing = this.hashMap.get(path);
      if (!existing || existing.mtime <= cache.mtime) {
        this.hashMap.set(path, { hash: cache.hash, mtime: cache.mtime, size: cache.size });
        changed = true;
      }
    }
    if (changed) {
      // 仅触发本地缓存表的 localStorage 和文件镜像保存
      let data: string;
      try {
        const obj = Object.fromEntries(this.hashMap);
        data = JSON.stringify(obj);
      } catch {
        return;
      }
      try {
        this.plugin.app.saveLocalStorage(this.storageKey, data);
      } catch {
        // Ignore storage saving error // 忽略本地存储保存错误
      }
      this.mirror.scheduleWrite(data);
    }
  }

  /**
   * 清清理已排除文件的哈希
   * 当同步排除设置变更时调用
   */
  cleanupExcludedHashes(): void {
    let deletedCount = 0;
    for (const path of this.hashMap.keys()) {
      if (isPathExcluded(path, this.plugin)) {
        this.hashMap.delete(path);
        this.syncHashMap.delete(path);
        this.confirmedPaths.delete(path);
        this.revisions.delete(path);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      dump(`FileHashManager: cleaned up ${deletedCount} hashes of excluded files`);
      this.scheduleSave();
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): { totalFiles: number; storageKey: string } {
    return {
      totalFiles: this.hashMap.size,
      storageKey: this.storageKey,
    };
  }

  /**
   * 诊断用计数：本地哈希缓存、基线条目、服务端确认基线，以及启动时是否发现远端目标变化
   * Diagnostic counters: local hash cache, baseline entries, server-confirmed baselines, and
   * whether startup detected a changed remote target
   */
  getDiagnosticCounts(): { hashEntries: number; baselineEntries: number; confirmedBaselines: number; baselineScopeChanged: boolean } {
    return {
      hashEntries: this.hashMap.size,
      baselineEntries: this.syncHashMap.size,
      confirmedBaselines: this.confirmedPaths.size,
      baselineScopeChanged: this.baselineScopeChangedAtLoad,
    };
  }
}
