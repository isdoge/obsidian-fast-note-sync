import { moment, Platform, normalizePath } from "obsidian";

import { invalidateFileDownloads, handleFileChunkDownload, BINARY_PREFIX_FILE_SYNC, clearUploadQueue, receiveFileUploadSessionNotFound } from "./operator_file";
import { clearEmptyNoteProbes, conflictBackupPaths, writeConflictMeta } from "./operator_note";
import { dump, addRandomParam, showSyncNotice, safeStringify } from "../utils/helpers";
import { enSendDTOToProtobuf, deReceivePacket } from "../../pb/protobuf_mapper";
import { receiveOperators, startupSync, startupFullSync, settleAllBatchSendSessionsOnClose, settleSyncTimes } from "./operator";
import { SyncLogManager } from "./sync_log_manager";
import * as WSAction from "./websocket_action";
import { WebSocketClient } from "./websocket_client";
import { CLIENT_TYPE } from "../utils/types";
import type FastSync from "../../main";
import { $ } from "../../i18n/lang";
import { conflictKindToSyncType, freezeConflictPath, normalizeConflict, storeSyncConflict } from "./conflict_store";


// 冲突相关错误码
const ERROR_SYNC_CONFLICT = 530;

const AUTH_ERROR_REIMPORT_CODES = new Set([307, 308, 309, 310]);

/**
 * 服务端广告基线版本 >= 1 时，等待 ClientInfo 确认的最长时间。超时后绝不放行新模式，
 * 而是按设计稿 §2.1 断开重连，避免在"服务端支持但确认未完成"的不确定状态下开始同步。
 * Max wait for the ClientInfo confirmation when the server advertises baseline >= 1. On
 * timeout the new mode is never silently enabled; the connection is re-established instead
 * (design §2.1).
 */
const BASELINE_CONFIRM_TIMEOUT_MS = 8000;

const AUTH_ERROR_FALLBACK_MESSAGES: Record<number, string> = {
  307: "Authorization token is missing",
  308: "Session expired or token has been revoked",
  309: "Authorization token is invalid or incomplete",
  310: "Authorization token has expired",
  312: "Authorization token is restricted by IP",
  313: "Authorization token is restricted by user agent",
  314: "Authorization token is restricted by client",
  315: "Authorization token scope is restricted",
};

export interface StructuredMessageData {
  code: number;
  status?: boolean;
  message?: string;
  details?: string;
  data?: Record<string, unknown> | null;
  vault?: string;
  context?: string; // 当前同步上下文 / Current sync context
  // WSResponse 信封 pageIndex，线上值 1-based：0/undefined=非分页消息，n>0=下载第 n-1 页（设计稿 §4.3，
  // 用户澄清覆盖设计稿 §2.4 的旧假设）。JSON 模式下该字段随服务端顶层 JSON 天然携带；pb 模式由
  // protobuf_mapper.ts 的 deReceivePacket 透传。1-based->0-based 转换统一在 handleStructuredMessage 做。
  // WSResponse envelope pageIndex, wire value is 1-based: 0/undefined=non-paginated message,
  // n>0=download page n-1 (design §4.3; this supersedes design §2.4's original assumption per
  // user clarification). JSON mode carries it naturally as a top-level key; pb mode passes it
  // through via protobuf_mapper.ts's deReceivePacket. The 1-based->0-based conversion happens in
  // exactly one place: handleStructuredMessage below.
  pageIndex?: number;
}

function normalizeNoticeValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeNoticeValue(item))
      .filter(Boolean)
      .join(", ");
  }

  const text = safeStringify(value).trim();
  return text === "undefined" ? "" : text;
}

export function formatAuthorizationError(data: StructuredMessageData): string {
  const message = normalizeNoticeValue(data.message) || AUTH_ERROR_FALLBACK_MESSAGES[data.code] || "Authorization failed";
  const details = normalizeNoticeValue(data.details);
  const detailsText = details ? " Details=" + details : "";
  const authFailureText = (message + " " + details).toLowerCase();
  const needsReimportHint = AUTH_ERROR_REIMPORT_CODES.has(data.code) ||
    authFailureText.includes("rotated") ||
    authFailureText.includes("revoked") ||
    authFailureText.includes("no longer exists") ||
    authFailureText.includes("missing");
  const hint = needsReimportHint ? " Hint=Please re-import the API configuration from the management console." : "";

  return "Service Authorization Error: Code=" + data.code + " Msg=" + message + detailsText + hint;
}

export class WebSocketManager {
  public client: WebSocketClient;
  private plugin: FastSync;
  private currentStartHandleId = 0;
  private receivedFileDetails = new Set<string>();
  private receivedFileContext: string | null = null;
  // startupDelay 按设置文案（setting.sync.startup_delay_desc）本意是只延迟"首次"检查更新，
  // 用于错开 Obsidian 启动时其他插件并发加载造成的卡顿；不应在每次断线重连时都重复套用。
  // startupDelay is documented as delaying only the "first" update check, to avoid contending
  // with other plugins loading at Obsidian startup — it should not be re-applied on every reconnect.
  private hasAppliedStartupDelay = false;
  // 仅在本次插件会话禁用 protobuf，不修改用户保存的设置；插件重启后仍先尝试 protobuf。
  // Disable protobuf only for this plugin session, preserving the saved setting for the next launch.
  private hasProtobufDecodeFailed = false;
  // ClientInfo 确认等待（基线能力协商闸门）/ ClientInfo confirmation wait (baseline gate)
  private baselineConfirmTimer: number | null = null;
  private baselineGateWaiters: { resolve: () => void; reject: (reason: Error) => void }[] = [];

  // ─── 活跃同步期间它源消息的延后队列 ───────────────────────────────────────────
  // 一轮同步进行中（activeSyncContext 非空）时，context 不匹配且不属于本机已作废 context 的
  // 消息（其它设备的实时广播、本机无 context 请求的应答如 #205 的 NoteRePush 回包）不再丢弃，
  // 而是进此队列，本轮结束（activeSyncContext 置空，setter 触发 onSyncContextRetired）后按到达
  // 顺序走与实时分发完全相同的路径回放。回放中新一轮开始则剩余消息留队等下一次。断线清空。
  // While a sync round is active, messages whose context mismatches but is not one of this
  // client's retired contexts (other devices' live broadcasts, replies to this client's
  // contextless requests such as #205's NoteRePush round trip) are deferred here instead of
  // being dropped; they replay through the exact same dispatch path in arrival order once the
  // round ends (the activeSyncContext setter fires onSyncContextRetired). If a new round
  // starts mid-replay the rest stays queued for the next drain. Cleared on disconnect.
  private deferredMessages: { action: string; data: StructuredMessageData }[] = [];
  private deferredBytes = 0;
  private replayScheduled = false;
  private replayGeneration = 0;
  private deferredOverflowed = false;

  // --- 轻量事件总线，用于分批发送时等待服务端 BatchAck ---
  // Lightweight event bus for awaiting server BatchAck during batch send
  private sentRequests = new Map<string, { action: string; path?: string }>();
  private _listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();

  /**
   * 订阅事件 / Subscribe to an event
   */
  public on(event: string, cb: (...args: unknown[]) => void): void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)!.add(cb);
  }

  /**
   * 取消订阅事件 / Unsubscribe from an event
   */
  public off(event: string, cb: (...args: unknown[]) => void): void {
    const cbs = this._listeners.get(event);
    if (cbs) {
      cbs.delete(cb);
      if (cbs.size === 0) {
        this._listeners.delete(event);
      }
    }
  }

  /**
   * 触发事件 / Emit an event
   */
  public emit(event: string, ...args: unknown[]): void {
    const cbs = this._listeners.get(event);
    if (cbs) {
      cbs.forEach(cb => cb(...args));
    }
  }

  constructor(plugin: FastSync) {
    this.plugin = plugin;
    // 活跃同步 context 置空/替换（近十处分散写入点）时，由此集中触发延后队列回放；
    // 回放异步调度，不在置空的调用栈里同步重入分发
    // Clearing/superseding the active sync context (scattered write sites) centrally triggers
    // the deferred-queue replay here; replay is scheduled async, never re-entering dispatch
    // synchronously inside the clearing call stack
    this.plugin.syncState.onSyncContextRetired = () => this.scheduleDeferredReplay();
    this.client = new WebSocketClient(this.plugin, {
      getWsUrl: (count) => {
        const client = CLIENT_TYPE;
        const clientName = encodeURIComponent(this.plugin.getClientName());
        const clientVersion = this.plugin.manifest.version || "";
        // Always include protocol=protobuf regardless of settings
        // 无论设置如何，始终包含 protocol=protobuf 参数
        const useProtoParam = "&protocol=protobuf";
        // pv=2：声明客户端支持 v2 握手协商（auth 响应携带协商块、窗口流水线、pb 提前升级）
        // pb=1/0：客户端本地 protobufEnabled 设置，供服务端判定是否提前升级 pb（设计稿 §2.2）
        const isProtobufEnabled = this.isProtobufEnabled();
        const negotiationParams = "&pv=2&pb=" + (isProtobufEnabled ? "1" : "0");
        return addRandomParam(
          this.plugin.runWsApi +
          "/api/user/sync?lang=" +
          moment.locale() +
          "&count=" +
          count +
          "&client=" +
          client +
          "&clientName=" +
          clientName +
          "&clientVersion=" +
          clientVersion +
          useProtoParam +
          negotiationParams
        );
      },
      preConnectProbe: async () => {
        const needProbe = this.plugin.settings.autoRedirectEnabled || this.plugin.settings.wsPreProbeEnabled;
        if (needProbe) {
          return await this.plugin.api.probeApiRedirect(this.plugin.runApi);
        }
        return true;
      },
      onOpen: (client) => {
        // 每次新建连接都从零开始协商基线能力（设计稿 §2.1 第 1 条）
        // Every new connection starts baseline negotiation from scratch (design §2.1 rule 1)
        this.resetBaselineNegotiation();
        client.Send(WSAction.ClientReceiveAuth, this.plugin.settings.apiToken);
        dump("Service authorization");
      },
      onClose: (client, code, reason) => {
        SyncLogManager.getInstance().addLog('error', 'ConnectionClosed',
          `WebSocket closed: ${code} ${reason}`, 'error');
        this.cleanupDisconnectedSync();
      },
      onMessage: (client, action, data) => {
        void this.handleStructuredMessage(action, data);
      },
      serializeMessage: (action, payload) => {
        // 防御性守卫：client.useProtobuf 与设置变更都会在发送前挡住此回调，正常不可达；
        // 即便到达，WebSocketClient.Send 也会捕获并退回 JSON 文本帧，消息不会丢失。
        // Defensive guard: client.useProtobuf and the settings check keep this unreachable;
        // even if reached, WebSocketClient.Send catches and falls back to a JSON text frame.
        if (!this.isProtobufEnabled()) {
          throw new Error("Protobuf disabled after a decode failure");
        }
        return enSendDTOToProtobuf(action, payload);
      },
      deserializeMessage: (data) => {
        if (this.hasProtobufDecodeFailed) {
          return null;
        }
        try {
          return deReceivePacket(data) as unknown as { action: string;[key: string]: unknown };
        } catch {
          this.fallbackToJsonAfterProtobufDecodeFailure();
          return null;
        }
      },
    });

    // 绑定大流量下载 binary handler
    this.client.registerBinaryHandler(BINARY_PREFIX_FILE_SYNC, (data) => {
      void handleFileChunkDownload(data, this.plugin);
    });
  }

  /** 主动与被动断线共用清理，保留本地待上传改动。 / Shared disconnect cleanup preserves pending edits. */
  private cleanupDisconnectedSync(): void {
    // 断线即失去本连接的协商结论：清零并让仍在等待的闸门失败，重连后重新协商
    // A drop voids this connection's negotiation verdict: reset it and fail pending gate
    // waiters so the next connection re-negotiates
    this.resetBaselineNegotiation();
    this.sentRequests?.clear();
    this.plugin.retryQueue?.onDisconnected();
    if (this.plugin.isSyncing) {
      this.plugin.isSyncing = false;
      this.plugin.isSyncRequesting = false;
      // 连接断开后本轮同步已不可能继续：一并作废其 context，让仍在跑的扫描循环
      // 在下一个让出点自行退出，否则它会一直扫到底并用作废的 context 发一轮数据
      // The round can't continue once the socket is gone: invalidate its context so an
      // in-flight scan bails out at its next yield point instead of scanning to completion
      // and sending a full round under a dead context.
      this.plugin.syncState.activeSyncContext = null;
      // 本轮未完成：已推进的同步时间回到本轮基线 / Unfinished round: sync times return to the baseline
      settleSyncTimes(this.plugin, true);
    }
    // 旧连接上的延后消息不该在新连接上处理（其 vault/会话前提可能已失效）；
    // 断线后本轮游标回基线，重连的增量同步会重新拉这些变更
    // Deferred messages from the closed connection must not run on a new one (their
    // vault/session assumptions may be stale); the round's cursor fell back to its
    // baseline, so the post-reconnect incremental sync re-pulls those changes
    this.clearDeferredMessages();
    this.receivedFileDetails.clear();
    // 断线即失去"本连接已对齐"的保证：单条消息推进游标的许可随连接失效（service#101）
    // Disconnect voids the "this connection is aligned" guarantee: the per-item cursor
    // advance permission expires with the connection (service#101)
    this.plugin.syncState.hasSyncedThisConnection = false;
    // #205：断线后空白笔记探测的结论不会再到达，作废在途/已确认标记，重连后重新探测
    // #205: no probe verdict can arrive after the drop; void the marks so reconnect re-probes
    clearEmptyNoteProbes(this.plugin);
    // Downloads requested on the closed connection may no longer commit.
    invalidateFileDownloads(this.plugin);
    clearUploadQueue();
    this.plugin.concurrencyLimiter.clear();
    // 断线：清空所有在途上行批发送窗口会话的重传 timer（设计稿 §3.2 异常路径表）；
    // W==0/旧路径下没有会话注册，no-op
    settleAllBatchSendSessionsOnClose();
  }

  private isProtobufEnabled(): boolean {
    return !this.hasProtobufDecodeFailed && this.plugin.settings.protobufEnabled !== false;
  }

  /**
   * 服务端会分别处理文本 JSON 帧，且 ClientInfo(protobuf=false) 会关闭本连接的 protobuf。
   * 因而不必断开连接；本会话后续重连则通过握手 pb=0 保持 JSON。
   * The server parses text JSON frames separately and ClientInfo(protobuf=false) disables
   * protobuf for this connection, so reconnecting is unnecessary. pb=0 keeps later reconnects on JSON.
   */
  private fallbackToJsonAfterProtobufDecodeFailure(): void {
    if (this.hasProtobufDecodeFailed) {
      return;
    }
    this.hasProtobufDecodeFailed = true;
    this.client.useProtobuf = false;

    // 每次插件会话只提示一次，鉴权前后的失败路径都走这里。
    // Notify once per plugin session, on both the pre-auth and post-auth paths.
    const message = $("ui.notice.protobuf_fallback");
    showSyncNotice(message);
    SyncLogManager.getInstance().addLog('error', 'ProtobufFallback', message, 'error');

    if (!this.client.isAuth) {
      // 降级帧需要已认证连接；若解码在鉴权前失败，用 pb=0 的新连接完成握手。
      // The downgrade frame requires authentication; reconnect with pb=0 if it failed earlier.
      this.triggerReconnect();
      return;
    }

    this.sendClientInfo();
  }

  // 代理一些 WebSocketClient 的方法和属性以保持向后兼容性
  public get ws(): WebSocket | null {
    return this.client.ws;
  }
  public get isOpen(): boolean {
    return this.client.isOpen;
  }
  public get isAuth(): boolean {
    return this.client.isAuth;
  }
  public set isAuth(val: boolean) {
    this.client.isAuth = val;
  }
  public get useProtobuf(): boolean {
    return this.client.useProtobuf;
  }
  public get isRegister(): boolean {
    return this.client.isRegister;
  }
  public set isRegister(val: boolean) {
    this.client.isRegister = val;
  }
  public get count(): number {
    return this.client.count;
  }

  public addStatusListener(listener: (status: boolean) => void) {
    this.client.addStatusListener(listener);
  }
  public removeStatusListener(listener: (status: boolean) => void) {
    this.client.removeStatusListener(listener);
  }
  public addActivityListener(listener: () => void) {
    this.client.addActivityListener(listener);
  }
  public register() {
    return this.client.register();
  }
  public unRegister(setUnregistered = false) {
    this.client.unRegister(setUnregistered);
    this.cleanupDisconnectedSync();
  }
  public isConnected(): boolean {
    return this.client.isConnected();
  }
  public triggerReconnect() {
    this.client.triggerReconnect();
  }
  public SendMessage(action: WSAction.WSSendAction, data: unknown, before?: () => boolean, after?: () => void, context?: string) {
    const queue = this.plugin.retryQueue;
    const guard = queue?.sendGuard(action, data as { path?: string; oldPath?: string });
    // Explicitly contextless: retry ACKs never belong to a scan round.
    const injectedData = guard ? { ...(data as object), context: "" } : this.injectContext(data, context);
    return this.client.SendMessage(action, injectedData, () => {
      if (guard && !guard()) return true;
      return before?.() ?? false;
    }, () => {
      const path = (data as { path?: string })?.path;
      this.sentRequests ??= new Map();
      if (/^(Note|File|Folder|Setting)(Modify|Delete|Rename|UploadCheck)$/.test(action)) {
        this.sentRequests.set(`${action}:${path || ""}`, { action, path });
      }
      if (guard) queue.onSent(action, data as { path?: string; oldPath?: string });
      // Record the send event in sync logs
      // 在同步日志中记录发送事件
      SyncLogManager.getInstance().logSentMessage(action, injectedData as object | string, this.plugin.currentSyncType);
      after?.();
    }, guard ? () => queue.beforeSend(action, data as { path?: string; oldPath?: string }) : undefined);
  }
  public Send(action: WSAction.WSSendAction, data: unknown, after?: () => void, context?: string) {
    const injectedData = this.injectContext(data, context);
    this.client.Send(action, injectedData, () => {
      // Record the send event in sync logs
      // 在同步日志中记录发送事件
      SyncLogManager.getInstance().logSentMessage(action, injectedData as object | string, this.plugin.currentSyncType);
      after?.();
    });
  }

  /**
   * Injects the current sync context into outgoing payload if in an active sync session.
   * 如果处于活跃同步状态，向消息载荷注入当前同步 context。
   * 仅对不已携带 context 字段的对象类型载荷进行注入，避免重复注入。
   */
  private injectContext(data: unknown, context?: string): unknown {
    const ctx = context || this.plugin.syncState.activeSyncContext;
    if (
      ctx &&
      data !== null &&
      typeof data === 'object' &&
      !('context' in (data as Record<string, unknown>))
    ) {
      return { ...(data as Record<string, unknown>), context: ctx };
    }
    return data;
  }
  public SendBinary(data: ArrayBuffer | Uint8Array, prefix: string, before?: () => boolean, after?: () => void) {
    return this.client.SendBinary(data, prefix, before, after);
  }

  private isStructuredMessageData(obj: unknown): obj is StructuredMessageData {
    if (typeof obj !== "object" || obj === null) {
      return false;
    }
    const record = obj as Record<string, unknown>;
    return typeof record.code === "number";
  }

  private handleStructuredMessage(msgAction: string, data: unknown, fromReplay = false) {
    if (!this.isStructuredMessageData(data)) {
      return;
    }

    // 记录接收到的消息
    if (msgAction) {
      SyncLogManager.getInstance().logReceivedMessage(msgAction, data, this.plugin.currentSyncType);
    }

    if (msgAction === WSAction.ClientReceiveAuth) {
      if (data.code <= 0 || data.code >= 300) {
        showSyncNotice(formatAuthorizationError(data), 6000);
        return;
      } else {
        this.client.isAuth = true;
        const paths = (data.data?.["paths"] as string[]) || [];
        this.plugin.shareIndicatorManager?.updateSharedPaths(paths);
        if (data.data) {
          const serverVersion = (data.data["version"] as string) ?? this.plugin.localStorageManager.getMetadata("serverVersion");
          const serverChangelog = (data.data["changelog"] as string) ?? this.plugin.localStorageManager.getMetadata("serverChangelog");
          this.plugin.localStorageManager.setMetadata("serverVersion", serverVersion);
          this.plugin.localStorageManager.setMetadata("serverChangelog", serverChangelog);
        }

        // 握手合并（设计稿 §5.2）：pv>=2 的服务端在 auth 响应追加协商块，此处必须在 StartHandle() 之前
        // 写入 syncState，因为 sendSyncInBatches 的窗口大小/chunkNum 默认取 syncState 当前值。
        // 旧服务端（无协商块）：所有协商字段保持 sync_state.ts 的默认值（negotiated=false, window=0），
        // 即现状 stop-and-wait，行为零变化。
        // Handshake merge (design §5.2): a pv>=2 server appends a negotiation block to the auth
        // response. This MUST be written to syncState before StartHandle() is invoked below, since
        // sendSyncInBatches reads window size/chunkNum defaults from syncState at call time.
        // Old server (no negotiation block): all fields stay at sync_state.ts defaults
        // (negotiated=false, window=0) — current stop-and-wait behavior, unchanged.
        if (data.data) {
          const nego = data.data;
          let negotiated = false;
          if (typeof nego.syncUpChunkNum === "number") {
            this.plugin.syncState.syncUpChunkNum = nego.syncUpChunkNum;
            negotiated = true;
          }
          if (typeof nego.syncDownChunkNum === "number") {
            this.plugin.syncState.syncDownChunkNum = nego.syncDownChunkNum;
            negotiated = true;
          }
          if (typeof nego.pipelineWindowUp === "number") {
            this.plugin.syncState.pipelineWindowUp = nego.pipelineWindowUp;
            negotiated = true;
          }
          if (typeof nego.pipelineWindowDown === "number") {
            this.plugin.syncState.pipelineWindowDown = nego.pipelineWindowDown;
            negotiated = true;
          }
          this.plugin.syncState.negotiated = negotiated;
          // 基线能力广告（设计稿 §2.1 第 2 条）：只是能力，不能据此启用新模式
          // Baseline capability advertisement (design §2.1 rule 2): advertisement only
          this.plugin.syncState.serverAdvertisedBaselineVersion =
            typeof nego.syncBaselineVersion === "number" && nego.syncBaselineVersion > 0
              ? Math.floor(nego.syncBaselineVersion) : 0;
          // protobufAck===true：服务端已在 auth 响应后提前 setUseProtobuf，本连接后续下行帧即为 pb，
          // 客户端同步跟进，无需再等 ClientInfo 响应触发升级（websocket_client.ts:259 该触发仍保留作旧服务端路径）
          if (nego.protobufAck === true && this.isProtobufEnabled()) {
            this.client.useProtobuf = true;
            dump("WS Client upgraded to Protobuf via auth negotiation (pv2)");
          }
        }

        dump("Service authorization success");
        // 新连接：离线增量尚未对齐，单条实时消息不得推进游标，直到本连接完成一轮正常同步
        //（service#101，见 sync_state.hasSyncedThisConnection）
        // New connection: the offline backlog is unaligned, per-item live messages must not
        // advance the cursor until this connection completes one clean round
        // (service#101, see sync_state.hasSyncedThisConnection)
        this.plugin.syncState.hasSyncedThisConnection = false;
        this.client.notifyStatusChange(true);

        this.sendClientInfo();
        void this.startAfterBaselineGate();
      }
      return;
    }

    if (msgAction === WSAction.ClientReceiveInfo) {
      if (data.code <= 0 || data.code >= 300) {
        return;
      } else {
        if (data.data) {
          this.plugin.versionManager.updateFromClientInfo(data.data);
          // 只有本连接尚未确认时才采纳；后台版本广播只更新提示，不篡改已确认的模式
          // Only adopt while this connection is unconfirmed; a background broadcast updates the
          // version notice but never rewrites an established mode (design §2.1 rule 9)
          if (!this.plugin.syncState.clientInfoConfirmed) {
            this.confirmBaseline(data.data["syncBaselineVersion"]);
            dump(`[Baseline] ClientInfo confirmed version ${this.plugin.syncState.negotiatedSyncBaselineVersion}`);
            this.openBaselineGate();
          }
        } else if (!this.plugin.syncState.clientInfoConfirmed) {
          // 应答没有 data：视为老服务端，按 0 确认，立即进入兼容模式
          // Reply without data: treat as an old server, confirm 0 and enter compatibility mode
          this.confirmBaseline(0);
          this.openBaselineGate();
        }
      }
      return;
    }

    if (data.code <= 0 || data.code >= 300) {
      const isProtobufDecodeError = /(?:^|,\s*)(?:body:\s*)?Protobuf decode failed:/i.test(data.details || "");
      const errorPath = typeof data.data?.path === "string" ? data.data.path : undefined;
      // Old validation errors omit both path and action. Only a unique outstanding request
      // can identify one safely; named legacy Ack errors match the serial queue by action.
      const [onlyRequest] = this.sentRequests?.size === 1 ? this.sentRequests.values() : [];
      const pathRequest = errorPath ? [...(this.sentRequests?.values() || [])].filter(r => r.path === errorPath) : [];
      const errorAction = (!msgAction || msgAction === "Error")
        ? (pathRequest.length === 1 ? pathRequest[0].action : onlyRequest?.action || "") : msgAction;
      if (!isProtobufDecodeError && (!data.vault || data.vault === this.plugin.settings.vault) && !data.context
        && this.plugin.retryQueue?.reject?.(errorAction, errorPath || (!msgAction ? onlyRequest?.path : undefined), data.code, data.message || "")) {
        this.sentRequests?.delete(`${errorAction.replace(/Ack$/, "")}:${errorPath || onlyRequest?.path || ""}`);
        return;
      }
      // 冲突（530）不在这里吞掉：队列未认领的冲突（如改名目标路径）必须交给冲突面板。
      // Never swallow a conflict (530) here: an unclaimed one (e.g. a rename target) must reach
      // the conflict panel.
      if (!isProtobufDecodeError && data.code !== ERROR_SYNC_CONFLICT && !data.context && errorPath
        && this.plugin.retryQueue?.ownsPendingPath(errorPath)) return;
      // 处理冲突相关错误码
      if (data.code === ERROR_SYNC_CONFLICT) {
        void this.handleConflictError(data);
        const conflict = normalizeConflict(data.data);
        const path = conflict?.path || "";
        if (path !== "") {
          this.plugin.concurrencyLimiter.releaseSlot(path);
          // 四类资源共用同一拒绝载荷：按 kind 归账，不能一律记到笔记上
          // All four kinds share the rejection payload: account by kind, never always as a note
          const type = conflictKindToSyncType(conflict?.kind || "note");
          const pageIndex = type === "note" ? this.plugin.syncState.pendingNotePushPageIndex.get(path)
            : type === "setting" ? this.plugin.syncState.pendingConfigPushPageIndex.get(path)
            : type === "file" ? this.plugin.syncState.pendingFilePushPageIndex.get(path) : undefined;
          if (type === "note") this.plugin.syncState.pendingNotePushPageIndex.delete(path);
          else if (type === "setting") this.plugin.syncState.pendingConfigPushPageIndex.delete(path);
          else if (type === "file") this.plugin.syncState.pendingFilePushPageIndex.delete(path);
          this.plugin.recordSyncCompleted(type, pageIndex);
        }
      } else if (data.code === 463 && typeof data.data?.sessionID === "string") {
        receiveFileUploadSessionNotFound(data.data.sessionID, this.plugin);
      } else {
        const errorMsg = data.message || "";
        const errorDetails = data.details ? " Details=" + data.details : "";
        // 服务端已成功解码外层响应，但客户端上行 protobuf 的内层 DTO 解码失败。
        // The server decoded this error envelope, but rejected our uplink protobuf DTO.
        if (isProtobufDecodeError) {
          // 仅这类解码错误区别对待：protobuf 仍启用则回退到 JSON；已回退则静默忽略迟到的同类错误。
          // Only decode errors are special-cased: fall back while protobuf is still enabled,
          // and silently drop late duplicates afterwards. All other errors keep their notice.
          if (this.isProtobufEnabled()) {
            this.fallbackToJsonAfterProtobufDecodeFailure();
          }
        } else {
          showSyncNotice("Service Error: Code=" + data.code + " Message=" + errorMsg + errorDetails);
        }
        
        // 如果错误数据里含有 sessionID 或 path，也进行释放和清理，防止同步卡死
        // If error payload contains sessionID or path, release slot and increment completed to prevent deadlock
        if (data.data && typeof data.data.sessionID === "string") {
          receiveFileUploadSessionNotFound(data.data.sessionID, this.plugin);
        } else if (data.data && typeof data.data.path === "string") {
          const path = data.data.path;
          this.plugin.concurrencyLimiter.releaseSlot(path);
          // 下载占用的是 download_<路径> 名额，出错回应只带路径时也要一并放掉
          // Downloads hold a download_<path> slot; release it too when the error only carries the path
          this.plugin.concurrencyLimiter.releaseSlot("download_" + path);
          this.plugin.fileSyncTasks.completed++;
        }
      }
    } else {
      if (typeof data === "object" && "vault" in data && data.vault != null && data.vault !== "" && data.vault !== this.plugin.settings.vault) {
        // 两个库名都放进结构化字段，诊断日志按键名整体脱敏（服务端回来的库名和本机配置的不同，整词规则遮不到）
        // Both vault names go into keyed fields so the diagnostic log redacts them by key
        dump("Service vault not match", { remoteVault: data.vault, localVault: this.plugin.settings.vault });
        return;
      }

      // 基于 Context 进行过滤：活跃同步中必须完全匹配；不匹配时区分两类——
      // 本机已作废 context（上一轮的迟到应答）照旧丢弃；其它来源（其它设备的实时广播、
      // 本机无 context 请求的应答）延后到本轮结束再处理，不再直接丢弃
      // Context filter: during an active round messages must match. On mismatch, retired
      // contexts of this client (late replies of the previous round) are still discarded;
      // other sources (other devices' live broadcasts, replies to this client's contextless
      // requests) are deferred until the round ends instead of being dropped outright
      // 本机已作废 context 的迟到应答，没有活跃轮次时同样丢弃：取消同步或停滞重启后，服务端
      // 已发出的旧轮次消息不能继续落地，更不能凭旧 context 回分页确认把被取消的轮次接着跑完
      // Late replies carrying a retired context of this client are discarded when idle too:
      // after a cancel or stall restart the old round's in-flight messages must not be applied,
      // nor may their page acks keep driving the cancelled round to the end
      if (data.context && data.context !== this.plugin.syncState.activeSyncContext
        && this.plugin.syncState.retiredSyncContexts.has(data.context)) {
        dump(`[SyncContext] Discard message ${msgAction} due to mismatched context. Expected: ${this.plugin.syncState.activeSyncContext}, Got: ${data.context}`);
        return;
      }
      if (this.plugin.retryQueue?.shouldIgnoreAck(msgAction, typeof data.data?.path === "string" ? data.data.path : undefined)) return;
      // 仅本机空闲时申请的槽位允许提前确认；已作废 context 已在上方丢弃。
      // Only this client's idle-owned slots may settle early; retired contexts were rejected above.
      const ackPath = typeof data.data?.path === "string" && data.data.path ? data.data.path
        : msgAction === WSAction.NoteRenameAck ? Array.from(this.plugin.pendingNoteRenames?.keys() ?? [])[0]
        : msgAction === WSAction.FileRenameAck ? this.plugin.pendingFileRenames?.[0]?.newPath : undefined;
      const idleSlot = !data.context && ackPath !== undefined
        && this.plugin.concurrencyLimiter?.getSlotContext?.(ackPath) === null;
      const isLocalAck = [WSAction.NoteModifyAck, WSAction.FileUploadAck, WSAction.SettingModifyAck,
        WSAction.NoteSyncMtime, WSAction.FileSyncMtime, WSAction.FileUpload,
        WSAction.NoteRenameAck, WSAction.FileRenameAck, WSAction.NoteDeleteAck,
        WSAction.FileDeleteAck, WSAction.SettingDeleteAck].includes(msgAction);
      const queueAck = !data.context && this.plugin.retryQueue?.matchesAck(msgAction, typeof data.data?.path === "string" ? data.data.path : undefined);
      const outsideRound = !!queueAck || (!!this.plugin.syncState.activeSyncContext && idleSlot && isLocalAck);
      if (this.plugin.syncState.activeSyncContext) {
        const isControlMsg = msgAction === WSAction.ClientReceiveAuth || msgAction === WSAction.ClientReceiveInfo;
        // Older servers omit context on the UpdateMtime response to NoteModify.
        // Only admit a contextless response for a pending upload in this client.
        const isPendingMtimeAck = msgAction === WSAction.NoteSyncMtime && !data.context
          && typeof data.data?.path === 'string'
          && this.plugin.pendingNoteModifies.has(data.data.path);
        // 旧服务端复用上传会话时可能丢失本轮 context；按路径等待的文件确认不能延后，否则分页永远无法结束。
        // Older servers may lose the round context when reusing uploads; pending file Acks must settle now or the page cannot finish.
        const isPendingFileUploadAck = msgAction === WSAction.FileUploadAck && !data.context
          && typeof data.data?.path === 'string'
          && this.plugin.syncState.pendingFilePushPageIndex.has(data.data.path);
        if (!isControlMsg && !outsideRound && !isPendingMtimeAck && !isPendingFileUploadAck && data.context !== this.plugin.syncState.activeSyncContext) {
          this.enqueueDeferredMessage(msgAction, data);
          return;
        }
      }

      // 回放中的新实时消息排到队尾，控制消息仍立即处理。
      // Queue live arrivals behind the replay backlog; control messages remain immediate.
      const isControlMsg = msgAction === WSAction.ClientReceiveAuth || msgAction === WSAction.ClientReceiveInfo;
      if (!fromReplay && !isControlMsg && !(isLocalAck && idleSlot) && !msgAction.endsWith("Ack") && !this.plugin.syncState.activeSyncContext
        && (this.replayScheduled || this.deferredMessages.length > 0)) {
        this.enqueueDeferredMessage(msgAction, data);
        this.scheduleDeferredReplay();
        return;
      }
      return this.dispatchReceiveMessage(msgAction, data, outsideRound);
    }
  }

  /**
   * 实时与延后回放共用的分发路径（原 handleStructuredMessage 尾段原样抽出）：vault 校验已在上游
   * 完成，此处做 pageIndex 转换、context 合并、重传去重并调用 handler。
   * Shared dispatch path for live and deferred replay (extracted verbatim from the former
   * tail of handleStructuredMessage): vault filtering already happened upstream; this does
   * the pageIndex conversion, context merge, retransmission dedup and handler invocation.
   */
  private dispatchReceiveMessage(msgAction: string, data: StructuredMessageData, outsideRound = false) {
    const handler = receiveOperators.get(msgAction);
    if (!handler) return;
    // WSResponse 信封 pageIndex 转换（设计稿 §4.3，唯一转换点）：线上 1-based，
        // 0/undefined = 非分页消息（不并入 payload，下游按 undefined 走旧路径）；
        // n>0 = 下载第 n-1 页，转换为内部 0-based 值并入 payload.pageIndex
        // WSResponse envelope pageIndex conversion (design §4.3, the single conversion point):
        // wire value is 1-based. 0/undefined = non-paginated (not merged into payload, downstream
        // reads undefined and takes the legacy path); n>0 = download page n-1, converted to the
        // internal 0-based value and merged into payload.pageIndex
        const rawPageIndex = typeof data.pageIndex === 'number' ? data.pageIndex : 0;
        const pageIndex = rawPageIndex > 0 ? rawPageIndex - 1 : undefined;

        let payload: unknown = data.data;
        if (typeof data.data === 'object' && data.data !== null) {
          const merged = { ...data.data };
          if (data.context) merged.context = data.context;
          if (pageIndex !== undefined) merged.pageIndex = pageIndex;
          payload = merged;
        }
        this.receivedFileDetails ??= new Set<string>();
        const context = this.plugin.syncState.activeSyncContext;
        if (this.receivedFileContext !== context) {
          this.receivedFileDetails.clear();
          this.receivedFileContext = context;
        }
        // Retransmission must not enqueue the same page item again while it is
        // waiting for a slot or already processed. Non-paged live edits bypass this.
        const path = (payload as { path?: string })?.path;
        const requestAction = msgAction === WSAction.FileUpload || msgAction === WSAction.FileSyncMtime || msgAction === WSAction.FileUploadAck
          ? "FileUploadCheck" : msgAction === WSAction.NoteSyncMtime ? "NoteModify" : msgAction.replace(/Ack$/, "");
        const requestPath = path || (msgAction === WSAction.NoteRenameAck ? [...this.plugin.pendingNoteRenames.keys()][0]
          : msgAction === WSAction.FileRenameAck ? this.plugin.pendingFileRenames[0]?.newPath : undefined);
        if (requestPath) this.sentRequests?.delete(`${requestAction}:${requestPath}`);
        const detailKey = context && pageIndex !== undefined && typeof path === 'string'
          && [WSAction.FileSyncUpdate, WSAction.FileUpload, WSAction.FileSyncMtime,
              WSAction.FileSyncDelete, WSAction.FileSyncRename].includes(msgAction)
          ? JSON.stringify([context, pageIndex, msgAction, path]) : null;
        if (detailKey && this.receivedFileDetails.has(detailKey)) return;
        if (detailKey) this.receivedFileDetails.add(detailKey);
        const processing = Promise.resolve(handler(payload, this.plugin, outsideRound)).catch(error => {
          if (detailKey) this.receivedFileDetails.delete(detailKey);
          dump('Sync handler failed', msgAction, error);
        });
        this.client.notifyActivity();
        return processing;
  }

  // ─── 延后队列（见类顶部字段注释 / see class-top field comment）──────────────

  /** 队列上限：条数与序列化字节数，防 NoteSyncModify 带正文撑爆内存；超限丢弃新消息并 dump */
  private static readonly DEFERRED_MAX_COUNT = 500;
  private static readonly DEFERRED_MAX_BYTES = 8 * 1024 * 1024;

  private enqueueDeferredMessage(action: string, data: StructuredMessageData): void {
    if (!receiveOperators.has(action)) return;
    const size = WebSocketManager.stringifySize(data);
    if (this.deferredMessages.length >= WebSocketManager.DEFERRED_MAX_COUNT
      || this.deferredBytes + size > WebSocketManager.DEFERRED_MAX_BYTES) {
      dump(`[SyncContext] Deferred queue overflow (${this.deferredMessages.length} items, ${this.deferredBytes} bytes); discard incoming ${action}`);
      this.deferredOverflowed = true;
      return;
    }
    this.deferredMessages.push({ action, data });
    this.deferredBytes += size;
    dump(`[SyncContext] Deferring message ${action} (context: ${data.context || "none"}) until the active round ends; queued: ${this.deferredMessages.length}`);
  }

  /** 轮次结束（activeSyncContext 置空/替换）时异步调度回放；不在置空调用栈里同步重入 */
  private scheduleDeferredReplay(): void {
    if ((this.deferredMessages.length === 0 && !this.deferredOverflowed) || this.replayScheduled) return;
    this.replayScheduled = true;
    const generation = this.replayGeneration ??= 0;
    window.setTimeout(() => {
      if (generation !== this.replayGeneration) return;
      void this.drainDeferredMessages(generation).catch(error => {
        dump('Deferred replay failed', error);
      }).finally(() => {
        if (generation === this.replayGeneration) {
          this.replayScheduled = false;
          if (!this.plugin.syncState.activeSyncContext) this.scheduleDeferredReplay();
        }
      });
    }, 0);
  }

  private async drainDeferredMessages(generation: number): Promise<void> {
    // 队列溢出丢过消息：回放其余消息时不能再推进同步时间，否则会越过被丢弃的那条。
    // 退回"本连接尚未完成同步"的状态，等下一轮同步按已结算的时间重新拉取
    // Messages were dropped on overflow: replaying the rest must not advance the sync cursor past
    // the dropped ones. Fall back to "no clean round on this connection" until the next round
    // re-pulls from the settled cursor
    if (this.deferredOverflowed) {
      this.deferredOverflowed = false;
      this.plugin.syncState.hasSyncedThisConnection = false;
    }
    // 回放期间新一轮同步已开始：剩余消息留队，等该轮结束的下次触发
    // A new round started mid-replay: leave the rest queued for that round's next trigger
    while (generation === this.replayGeneration && this.deferredMessages.length > 0 && !this.plugin.syncState.activeSyncContext) {
      const { action, data } = this.deferredMessages.shift()!;
      this.deferredBytes -= WebSocketManager.stringifySize(data);
      await this.handleStructuredMessage(action, data, true);
    }
  }

  private static stringifySize(data: StructuredMessageData): number {
    try { return safeStringify(data).length; } catch { return 2048; }
  }

  /** 断线清空：旧连接上的消息不该在新连接上处理；重连后增量同步按基线游标重新拉 */
  private clearDeferredMessages(): void {
    if (this.deferredMessages.length > 0) {
      dump(`[SyncContext] Connection closed; dropping ${this.deferredMessages.length} deferred messages`);
    }
    this.replayGeneration = (this.replayGeneration ?? 0) + 1;
    this.deferredMessages = [];
    this.deferredBytes = 0;
    this.replayScheduled = false;
    this.deferredOverflowed = false;
  }

  public sendClientInfo() {
    if (!this.client.isAuth) {
      return;
    }

    const clientName = this.plugin.getClientName();
    const isProtobufEnabled = this.isProtobufEnabled();

    if (!isProtobufEnabled) {
      // Reset client's Protobuf flag immediately to fallback to JSON format
      // 立即将客户端的 Protobuf 标志重置为 false 以退回到 JSON 格式
      this.client.useProtobuf = false;
    }

    this.Send(WSAction.ClientReceiveInfo, {
      name: clientName,
      version: this.plugin.manifest.version,
      type: CLIENT_TYPE,
      isDesktop: Platform.isDesktop,
      isMobile: Platform.isMobile,
      isPhone: Platform.isPhone,
      isTablet: Platform.isTablet,
      isMacOS: Platform.isMacOS,
      isWin: Platform.isWin,
      isLinux: Platform.isLinux,
      offlineSyncStrategy: this.plugin.settings.offlineSyncStrategy,
      protobuf: isProtobufEnabled,
      // 请求版本固定为 1；PB 降级重发携带同一版本，服务端按"首次 ClientInfo 生效"处理，
      // 因此不会重置已确认的模式（设计稿 §2.1 第 8 条）
      // Always request version 1; a PB downgrade re-send carries the same value and the server
      // applies "first ClientInfo wins", so the confirmed mode is never reset (design §2.1 rule 8)
      syncBaselineVersion: this.plugin.syncState.requestedSyncBaselineVersion,
    });
  }

  // ─── 基线能力协商闸门（设计稿 §2.1）─────────────────────────────────────────────
  // ─── Baseline capability negotiation gate (design §2.1) ───────────────────────

  /** 记录 ClientInfo 应答的确认结果；缺省视为 0（老服务端） / Record the confirmation; absent means 0 */
  private confirmBaseline(accepted: unknown): void {
    this.plugin.syncState.negotiatedSyncBaselineVersion =
      typeof accepted === "number" && accepted > 0 ? Math.floor(accepted) : 0;
    this.plugin.syncState.clientInfoConfirmed = true;
  }

  /** 清零连接级协商状态，并让仍在等待的闸门失败（新连接 / 断线） / Reset state and fail waiters */
  private resetBaselineNegotiation(): void {
    if (this.baselineConfirmTimer !== null) {
      window.clearTimeout(this.baselineConfirmTimer);
      this.baselineConfirmTimer = null;
    }
    // 直接写字段而非调用 SyncState 方法：部分测试/旧路径用最小 stub 注入 syncState，
    // 保持向后兼容（语义与 SyncState.resetSyncBaselineNegotiation 一致）。
    // Write the fields directly instead of calling SyncState methods: some tests and legacy
    // paths inject a minimal syncState stub (semantics identical to
    // SyncState.resetSyncBaselineNegotiation).
    this.plugin.syncState.serverAdvertisedBaselineVersion = 0;
    this.plugin.syncState.negotiatedSyncBaselineVersion = 0;
    this.plugin.syncState.clientInfoConfirmed = false;
    const waiters = this.baselineGateWaiters;
    this.baselineGateWaiters = [];
    for (const waiter of waiters) {
      waiter.reject(new Error("sync baseline negotiation reset"));
    }
  }

  /** ClientInfo 应答到达后放行所有等待者 / Release all waiters once the ClientInfo reply arrives */
  private openBaselineGate(): void {
    if (this.baselineConfirmTimer !== null) {
      window.clearTimeout(this.baselineConfirmTimer);
      this.baselineConfirmTimer = null;
    }
    const waiters = this.baselineGateWaiters;
    this.baselineGateWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  /**
   * 闸门：服务端广告 >= 1 时，等到 ClientInfo 确认后再开始同步；广告 0 时立即放行。
   * 超时绝不静默启用新模式，而是断开重连（设计稿 §2.1 末段）。
   * Gate: with an advertisement >= 1, wait for the ClientInfo confirmation before syncing;
   * with 0, proceed immediately. On timeout the new mode is never silently enabled — the
   * connection is re-established instead (design §2.1, last paragraph).
   */
  private async startAfterBaselineGate(): Promise<void> {
    if (!this.isBaselineGateOpen()) {
      try {
        await this.waitForBaselineConfirmation();
      } catch (error) {
        // 等待失败（超时或断线）：不放行同步，交给重连流程
        // The wait failed (timeout or disconnect): do not start sync; let reconnect handle it
        dump("[Baseline] ClientInfo confirmation failed; reconnecting instead of enabling the new mode", error);
        this.triggerReconnect();
        return;
      }
      if (!this.isBaselineGateOpen()) {
        dump("[Baseline] Gate still closed after confirmation; skipping this start");
        return;
      }
    }
    await this.StartHandle();
  }

  /**
   * 闸门判定（与 SyncState.isSyncBaselineGateOpen 语义一致）：服务端广告 < 1 时立即放行，
   * 否则等 ClientInfo 确认。直接读字段以兼容最小 syncState stub。
   * Gate check (same semantics as SyncState.isSyncBaselineGateOpen): open immediately when the
   * advertisement is < 1, otherwise wait for the ClientInfo confirmation. Reads fields directly
   * for minimal syncState stubs.
   */
  private isBaselineGateOpen(): boolean {
    const advertised = Number(this.plugin.syncState.serverAdvertisedBaselineVersion ?? 0);
    return advertised < 1 || this.plugin.syncState.clientInfoConfirmed === true;
  }

  /** 等待 ClientInfo 确认，带超时 / Wait for the ClientInfo confirmation with a timeout */
  private waitForBaselineConfirmation(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.baselineGateWaiters.push({ resolve, reject });
      if (this.baselineConfirmTimer === null) {
        this.baselineConfirmTimer = window.setTimeout(() => {
          this.baselineConfirmTimer = null;
          const waiters = this.baselineGateWaiters;
          this.baselineGateWaiters = [];
          for (const waiter of waiters) {
            waiter.reject(new Error("sync baseline confirmation timeout"));
          }
        }, BASELINE_CONFIRM_TIMEOUT_MS);
      }
    });
  }

  public async StartHandle() {
    const handleId = ++this.currentStartHandleId;
    dump(`Service start handle, id: ${handleId}`);

    // 验收断言（设计稿 §5.2 第 2 点）：协商写入必须先于 StartHandle 调用完成——
    // 要么本连接已完成 pv2 协商（negotiated=true），要么服务端是不支持协商的 v1（协商字段维持默认值，
    // 后续走 stop-and-wait）。这里只做非阻断式告警，禁止把 handleStructuredMessage 里的协商写入移到
    // StartHandle() 调用之后。
    // Acceptance assertion (design §5.2 point 2): negotiation write-back must complete before
    // StartHandle is invoked — either this connection completed pv2 negotiation, or the server is a
    // pre-negotiation v1 (fields stay at defaults, falls back to stop-and-wait). Non-blocking warn
    // only; do not move the negotiation write in handleStructuredMessage to after this call.
    if (!this.plugin.syncState.negotiated) {
      dump(`[Negotiation] StartHandle entered without pv2 negotiation — treating server as v1 (stop-and-wait fallback)`);
    }

    if (this.plugin.settings.startupDelay > 0 && !this.hasAppliedStartupDelay) {
      this.hasAppliedStartupDelay = true;
      dump(`Startup delay: ${this.plugin.settings.startupDelay}ms`);
      await new Promise((resolve) => window.setTimeout(resolve, this.plugin.settings.startupDelay));
    }

    if (handleId !== this.currentStartHandleId) {
      dump(`Service start handle cancelled, id: ${handleId}`);
      return;
    }

    // 等待 fileHashManager 初始化完成
    if (!this.plugin.fileHashManager || !this.plugin.fileHashManager.isReady()) {
      dump(`Waiting for fileHashManager to be ready...`);

      // 最多等待 30 秒
      const maxWaitTime = 30000;
      const startTime = Date.now();

      while (!this.plugin.fileHashManager || !this.plugin.fileHashManager.isReady()) {
        if (Date.now() - startTime > maxWaitTime) {
          dump(`FileHashManager initialization timeout after ${maxWaitTime}ms`);
          showSyncNotice($("ui.notice.file_hash_manager_timeout"));
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }

      if (this.plugin.fileHashManager && this.plugin.fileHashManager.isReady()) {
        dump("FileHashManager is ready, proceeding with sync");
      }
    }

    // A failed or cancelled drain must not prevent the regular catch-up scan.
    await this.plugin.retryQueue?.onAuthenticated().catch(error => {
      dump("[RetryQueue] Replay interrupted; continuing regular sync safely", error);
    });
    if (handleId !== this.currentStartHandleId || !this.client.isAuth || !this.client.isOpen) return;
    this.plugin.isFirstSync = true;

    // 检查是否有用户手动触发的待执行同步 / Check if user manually triggered a pending sync
    const pendingType = this.plugin.syncState.pendingSyncType;

    if (this.plugin.settings.manualSyncEnabled) {
      // 如果用户手动触发了同步，即使 manualSyncEnabled 也执行一次
      // If user manually triggered sync, execute once even with manualSyncEnabled
      if (pendingType) {
        if (pendingType === 'full') {
          void startupFullSync(this.plugin);
        } else {
          void startupSync(this.plugin);
        }
      } else {
        dump("Full Manual Sync Mode enabled, skipping startup sync");
      }
      return;
    }

    // 有 pending 同步请求时，使用 pending 的类型；否则走默认增量同步
    // If pending sync requested, use its type; otherwise default incremental
    if (pendingType === 'full') {
      void startupFullSync(this.plugin);
    } else {
      void startupSync(this.plugin);
    }
  }

  private async handleConflictError(data: StructuredMessageData) {
    // 基线模式：统一冲突载荷一律持久化，不受 manualMerge 限制，也不要求远端正文非空；
    // 旧服务端的 530 旧载荷在兼容模式下保持原有行为（设计稿 §2.6）
    // Baseline mode: always persist the unified payload, never gated on manualMerge or a non-empty
    // body. Legacy 530 payloads from old servers keep the compatibility behavior (§2.6)
    if (this.plugin.syncState.isSyncBaselineModeEnabled?.() === true) {
      if (await storeSyncConflict(this.plugin, data.data)) return;
    }
    const payloadData = data.data;
    let path = "";
    let serverContent = "";
    let baseContent = "";
    let serverHash = "";

    if (payloadData && typeof payloadData === "object") {
      const rawPath = payloadData.path ?? payloadData.Path;
      if (typeof rawPath === "string") {
        path = normalizePath(rawPath);
      }
      const rawServerContent = payloadData.serverContent ?? payloadData.ServerContent;
      if (typeof rawServerContent === "string") {
        serverContent = rawServerContent;
      }
      const rawBaseContent = payloadData.baseContent ?? payloadData.BaseContent;
      if (typeof rawBaseContent === "string") {
        baseContent = rawBaseContent;
      }
      const rawServerHash = payloadData.serverHash ?? payloadData.ServerHash;
      if (typeof rawServerHash === "string") {
        serverHash = rawServerHash;
      } else if (typeof rawServerHash === "number") {
        serverHash = String(rawServerHash);
      }
    }

    dump("[ConflictDebug] handleConflictError triggered. Path:", path, 
         "serverContent length:", serverContent ? serverContent.length : "undefined/null",
         "serverHash:", serverHash, 
         "strategy:", this.plugin.settings.offlineSyncStrategy);

    // 旧协议载荷（未走统一持久化）同样要冻结：清掉在途上传/回执定时器/待确认删除，
    // 否则 60s 后 recoverUpload 会把冲突附件当作回执丢失自动重传，反复撞 530
    // Legacy payloads (not persisted through the unified store) freeze the path too: clear the
    // in-flight upload, ack timers and pending delete acks so recoverUpload cannot retry a
    // conflicting attachment after 60s and keep hitting 530
    if (path !== "") freezeConflictPath(this.plugin, path);

    if (this.plugin.settings.offlineSyncStrategy === "manualMerge" &&
        path !== "" && serverContent !== "" && serverHash !== "") {
      
      const conflictData = {
        serverContent,
        baseContent: baseContent || "",
        serverHash,
        message: $("ui.log.error_code.530") || "检测到同步冲突，需要手动处理"
      };
      
      SyncLogManager.getInstance().addLog(
        'error',
        'NoteManualMergeConflict',
        JSON.stringify(conflictData),
        'error',
        path,
        this.plugin.settings.vault
      );

      // 写入 Remote 物理冲突文件到 conflict-notes（位于插件目录下，文件名附加路径哈希以防碰撞）。
      // 只有服务端明确给出非空 base 时才写 base 文件：空文本可能是“真实空 base”，但历史快照
      // 缺失时服务端也会回退成空串，不能拿来冒充共同祖先。
      // Write the remote conflict copy into conflict-notes. A base file is written only when the
      // server supplied a non-empty ancestor; an empty string may just be a missing snapshot and
      // must not be presented as a real common ancestor.
      try {
        const { dir, baseBackupPath, remoteBackupPath } = conflictBackupPaths(this.plugin, path);
        const adapter = this.plugin.app.vault.adapter;
        if (!(await adapter.exists(dir))) {
          await adapter.mkdir(dir);
        }

        const hasRealBase = baseContent.length > 0;
        if (hasRealBase) await adapter.write(baseBackupPath, baseContent);
        else if (await adapter.exists(baseBackupPath)) await adapter.remove(baseBackupPath);
        await adapter.write(remoteBackupPath, serverContent);
        await writeConflictMeta(this.plugin, path, {
          reason: hasRealBase ? "manual_merge" : "manual_merge_no_base",
          baseMissing: !hasRealBase,
          remoteHash: serverHash,
        });
      } catch (e) {
        dump("Failed to create conflict-notes backup files:", e);
      }

      this.plugin.syncState.conflictedPaths.add(path);
      this.plugin.syncState.newConflictedPathsThisRound.add(path);
      this.plugin.localStorageManager.setConflictedPaths(this.plugin.syncState.conflictedPaths);
      this.plugin.statusBarManager.updateConflictBadge();
    } else {
      if (typeof path === "string") {
        dump("Conflict detected:", { code: data.code, Path: path, message: data.message });
        showSyncNotice($("ui.status.conflict", { path: path }), 10000);
      }
    }
  }
}
