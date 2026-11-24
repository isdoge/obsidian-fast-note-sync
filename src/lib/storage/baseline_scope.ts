import { computeMirrorDigest } from "../utils/helpers";
import type { SyncBaselineFields } from "../utils/types";

/**
 * 基线作用域与待删基线记录（设计稿 §5.1）。
 * Baseline scope and pending-delete records (design §5.1).
 *
 * 服务端确认的 `revision` 令牌只对签发它的远端目标（规范化 api + vault + 账号配置）有意义。
 * 切换目标后旧令牌绝不能发往新目标：作用域指纹变化时，三个存储管理器都会清空 revision 表，
 * 并把旧的可信来源降级为“需内容相等自证”，而不是继续当作服务端已确认。
 *
 * A server-confirmed `revision` token is only meaningful for the remote target that issued it
 * (normalized api + vault + account config). After a target switch the old tokens must never be
 * sent to the new target: on a scope change the three storage managers clear their revision maps
 * and downgrade trusted provenance to equality-only verification.
 */
export interface BaselineDeleteRecord {
  /** 删除前最后确认的内容哈希；目录恒为空串 / Last confirmed content hash; always "" for folders */
  hash: string;
  /** 没有可信内容基线时为 true / True when no trusted content baseline existed */
  hashMissing: boolean;
  /** 删除前最后确认的版本令牌 / Last confirmed revision token */
  revision: string;
}

export interface ScopedBaselineState {
  /** 规范化远端作用域指纹 / Normalized remote-scope fingerprint */
  scope: string;
  /** path -> revision / path -> revision */
  revisions: Record<string, string>;
  /** path -> 删除前基线 / path -> pre-delete baseline */
  pendingDeletes: Record<string, BaselineDeleteRecord>;
}

/**
 * 规范化远端作用域：去掉 api 尾部斜杠、vault 与 token 首尾空白后取指纹。
 * Normalized remote scope: trim api trailing slashes and vault/token whitespace, then digest.
 */
export function computeRemoteScope(settings: { api?: string; vault?: string; apiToken?: string } | undefined): string {
  const api = (settings?.api ?? "").trim().replace(/\/+$/, "").toLowerCase();
  const vault = (settings?.vault ?? "").trim();
  const token = (settings?.apiToken ?? "").trim();
  return computeMirrorDigest(`${api}\0${vault}\0${token}`);
}

export function emptyScopedState(scope: string): ScopedBaselineState {
  return { scope, revisions: {}, pendingDeletes: {} };
}

/**
 * 解析持久化的作用域状态。作用域不一致时返回空状态并标记 scopeChanged，
 * 由调用方决定降级旧的可信来源。
 * Parse the persisted scoped state. A different scope yields an empty state with
 * `scopeChanged` set so the caller can downgrade legacy provenance.
 */
export function parseScopedState(raw: string | null | undefined, scope: string): { state: ScopedBaselineState; scopeChanged: boolean } {
  if (!raw) return { state: emptyScopedState(scope), scopeChanged: false };
  try {
    const parsed = JSON.parse(raw) as Partial<ScopedBaselineState> | null;
    if (!parsed || typeof parsed !== "object") return { state: emptyScopedState(scope), scopeChanged: false };
    if (parsed.scope !== scope) return { state: emptyScopedState(scope), scopeChanged: true };
    const revisions: Record<string, string> = {};
    if (parsed.revisions && typeof parsed.revisions === "object") {
      for (const [path, revision] of Object.entries(parsed.revisions)) {
        if (typeof path === "string" && typeof revision === "string" && revision !== "") {
          revisions[path] = revision;
        }
      }
    }
    const pendingDeletes: Record<string, BaselineDeleteRecord> = {};
    if (parsed.pendingDeletes && typeof parsed.pendingDeletes === "object") {
      for (const [path, record] of Object.entries(parsed.pendingDeletes)) {
        if (typeof path !== "string" || !record || typeof record !== "object") continue;
        const value = record as Partial<BaselineDeleteRecord>;
        pendingDeletes[path] = {
          hash: typeof value.hash === "string" ? value.hash : "",
          hashMissing: value.hashMissing === true,
          revision: typeof value.revision === "string" ? value.revision : "",
        };
      }
    }
    return { state: { scope, revisions, pendingDeletes }, scopeChanged: false };
  } catch {
    return { state: emptyScopedState(scope), scopeChanged: false };
  }
}

export function serializeScopedState(state: ScopedBaselineState): string {
  return JSON.stringify(state);
}

/**
 * 依据 pending-delete 记录构造删除请求的基线字段（仅基线模式）。
 * Build delete-request baseline fields from a pending-delete record (baseline mode only).
 */
export function baselineFieldsFromDeleteRecord(record: BaselineDeleteRecord | null | undefined): SyncBaselineFields {
  if (!record) return { baseHashMissing: true };
  if (record.hashMissing || record.revision === "") {
    return { baseHashMissing: true };
  }
  return { baseHash: record.hash, baseHashMissing: false, baseRevision: record.revision };
}

export type BaselineResourceKind = "note" | "file" | "setting" | "folder";

export interface BaselineTrustProbe {
  fileHashManager?: {
    getDiagnosticCounts?: () => { baselineEntries: number; confirmedBaselines: number };
  };
  localStorageManager?: {
    wasSyncStateRestoredFromMirror?: () => boolean;
  };
}

/**
 * 判断持久化的基线是否属于“外来/不可信同步状态”。
 *
 * 典型场景：新设备把另一台机子的插件目录整份拷过来，插件目录里带着哈希/基线镜像，
 * 但服务端确认表存在本机 localStorage（`fns-syncHashMapConfirmed`），不会随目录复制。
 * 于是出现“有 N 条基线、0 条已确认”，而同步时间/isInitSync 又是从目录镜像恢复的——
 * 这份历史不是本机原生积累的，游标和基线都不能按可信历史使用。
 *
 * 判据：基线条目 > 0、已确认 == 0，且本次启动的同步时间确实来自插件目录镜像。
 * 原地升级的旧版安装（localStorage 里本就有同步时间）不算外来状态，保持原有增量行为。
 *
 * Whether the persisted baselines belong to a foreign/untrusted sync state.
 *
 * Typical case: a new device copies another machine's whole plugin folder. The folder carries
 * the hash/baseline mirrors, but the server-confirmation table lives in this app's localStorage
 * (`fns-syncHashMapConfirmed`) and is not copied. The result is "N baselines, 0 confirmed" while
 * the sync times/isInitSync were restored from the folder mirror — history this device never
 * accumulated, so neither cursors nor baselines may be trusted as local history.
 *
 * Criterion: baselines > 0, confirmed == 0, and this startup's sync times came from the
 * plugin-dir mirror. An in-place legacy upgrade (localStorage already had the sync times) is
 * not foreign and keeps the previous incremental behavior.
 */
export function isUntrustedBaselineState(plugin: BaselineTrustProbe): boolean {
  const counts = plugin.fileHashManager?.getDiagnosticCounts?.();
  if (!counts || counts.baselineEntries <= 0 || counts.confirmedBaselines > 0) return false;
  return plugin.localStorageManager?.wasSyncStateRestoredFromMirror?.() === true;
}

interface BaselineManagerLike {
  getPathHash?: (path: string) => string | null;
  getVerifiedPathHash?: (path: string, localContentHash: string | null) => string | null;
  getBaselineRevision?: (path: string) => string | null;
  getConfirmedBaseline?: (path: string, localContentHash: string | null) => { hash: string; revision: string } | null;
  isBaselineConfirmed?: (path: string) => boolean;
  getPendingDeleteBaseline?: (path: string) => BaselineDeleteRecord | null;
}

function managerFor(plugin: { fileHashManager?: BaselineManagerLike; configHashManager?: BaselineManagerLike; folderSnapshotManager?: BaselineManagerLike }, kind: BaselineResourceKind): BaselineManagerLike | undefined {
  if (kind === "setting") return plugin.configHashManager;
  if (kind === "folder") return plugin.folderSnapshotManager;
  return plugin.fileHashManager;
}

/**
 * 构造上行清单/实时请求的基线字段。
 * - 兼容模式（协商 0）：保持阶段 B/C 原样，仅携带旧表的 baseHash；
 * - 基线模式（协商 >= 1）：优先携带服务端确认过的 `{baseHash, baseRevision}`；
 *   旧版持久化基线只在本地内容仍等于记录值时按“未偏离”接受（baseRevision 缺失，交由服务端核验）；
 *   否则明确 baseHashMissing=true，绝不把本地当前内容冒充成服务端基线。
 *
 * Build baseline fields for scan/live requests.
 * - Compatibility mode (negotiated 0): exactly the stage-B/C behavior, only the legacy baseHash;
 * - Baseline mode (negotiated >= 1): carry the server-confirmed `{baseHash, baseRevision}` when
 *   available; a legacy persisted baseline is accepted only while local content still matches
 *   (no revision, server verifies); otherwise baseHashMissing=true — local bytes are never
 *   passed off as a server baseline.
 */
export function buildBaselineFields(
  plugin: {
    isSyncBaselineModeEnabled?: () => boolean;
    fileHashManager?: BaselineManagerLike;
    configHashManager?: BaselineManagerLike;
    folderSnapshotManager?: BaselineManagerLike;
  },
  kind: BaselineResourceKind,
  path: string,
  localContentHash: string | null = null
): SyncBaselineFields {
  const manager = managerFor(plugin, kind);
  const baselineMode = plugin.isSyncBaselineModeEnabled?.() === true;
  if (kind === "folder") {
    if (!baselineMode) return {};
    const revision = manager?.getBaselineRevision?.(path) ?? null;
    return revision ? { baseRevision: revision } : {};
  }
  if (!baselineMode) {
    const legacy = manager?.getPathHash?.(path) ?? null;
    return legacy !== null ? { baseHash: legacy } : { baseHashMissing: true };
  }
  const confirmed = manager?.getConfirmedBaseline?.(path, localContentHash);
  if (confirmed && confirmed.revision !== "") {
    return { baseHash: confirmed.hash, baseHashMissing: false, baseRevision: confirmed.revision };
  }
  const verified = manager?.getVerifiedPathHash
    ? manager.getVerifiedPathHash(path, localContentHash)
    : (manager?.getPathHash?.(path) ?? null);
  if (verified !== null && verified !== undefined) {
    return { baseHash: verified, baseHashMissing: false };
  }
  return { baseHashMissing: true };
}

/**
 * 构造删除请求的基线字段：优先用删除前记录的基线（在途删除可能已清空活跃缓存）。
 * Build delete-request baseline fields, preferring the pre-delete record (an in-flight delete
 * may already have cleared the active cache).
 */
export function buildDeleteBaselineFields(
  plugin: {
    isSyncBaselineModeEnabled?: () => boolean;
    fileHashManager?: BaselineManagerLike & { getPendingDeleteBaseline?: (path: string) => BaselineDeleteRecord | null };
    configHashManager?: BaselineManagerLike & { getPendingDeleteBaseline?: (path: string) => BaselineDeleteRecord | null };
    folderSnapshotManager?: BaselineManagerLike & { getPendingDeleteBaseline?: (path: string) => BaselineDeleteRecord | null };
  },
  kind: BaselineResourceKind,
  path: string
): SyncBaselineFields {
  if (plugin.isSyncBaselineModeEnabled?.() !== true) return {};
  const manager = managerFor(plugin, kind);
  const record = manager?.getPendingDeleteBaseline?.(path);
  if (record) return baselineFieldsFromDeleteRecord(record);
  if (kind === "folder") {
    const revision = manager?.getBaselineRevision?.(path) ?? null;
    return revision ? { baseRevision: revision } : {};
  }
  const confirmed = manager?.getConfirmedBaseline?.(path, null);
  if (confirmed && confirmed.revision !== "") {
    return { baseHash: confirmed.hash, baseHashMissing: false, baseRevision: confirmed.revision };
  }
  return { baseHashMissing: true };
}
