/**
 * 当前令牌权限的轻量缓存与刷新。
 * Lightweight cache and refresh for the current token's capabilities.
 *
 * 缓存键为「连接地址 + 令牌」，切令牌或重连时清空后重取；取不到（旧版服务端 / 断网）
 * 时保持 null，调用方据此不显示任何提示——绝不打断同步。
 * The cache key is base URL + token; switching tokens or reconnecting clears and refetches.
 * Unavailable results (old server / offline) stay null so callers simply show nothing.
 */
import type FastSync from "../../main";
import { capabilitiesCacheKey, type TokenCapabilities } from "./token_capabilities";

export class TokenCapabilitiesManager {
  private capabilities: TokenCapabilities | null = null
  private cacheKey: string | null = null
  private inFlight: Promise<TokenCapabilities | null> | null = null
  private listeners = new Set<(caps: TokenCapabilities | null) => void>()

  constructor(private readonly plugin: FastSync) {}

  /** 当前缓存值（可能为 null）/ Currently cached value (may be null). */
  get(): TokenCapabilities | null {
    return this.capabilities
  }

  /** 注册能力变化监听，返回取消函数 / Subscribe to capability changes; returns an unsubscribe fn. */
  onChange(listener: (caps: TokenCapabilities | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private currentKey(): string {
    return capabilitiesCacheKey(this.plugin.settings.api || "", this.plugin.settings.apiToken || "")
  }

  /**
   * 连接配置（地址/令牌）变化时清空缓存；未变化则不动。
   * Clear the cache when the connection config changed; no-op otherwise.
   */
  invalidateIfConnectionChanged(): void {
    if (this.cacheKey !== null && this.cacheKey !== this.currentKey()) this.clear()
  }

  /** 切令牌/重连/卸载时清空缓存 / Clear the cache on token switch, reconnect or unload. */
  clear(): void {
    this.capabilities = null
    this.cacheKey = null
    this.inFlight = null
    this.emit()
  }

  /**
   * 刷新能力：缓存命中则直接返回，否则拉取一次；并发调用共享同一请求。
   * Refresh capabilities: return the cached value when valid, otherwise fetch once; concurrent
   * callers share a single request.
   */
  async refresh(force = false): Promise<TokenCapabilities | null> {
    const key = this.currentKey()
    if (!force && this.cacheKey === key) return this.capabilities
    if (!force && this.inFlight) return this.inFlight

    this.cacheKey = key
    this.inFlight = this.plugin.api
      .getTokenCapabilities()
      .then((caps) => {
        // 请求期间令牌被换掉：丢弃这份过期结果
        // Token changed while in flight: drop the stale result
        if (this.cacheKey !== key) return this.capabilities
        this.capabilities = caps
        this.inFlight = null
        this.emit()
        return caps
      })
      .catch(() => {
        if (this.cacheKey === key) {
          this.capabilities = null
          this.inFlight = null
          this.emit()
        }
        return null
      })
    return this.inFlight
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.capabilities)
      } catch {
        // 监听方异常不影响其它监听与同步 / A failing listener must not break others
      }
    }
  }
}
