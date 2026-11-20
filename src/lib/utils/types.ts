import { App, Menu, MenuItem } from "obsidian";

/**
 * Client type identifier sent to the server in HTTP headers, WebSocket URL,
 * and API request parameters to distinguish the Obsidian plugin client.
 * 发送给服务端的客户端类型标识符，用于 HTTP 请求头、WebSocket URL 及 API 参数中标识 Obsidian 插件客户端。
 */
export const CLIENT_TYPE = "ObsidianPlugin";

export type SyncMode = "auto" | "note" | "config";

export interface SnapFile {
    path: string;
    pathHash: string;
    contentHash: string;
    mtime: number;
    ctime: number;
    size: number;
    baseHash?: string | null;
    /** 无可信内容基线（基线模式）/ No trusted content baseline (baseline mode) */
    baseHashMissing?: boolean;
    /** 服务端确认的版本令牌（基线模式）/ Server-confirmed revision token (baseline mode) */
    baseRevision?: string;
}

export interface SnapFolder {
    path: string;
    pathHash: string;
    /** 目录基线版本令牌（基线模式）/ Folder baseline revision token (baseline mode) */
    baseRevision?: string;
}

export interface PathHashFile {
    path: string;
    pathHash: string;
    /** 删除前的内容基线（基线模式）/ Pre-delete content baseline (baseline mode) */
    baseHash?: string;
    baseHashMissing?: boolean;
    baseRevision?: string;
}

export interface ReceiveMessage {
    vault: string;
    path: string;
    pathHash: string;
    action: string;
    content: string;
    contentHash: string;
    ctime: number;
    mtime: number;
    lastTime: number;
    context?: string;
    /** 服务端确认的版本令牌（基线模式下行）/ Server-confirmed revision (baseline-mode downlink) */
    revision?: string;
    /** 当前是墓碑（基线模式）/ Current state is a tombstone (baseline mode) */
    serverDeleted?: boolean;
    // 所属下载页（0-based，内部值，由 websocket_manager.ts 从 WSResponse 信封 1-based 转换后并入 payload）；
    // 旧服务端/非分页项为 undefined，下游按 undefined 走旧的单页全局计数路径（设计稿 §4.3）
    // Owning download page (0-based, internal value, merged into payload by websocket_manager.ts
    // after converting from the WSResponse envelope's 1-based wire value); undefined for old
    // servers / non-paginated items, downstream falls back to the legacy single-page global
    // counting path on undefined (design §4.3)
    pageIndex?: number;
}

export interface SyncMessage {
    action: string;
    data: unknown;
}

export interface ReceiveFileSyncUpdateMessage {
    path: string;
    vault: string;
    pathHash: string;
    contentHash: string;
    /** 服务端确认的版本令牌（基线模式）/ Server-confirmed revision (baseline mode) */
    revision?: string;
    size: number;
    mtime: number;
    ctime: number;
    lastTime: number;
    /** 所属下载页（0-based），见 ReceiveMessage.pageIndex 注释 / owning download page, see ReceiveMessage.pageIndex */
    pageIndex?: number;
}

export interface FileUploadMessage {
    path: string;
    pathHash: string;
    /** 服务端确认的版本令牌（基线模式）/ Server-confirmed revision (baseline mode) */
    revision?: string;
    ctime: number;
    mtime: number;
    sessionId: string;
    chunkSize: number;
    /** 所属下载页（0-based），见 ReceiveMessage.pageIndex 注释 / owning download page, see ReceiveMessage.pageIndex */
    pageIndex?: number;
}

export interface FileSyncChunkDownloadMessage {
    path: string;
    contentHash?: string;
    ctime: number;
    mtime: number;
    sessionId: string;
    chunkSize: number;
    totalChunks: number;
    size: number;
    /** 服务端确认的版本令牌（基线模式）/ Server-confirmed revision (baseline mode) */
    revision?: string;
}

export interface FileDownloadSession {
    /** Local state captured when the download was requested; checked before writing. */
    commitGuard?: {
        owner: object;
        epoch: number;
        file: import("obsidian").TFile | null;
        mtime?: number;
        size?: number;
    };
    path: string;
    contentHash?: string;
    ctime: number;
    mtime: number;
    lastTime: number;
    sessionId: string;
    totalChunks: number;
    size: number;
    /** 服务端确认的版本令牌，下载落盘后绑定 / Server-confirmed revision, bound when the download lands */
    revision?: string;
    chunks?: Map<number, ArrayBuffer>;
    tempDir?: string;
    downloadedChunks?: Set<number>;
    /** 所属下载页（0-based），从 receiveFileSyncUpdate 的 pageIndex 透传，供分片下载会话完成时归账（见 ReceiveMessage.pageIndex 注释） */
    pageIndex?: number;
    initialSlotKey?: string;
    /** Last time a response or chunk arrived for this session; used by the stalled-download watchdog */
    lastActivityAt?: number;
    /** 已进入组装/写盘阶段，看门狗跳过，避免与提交流程重复记账 / Assembling or writing; skipped by the watchdog to avoid double accounting */
    committing?: boolean;
}

export interface ReceiveMtimeMessage {
    path: string;
    ctime: number;
    mtime: number;
    lastTime?: number;
    /** 内容一致确认通道（基线模式，设计稿 §2.5）/ Content-equality confirmation (baseline mode, §2.5) */
    contentHash?: string;
    /** 服务端确认的版本令牌（基线模式）/ Server-confirmed revision (baseline mode) */
    revision?: string;
    /** 所属下载页（0-based），见 ReceiveMessage.pageIndex 注释 / owning download page, see ReceiveMessage.pageIndex */
    pageIndex?: number;
}

export interface ReceivePathMessage {
    path: string;
    lastTime?: number;
    /** 所属下载页（0-based），见 ReceiveMessage.pageIndex 注释 / owning download page, see ReceiveMessage.pageIndex */
    pageIndex?: number;
}

export interface SyncEndData {
    lastTime: number;
    messages: SyncMessage[];
    needUploadCount?: number;
    needModifyCount?: number;
    needSyncMtimeCount?: number;
    needDeleteCount?: number;
    /** 本轮已持久化的基线冲突数量（基线模式；旧服务端缺省）/ Persisted baseline conflicts this round (baseline mode; absent on old servers) */
    needConflictCount?: number;
    context?: string;
}

export interface NoteSyncData {
    lastTime: number;
    notes: SnapFile[];
    delNotes: PathHashFile[];
    missingNotes: PathHashFile[];
    context?: string;
}

export interface FileSyncData {
    lastTime: number;
    files: SnapFile[];
    delFiles: PathHashFile[];
    missingFiles: PathHashFile[];
    context?: string;
}

export interface ConfigSyncData {
    lastTime: number;
    configs: SnapFile[];
    delConfigs: PathHashFile[];
    missingConfigs: PathHashFile[];
    context?: string;
}


export interface FolderSyncRequest {
    vault: string;
    lastTime: number;
    folders: SnapFolder[];
    delFolders?: PathHashFile[];
    missingFolders?: PathHashFile[];
    context?: string;
}

export interface FolderSyncRenameMessage {
    path: string;
    pathHash: string;
    ctime: number;
    mtime: number;
    oldPath: string;
    oldPathHash: string;
    lastTime?: number;
    /** 所属下载页（0-based），见 ReceiveMessage.pageIndex 注释 / owning download page, see ReceiveMessage.pageIndex */
    pageIndex?: number;
}

export interface FolderSyncData {
    lastTime: number;
    folders: SnapFolder[];
    delFolders: PathHashFile[];
    missingFolders: PathHashFile[];
    context?: string;
}

/**
 * Internal Obsidian types for better type safety when accessing unofficial APIs.
 */
export interface AppWithInternal extends App {
    setting?: {
        open(): void;
        openTabById(id: string): void;
        activeTab?: {
            display(): void;
        };
        containerEl: HTMLElement;
        close(): void;
    };
    plugins?: {
        enabledPlugins: Set<string>;
        disablePlugin(id: string): Promise<void>;
        enablePlugin(id: string): Promise<void>;
        loadManifests(): Promise<void>;
        manifests: Record<string, unknown>;
        plugins: Record<string, unknown>;
    };
    internalPlugins?: {
        getPluginById(id: string): unknown;
        plugins: Record<string, unknown>;
    };
    hotkeys?: {
        load(): Promise<void>;
    };
}

export interface MenuItemWithDom {
    dom: HTMLElement;
}

/**
 * Obsidian Menu internal hide method type.
 * Obsidian Menu 内部 hide 方法的类型定义。
 */
export interface MenuWithHide {
    hide(): void;
}

export interface MenuItemWithInternal extends MenuItem {
    setSubmenu(): Menu;
    titleEl?: HTMLElement;
}


export interface WorkspaceWithInternal {
    on(name: 'file-menu', callback: (menu: Menu, file: import("obsidian").TAbstractFile) => void, ctx?: unknown): import("obsidian").EventRef;
    on(name: 'editor-menu', callback: (menu: Menu, editor: import("obsidian").Editor, view: import("obsidian").MarkdownView) => void, ctx?: unknown): import("obsidian").EventRef;
}



/**
 * 同步基线相关字段（阶段 C 仅做协议准备，阶段 E 才启用完整新决策）。
 * Sync baseline fields: stage C only prepares the protocol; stage E activates the full rules.
 *
 * 语义（设计稿 §2.2）：baseHashMissing=true 或 baseHash="" 表示没有可信内容基线；
 * 空文本的内容哈希是字符串 "0"（helpers.ts hashContent("") === "0"），它是有效哈希，
 * 不能按空字符串处理。两者矛盾时以 baseHashMissing 为准。
 * Semantics (design §2.2): baseHashMissing=true or baseHash="" means "no trusted content
 * baseline"; the empty-text hash is the string "0" and is a real hash. When the two disagree,
 * baseHashMissing wins.
 */
export interface SyncBaselineFields {
    baseHash?: string;
    baseHashMissing?: boolean;
    baseRevision?: string;
    isConflictResolved?: boolean;
}

/** 空文本内容哈希：有效哈希，不得当作空基线 / Empty-text content hash: real, never "no baseline" */
export const EMPTY_CONTENT_HASH = "0";

/**
 * 归一 baseline 字段，供 JSON 与 PB 解码结果共用。
 * Normalizes baseline fields for both JSON and PB decoding results.
 */
export function normalizeSyncBaseline<T extends SyncBaselineFields>(input: T): T {
    const baseHash = typeof input.baseHash === "string" ? input.baseHash : "";
    const missing = input.baseHashMissing === true || baseHash === "";
    return {
        ...input,
        baseHash: missing ? "" : baseHash,
        baseHashMissing: missing,
    };
}

/** 是否存在可信基线 / Whether a trusted baseline exists */
export function hasTrustedBaseline(input: SyncBaselineFields): boolean {
    return normalizeSyncBaseline(input).baseHashMissing === false;
}

/** 四类资源共用的统一冲突载荷 / Unified conflict payload shared by all four kinds */
export interface SyncConflictPayload {
    /** note | file | setting | folder（未来可能扩展，故保持 string） / note | file | setting | folder (kept as string for forward compatibility) */
    kind: string;
    path: string;
    pathHash: string;
    /**
     * both_modified | remote_deleted | local_deleted | no_baseline | baseline_unverified |
     * server_missing | revision_changed（未来可能扩展，故保持 string）
     */
    reason: string;
    serverHash: string;
    serverRevision: string;
    serverDeleted: boolean;
    baseHash: string;
    baseContent: string;
    baseMissing: boolean;
    serverContent: string;
}
