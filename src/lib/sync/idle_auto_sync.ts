/**
 * 空闲连接定时兜底增量同步 / Idle-connection periodic fallback sync
 *
 * 经反向代理、Cloudflare Tunnel 或移动网络长时间挂机时，底层连接可能半开未被察觉，
 * 或休眠唤醒期间漏掉远端事件，直到手动点同步才追平（服务端 issue #503）。
 * 本调度器在连接空闲、无待处理队列、页面可见且距上次同步已超过设定间隔时，
 * 静默触发一次轻量增量同步，不弹提示、不影响进行中的同步。
 *
 * Long-lived connections behind reverse proxies, Cloudflare Tunnel or mobile networks can
 * go half-open unnoticed, or lose remote events across sleep/wake, leaving changes unsynced
 * until a manual sync (server issue #503). This scheduler silently triggers a lightweight
 * incremental sync when the connection is idle, no queues are pending, the page is visible,
 * and the configured interval has elapsed since the last sync. It never shows a notice and
 * never interrupts an active round.
 */

export const IDLE_SYNC_INTERVAL_OPTIONS = [0, 5, 15, 30, 60]
export const DEFAULT_IDLE_SYNC_INTERVAL_MINUTES = 15
/** 检查节拍：实际触发还受配置分钟数与 lastActivityAt 约束 / Check cadence; actual firing also needs the configured minutes to elapse */
export const IDLE_SYNC_TICK_MS = 30 * 1000

export interface IdleAutoSyncHost {
    /** 配置的间隔分钟数，0 表示关闭 / Configured interval in minutes; 0 disables */
    getIntervalMinutes(): number
    /** 已连接且已通过鉴权 / Connected and authenticated */
    isConnected(): boolean
    /** 有同步轮次进行中或仍有待处理上传/下载队列 / A round is active or upload/download queues are non-empty */
    isBusy(): boolean
    /** 页面/应用当前可见 / The page/app is currently visible */
    isVisible(): boolean
    /** 触发一次轻量增量同步（不得弹出打扰性提示） / Trigger one lightweight incremental sync (no intrusive notice) */
    runSync(): void
}

export interface IdleAutoSyncTimerDeps {
    setInterval(handler: () => void, ms: number): number
    clearInterval(handle: number): void
    now(): number
}

const defaultDeps: IdleAutoSyncTimerDeps = {
    setInterval: (handler, ms) => window.setInterval(handler, ms),
    clearInterval: (handle) => window.clearInterval(handle),
    now: () => Date.now(),
}

export class IdleAutoSyncScheduler {
    private timer: number | null = null
    private started = false
    private lastActivityAt: number

    constructor(
        private readonly host: IdleAutoSyncHost,
        private readonly deps: IdleAutoSyncTimerDeps = defaultDeps,
        initialNow?: number,
    ) {
        // 以构造时刻为基准：启动后至少等一个完整间隔才触发，避免刚加载就空转同步
        // Baseline at construction: wait at least one full interval after startup
        this.lastActivityAt = initialNow ?? deps.now()
    }

    /** 当前是否挂有检查定时器 / Whether a check timer is installed */
    public isRunning(): boolean {
        return this.timer !== null
    }

    /** 连接状态变化：断开立即清理定时器，连上后按需启动 / Connection changes: clear on drop, start on connect */
    public setConnected(connected: boolean): void {
        if (connected) {
            this.start()
        } else {
            this.stop()
        }
    }

    /** 启动检查（未连接或间隔为 0 时只记录状态，不挂定时器）/ Start checks (records state only when disconnected or disabled) */
    public start(): void {
        this.started = true
        if (this.timer !== null) return
        if (!this.isEnabled()) return
        if (!this.host.isConnected()) return
        this.timer = this.deps.setInterval(() => this.tick(), IDLE_SYNC_TICK_MS)
    }

    /** 停止并释放定时器（断开、卸载、关闭功能时调用）/ Stop and release the timer (disconnect, unload, disable) */
    public stop(): void {
        this.started = false
        if (this.timer !== null) {
            this.deps.clearInterval(this.timer)
            this.timer = null
        }
    }

    /** 设置项变化后重新评估是否需要定时器 / Re-evaluate after settings changes */
    public applySettings(): void {
        if (!this.isEnabled() || !this.host.isConnected()) {
            this.stop()
            return
        }
        this.start()
    }

    /** 同步轮次开始 / A sync round started */
    public notifySyncStarted(): void {
        this.lastActivityAt = this.deps.now()
    }

    /** 同步轮次结束 / A sync round finished */
    public notifySyncCompleted(): void {
        this.lastActivityAt = this.deps.now()
    }

    /**
     * 判断并尝试触发一次空闲同步。返回 true 表示本次已调用 runSync。
     * Evaluate and maybe trigger one idle sync. Returns true when runSync was invoked.
     */
    public maybeTrigger(): boolean {
        if (!this.isEnabled()) return false
        if (!this.host.isConnected()) return false
        if (!this.host.isVisible()) return false
        if (this.host.isBusy()) return false

        const now = this.deps.now()
        if (now - this.lastActivityAt < this.host.getIntervalMinutes() * 60 * 1000) return false

        // 先刷新时间，避免 runSync 异步设置 isSyncing 之前被下一个节拍重复触发
        // Refresh before running so the next tick cannot duplicate it before isSyncing flips
        this.lastActivityAt = now
        this.host.runSync()
        return true
    }

    private isEnabled(): boolean {
        const minutes = this.host.getIntervalMinutes()
        return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
    }

    private tick(): void {
        if (!this.started) return
        // 断开或关闭功能后自清理，覆盖未收到状态回调的极端情况
        // Self-clean on disconnect/disable, covering a missed status callback
        if (!this.isEnabled() || !this.host.isConnected()) {
            this.stop()
            return
        }
        this.maybeTrigger()
    }
}
