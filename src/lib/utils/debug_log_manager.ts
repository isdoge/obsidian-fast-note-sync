import { formatDiagnostic } from "./redact_log";

export class DebugLogManager {
    private static instance: DebugLogManager;
    private logs: string[] = [];
    private readonly MAX_LOGS = 1000;
    private listeners: Set<(logs: string[]) => void> = new Set();

    private constructor() {}

    public static getInstance(): DebugLogManager {
        if (!DebugLogManager.instance) {
            DebugLogManager.instance = new DebugLogManager();
        }
        return DebugLogManager.instance;
    }

    /**
     * 写入日志时即脱敏：token / Bearer / JWT 等凭据会被替换，笔记正文与二进制被省略，
     * Error 的 name / message / stack 保留。这样任何读取日志的出口（含复制）默认安全。
     *
     * Redact on write: credentials are replaced, note bodies and binary payloads omitted,
     * while Error name/message/stack survive. Every read path (including copy) is safe by default.
     */
    public addLog(...message: unknown[]) {
        const timestamp = new Date().toLocaleTimeString();
        const msg = message.map(m => formatDiagnostic(m)).join(' ');

        this.logs.push(`[${timestamp}] ${msg}`);
        if (this.logs.length > this.MAX_LOGS) {
            this.logs.shift();
        }
        this.notify();
    }

    public getLogs(): string[] {
        return [...this.logs];
    }

    /** 供导出/复制使用：即便写入时已脱敏，也在出口再返回一份脱敏快照。 */
    public getRedactedLogs(): string[] {
        return this.logs.map(log => formatDiagnostic(log));
    }

    public clearLogs() {
        this.logs = [];
        this.notify();
    }

    public subscribe(listener: (logs: string[]) => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify() {
        this.listeners.forEach(l => l(this.getLogs()));
    }
}
