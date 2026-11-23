import type FastSync from "../../main";
import { LocalStateFileMirror, computeMirrorDigest, generateUUID, dump, isPathExcluded, isFolderSyncPathExcluded, hashContentAsync, hashFileAsync, showSyncNotice } from "../utils/helpers";
import { HttpApiService } from "../api/http_api_service";
import { SyncLogManager } from "./sync_log_manager";
import { noteDeleteByPath, noteRename } from "./operator_note";
import { fileDeleteByPath, fileRename } from "./operator_file";
import { folderDeleteByPath, folderRename } from "./operator_folder";

export const RETRY_QUEUE_MAX_ENTRIES = 2000;
export const RETRY_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// pkg/code/common.go: invalid input, invalid credentials/restrictions, disabled access,
// invalid storage configuration and an occupied rename target need user intervention.
export const DETERMINISTIC_MUTATION_ERRORS = new Set([305, 306, 307, 308, 309, 310,
    312, 313, 314, 315, 411, 414, 422, 423, 438, 444]);
const RETRY_DELAYS = [2000, 5000, 15000, 60000];
type ObjectType = "note" | "file" | "folder";
type Operation = "delete" | "rename";
export interface RetryQueueEntry {
    id: string;
    objectType: ObjectType;
    operation: Operation;
    path: string;
    oldPath?: string;
    createdAt: number;
    attempts: number;
    baselineHash: string;
    /** 源路径服务端 revision（基线模式）/ Source-path server revision (baseline mode) */
    baselineRevision?: string;
    /** 源路径没有可信基线 / Source path had no trusted baseline */
    baselineMissing?: boolean;
}

/** Only observed vault mutations enter here; scans must never manufacture tombstones. */
export class RetryQueue {
    public entries: RetryQueueEntry[] = [];
    private mirror: LocalStateFileMirror;
    private api: HttpApiService;
    private scope: string;
    private timer: number | null = null;
    private busy = false;
    private stopped = false;
    private generation = 0;
    private active: RetryQueueEntry | null = null;
    private activeTargetStat = "";
    private activeSourceStat = "";
    private due = 0;
    private liveFolders = new Set<string>();
    private replayedPaths = new Map<string, ObjectType>();
    private recoveryPaths = new Map<string, ObjectType>();
    private retiredAckKeys = new Set<string>();
    private reconnectRequested = false;
    private waiters: (() => void)[] = [];

    constructor(private plugin: FastSync) {
        this.scope = this.getScope();
        this.mirror = new LocalStateFileMirror(plugin, "retryQueue.json");
        this.api = new HttpApiService(plugin);
    }

    private getScope(): string {
        const s = this.plugin.settings;
        return computeMirrorDigest(`${(s.api || "").trim().replace(/\/+$/, "")}\0${(s.vault || "").trim()}\0${(s.apiToken || "").trim()}`);
    }

    async initialize(): Promise<void> {
        this.scope = this.getScope();
        const raw = await this.mirror.read();
        try {
            const data = (raw ? JSON.parse(raw) : null) as { version?: unknown; scope?: unknown; entries?: RetryQueueEntry[] } | null;
            if (data?.version === 1 && data.scope === this.scope && Array.isArray(data.entries)) {
                this.entries = data.entries.filter((e: RetryQueueEntry) => e && typeof e.id === "string"
                    && ["note", "file", "folder"].includes(e.objectType) && ["delete", "rename"].includes(e.operation)
                    && this.validPath(e.path) && (e.operation !== "rename" || this.validPath(e.oldPath))
                    && Number.isFinite(e.createdAt) && e.createdAt >= 0 && e.createdAt <= Date.now()
                    && Number.isInteger(e.attempts) && e.attempts >= 0 && typeof e.baselineHash === "string"
                    && (e.baselineRevision === undefined || typeof e.baselineRevision === "string")
                    && (e.baselineMissing === undefined || typeof e.baselineMissing === "boolean"));
            } else if (raw) dump("[RetryQueue] Invalid file or scope changed; discarding queue");
        } catch (error) {
            dump("[RetryQueue] Corrupt file; ignoring queue", error);
        }
        this.entries.sort((a, b) => a.createdAt - b.createdAt);
        this.prune();
        this.persist();
    }

    private validPath(path: unknown): path is string {
        return typeof path === "string" && path.length > 0 && !path.startsWith("/")
            && !path.includes("\\") && !path.split("/").some(part => !part || part === "." || part === "..");
    }

    private persist(): void {
        this.mirror.scheduleWrite(JSON.stringify({ version: 1, scope: this.scope, entries: this.entries }));
        // Mutation durability is urgent; reuse the mirror's serialized writer, bypassing debounce.
        this.mirror.flush();
    }

    private checkScope(): void {
        const scope = this.getScope();
        if (scope !== this.scope) {
            this.generation++;
            for (const e of this.entries) this.release(e);
            this.entries = [];
            this.active = null;
            this.liveFolders.clear();
            this.replayedPaths.clear();
            this.recoveryPaths.clear();
            this.scope = scope;
            this.persist();
            dump("[RetryQueue] Scope changed; discarding queue");
        }
    }

    private excluded(kind: ObjectType, path: string): boolean {
        return kind === "folder" ? isFolderSyncPathExcluded(path, this.plugin) : isPathExcluded(path, this.plugin);
    }

    observe(objectType: ObjectType, operation: Operation, path: string, oldPath?: string): void {
        this.checkScope();
        const p = this.plugin;
        if (this.stopped || !p.settings.syncEnabled || p.settings.readonlySyncEnabled || p.settings.manualSyncEnabled) return;
        if (!this.validPath(path) || (operation === "rename" && !this.validPath(oldPath))) return;
        // Remote rename handlers protect both paths, including delete/create echoes of target replacement.
        if (p.isIgnoredFile(path) || (oldPath && p.isIgnoredFile(oldPath))
            || p.lastSyncPathDeleted.has(path) || (oldPath && p.lastSyncPathDeleted.has(oldPath))
            || p.lastSyncPathRenamed.has(path) || (oldPath && p.lastSyncPathRenamed.has(oldPath))) return;
        const oldExcluded = oldPath ? this.excluded(objectType, oldPath) : false;
        if (this.excluded(objectType, path)) {
            if (operation === "rename" && !oldExcluded) this.observe(objectType, "delete", oldPath!);
            return;
        }
        // Moving into the sync scope is a create; the regular scan/modify path owns it.
        if (oldExcluded) return;
        this.prune();
        const previous = [...this.entries].reverse().find(e => e.objectType === objectType
            && e.path === (oldPath || path));
        let baselineHash = objectType === "folder" ? "" : p.fileHashManager.getPathHash(oldPath || path) || "";
        // 源路径删除前的服务端 revision：切换远端目标后管理器已清空旧令牌，这里只取当前作用域的值。
        // 管理器只查内存表（已按远端作用域隔离并持久化），离线时同样可读，因此不再以基线模式为前提，
        // 否则离线期间入队的条目会丢失令牌、重连后被服务端判冲突并无限重发。
        // The source path's server revision before deletion; the manager already dropped tokens of
        // another remote target, so this is current-scope only. The manager reads in-memory state
        // (scoped and persisted), which is available offline, so this must not depend on baseline
        // mode: otherwise offline entries carry no token and the server rejects them forever.
        let baselineRevision = objectType === "folder"
            ? (p.folderSnapshotManager?.getBaselineRevision?.(oldPath || path) ?? "")
            : (p.fileHashManager?.getBaselineRevision?.(oldPath || path) ?? "");
        // 老服务端不签发令牌，管理器里也没有令牌，因此仍然按“无基线”发送（与旧行为一致）。
        // An old server issues no tokens and the manager holds none, so "no baseline" is still
        // reported, matching the previous wire behaviour.
        let baselineMissing = baselineRevision === ""
            || (objectType !== "folder" && !p.fileHashManager?.getConfirmedBaseline?.(oldPath || path, null));
        let createdAt = Date.now();
        if (previous) {
            // Sent operations are immutable until ACK/GET settles them. Keep a successor
            // behind them, carrying the original baseline, rather than guessing the outcome.
            if (previous.attempts > 0) {
                baselineHash = previous.baselineHash;
                baselineRevision = previous.baselineRevision ?? baselineRevision;
                baselineMissing = previous.baselineMissing ?? baselineMissing;
            } else {
                baselineHash = previous.baselineHash;
                createdAt = previous.createdAt;
                if (previous.operation === "rename") {
                    if (operation === "rename") oldPath = previous.oldPath;
                    else path = previous.oldPath!;
                }
                this.remove(previous);
                if (operation === "rename" && path === oldPath) { this.persist(); this.kick(); return; }
            }
        }
        const entry: RetryQueueEntry = { id: generateUUID(), objectType, operation, path,
            ...(operation === "rename" ? { oldPath } : {}), createdAt, attempts: 0, baselineHash,
            ...(baselineRevision ? { baselineRevision } : {}), baselineMissing };
        this.entries.push(entry);
        // Folders have no queryable content version. Only the current continuous connection
        // may retry its observed events; restored/offline entries are discarded before sync.
        if (objectType === "folder" && this.connected()) this.liveFolders.add(entry.id);
        this.prune();
        this.persist();
        this.kick();
    }

    onLocalCreate(path: string): void {
        this.checkScope();
        for (const e of [...this.entries]) {
            if (e.operation === "delete" && e.path === path) this.remove(e);
        }
        this.persist();
        this.kick();
    }

    private prune(): void {
        const expired = this.entries.filter(e => Date.now() - e.createdAt > RETRY_QUEUE_MAX_AGE_MS);
        for (const e of expired) this.remove(e);
        if (expired.length) dump(`[RetryQueue] Discarded ${expired.length} expired entries`);
        const excess = this.entries.length - RETRY_QUEUE_MAX_ENTRIES;
        if (excess > 0) {
            for (const e of this.entries.slice(0, excess)) this.remove(e);
            dump(`[RetryQueue] Limit exceeded; discarded ${excess} oldest entries`);
        }
    }

    private connected(): boolean {
        return !this.stopped && this.plugin.websocket?.isAuth && this.plugin.websocket?.isOpen;
    }

    private enabled(): boolean {
        const s = this.plugin.settings;
        return !!s.syncEnabled && !s.readonlySyncEnabled && !s.manualSyncEnabled;
    }

    private release(e: RetryQueueEntry): void {
        if (this.active !== e) return;
        const p = this.plugin;
        if (e.objectType === "note") {
            if (e.operation === "delete") p.pendingNoteDeleteAcks.delete(e.path);
            else p.pendingNoteRenames.delete(e.path);
        } else if (e.objectType === "file") {
            if (e.operation === "delete") p.pendingFileDeleteAcks.delete(e.path);
            else p.pendingFileRenames = p.pendingFileRenames.filter(r => r.newPath !== e.path);
        }
        p.concurrencyLimiter.releaseSlot(e.path);
    }

    private ackKey(e: RetryQueueEntry): string {
        return `${e.objectType}:${e.operation}:${e.path}`;
    }

    shouldIgnoreAck(action: string, path?: string): boolean {
        if (!path) return false;
        const match = /^(Note|File|Folder)(Delete|Rename)Ack$/.exec(action);
        return !!match && this.retiredAckKeys.has(`${match[1].toLowerCase()}:${match[2].toLowerCase()}:${path}`);
    }

    private remove(e: RetryQueueEntry): void {
        if (e.attempts > 0) this.retiredAckKeys.add(this.ackKey(e));
        this.release(e);
        this.entries = this.entries.filter(item => item !== e);
        this.liveFolders.delete(e.id);
        if (this.active === e) { this.active = null; this.activeTargetStat = ""; this.activeSourceStat = ""; this.due = 0; }
        if (e.operation === "rename") this.plugin.eventManager?.resumeQueuedRename(e.path);
    }

    private async localValid(e: RetryQueueEntry): Promise<boolean> {
        const vault = this.plugin.app.vault;
        if (e.operation === "delete") return !vault.getAbstractFileByPath(e.path);
        if (!vault.getAbstractFileByPath(e.path)) return false;
        const old = vault.getAbstractFileByPath(e.oldPath!);
        if (!old) return true;
        if (!e.baselineHash || e.objectType === "folder") return false;
        const hash = e.objectType === "note" ? await hashContentAsync(await vault.read(old as Parameters<typeof vault.read>[0]))
            : await hashFileAsync(this.plugin.app, e.oldPath!);
        return hash === e.baselineHash;
    }

    /**
     * 2.6.4–2.6.9 在离线期间落盘的条目没有版本令牌。重连确认基线模式后、发送前从管理器补一次；
     * 只有管理器记录的内容哈希与条目基线一致时才采用，查不到则保持原样（随后由队列清理兜底）。
     * Entries persisted offline by 2.6.4–2.6.9 carry no revision token. Once the connection confirms
     * baseline mode, fill it from the manager before sending, but only when the manager's hash still
     * matches the entry's recorded baseline; otherwise leave the entry unchanged.
     */
    private refillBaselineToken(e: RetryQueueEntry): void {
        if (e.baselineRevision || this.plugin.isSyncBaselineModeEnabled?.() !== true) return;
        const key = e.oldPath || e.path;
        if (e.objectType === "folder") {
            const revision = this.plugin.folderSnapshotManager?.getBaselineRevision?.(key) ?? "";
            if (!revision) return;
            e.baselineRevision = revision;
            e.baselineMissing = false;
        } else {
            const confirmed = this.plugin.fileHashManager?.getConfirmedBaseline?.(key, null);
            if (!confirmed || confirmed.hash !== e.baselineHash) return;
            e.baselineRevision = confirmed.revision;
            e.baselineMissing = false;
        }
        this.persist();
    }

    private async safe(e: RetryQueueEntry): Promise<boolean> {
        if (!await this.localValid(e)) return false;
        if (this.excluded(e.objectType, e.path) || (e.oldPath && this.excluded(e.objectType, e.oldPath))) return false;
        if (e.objectType === "folder") return this.liveFolders.has(e.id);
        if (!e.baselineHash) return false;
        const source = await this.api.getRetryQueueState(e.objectType, e.oldPath || e.path);
        if (!source || source.contentHash !== e.baselineHash) return false;
        if (e.operation === "rename") {
            const target = await this.api.getRetryQueueState(e.objectType, e.path);
            if (target) return false;
        }
        return true;
    }

    private matches(e: RetryQueueEntry, action: string, data: { path?: string; oldPath?: string }): boolean {
        const prefix = e.objectType[0].toUpperCase() + e.objectType.slice(1);
        return action === `${prefix}${e.operation === "delete" ? "Delete" : "Rename"}`
            && data.path === e.path && (e.operation !== "rename" || data.oldPath === e.oldPath);
    }

    /** Capture identity before any slot/buffer await; a coalesced entry must never send later. */
    sendGuard(action: string, data: { path?: string; oldPath?: string }): (() => boolean) | undefined {
        const e = this.active;
        if (!e || !this.matches(e, action, data)) return undefined;
        const generation = this.generation;
        const vault = this.plugin.app.vault;
        const target = vault.getAbstractFileByPath(e.path);
        const source = e.oldPath ? vault.getAbstractFileByPath(e.oldPath) : null;
        const sourceStat = e.attempts > 0 ? this.activeSourceStat : source && "stat" in source ? JSON.stringify(source.stat) : "";
        const targetStat = e.attempts > 0 ? this.activeTargetStat : target && "stat" in target ? JSON.stringify(target.stat) : "";
        return () => this.active === e && this.entries.includes(e) && generation === this.generation
            && this.getScope() === this.scope && this.connected() && this.enabled()
            && (e.operation === "delete" ? !vault.getAbstractFileByPath(e.path)
                : vault.getAbstractFileByPath(e.path) === target && !!target
                    && (!("stat" in target) || JSON.stringify(target.stat) === targetStat)
                    && vault.getAbstractFileByPath(e.oldPath!) === source
                    && (!source || !("stat" in source) || JSON.stringify(source.stat) === sourceStat));
    }

    /** Last remote check runs after the path lock, slot and socket buffer wait. */
    async beforeSend(action: string, data: { path?: string; oldPath?: string }): Promise<boolean> {
        const e = this.active;
        const guard = this.sendGuard(action, data);
        if (!e || !guard || !guard()) return false;
        if (e.operation !== "delete" || e.objectType === "folder") return true;
        let safe = false;
        try {
            const source = await this.api.getRetryQueueState(e.objectType, e.path);
            safe = !!source && source.contentHash === e.baselineHash;
        } catch (error) { dump("[RetryQueue] Final state check failed", e.path, error); }
        if (!guard()) return false;
        if (safe) return true;
        dump("[RetryQueue] Remote state changed before send; discarding operation", e.path);
        SyncLogManager.getInstance().addLog("send", "RetryQueueDiscard", "Final remote state check failed; operation cancelled", "cancelled", e.path);
        this.recoveryPaths.set(e.path, e.objectType);
        this.remove(e);
        this.persist();
        return false;
    }

    /** The queue is serial; legacy replies identify its active sent operation by action. */
    reject(action: string, path: string | undefined, code: number, message: string): boolean {
        if (path && this.shouldIgnoreAck(action, path)) return true;
        const e = this.active;
        if (!e || e.attempts === 0 || (path && path !== e.path)) return false;
        const expected = `${e.objectType[0].toUpperCase() + e.objectType.slice(1)}${e.operation === "delete" ? "Delete" : "Rename"}`;
        if (action !== expected && action !== `${expected}Ack`) return false;
        if (!DETERMINISTIC_MUTATION_ERRORS.has(code)) return true;
        this.recoveryPaths.set(e.oldPath || e.path, e.objectType);
        this.remove(e);
        this.persist();
        showSyncNotice(`Service rejected ${expected}: ${e.path} (Code=${code}) ${message}`);
        this.kick();
        return true;
    }

    canSend(action: string, data: { path?: string; oldPath?: string }): boolean {
        return this.sendGuard(action, data)?.() ?? false;
    }

    onSent(action: string, data: { path?: string; oldPath?: string }): void {
        const e = this.active;
        if (!e || !this.matches(e, action, data)) return;
        e.attempts++;
        this.due = Date.now() + RETRY_DELAYS[Math.min(e.attempts - 1, RETRY_DELAYS.length - 1)];
        const target = this.plugin.app.vault.getAbstractFileByPath(e.path);
        const source = e.oldPath ? this.plugin.app.vault.getAbstractFileByPath(e.oldPath) : null;
        this.activeTargetStat = target && "stat" in target ? JSON.stringify(target.stat) : "";
        this.activeSourceStat = source && "stat" in source ? JSON.stringify(source.stat) : "";
        this.replayedPaths.set(e.oldPath || e.path, e.objectType);
        this.replayedPaths.set(e.path, e.objectType);
        this.persist();
        this.kick();
    }

    ownsPendingPath(path: string): boolean {
        return this.active?.path === path;
    }

    matchesAck(action: string, path?: string): boolean {
        const e = this.active;
        return !!e && action.endsWith("Ack") && e.attempts > 0 && !!path && !this.shouldIgnoreAck(action, path) && this.matches(e, action.replace(/Ack$/, ""), { path, oldPath: e.oldPath });
    }

    acknowledge(action: string, path?: string): boolean {
        if (!this.matchesAck(action, path)) return false;
        this.remove(this.active!);
        this.persist();
        this.kick();
        return true;
    }

    shouldSkipScanDelete(path: string): boolean {
        return this.replayedPaths.has(path) || this.recoveryPaths.has(path)
            || this.entries.some(e => e.path === path || e.oldPath === path);
    }

    getRecoveryPaths(kind: ObjectType): string[] {
        return [...this.recoveryPaths].filter(([path, type]) => type === kind
            && !this.plugin.app.vault.getAbstractFileByPath(path) && !this.excluded(kind, path)).map(([path]) => path);
    }

    completeScan(types: readonly string[] = ["note", "file", "folder"]): void {
        for (const [path, type] of this.replayedPaths) if (types.includes(type)) this.replayedPaths.delete(path);
        for (const [path, type] of this.recoveryPaths) if (types.includes(type)) this.recoveryPaths.delete(path);
    }

    resume(): void {
        this.kick();
    }

    private kick(): void {
        if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
        if (!this.connected() || !this.enabled() || this.plugin.isSyncing) { this.settleWaiters(); return; }
        if (this.busy) return;
        const delay = this.active ? Math.max(0, this.due - Date.now()) : 0;
        if (delay > 0) this.timer = window.setTimeout(() => { this.timer = null; void this.pump(); }, delay);
        else void this.pump();
    }

    private async pump(): Promise<void> {
        if (this.busy || !this.connected() || !this.enabled() || this.plugin.isSyncing) return;
        this.busy = true;
        this.checkScope();
        this.prune();
        const generation = this.generation;
        const e = this.active || this.entries[0];
        try {
            if (!e) return;
            this.active = e;
            if (this.retiredAckKeys.has(this.ackKey(e))) {
                // The wire ACK has no operation ID. A new operation with the same action/path
                // needs a fresh socket, otherwise a duplicate old ACK could confirm it.
                this.due = Date.now() + 60000;
                if (!this.reconnectRequested) {
                    this.reconnectRequested = true;
                    this.plugin.websocket.unRegister();
                    this.plugin.websocket.triggerReconnect();
                }
                return;
            }
            let safe = false;
            try { safe = await this.safe(e); }
            catch (error) { dump("[RetryQueue] State check failed; discarding operation", e.path, error); }
            if (generation !== this.generation || !this.connected() || !this.entries.includes(e)) return;
            if (!safe) {
                dump("[RetryQueue] State no longer safe; discarding operation", e.objectType, e.operation, e.path);
                this.recoveryPaths.set(e.oldPath || e.path, e.objectType);
                SyncLogManager.getInstance().addLog("send", "RetryQueueDiscard", "Local or remote state changed, or the state check failed; operation cancelled", "cancelled", e.path);
                this.remove(e);
                this.persist();
                return;
            }
            // Recheck local state after HTTP yields. The send guard also checks identity after drain.
            if (!await this.localValid(e)) { this.remove(e); this.persist(); return; }
            if (generation !== this.generation || !this.connected() || !this.entries.includes(e)) return;
            this.refillBaselineToken(e);
            if (this.active === e && e.attempts > 0) {
                const action = `${e.objectType[0].toUpperCase() + e.objectType.slice(1)}${e.operation === "delete" ? "Delete" : "Rename"}`;
                const guard = this.sendGuard(action, { path: e.path, oldPath: e.oldPath });
                if (guard && !guard()) {
                    this.recoveryPaths.set(e.oldPath || e.path, e.objectType);
                    SyncLogManager.getInstance().addLog("send", "RetryQueueDiscard", "Local content changed after the request; retransmission cancelled", "cancelled", e.path);
                    this.remove(e);
                    this.persist();
                    return;
                }
            }
            this.due = Date.now() + 2000; // Lock/slot/socket failure retains the entry, with no finite retry limit.
            const action = `${e.objectType[0].toUpperCase() + e.objectType.slice(1)}${e.operation === "delete" ? "Delete" : "Rename"}`;
            const guard = this.sendGuard(action, { path: e.path, oldPath: e.oldPath });
            if (e.operation === "delete") {
                const explicit = { hash: e.baselineHash, hashMissing: e.baselineMissing === true, revision: e.baselineRevision || "" };
                const send = e.objectType === "note" ? noteDeleteByPath : e.objectType === "file" ? fileDeleteByPath : folderDeleteByPath;
                await send(e.path, this.plugin, guard, explicit);
            } else {
                const file = this.plugin.app.vault.getAbstractFileByPath(e.path);
                if (!file) { this.remove(e); this.persist(); return; }
                if (e.objectType === "note") await noteRename(file, e.oldPath!, this.plugin, false, guard, e.baselineHash, e.baselineRevision);
                else if (e.objectType === "file") await fileRename(file, e.oldPath!, this.plugin, false, guard, e.baselineHash, e.baselineRevision);
                else await folderRename(file as Parameters<typeof folderRename>[0], e.oldPath!, this.plugin, false, guard, e.baselineRevision);
            }
        } catch (error) {
            dump("[RetryQueue] Send failed; retaining operation", e?.path, error);
        } finally {
            this.busy = false;
            if (!this.entries.length) this.settleWaiters();
            else this.kick();
        }
    }

    async onAuthenticated(): Promise<void> {
        this.checkScope();
        this.kick();
        await this.drainBeforeSync();
    }

    async drainBeforeSync(): Promise<void> {
        if (!this.connected() || !this.enabled() || !this.entries.length) return;
        const wait = new Promise<void>(resolve => this.waiters.push(resolve));
        this.kick();
        await wait;
    }

    private settleWaiters(): void {
        for (const resolve of this.waiters.splice(0)) resolve();
    }

    onDisconnected(): void {
        this.generation++;
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = null;
        if (this.active) this.release(this.active);
        this.active = null;
        this.activeTargetStat = "";
        this.activeSourceStat = "";
        this.due = 0;
        this.liveFolders.clear();
        this.replayedPaths.clear();
        this.retiredAckKeys.clear();
        this.reconnectRequested = false;
        this.settleWaiters();
    }

    /**
     * 清空队列（切换远端笔记库名时调用）。旧库的删除/改名重试不能带到新库，
     * 否则会在空库里重放旧路径的删除操作。
     *
     * Clear the queue (called when switching the remote vault name). Delete/rename retries
     * belonging to the old vault must not replay against the new (possibly empty) vault.
     */
    clear(): void {
        this.generation++;
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.active) this.release(this.active);
        this.active = null;
        this.activeTargetStat = "";
        this.activeSourceStat = "";
        this.due = 0;
        this.entries = [];
        this.liveFolders.clear();
        this.replayedPaths.clear();
        this.recoveryPaths.clear();
        this.retiredAckKeys.clear();
        this.reconnectRequested = false;
        this.scope = this.getScope();
        this.settleWaiters();
        this.persist();
    }

    stop(): void {
        this.stopped = true;
        this.onDisconnected();
        this.persist();
    }
}
