/**
 * 只读 / 手动同步模式的纯逻辑（无 Obsidian 依赖，便于 Node 定向测试）。
 * Pure logic for the read-only / manual sync modes (no Obsidian imports, easy to unit test).
 *
 * 这两个模式只影响插件本地的同步行为，不改变服务端令牌权限：
 * - 只读同步：仅接收远端更新，不上传本地修改与删除；
 * - 手动同步：暂停自动监听与定时触发，仅手动触发时同步。
 * They only change local plugin behavior, never server-side token permissions.
 */

export type SyncModeKind = "readonly" | "manual"

/** 只读取本插件设置对象中与本功能相关的字段 / Only the settings fields this feature touches. */
export interface SyncModeSettings {
  readonlySyncEnabled?: boolean
  manualSyncEnabled?: boolean
}

export interface SyncModeState {
  readonly: boolean
  manual: boolean
}

/** 当前模式状态 / Current mode state. */
export function readSyncModes(settings: SyncModeSettings | null | undefined): SyncModeState {
  return {
    readonly: settings?.readonlySyncEnabled === true,
    manual: settings?.manualSyncEnabled === true,
  }
}

/**
 * 切换指定模式并写回设置对象，返回切换后的值。
 * Toggle the given mode in place and return the new value.
 */
export function toggleSyncMode(settings: SyncModeSettings, kind: SyncModeKind): boolean {
  if (kind === "readonly") {
    const next = settings.readonlySyncEnabled !== true
    settings.readonlySyncEnabled = next
    return next
  }
  const next = settings.manualSyncEnabled !== true
  settings.manualSyncEnabled = next
  return next
}

/** 切换后要展示的提示文案 key（与语言包 key 一一对应）。 */
export type SyncModeNoticeKey =
  | "ui.mode.readonly_on"
  | "ui.mode.readonly_off"
  | "ui.mode.manual_on"
  | "ui.mode.manual_off"

/** 切换后要展示的提示文案 key / i18n key of the notice shown after a toggle. */
export function syncModeNoticeKey(kind: SyncModeKind, enabled: boolean): SyncModeNoticeKey {
  if (kind === "readonly") {
    return enabled ? "ui.mode.readonly_on" : "ui.mode.readonly_off"
  }
  return enabled ? "ui.mode.manual_on" : "ui.mode.manual_off"
}

/**
 * 空闲兜底定时同步的有效间隔：手动同步模式下为 0（关闭定时触发）。
 * Effective idle-fallback interval: 0 (disabled) while manual sync mode is on.
 */
export function effectiveIdleSyncMinutes(settings: SyncModeSettings, configured: number): number {
  if (settings.manualSyncEnabled === true) return 0
  return configured
}
