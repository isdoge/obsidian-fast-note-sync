/**
 * 令牌实际权限（服务端 /api/user/token-capabilities）的解析与判定。
 * 纯函数，无 Obsidian 依赖，供 HttpApiService 与 Node 定向测试共用。
 *
 * Parsing and classification helpers for the server's token-capabilities endpoint.
 * Pure functions with no Obsidian imports, shared by HttpApiService and Node tests.
 *
 * 全部判定都是「尽力而为」：旧版服务端返回 404 或网络失败时由调用方静默降级为 null，
 * 绝不因此打断同步或弹出错误。
 * Every check here is best-effort: on a 404 from an older server or a network failure the
 * caller degrades silently to null and never interrupts sync or shows an error.
 */

export interface TokenPermissions {
  noteRead: boolean
  noteWrite: boolean
  fileRead: boolean
  fileWrite: boolean
  settingRead: boolean
  settingWrite: boolean
  vaultRead: boolean
  vaultWrite: boolean
}

export interface TokenCapabilities {
  uid: number
  isAdmin: boolean
  tokenId: string
  protocol: string
  restricted: boolean
  vaults: string[]
  permissions: TokenPermissions
  readOnly: boolean
}

/** 服务端业务码：非管理员（HTTP 仍为 200，见 pkg/code/common.go）。 */
export const CODE_USER_NOT_ADMIN = 411
/** 服务端业务码：令牌作用域受限。 */
export const CODE_TOKEN_SCOPE_RESTRICTED = 315

function asBool(value: unknown): boolean {
  return value === true
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

/**
 * 把接口的 data 解析成能力对象；结构不完整时返回 null（视为旧版/不可用）。
 * Parse the endpoint's `data`; returns null when the shape is unusable (treated as unavailable).
 */
export function parseTokenCapabilities(data: unknown): TokenCapabilities | null {
  if (!data || typeof data !== "object") return null
  const raw = data as Record<string, unknown>
  const permRaw = raw.permissions
  if (!permRaw || typeof permRaw !== "object") return null
  const p = permRaw as Record<string, unknown>

  // 缺少任何一个权限位都视为不可用，避免把「全 false」误判成只读令牌
  // Any missing permission bit makes the payload unusable, so a partial body is never
  // mistaken for a fully read-only token.
  const keys: (keyof TokenPermissions)[] = [
    "noteRead", "noteWrite", "fileRead", "fileWrite",
    "settingRead", "settingWrite", "vaultRead", "vaultWrite",
  ]
  for (const key of keys) {
    if (typeof p[key] !== "boolean") return null
  }

  const permissions: TokenPermissions = {
    noteRead: asBool(p.noteRead),
    noteWrite: asBool(p.noteWrite),
    fileRead: asBool(p.fileRead),
    fileWrite: asBool(p.fileWrite),
    settingRead: asBool(p.settingRead),
    settingWrite: asBool(p.settingWrite),
    vaultRead: asBool(p.vaultRead),
    vaultWrite: asBool(p.vaultWrite),
  }

  return {
    uid: asNumber(raw.uid),
    isAdmin: asBool(raw.isAdmin),
    tokenId: asString(raw.tokenId),
    protocol: asString(raw.protocol),
    restricted: asBool(raw.restricted),
    vaults: asStringArray(raw.vaults),
    permissions,
    // 服务端给出的 readOnly 优先；缺失时按「无任何写权限」推导
    // Server-provided readOnly wins; when absent it is derived from the write bits
    readOnly: typeof raw.readOnly === "boolean"
      ? raw.readOnly
      : !permissions.noteWrite && !permissions.fileWrite && !permissions.settingWrite && !permissions.vaultWrite,
  }
}

export interface TokenWriteLimits {
  /** 令牌整体只读（服务端会拒绝上传） / Token is read-only overall. */
  readOnly: boolean
  /** 具体缺失的写权限 key 列表 / Missing write permission keys. */
  missingWrite: (keyof TokenPermissions)[]
}

/**
 * 汇总令牌的写入限制，用于菜单顶部与状态栏 tooltip 提示。
 * Summarize write limits for the menu banner and status-bar tooltip.
 */
export function describeTokenWriteLimits(caps: TokenCapabilities | null): TokenWriteLimits {
  if (!caps) return { readOnly: false, missingWrite: [] }
  const missingWrite: (keyof TokenPermissions)[] = []
  if (!caps.permissions.noteWrite) missingWrite.push("noteWrite")
  if (!caps.permissions.fileWrite) missingWrite.push("fileWrite")
  if (!caps.permissions.settingWrite) missingWrite.push("settingWrite")
  if (!caps.permissions.vaultWrite) missingWrite.push("vaultWrite")
  return {
    readOnly: caps.readOnly === true || !caps.permissions.noteWrite || !caps.permissions.fileWrite,
    missingWrite,
  }
}

/**
 * 当前配置的库是否在令牌限定库内。`vaults` 为空表示不限定。
 * Whether the configured vault is inside the token's allow-list; empty means unrestricted.
 */
export function isVaultAllowedByToken(caps: TokenCapabilities | null, vault: string): boolean {
  if (!caps) return true
  if (!Array.isArray(caps.vaults) || caps.vaults.length === 0) return true
  return caps.vaults.includes(vault)
}

/**
 * 能力缓存的键：连接地址 + 令牌指纹。任一变化都必须重新拉取（切令牌/换服务器）。
 * Cache key: base URL + token fingerprint. Either change forces a refetch.
 */
export function capabilitiesCacheKey(api: string, token: string): string {
  const base = (api || "").trim().replace(/\/+$/, "")
  const tokenFingerprint = (token || "").trim()
  return `${base}|${tokenFingerprint}`
}

export type WSClientsFailure = "no_admin" | "not_connected" | "error"

export interface WSClientsResult {
  ok: boolean
  clients: { uid: number | string; clientName?: string }[]
  /** 失败原因；ok 为 true 时为 null / Failure reason, null when ok */
  failure: WSClientsFailure | null
}

/**
 * 区分「无管理员权限」与「确实没有其它在线设备」。
 * Distinguish "no admin permission" from "genuinely no other devices online".
 *
 * 服务端对非管理员返回 HTTP 200 + 业务码 411；代理/网关可能直接返回 403；
 * 令牌作用域受限返回 315。这些都不等于「列表为空」。
 * The server answers non-admins with HTTP 200 + business code 411; a proxy may return
 * 403 directly; a scope-restricted token yields 315. None of these mean "empty list".
 */
export function classifyWSClientsResponse(status: number, json: unknown): WSClientsResult {
  const body = (json && typeof json === "object" ? json : null) as
    { code?: unknown; data?: unknown } | null
  const code = typeof body?.code === "number" ? body.code : 0

  if (status === 401) return { ok: false, clients: [], failure: "not_connected" }
  if (
    status === 403
    || code === CODE_USER_NOT_ADMIN
    || code === CODE_TOKEN_SCOPE_RESTRICTED
  ) {
    return { ok: false, clients: [], failure: "no_admin" }
  }
  if (status !== 200 || code <= 0 || code >= 300) {
    return { ok: false, clients: [], failure: "error" }
  }

  const list = Array.isArray(body?.data) ? (body.data as WSClientsResult["clients"]) : []
  return { ok: true, clients: list, failure: null }
}
