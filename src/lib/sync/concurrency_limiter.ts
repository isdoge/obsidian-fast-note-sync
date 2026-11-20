import type FastSync from "../../main";
import { dump } from "../utils/helpers";

/**
 * 并发管理器
 * 用于精确控制基于 ACK 的上行同步任务并发
 */
export class ConcurrencyLimiter {
    private plugin: FastSync;
    private queue: { key: string; priority: number; resolve: () => void; cancel: () => void }[] = [];
    private activeKeys: Set<string> = new Set();
    // 槽位归属固定在申请时，空闲编辑不计入后来开始的同步。 / Slot ownership survives a later sync start.
    private slotContexts = new Map<string, string | null>();
    // 每个活跃键最近一次"有动静"的时间，供 sweepStale 找出长期无人归还的名额。
    // Last activity time of each active key; sweepStale uses it to find slots nobody returns.
    private sending = new Map<string, Set<object>>();
    private keyActivityAt = new Map<string, number>();

    // 针对 FIFO 类型的 ACK（如重命名消息），记录其对应的 Key 顺序
    private fifoKeys: string[] = [];

    constructor(plugin: FastSync) {
        this.plugin = plugin;
    }

    /**
     * 等待并获取一个并发槽位
     * @param key 任务标识（通常是文件路径，或者是生成的随机 ID）
     * @param isFifo 是否是 FIFO 类型的 ACK (ACK 中不带 path)
     * @param priority 优先级（数字越大优先级越高，用于实现先上传后下载等逻辑）
     */
    public async waitForSlot(key: string, isFifo: boolean = false, priority: number = 0): Promise<boolean> {
        const context = this.plugin.syncState?.activeSyncContext ?? null;
        if (!this.plugin.settings.concurrencyControlEnabled) {
            return true;
        }

        // FileUploadCheck hands its existing slot to FileUpload.
        if (this.activeKeys.has(key)) return true;

        if (this.activeKeys.size < this.plugin.settings.maxConcurrentUploads) {
            this.activeKeys.add(key);
            this.slotContexts.set(key, context);
            this.keyActivityAt.set(key, Date.now());
            if (isFifo) this.fifoKeys.push(key);
            dump(`Concurrency: Slot acquired immediately for ${key} (Priority: ${priority}). Active: ${this.activeKeys.size}`);
            return true;
        }

        return new Promise((resolve) => {
            dump(`Concurrency: Queueing task ${key} (Priority: ${priority}). Current active: ${this.activeKeys.size}`);
            this.queue.push({
                key,
                priority,
                resolve: () => {
                    this.activeKeys.add(key);
                    this.slotContexts.set(key, context);
                    this.keyActivityAt.set(key, Date.now());
                    if (isFifo) this.fifoKeys.push(key);
                    dump(`Concurrency: Slot acquired from queue for ${key}. Active: ${this.activeKeys.size}`);
                    resolve(true);
                },
                cancel: () => resolve(false)
            });
            // 按照优先级倒序排序（优先级数值越大的越靠前）
            this.queue.sort((a, b) => b.priority - a.priority);
        });
    }

    /** 空闲请求为 null，不存在的槽位为 undefined。 / Null means idle-owned; undefined means no active slot. */
    public getSlotContext(key: string): string | null | undefined {
        return this.slotContexts.get(key);
    }

    /** 活跃与排队中的槽位总数，供空闲同步判断是否有待处理上传 / Active plus queued slots, used by idle sync to detect pending uploads */
    public get activeSlotCount(): number {
        return this.activeKeys.size + this.queue.length;
    }

    /**
     * 为仍在干活的任务续期，避免刚发过数据的名额被 sweepStale 当成无人归还。
     * Refresh an in-progress key so a slot that just did work is not swept as abandoned.
     */
    public touch(key: string, now: number = Date.now()): void {
        if (!this.plugin.settings.concurrencyControlEnabled) {
            return;
        }
        if (this.activeKeys.has(key)) {
            this.keyActivityAt.set(key, now);
        }
    }

    /** Buffer-drain and final validation are live work, regardless of their duration. */
    public protectSending(key: string): () => void {
        const owners = this.sending.get(key) || new Set<object>();
        const owner = {};
        owners.add(owner);
        this.sending.set(key, owners);
        return () => {
            owners.delete(owner);
            if (this.sending.get(key) !== owners) return;
            if (!owners.size) this.sending.delete(key);
            this.touch(key);
        };
    }

    /**
     * 清扫超过 maxIdleMs 没有动静、且 isBusy 判定为不忙的活跃名额。
     * 只归还名额，不碰任何同步进度记账；迟到的确认对已不存在的键本就是空操作。
     * Sweep active slots idle longer than maxIdleMs unless isBusy says otherwise. Only slots
     * are returned; sync progress accounting is untouched, and late acks for absent keys no-op.
     */
    public sweepStale(maxIdleMs: number, isBusy?: (key: string) => boolean, now: number = Date.now()): string[] {
        if (!this.plugin.settings.concurrencyControlEnabled) {
            return [];
        }
        const stale: string[] = [];
        for (const key of this.activeKeys) {
            const lastActive = this.keyActivityAt.get(key) ?? now;
            if (now - lastActive <= maxIdleMs) continue;
            if (this.sending.has(key) || isBusy?.(key)) continue;
            stale.push(key);
        }
        for (const key of stale) {
            const idleMs = now - (this.keyActivityAt.get(key) ?? now);
            dump(`Concurrency: Sweeping slot ${key} after ${idleMs}ms without activity`);
            // releaseSlot 同时把键从 fifoKeys 里移除 / releaseSlot also removes the key from fifoKeys
            this.releaseSlot(key);
        }
        return stale;
    }

    /**
     * 释放指定任务的并发槽位
     * @param key 任务标识
     */
    public releaseSlot(key: string): void {
        if (!this.plugin.settings.concurrencyControlEnabled) {
            return;
        }

        if (this.activeKeys.has(key)) {
            this.activeKeys.delete(key);
            this.slotContexts.delete(key);
            this.keyActivityAt.delete(key);
            // 同时从 FIFO 队列中移除该 key (如果存在)
            const fifoIndex = this.fifoKeys.indexOf(key);
            if (fifoIndex !== -1) {
                this.fifoKeys.splice(fifoIndex, 1);
            }
            
            dump(`Concurrency: Slot released for ${key}. Remaining active: ${this.activeKeys.size}`);
            this.processQueue();
        } else {
            // dump(`Concurrency: Skip release, key not active: ${key}`);
        }
    }

    /**
     * 针对没有带 path 的 ACK，释放最早的一个 FIFO 槽位
     */
    public releaseFifoSlot(): void {
        if (!this.plugin.settings.concurrencyControlEnabled) {
            return;
        }

        const key = this.fifoKeys.shift();
        if (key) {
            this.activeKeys.delete(key);
            this.slotContexts.delete(key);
            this.keyActivityAt.delete(key);
            dump(`Concurrency: FIFO slot released for ${key}. Remaining active: ${this.activeKeys.size}`);
            this.processQueue();
        }
    }

    /**
     * 处理等待队列
     */
    private processQueue(): void {
        const activeCount = this.activeKeys.size;
        const queueCount = this.queue.length;
        if (queueCount > 0) {
            dump(`Concurrency: Processing queue. Active: ${activeCount}, Queued: ${queueCount}`);
        }
        while (this.activeKeys.size < this.plugin.settings.maxConcurrentUploads && this.queue.length > 0) {
            const next = this.queue.shift();
            if (next) {
                dump(`Concurrency: Resuming task ${next.key} from queue.`);
                next.resolve();
            }
        }
    }

    public cancelQueued(key: string): void {
        const cancelled = this.queue.filter(item => item.key === key);
        this.queue = this.queue.filter(item => item.key !== key);
        for (const item of cancelled) item.cancel();
    }

    /**
     * 清空所有并发状态（通常用于断网或重连）
     */
    public clear(): void {
        dump(`Concurrency: Clearing all ${this.activeKeys.size} active tasks and ${this.queue.length} queued tasks.`);
        // Settle cancelled waiters without granting slots or starting binary reads.
        const pending = this.queue;
        this.queue = [];
        for (const item of pending) {
            item.cancel();
        }
        this.activeKeys.clear();
        this.slotContexts.clear();
        this.keyActivityAt.clear();
        this.sending.clear();
        this.fifoKeys = [];
    }

}
