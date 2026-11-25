import { TFolder } from "obsidian";

import { dump, isFolderSyncPathExcluded, debounce, LocalStateFileMirror, computeMirrorDigest } from "../utils/helpers";
import type FastSync from "../../main";
import { BaselineDeleteRecord, computeRemoteScope, parseScopedState, serializeScopedState, ScopedBaselineState } from "./baseline_scope";
import { scheduleConflictRecordReset } from "../sync/conflict_reset_scheduler";

// 对账延迟：初始化后等待若干秒再比对，避开插件刚加载时的启动开销高峰
// Reconciliation delay: wait a few seconds after init to avoid the plugin's startup load spike
const RECONCILE_DELAY_MS = 5000;


/**
 * 文件夹快照管理器
 * 负责记录本地文件夹路径及其上一次同步的时间戳 (mtime)
 * 用于离线删除检测以及启动时的快速同步判定
 */
export class FolderSnapshotManager {
    private plugin: FastSync;
    private snapshotMap: Map<string, number> = new Map();
    /** 服务端确认的目录 revision（设计稿 §5.1）/ Server-confirmed folder revisions (§5.1) */
    private revisions: Map<string, string> = new Map();
    private pendingDeleteBaselines: Map<string, BaselineDeleteRecord> = new Map();
    private baselineScope: string = "";
    private baselineStorageKey: string;
    private baselineMirror: LocalStateFileMirror;
    private storageKey: string;
    private isInitialized: boolean = false;
    // 脏标记 + 防抖落盘：高频单条写入（下载/Ack 路径）不再逐条同步整表 JSON.stringify，
    // 避免高频写 localStorage 阻塞主线程导致界面白屏
    private isDirty: boolean = false;
    private debouncedFlush: () => void;
    // 文件镜像：localStorage 被移动端系统清除后的兜底恢复
    private mirror: LocalStateFileMirror;
    private restoredFromPersisted: boolean = false;
    private digest: string = "";

    constructor(plugin: FastSync) {
        this.plugin = plugin;
        // 与 vault 名无关的稳定存储键：iCloud 手机端会把库文件夹改名，绑定 vault 名的旧 key 会失效
        // (与 local_storage_manager.ts getInternalKey 的修复同理)，历史键迁移见 loadFromStorage
        this.storageKey = `fns-folderSnapshot`;
        this.baselineStorageKey = `fns-folderBaselineState`;
        this.debouncedFlush = debounce(() => this.flush(), 500);
        this.mirror = new LocalStateFileMirror(plugin, "folderSnapshot.json");
        this.baselineMirror = new LocalStateFileMirror(plugin, "folderBaselineState.json");
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
        this.baselineMirror.flush();
    }

    /**
     * 初始化快照表
     */
    async initialize(): Promise<void> {
        // revision 令牌按远端作用域恢复；切换目标后旧令牌作废
        // Revisions are restored per remote scope; old tokens are void after a target switch
        await this.loadBaselineState();
        const loaded = this.loadFromStorage();
        if (loaded) {
            this.restoredFromPersisted = true;
            this.isInitialized = true;
            // 采用了持久化快照，其内容可能因外部工具改动目录而漂移（新增/删除文件夹后从未与
            // 真实 vault 对账过）。安排一次轻量后台对账去修正，buildSnapshot 分支是刚从 vault
            // 现状构建的，天然一致，无需对账。
            // Adopted a persisted snapshot, which may have drifted if external tools changed
            // folders (it's never been reconciled against the real vault). Schedule a lightweight
            // background reconciliation to fix it; the buildSnapshot branch is freshly built from
            // vault state and is inherently consistent, so it doesn't need reconciliation.
            this.scheduleReconciliation();
            return;
        }

        // localStorage 未命中：尝试从文件镜像恢复，不弹通知、不重建
        const mirrored = await this.mirror.read();
        if (mirrored && this.parseAndLoad(mirrored)) {
            dump("FolderSnapshotManager: restored snapshot from file mirror");
            this.restoredFromPersisted = true;
            this.saveToStorage();
            this.isInitialized = true;
            // 镜像恢复的数据同样可能漂移，与 localStorage 命中分支一样安排对账
            this.scheduleReconciliation();
            return;
        }

        this.restoredFromPersisted = false;
        await this.buildSnapshot();
        this.isInitialized = true;
    }

    wasRebuilt(): boolean {
        return !this.restoredFromPersisted;
    }

    getDigest(): string {
        if (this.isDirty || !this.digest) {
            this.digest = computeMirrorDigest(JSON.stringify(Object.fromEntries(this.snapshotMap)));
        }
        return this.digest;
    }

    /**
     * 安排一次轻量后台对账 / Schedule a lightweight background reconciliation
     */
    private scheduleReconciliation(): void {
        window.setTimeout(() => {
            this.reconcileWithVault();
        }, RECONCILE_DELAY_MS);
    }

    /**
     * 比对当前 vault 的文件夹集合与快照 key 集合的差集，修正漂移：
     * 本地新增但快照缺失的文件夹补进去，快照里有但本地已消失的文件夹删掉。
     * 批量更新内存 Map 后走一次 flush 落盘，不逐条触发防抖写入。
     * Diff the current vault's folder set against the snapshot's key set and correct drift:
     * add folders present locally but missing from the snapshot, remove snapshot entries whose
     * local folder is gone. Batches the in-memory Map update then flushes once, instead of
     * triggering the debounced write per item.
     */
    private reconcileWithVault(): void {
        try {
            const files = this.plugin.app.vault.getAllLoadedFiles();
            const vaultFolderPaths = new Set<string>();
            for (const file of files) {
                if (file instanceof TFolder) {
                    if (file.path === "/" || isFolderSyncPathExcluded(file.path, this.plugin)) continue;
                    vaultFolderPaths.add(file.path);
                }
            }

            const toAdd: string[] = [];
            for (const path of vaultFolderPaths) {
                if (!this.snapshotMap.has(path)) toAdd.push(path);
            }
            const toRemove: string[] = [];
            for (const path of this.snapshotMap.keys()) {
                if (!vaultFolderPaths.has(path)) toRemove.push(path);
            }

            if (toAdd.length === 0 && toRemove.length === 0) {
                dump("FolderSnapshotManager: [Reconcile] no drift detected against vault");
                return;
            }

            const now = Date.now();
            for (const path of toAdd) this.snapshotMap.set(path, now);
            for (const path of toRemove) this.snapshotMap.delete(path);

            dump(`FolderSnapshotManager: [Reconcile] drift corrected, added=${toAdd.length}, removed=${toRemove.length}`, { toAdd, toRemove });

            // 对账是低频一次性事件，直接标脏并立即落盘一次，不必等待防抖窗口
            // Reconciliation is a low-frequency one-off event; mark dirty and flush immediately
            // rather than waiting for the debounce window
            this.isDirty = true;
            this.flush();
            (this.plugin.localStorageManager as { refreshSyncStateMirrorIfPresent?: () => void } | undefined)?.refreshSyncStateMirrorIfPresent?.();
        } catch (error) {
            dump("FolderSnapshotManager: [Reconcile] failed", error);
        }
    }

    isReady(): boolean {
        return this.isInitialized;
    }

    /**
     * 构建初始快照
     */
    private async buildSnapshot(): Promise<void> {
        try {
            const files = this.plugin.app.vault.getAllLoadedFiles();
            const now = Date.now();
            for (const file of files) {
                if (file instanceof TFolder) {
                    if (file.path === "/" || isFolderSyncPathExcluded(file.path, this.plugin)) continue;

                    // 初始快照时，所有文件夹的 mtime 设为当前时间 (虚拟化)
                    this.snapshotMap.set(file.path, now);
                }
            }
            this.saveToStorage();
        } catch (error) {
            dump("FolderSnapshotManager: failed to build snapshot", error);
        }
    }

    // ─── 阶段 E：服务端确认的目录 revision 与待删基线（设计稿 §5.1）──────────────

    private ensureBaselineScope(): void {
        const scope = computeRemoteScope(this.plugin.settings);
        if (scope === this.baselineScope) return;
        this.baselineScope = scope;
        this.revisions.clear();
        this.pendingDeleteBaselines.clear();
        dump("FolderSnapshotManager: remote scope changed; folder revisions cleared");
        this.saveBaselineState();
        // 旧目标的冲突记录不再有意义。登记成待执行的清理，下一轮同步开始 / 写入新冲突前
        // 会等待它完成，失败则保留标志重试。
        // Old-target conflicts are meaningless. Register a tracked cleanup that the next sync
        // round / conflict write awaits; failures keep a retry flag.
        scheduleConflictRecordReset(this.plugin, "folder baseline scope changed");
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
        this.revisions = new Map(Object.entries(state.revisions));
        this.pendingDeleteBaselines = new Map(Object.entries(state.pendingDeletes));
        if (scopeChanged) {
            this.revisions.clear();
            this.pendingDeleteBaselines.clear();
            dump("FolderSnapshotManager: stored folder revisions belong to another remote target; discarded");
            this.saveBaselineState();
            // 启动即发现换过目标：先清旧目标的冲突记录，再由主流程读回集合。
            // 失败时保留重试标志，下一轮同步开始前会再清一次。
            // Target changed since last session: clear old conflicts before main reads the set.
            // On failure keep the retry flag so the next sync round tries again.
            try {
                const { resetConflictRecords } = await import("../sync/conflict_store");
                if (!(await resetConflictRecords(this.plugin))) this.plugin.conflictResetFailed = true;
            } catch {
                // Conflict cleanup is best-effort; initialization must continue, the next round retries
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
            dump("FolderSnapshotManager: failed to save baseline state", error);
        }
        this.baselineMirror.scheduleWrite(data);
    }

    getBaselineRevision(path: string): string | null {
        this.ensureBaselineScope();
        return this.revisions.get(path) ?? null;
    }

    isBaselineConfirmed(path: string): boolean {
        this.ensureBaselineScope();
        return this.revisions.has(path);
    }

    /** 只允许在服务端确认（Ack / 远端落盘）后调用 / Only call after server confirmation */
    setConfirmedRevision(path: string, revision: string): void {
        this.ensureBaselineScope();
        if (revision === "") return;
        this.revisions.set(path, revision);
        this.scheduleSave();
    }

    /** 删除前快照（目录只有 revision）/ Pre-delete snapshot (folders only have a revision) */
    recordPendingDeleteBaseline(path: string): BaselineDeleteRecord {
        this.ensureBaselineScope();
        const revision = this.revisions.get(path) ?? "";
        const record: BaselineDeleteRecord = { hash: "", hashMissing: revision === "", revision };
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

    /**
     * 获取路径的快照时间
     */
    getMtime(path: string): number | null {
        return this.snapshotMap.get(path) || null;
    }

    /**
     * 获取快照中记录的所有路径
     */
    getAllPaths(): string[] {
        return Array.from(this.snapshotMap.keys());
    }

    /**
     * 诊断用计数：文件夹基线（快照）数与服务端确认的目录 revision 数，
     * 供外来同步状态判定汇总（见 baseline_scope.isUntrustedBaselineState）。
     * Diagnostic counts: folder baselines (snapshots) and server-confirmed folder revisions,
     * aggregated by the foreign sync-state probe.
     */
    getDiagnosticCounts(): { baselineEntries: number; confirmedBaselines: number } {
        return {
            baselineEntries: this.snapshotMap.size,
            confirmedBaselines: this.revisions.size,
        };
    }

    /**
     * 更新单个文件夹的快照时间
     */
    setFolderMtime(path: string, mtime: number): void {
        this.snapshotMap.set(path, mtime);
        this.scheduleSave();
    }

    /**
     * 批量更新文件夹的快照时间
     */
    setFolderMtimes(paths: string[], mtime: number): void {
        for (const path of paths) {
            this.snapshotMap.set(path, mtime);
        }
        this.saveToStorage();
    }

    /**
     * 删除路径快照
     */
    removeFolder(path: string): void {
        const removed = this.snapshotMap.delete(path);
        const removedRevision = this.revisions.delete(path);
        if (removed || removedRevision) {
            this.scheduleSave();
        }
    }

    /**
     * 批量删除文件夹快照
     */
    removeFolders(paths: Iterable<string>): void {
        let changed = false;
        for (const path of paths) {
            if (this.snapshotMap.delete(path) || this.revisions.delete(path)) {
                changed = true;
            }
        }
        if (changed) {
            this.scheduleSave();
        }
    }

    /**
     * 从 localStorage 加载快照
     */
    private loadFromStorage(): boolean {
        try {
            let data = this.plugin.app.loadLocalStorage(this.storageKey) as string | null;

            // 迁移逻辑：如果新键无数据，按由新到旧依次回溯历史键格式
            if (!data) {
                const vaultName = this.plugin.app.vault.getName();
                const legacyKeys = [
                    `fns-${vaultName}-folderSnapshot`,                  // 上一版：绑定本地库名的稳定前缀
                    `fast-note-sync-${vaultName}-folderSnapshot`,       // 更早版
                    `fast-note-sync-${vaultName}-folder-snapshot`,      // 更更早版
                    `fast-note-sync-folder-snapshot-${vaultName}`,      // 最原始格式
                ];
                for (const legacyKey of legacyKeys) {
                    data = this.plugin.app.loadLocalStorage(legacyKey) as string | null;
                    if (data) break;
                }

                if (data) {
                    dump("FolderSnapshotManager: legacy snapshot data found, migrating");
                    this.plugin.app.saveLocalStorage(this.storageKey, data);
                } else {
                    return false;
                }
            }
            return this.parseAndLoad(data);
        } catch (error) {
            dump("FolderSnapshotManager: failed to load snapshot", error);
            return false;
        }
    }

    /**
     * 解析快照数据并装入 this.snapshotMap
     */
    private parseAndLoad(data: string): boolean {
        try {
            const parsed = JSON.parse(data) as Record<string, number>;
            this.snapshotMap = new Map(
                Object.entries(parsed).map(([key, value]) => [key, Number(value)])
            );
            this.digest = computeMirrorDigest(JSON.stringify(Object.fromEntries(this.snapshotMap)));
            return true;
        } catch (error) {
            dump("FolderSnapshotManager: failed to parse snapshot data", error);
            return false;
        }
    }

    /**
     * 清空快照表与目录基线（切换远端笔记库名时调用）。
     * 旧库的目录 mtime 与 revision 都属于旧作用域，必须连同快照一起丢弃，
     * 否则新库会把这些目录当成“曾经同步、服务端已删除”。
     *
     * Clear the snapshot and folder baselines (called when switching the remote vault name).
     * The old vault's mtimes and revisions belong to the previous remote scope and must be
     * dropped with the snapshot, or the new vault treats these folders as server-deleted.
     */
    clearAll(): void {
        this.snapshotMap.clear()
        this.revisions.clear()
        this.pendingDeleteBaselines.clear()
        this.digest = computeMirrorDigest("{}")
        this.isDirty = false
        // 作用域跟随最新设置后再落盘，避免把旧 scope 写回镜像
        this.baselineScope = computeRemoteScope(this.plugin.settings)
        this.saveToStorage()
        this.flush()
    }

    /**
     * 保存快照到 localStorage，同时镜像写入文件 (兜底移动端 localStorage 被清除)
     */
    private saveToStorage(): void {
        let data: string;
        try {
            const obj = Object.fromEntries(this.snapshotMap);
            data = JSON.stringify(obj);
            this.digest = computeMirrorDigest(data);
        } catch (error) {
            dump("FolderSnapshotManager: failed to serialize snapshot", error);
            return;
        }

        try {
            this.plugin.app.saveLocalStorage(this.storageKey, data);
        } catch (error) {
            dump("FolderSnapshotManager: failed to save snapshot", error);
        }

        // 即使 localStorage 写入失败，镜像写入也照常进行
        this.mirror.scheduleWrite(data);
        this.saveBaselineState();
    }
}
