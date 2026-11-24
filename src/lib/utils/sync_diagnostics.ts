import { Platform } from "obsidian";

import type FastSync from "../../main";
import { dump } from "../helpers_obsidian_bypass";
import { formatDiagnostic, redactDiagnosticText } from "./redact_log";

/**
 * 同步诊断缓冲。
 * Sync diagnostics buffer.
 *
 * 目的：不依赖调试日志开关（`logEnabled` 默认 off，`dump` 全部丢弃）也能在事后看到
 * 启动状态、协商结果、每轮同步摘要和失败记录，并一键复制给开发者。
 * 只记录，不参与任何同步决策；所有文本在写入时即脱敏（token / 服务器地址 / 库名）。
 *
 * Purpose: keep startup state, negotiation results, per-round summaries and failures visible
 * after the fact even with `logEnabled` off (where `dump` discards everything), and let the
 * user copy them in one click. Record-only: never influences a sync decision, and every text
 * is redacted on write (token / server address / vault name).
 */

export type DiagLevel = "info" | "warn" | "error";

export interface DiagEntry {
    time: number;
    level: DiagLevel;
    kind: string;
    message: string;
    path?: string;
}

interface SyncEndCounts {
    upload: number;
    modify: number;
    confirm: number;
    delete: number;
    conflict: number;
}

interface RoundStats {
    type: string;
    readonly: boolean;
    initSync: boolean;
    startedAt: number;
    scan: {
        notes: number;
        files: number;
        configs: number;
        folders: number;
        noBaselineNotes?: number;
        noBaselineFiles?: number;
        noBaselineConfigs?: number;
    } | null;
    ends: Partial<Record<"note" | "file" | "config" | "folder", SyncEndCounts>>;
    uploadSkippedReadOnly: number;
    scanErrors: number;
    scanErrorPaths: string[];
}

const MAX_ENTRIES = 300;
const MAX_MESSAGE_LENGTH = 800;
const PERSIST_DEBOUNCE_MS = 2000;
const MAX_ROUND_SUMMARIES = 5;
const MAX_READONLY_SKIP_PATHS_PER_ROUND = 100;

let plugin: FastSync | null = null;
let mirrorPath = "";
let initialized = false;
let entries: DiagEntry[] = [];
let startupState: string | null = null;
let negotiated: string | null = null;
let roundSummaries: string[] = [];
let round: RoundStats | null = null;
let connectionVaultMismatchCount = 0;
let vaultMismatchLogged = false;
let readonlySkipPathsThisRound = 0;
let persistTimer: number | null = null;
let writeInFlight = false;
let writePending = false;
let logWriter: ((level: DiagLevel, kind: string, message: string, path?: string) => void) | null = null;
let suppressMirror = false;

function clean(value: unknown): string {
    const text = value === undefined || value === null
        ? ""
        : typeof value === "string"
            ? value
            : typeof value === "object"
                ? JSON.stringify(value)
                : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
                    ? String(value)
                    : "";
    // 先对完整文本脱敏再截断，避免凭据跨在截断点上时只遮住一半、留下前缀
    // Redact the full text first, then truncate: a credential straddling the cut would
    // otherwise leave its prefix behind
    const redacted = redactDiagnosticText(text);
    return redacted.length > MAX_MESSAGE_LENGTH ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}…` : redacted;
}

function append(level: DiagLevel, kind: string, message: unknown, path?: string): void {
    const entry: DiagEntry = {
        time: Date.now(),
        level,
        kind: clean(kind),
        message: clean(message),
    };
    if (path) entry.path = clean(path);
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
        // 超限时先淘汰最早的一条 info，没有 info 才淘汰最早的一条（warn / error 同等对待）
        // Evict the oldest info first; only when none remains, evict the oldest entry
        // (warn and error are treated equally and outlive info)
        const infoIndex = entries.findIndex(item => item.level === "info");
        entries.splice(infoIndex >= 0 ? infoIndex : 0, 1);
    }
    schedulePersist();
}

/** 诊断缓冲持久化（2 秒合并一次，串行写入） / Throttled (2s) serialized persist */
function schedulePersist(): void {
    if (!initialized || !plugin || !mirrorPath) return;
    if (persistTimer !== null) return;
    persistTimer = window.setTimeout(() => {
        persistTimer = null;
        void flushPersist();
    }, PERSIST_DEBOUNCE_MS);
}

/** 立即落盘（插件卸载时也可调用）/ Write now (safe to call on unload) */
export async function flushSyncDiagnostics(): Promise<void> {
    if (persistTimer !== null) {
        window.clearTimeout(persistTimer);
        persistTimer = null;
    }
    await flushPersist();
}

async function flushPersist(): Promise<void> {
    if (!plugin || !mirrorPath) return;
    if (writeInFlight) {
        writePending = true;
        return;
    }
    writeInFlight = true;
    try {
        const payload = JSON.stringify({
            version: 1,
            entries,
            startup: startupState,
            negotiated,
            summaries: roundSummaries,
        });
        await plugin.app.vault.adapter.write(mirrorPath, payload);
    } catch (error) {
        dump("SyncDiagnostics: failed to persist diagnostics file", error);
    } finally {
        writeInFlight = false;
        if (writePending) {
            writePending = false;
            void flushPersist();
        }
    }
}

/**
 * 初始化诊断缓冲并读回上次落盘内容；读失败 / 格式不对都当空处理。
 * Initialize and restore the previous file; read failure or a bad shape means empty.
 */
export async function initSyncDiagnostics(p: FastSync, filePath: string): Promise<void> {
    plugin = p;
    mirrorPath = filePath;
    initialized = true;
    // 脱敏上下文由 main.ts 在启动时注册，这里复用同一套规则 / Reuse the context registered by main.ts
    try {
        if (await p.app.vault.adapter.exists(mirrorPath)) {
            const raw = await p.app.vault.adapter.read(mirrorPath);
            const data = JSON.parse(raw) as {
                version?: unknown;
                entries?: unknown;
                startup?: unknown;
                negotiated?: unknown;
                summaries?: unknown;
            } | null;
            if (data && data.version === 1) {
                if (Array.isArray(data.entries)) {
                    entries = data.entries
                        .filter((e): e is DiagEntry => !!e && typeof e === "object"
                            && typeof (e as DiagEntry).time === "number"
                            && ["info", "warn", "error"].includes((e as DiagEntry).level)
                            && typeof (e as DiagEntry).kind === "string")
                        .slice(-MAX_ENTRIES)
                        .map(e => ({
                            time: e.time,
                            level: e.level,
                            kind: clean(e.kind),
                            message: clean(e.message ?? ""),
                            ...(typeof e.path === "string" ? { path: clean(e.path) } : {}),
                        }));
                }
                startupState = typeof data.startup === "string" ? clean(data.startup) : null;
                negotiated = typeof data.negotiated === "string" ? clean(data.negotiated) : null;
                if (Array.isArray(data.summaries)) {
                    roundSummaries = data.summaries.filter((s): s is string => typeof s === "string").slice(-MAX_ROUND_SUMMARIES).map(clean);
                }
            }
        }
    } catch (error) {
        dump("SyncDiagnostics: corrupt or unreadable diagnostics file, starting empty", error);
        entries = [];
        startupState = null;
        negotiated = null;
        roundSummaries = [];
    }
}

/** 供 SyncLogManager 注册同步日志写入通道（避免模块循环依赖） */
export function bindSyncLogWriter(writer: ((level: DiagLevel, kind: string, message: string, path?: string) => void) | null): void {
    logWriter = writer;
}

/**
 * SyncLog 中 error / cancelled 条目自动转存到诊断缓冲（error→error，cancelled→warn）。
 * 诊断缓冲自身不会回写 SyncLog。
 */
export function mirrorSyncLog(log: { action?: string; status?: string; message?: string; path?: string } | null | undefined): void {
    if (suppressMirror || !log) return;
    if (log.status !== "error" && log.status !== "cancelled") return;
    const level: DiagLevel = log.status === "error" ? "error" : "warn";
    // SyncLog 的 message 可能含 JSON 载荷（冲突备份等），先按字段剔除正文再进缓冲
    // A sync-log message may carry a JSON payload (conflict backups etc.); strip body fields first
    append(level, log.action || "SyncLog", log.message ? formatDiagnostic(log.message) : log.status, log.path);
}

/**
 * 显式诊断记录：写缓冲、写一条 SyncLog（info 用成功态）、并 dump。
 * Explicit record: buffer + one SyncLog entry (info maps to success) + dump.
 */
export function recordDiag(level: DiagLevel, kind: string, message: unknown, path?: string): void {
    append(level, kind, message, path);
    if (logWriter) {
        suppressMirror = true;
        try {
            logWriter(level, kind, clean(message), path ? clean(path) : undefined);
        } catch (error) {
            dump("SyncDiagnostics: log writer failed", error);
        } finally {
            suppressMirror = false;
        }
    }
    dump(`[Diagnostics] ${level} ${kind}: ${clean(message)}${path ? ` (${clean(path)})` : ""}`);
}

/**
 * 只进诊断缓冲（并 dump），不写 SyncLog。用于可自动恢复、不希望计入失败的场景。
 * Buffer + dump only, never a SyncLog entry: for recoverable cases that must not count as failures.
 */
export function recordDiagBufferOnly(level: DiagLevel, kind: string, message: unknown, path?: string): void {
    append(level, kind, message, path);
    dump(`[Diagnostics] ${level} ${kind}: ${clean(message)}${path ? ` (${clean(path)})` : ""}`);
}

/**
 * 启动状态（调用一次，在 reloadServices 之前）。
 * Startup state (called once, before reloadServices).
 */
export function recordStartupState(p: FastSync): void {
    try {
        const persisted = (k: Parameters<typeof p.localStorageManager.getMetadata>[0]) => p.localStorageManager.getMetadata(k);
        const counts = p.fileHashManager?.getDiagnosticCounts?.() ?? null;
        const hashStats = counts ?? p.fileHashManager?.getStats?.() ?? { totalFiles: 0 };
        const state = {
            pluginVersion: p.manifest?.version ?? "unknown",
            isInitSync: !!persisted("isInitSync"),
            cursors: {
                note: Number(persisted("lastNoteSyncTime")) || 0,
                file: Number(persisted("lastFileSyncTime")) || 0,
                config: Number(persisted("lastConfigSyncTime")) || 0,
                folder: Number(persisted("lastFolderSyncTime")) || 0,
            },
            hashEntries: "hashEntries" in hashStats ? (hashStats as { hashEntries: number }).hashEntries : (hashStats as { totalFiles?: number }).totalFiles ?? 0,
            baselineEntries: "baselineEntries" in hashStats ? (hashStats as { baselineEntries: number }).baselineEntries : (p.fileHashManager?.getAllPaths?.().length ?? 0),
            confirmedBaselines: "confirmedBaselines" in hashStats ? (hashStats as { confirmedBaselines: number }).confirmedBaselines : undefined,
            baselineScopeChanged: "baselineScopeChanged" in hashStats ? (hashStats as { baselineScopeChanged: boolean }).baselineScopeChanged : undefined,
            retryQueueEntries: p.retryQueue?.entries?.length ?? 0,
            conflictedPaths: p.syncState?.conflictedPaths?.size ?? 0,
            pendingNoteModifies: p.pendingNoteModifies?.size ?? 0,
            flags: {
                syncEnabled: !!p.settings?.syncEnabled,
                manualSyncEnabled: !!p.settings?.manualSyncEnabled,
                readonlySyncEnabled: !!p.settings?.readonlySyncEnabled,
                configSyncEnabled: !!p.settings?.configSyncEnabled,
                offlineDeleteSyncEnabled: !!p.settings?.offlineDeleteSyncEnabled,
                cloudPreviewEnabled: !!p.settings?.cloudPreviewEnabled,
                logEnabled: p.settings?.logEnabled ?? "off",
            },
        };
        startupState = clean(JSON.stringify(state));
        append("info", "StartupState", startupState);
    } catch (error) {
        recordDiag("warn", "StartupState", `failed to collect startup state: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** 基线协商结果 / Baseline negotiation result */
export function recordNegotiated(level: DiagLevel, message: string): void {
    negotiated = clean(message);
    if (level === "error") {
        recordDiag("error", "Negotiated", message);
    } else {
        append("info", "Negotiated", message);
        dump(`[Diagnostics] Negotiated: ${message}`);
    }
}

/** 每轮同步开始时重置本轮统计 / Reset per-round stats at round start */
export function beginSyncRound(type: string, readonly: boolean, initSync: boolean): void {
    round = {
        type,
        readonly,
        initSync,
        startedAt: Date.now(),
        scan: null,
        ends: {},
        uploadSkippedReadOnly: 0,
        scanErrors: 0,
        scanErrorPaths: [],
    };
    readonlySkipPathsThisRound = 0;
}

/** 扫描上报条数与无基线条数 / Reported scan counts and no-baseline subset */
export function recordScanReport(counts: { notes: number; files: number; configs: number; folders: number; noBaselineNotes?: number; noBaselineFiles?: number; noBaselineConfigs?: number }): void {
    if (!round) return;
    round.scan = counts;
}

function endCounts(data: { needUploadCount?: number; needModifyCount?: number; needSyncMtimeCount?: number; needDeleteCount?: number; needConflictCount?: number }): SyncEndCounts {
    return {
        upload: data?.needUploadCount ?? 0,
        modify: data?.needModifyCount ?? 0,
        confirm: data?.needSyncMtimeCount ?? 0,
        delete: data?.needDeleteCount ?? 0,
        conflict: data?.needConflictCount ?? 0,
    };
}

/** 服务端各类 SyncEnd 计数（已收到的字段） / Counts from each SyncEnd already received */
export function recordSyncEndCounts(kind: "note" | "file" | "config" | "folder", data: unknown): void {
    if (!round) return;
    round.ends[kind] = endCounts(data ?? {});
}

/** 扫描单文件出错：计数并只记录前 10 个路径 / Scan per-file error: count and log first 10 paths */
export function recordScanFileError(path: string | undefined, error: unknown): void {
    if (!round) return;
    round.scanErrors++;
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (round.scanErrorPaths.length < 10) {
        const safePath = path ?? "";
        if (safePath) round.scanErrorPaths.push(clean(safePath));
        append("warn", "ScanFileError", message, safePath || undefined);
    }
}

/**
 * 只读轮里服务端要求上传但被拦下的条目：总数全部累加，带路径的条目每轮最多写 100 条。
 * Upload requests blocked in a read-only round: always count, but write at most 100 pathed
 * entries per round (the same cap applies when no round is active).
 */
export function recordUploadSkippedReadOnly(path: string): void {
    if (round) round.uploadSkippedReadOnly++;
    if (readonlySkipPathsThisRound >= MAX_READONLY_SKIP_PATHS_PER_ROUND) return;
    readonlySkipPathsThisRound++;
    append("info", "UploadSkippedReadOnly", "Read-only round: upload request skipped", path);
}

/** 库名不符丢消息：每个连接首条记录，之后只计数 / Vault-mismatch drops: first per connection logged, later counted */
export function recordVaultMismatchDrop(action: string): void {
    connectionVaultMismatchCount++;
    if (vaultMismatchLogged) return;
    vaultMismatchLogged = true;
    append("warn", "VaultMismatchDropped", `Dropped message with mismatched vault: ${action}`);
}

/** 新连接重置连接级计数 / Reset connection-scoped counters on a new connection */
export function resetConnectionDiagnostics(): void {
    connectionVaultMismatchCount = 0;
    vaultMismatchLogged = false;
}

/**
 * 每轮同步摘要；失败 / 冲突 / 扫描出错时用 warn，否则 info。
 * Per-round summary; warn on failures, conflicts or scan errors, otherwise info.
 */
export function recordRoundSummary(opts: { failed: number; conflicts: number; unaligned: number; hashTimeouts: number }): void {
    if (!round) return;
    const failed = opts.failed + round.scanErrors;
    const warn = failed > 0 || opts.conflicts > 0 || round.scanErrors > 0;
    const state = {
        type: round.type,
        readonly: round.readonly,
        initSync: round.initSync,
        startedAt: round.startedAt,
        durationMs: Date.now() - round.startedAt,
        scan: round.scan,
        serverEnd: round.ends,
        uploadSkippedReadOnly: round.uploadSkippedReadOnly,
        failed: opts.failed,
        conflicts: opts.conflicts,
        unaligned: opts.unaligned,
        scanErrors: round.scanErrors,
        scanErrorPaths: round.scanErrorPaths,
        hashTimeouts: opts.hashTimeouts,
        vaultMismatchDropped: connectionVaultMismatchCount,
    };
    const message = clean(JSON.stringify(state));
    append(warn ? "warn" : "info", "SyncRoundSummary", message);
    roundSummaries.push(message);
    if (roundSummaries.length > MAX_ROUND_SUMMARIES) roundSummaries.splice(0, roundSummaries.length - MAX_ROUND_SUMMARIES);
    round = null;
}

/** 本轮是否有服务端要求上传的数量 / Server-requested upload totals for this round */
export function getRoundUploadTotals(): { notes: number; files: number; readonly: boolean; initSync: boolean } {
    return {
        notes: round?.ends.note?.upload ?? 0,
        files: round?.ends.file?.upload ?? 0,
        readonly: round?.readonly ?? false,
        initSync: round?.initSync ?? false,
    };
}

/**
 * 复制用纯文本：版本、平台、最近启动 / 协商、最近 5 轮摘要、全部缓冲条目。
 * 不含 token、服务器地址、库名（写入时已脱敏，导出时再脱敏一次）。
 */
export function buildSyncDiagnosticsText(p: FastSync): string {
    const appVersion = (p.app as unknown as { version?: string }).version || "unknown";
    const platform = Platform.isMobile ? (Platform.isIosApp ? "iOS" : "Android") : Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "desktop";
    const lines = [
        `Plugin: ${p.manifest?.version ?? "unknown"}`,
        `Obsidian: ${appVersion} (${platform})`,
        `Startup: ${startupState ?? "none"}`,
        `Negotiated: ${negotiated ?? "none"}`,
        `Rounds (last ${roundSummaries.length}):`,
        ...roundSummaries.map(summary => `- ${summary}`),
        `Diagnostics (${entries.length}):`,
        ...entries.map(entry => {
            const time = new Date(entry.time).toISOString();
            return `${time} ${entry.level} ${entry.kind}: ${entry.message}${entry.path ? ` path=${entry.path}` : ""}`;
        }),
    ];
    return redactDiagnosticText(lines.join("\n"));
}

/** 复制诊断文本；失败返回 false（不弹提示，交给调用方） / Copy; false on failure */
export async function copySyncDiagnostics(p: FastSync): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(buildSyncDiagnosticsText(p));
        return true;
    } catch (error) {
        dump("SyncDiagnostics: copy failed", error);
        return false;
    }
}
