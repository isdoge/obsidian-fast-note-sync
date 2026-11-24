import { normalizePath } from "obsidian";

import { hashContentAsync, dump, dumpError, configIsPathExcluded, getConfigSyncCustomDirs, showSyncNotice, hashFileAsync, debounce, LocalStateFileMirror, computeMirrorDigest } from "../utils/helpers";
import { configAllPaths } from "../sync/operator_config";
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
 * 配置哈希管理器
 * 负责管理配置文件路径与哈希值的映射关系,存储在 localStorage 中
 */
export class ConfigHashManager {
    private plugin: FastSync;
    /** 本地磁盘哈希缓存；扫描只允许写这里 / Local disk-hash cache; scans may only write here */
    private hashMap: Map<string, HashCache> = new Map();
    /** 可信同步基线：只由服务端确认（SettingModifyAck / 远端推送落盘 / 相等核验）写入 */
    /** Trusted baseline: written only at server-confirmed moments (Ack / remote push / equality) */
    private syncHashMap: Map<string, string> = new Map();
    private confirmedPaths: Set<string> = new Set();
    private storageKey: string;
    private syncStorageKey: string;
    private confirmedStorageKey: string;
    /** 服务端确认的 revision 与待删基线（设计稿 §5.1）/ Server-confirmed revisions and pre-delete baselines (§5.1) */
    private baselineStorageKey: string;
    private revisions: Map<string, string> = new Map();
    private pendingDeleteBaselines: Map<string, BaselineDeleteRecord> = new Map();
    private baselineScope: string = "";
    private baselineMirror: LocalStateFileMirror;
    private syncMirror: LocalStateFileMirror;
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
        this.storageKey = `fns-configHashMap`;
        this.syncStorageKey = `fns-configSyncHashMap`;
        this.confirmedStorageKey = `fns-configSyncHashMapConfirmed`;
        this.baselineStorageKey = `fns-configBaselineState`;
        this.debouncedFlush = debounce(() => this.flush(), 500);
        this.mirror = new LocalStateFileMirror(plugin, "configHashMap.json");
        this.syncMirror = new LocalStateFileMirror(plugin, "configSyncHashMap.json");
        this.baselineMirror = new LocalStateFileMirror(plugin, "configBaselineState.json");
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
     * 只在 localStorage 不存在时执行完整的配置文件遍历；localStorage 未命中时先尝试文件镜像恢复，
     * 镜像也没有才真正重建
     */
    async initialize(): Promise<void> {
        dump("ConfigHashManager: starting init");

        // 先恢复可信基线与确认来源，再恢复磁盘缓存：后者的 saveToStorage() 也会写基线表，
        // 顺序反了会用构造时的空表覆盖旧基线（与 FileHashManager 的 iOS 清除事故同理）。
        // Restore the trusted baseline and its provenance before the disk cache: the latter's
        // saveToStorage() also writes the baseline, and the wrong order would overwrite it.
        const hasSync = this.loadSyncFromStorage();
        if (!hasSync || this.syncHashMap.size === 0) {
            const mirroredSync = await this.syncMirror.read();
            if (mirroredSync && this.parseAndLoadSync(mirroredSync) && this.syncHashMap.size > 0) {
                this.saveSyncToStorage();
            }
        }
        this.loadConfirmedFromStorage();
        await this.loadBaselineState();

        // 尝试从 localStorage 加载
        const loaded = this.loadFromStorage();

        if (loaded) {
            dump(`ConfigHashManager: loaded from localStorage (${this.hashMap.size} configs)`);
            this.restoredFromPersisted = true;
            this.isInitialized = true;
            return;
        }

        // localStorage 未命中：尝试从文件镜像恢复，不弹通知、不重建
        const mirrored = await this.mirror.read();
        if (mirrored && this.parseAndLoad(mirrored)) {
            dump("ConfigHashManager: restored hash map from file mirror");
            this.restoredFromPersisted = true;
            this.saveToStorage();
            this.isInitialized = true;
            return;
        }

        dump("ConfigHashManager: no data in localStorage or file mirror, building config hash map");
        this.restoredFromPersisted = false;
        await this.buildConfigHashMap();
        this.isInitialized = true;
    }

    wasRebuilt(): boolean {
        return !this.restoredFromPersisted;
    }

    getDigest(): string {
        if (this.isDirty || !this.digest) {
            this.digest = computeMirrorDigest(JSON.stringify(Object.fromEntries(this.hashMap)));
        }
        return this.digest;
    }

    /**
     * 检查是否已初始化
     */
    isReady(): boolean {
        return this.isInitialized;
    }

    private async buildConfigHashMap(): Promise<void> {
        const notice = showSyncNotice($("ui.notice.config_hash_init_start"), 0);

        try {
            // 获取所有配置文件路径
            const configDir = this.plugin.app.vault.configDir;
            const customDirs = getConfigSyncCustomDirs(this.plugin);
            const configPaths = await configAllPaths([configDir, ...customDirs], this.plugin);

            // 添加 LocalStorage 虚拟路径
            const localStorageConfigs = await this.plugin.localStorageManager.getStorageConfigs();
            const allPaths = [...configPaths, ...localStorageConfigs.map(c => c.path)];

            const totalConfigs = allPaths.length;
            let processedConfigs = 0;

            dump(`ConfigHashManager: scanning ${totalConfigs} configs`);

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

            for (const path of allPaths) {
                // 跳过已排除的配置
                if (configIsPathExcluded(path, this.plugin)) {
                    processedConfigs++;
                    continue;
                }

                await scheduleHashTask(async () => {
                    let contentHash: string;

                    // 检查是否为 LocalStorage 虚拟路径
                    if (path.startsWith(this.plugin.localStorageManager.syncPathPrefix)) {
                        const key = this.plugin.localStorageManager.pathToKey(path);
                        if (key) {
                            let value: string | null = this.plugin.localStorageManager.getItemValue(key);
                            if (value) {
                                contentHash = await hashContentAsync(value);
                                this.hashMap.set(path, { hash: contentHash, mtime: 0, size: 0 });
                                value = null; // 显式释放引用 (Explicitly release reference)
                            }
                        }
                    } else {
                        // 从文件系统读取配置文件
                        // 注意：configAllPaths 返回的已经是相对于 Vault 的路径，无需再拼接 configDir
                        const filePath = normalizePath(path);
                        try {
                            const stat = await this.plugin.app.vault.adapter.stat(filePath);
                            if (stat) {
                                contentHash = await hashFileAsync(this.plugin.app, filePath);
                                this.hashMap.set(path, { hash: contentHash, mtime: stat.mtime, size: stat.size });
                            }
                        } catch (error) {
                            dumpError("Failed to read config file:", error);
                        }
                    }
                });

                processedConfigs++;

                // 每处理 50 个配置更新一次进度
                if (processedConfigs % 50 === 0) {
                    notice.setMessage($("ui.notice.config_hash_init_progress", { done: processedConfigs, total: totalConfigs }));
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

            notice.setMessage($("ui.notice.config_hash_init_done", { total: totalConfigs }));
            window.setTimeout(() => notice.hide(), 3000);

            dump(`ConfigHashManager: build complete, ${totalConfigs} configs`);
        } catch (error) {
            notice.hide();
            const errorMsg = error instanceof Error ? error.message : String(error);
            showSyncNotice($("ui.notice.config_hash_init_failed", { msg: errorMsg }));
            dump("ConfigHashManager: build failed", error);
            throw error;
        }
    }

    // ─── 阶段 E：服务端确认的 revision 与待删基线（设计稿 §5.1）──────────────────

    private ensureBaselineScope(): void {
        const scope = computeRemoteScope(this.plugin.settings);
        if (scope === this.baselineScope) return;
        this.baselineScope = scope;
        this.revisions.clear();
        this.pendingDeleteBaselines.clear();
        this.confirmedPaths.clear();
        dump("ConfigHashManager: remote scope changed; revisions and confirmed provenance cleared");
        this.saveBaselineState();
        this.saveSyncToStorage();
        // 旧目标的冲突记录不再有意义。登记成待执行的清理，下一轮同步开始 / 写入新冲突前
        // 会等待它完成，失败则保留标志重试。
        // Old-target conflicts are meaningless. Register a tracked cleanup that the next sync
        // round / conflict write awaits; failures keep a retry flag.
        scheduleConflictRecordReset(this.plugin, "config baseline scope changed");
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
            this.confirmedPaths.clear();
            dump("ConfigHashManager: stored baseline belongs to another remote target; tokens discarded");
            this.saveBaselineState();
            this.saveSyncToStorage();
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
            dump("ConfigHashManager: failed to save baseline state", error);
        }
        this.baselineMirror.scheduleWrite(data);
    }

    /** 该路径服务端确认过的 revision 令牌 / Server-confirmed revision token for a path */
    getBaselineRevision(path: string): string | null {
        this.ensureBaselineScope();
        return this.revisions.get(path) ?? null;
    }

    getConfirmedBaseline(path: string, localContentHash: string | null = null): { hash: string; revision: string } | null {
        this.ensureBaselineScope();
        if (!this.confirmedPaths.has(path)) return null;
        const hash = this.getVerifiedPathHash(path, localContentHash);
        const revision = this.revisions.get(path);
        if (hash === null || !revision) return null;
        return { hash, revision };
    }

    isBaselineConfirmed(path: string): boolean {
        this.ensureBaselineScope();
        return this.confirmedPaths.has(path) && this.revisions.has(path);
    }

    setConfirmedBaseline(path: string, hash: string, revision: string, mtime: number = 0, size: number = 0): void {
        this.ensureBaselineScope();
        this.hashMap.set(path, { hash, mtime, size });
        this.syncHashMap.set(path, hash);
        this.confirmedPaths.add(path);
        if (revision !== "") this.revisions.set(path, revision);
        this.scheduleSave();
    }

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
     * 获取有效的哈希值
     */
    getValidHash(path: string, mtime: number, size: number): string | null {
        const cache = this.hashMap.get(path);
        // 如果 mtime 和 size 为 0，通常是虚拟路径或旧数据，强制重新校验
        if (cache && cache.mtime === mtime && cache.size === size && mtime !== 0) {
            return cache.hash;
        }
        return null;
    }

    /**
     * 获取指定路径的可信同步基线哈希（不再回退到本地扫描缓存）
     * Trusted sync baseline for a path (never falls back to the scan cache)
     */
    getPathHash(path: string): string | null {
        return this.syncHashMap.get(path) || null;
    }

    /**
     * 判断基线在当前本地内容下是否可信：确认过的直接可信；旧版持久化基线仅当内容相等时可信。
     * Whether the baseline is trustworthy for the current local content. Confirmed entries are
     * trusted; legacy persisted entries only while local content still equals the recorded value.
     */
    getVerifiedPathHash(path: string, localContentHash: string | null): string | null {
        const stored = this.syncHashMap.get(path);
        if (stored === undefined) return null;
        if (this.confirmedPaths.has(path)) return stored;
        return localContentHash !== null && localContentHash === stored ? stored : null;
    }

    /**
     * 获取已同步（服务端确认过）的所有配置路径
     * All config paths with a server-confirmed baseline
     */
    getAllPaths(): string[] {
        return Array.from(this.syncHashMap.keys());
    }

    /**
     * 添加或更新单个配置的哈希（仅服务端确认/相等核验路径调用）
     * Add/update one config hash (only server-confirmed or equality-verified paths call this)
     */
    setFileHash(path: string, hash: string, mtime: number = 0, size: number = 0, revision?: string): void {
        this.ensureBaselineScope();
        this.hashMap.set(path, { hash, mtime, size });
        const previousHash = this.syncHashMap.get(path);
        this.syncHashMap.set(path, hash);
        this.confirmedPaths.add(path);
        if (revision !== undefined && revision !== "") {
            this.revisions.set(path, revision);
        } else if (previousHash !== undefined && previousHash !== hash) {
            this.revisions.delete(path);
        }
        this.scheduleSave();
    }

    async setFileHashes(entries: Iterable<[string, string]>, getStat?: (path: string) => Promise<{ mtime?: number; size?: number } | null | undefined> | { mtime?: number; size?: number } | null | undefined): Promise<void> {
        let changed = false;
        for (const [path, hash] of entries) {
            const stat = await getStat?.(path);
            this.hashMap.set(path, { hash, mtime: stat?.mtime || 0, size: stat?.size || 0 });
            changed = true;
        }
        if (changed) this.saveToStorage();
    }

    /**
     * 批量从扫描的哈希表中设置并持久化一次
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
        if (changed) this.saveToStorage();
    }


    /**
     * 删除指定路径的哈希
     */
    removeFileHash(path: string): void {
        const deleted = this.hashMap.delete(path);
        const deletedBase = this.syncHashMap.delete(path);
        this.confirmedPaths.delete(path);
        this.revisions.delete(path);
        if (deleted || deletedBase) {
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
                    `fns-${vaultName}-configHashMap`,                     // 上一版：绑定本地库名的稳定前缀
                    `fast-note-sync-${vaultName}-configHashMap`,          // 更早版
                    `fast-note-sync-${vaultName}-config-hash-map`,        // 更更早版
                    `fast-note-sync-config-hash-map-${vaultName}`,        // 最原始格式
                ];
                for (const legacyKey of legacyKeys) {
                    data = this.plugin.app.loadLocalStorage(legacyKey) as string | null;
                    if (data) break;
                }

                if (data) {
                    dump("ConfigHashManager: legacy config hash data found, migrating");
                    this.plugin.app.saveLocalStorage(this.storageKey, data);
                } else {
                    return false;
                }
            }

            return this.parseAndLoad(data);
        } catch (error) {
            dump("ConfigHashManager: failed to load from localStorage", error);
            return false;
        }
    }

    private loadSyncFromStorage(): boolean {
        try {
            const data = this.plugin.app.loadLocalStorage(this.syncStorageKey) as string | null;
            if (!data) return false;
            return this.parseAndLoadSync(data);
        } catch (error) {
            dump("ConfigHashManager: failed to load sync baseline from localStorage", error);
            return false;
        }
    }

    private parseAndLoadSync(data: string): boolean {
        try {
            const parsed = JSON.parse(data) as Record<string, string>;
            this.syncHashMap = new Map(Object.entries(parsed));
            return true;
        } catch (error) {
            dump("ConfigHashManager: failed to parse sync baseline data", error);
            return false;
        }
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
            dump("ConfigHashManager: failed to load confirmed baseline provenance", error);
        }
    }

    private saveSyncToStorage(): void {
        let data: string;
        try {
            data = JSON.stringify(Object.fromEntries(this.syncHashMap));
        } catch (error) {
            dump("ConfigHashManager: failed to serialize sync baseline", error);
            return;
        }
        try {
            this.plugin.app.saveLocalStorage(this.syncStorageKey, data);
            this.plugin.app.saveLocalStorage(this.confirmedStorageKey, JSON.stringify(Array.from(this.confirmedPaths)));
        } catch (error) {
            dump("ConfigHashManager: failed to save sync baseline to localStorage", error);
        }
        this.syncMirror.scheduleWrite(data);
    }

    /**
     * 解析哈希表数据并装入 this.hashMap，兼容旧版仅存哈希字符串的格式
     */
    private parseAndLoad(data: string): boolean {
        try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const migratedMap = new Map<string, HashCache>();
            let needsSave = false;

            for (const [path, value] of Object.entries(parsed)) {
                if (typeof value === "string") {
                    migratedMap.set(path, { hash: value, mtime: 0, size: 0 });
                    needsSave = true;
                } else {
                    migratedMap.set(path, value as HashCache);
                }
            }

            this.hashMap = migratedMap;
            this.digest = computeMirrorDigest(JSON.stringify(Object.fromEntries(this.hashMap)));
            if (needsSave) this.saveToStorage();

            return true;
        } catch (error) {
            dump("ConfigHashManager: failed to parse hash map data", error);
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
            this.digest = computeMirrorDigest(data);
        } catch (error) {
            dump("ConfigHashManager: failed to serialize hash map", error);
            return;
        }

        try {
            this.plugin.app.saveLocalStorage(this.storageKey, data);
        } catch (error) {
            dump("ConfigHashManager: failed to save to localStorage", error);
            const errorMsg = error instanceof Error ? error.message : String(error);
            showSyncNotice($("ui.notice.config_hash_save_failed", { msg: errorMsg }));
        }

        // 即使 localStorage 写入失败 (如配额)，镜像写入也照常进行
        this.mirror.scheduleWrite(data);
        this.saveSyncToStorage();
        this.saveBaselineState();
    }

    /**
     * 手动重建哈希表
     * 用于命令面板
     */
    async rebuildHashMap(): Promise<void> {
        dump("ConfigHashManager: manual config hash map rebuild");
        // 只重建磁盘缓存；手动重建不是服务端确认，不能据此生成可信基线
        // Rebuild only the disk cache; a manual rebuild is not server confirmation.
        this.hashMap.clear();
        await this.buildConfigHashMap();
        this.scheduleSave();
    }

    /**
     * 清理哈希表内容
     */
    clearAll(): void {
        this.hashMap.clear();
        this.syncHashMap.clear();
        this.confirmedPaths.clear();
        this.revisions.clear();
        this.pendingDeleteBaselines.clear();
        // 基线作用域跟随最新设置后再落盘（切库后旧 scope 的令牌不得留在新库镜像里）
        // Re-anchor the baseline scope before persisting (old-scope tokens must not survive a switch)
        this.baselineScope = computeRemoteScope(this.plugin.settings);
        this.saveToStorage();
    }

    /**
     * 清理已排除配置的哈希
     * 当配置排除设置变更时调用
     */
    cleanupExcludedHashes(): void {
        let deletedCount = 0;
        for (const path of this.hashMap.keys()) {
            if (configIsPathExcluded(path, this.plugin)) {
                this.hashMap.delete(path);
                this.syncHashMap.delete(path);
                this.confirmedPaths.delete(path);
                this.revisions.delete(path);
                deletedCount++;
            }
        }

        if (deletedCount > 0) {
            dump(`ConfigHashManager: cleaned up ${deletedCount} hashes of excluded configs`);
            this.scheduleSave();
        }
    }

    /**
     * 获取统计信息
     */
    getStats(): { totalConfigs: number; storageKey: string } {
        return {
            totalConfigs: this.hashMap.size,
            storageKey: this.storageKey,
        };
    }
}
