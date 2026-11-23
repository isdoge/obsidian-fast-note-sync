import { normalizePath, App } from "obsidian";

import { hashContent, hashContentAsync, dump, dumpError, configIsPathExcluded, getSafeCtime, isPathInConfigSyncDirs, showSyncNotice, isInWhitelist, hashFileAsync, hashArrayBuffer, checkAndNotifyCaseConflict, isLargeBinarySyncRisk, normalizeServerTimestamp } from "../utils/helpers";
import { decodeConfigContent, encodeConfigContent } from "../utils/config_codec";
import { SyncLogManager } from "./sync_log_manager";
import { advanceLiveSyncTime } from "./sync_state";
import { ReceiveMessage, ReceiveMtimeMessage, ReceivePathMessage, SyncEndData } from "../utils/types";
import type FastSync from "../../main";
import { $ } from "../../i18n/lang";
import { buildBaselineFields, buildDeleteBaselineFields } from "../storage/baseline_scope";
import * as syncDiagnostics from "../utils/sync_diagnostics";


/**
 * 排除监听文件的常量（针对 .obsidian 根目录）
 */
export const CONFIG_ROOT_FILES_EXCLUDE = ["workspace.json", "workspace-mobile.json"]
// 静态/字体/图片资源扩展名：配置通道用 fns-bin-v1 信封承载二进制内容（#234 主题图片、#264 字体）。
// Static/font/image extensions: the config channel carries binary content in fns-bin-v1 envelopes
// (theme images #234, custom fonts #264).
export const CONFIG_ASSET_EXTS_TO_WATCH = [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
]
export const CONFIG_PLUGIN_EXTS_TO_WATCH = [".json", ".js", ".css", ".dict", ".dic", ".aff", ".txt", ...CONFIG_ASSET_EXTS_TO_WATCH]
const CONFIG_PLUGIN_DIRS_EXCLUDE = new Set(["node_modules", ".git", ".cache", "cache", "caches", ".trash", ".tmp", "tmp", "temp"])

// 插件与主题目录下的生成/缓存目录都不参与同步 / Generated/cache dirs under plugins and themes are never synced
export const isConfigResourcePathExcluded = (path: string, configDir: string): boolean => {
    const normalized = path.replace(/\\/g, "/")
    for (const topDir of ["plugins", "themes"]) {
        const prefix = `${configDir}/${topDir}/`
        if (normalized.startsWith(prefix)) {
            return normalized.slice(prefix.length).split("/").slice(1)
                .some(part => CONFIG_PLUGIN_DIRS_EXCLUDE.has(part.toLowerCase()))
        }
    }
    return false
}
export const isPluginConfigPathExcluded = (path: string, configDir: string): boolean => {
    const prefix = `${configDir}/plugins/`
    return path.startsWith(prefix) && path.slice(prefix.length).split("/").slice(1)
        .some(part => CONFIG_PLUGIN_DIRS_EXCLUDE.has(part.toLowerCase()))
}
export const CONFIG_THEME_EXTS_TO_WATCH = [".css", ".json", ...CONFIG_ASSET_EXTS_TO_WATCH]
// 代码片段目录：样式本身 + 片段引用到的图片/字体资源 / Snippets: styles plus images/fonts they reference
export const CONFIG_SNIPPET_EXTS_TO_WATCH = [".css", ...CONFIG_ASSET_EXTS_TO_WATCH]
// 插件目录中决定插件代码与版本的文件 / Files in a plugin folder that make up its code and version
const PLUGIN_CODE_FILES = ["main.js", "manifest.json", "styles.css"]


/**
 * 配置操作函数导出
 */

let reloadTimer: number | null = null
const pendingConfigUpdates: Map<string, string> = new Map()

/**
 * 清理模块级 reloadTimer（插件卸载时调用，避免定时器在插件卸载后仍触发回调）
 * Clean up the module-level reloadTimer (called on plugin unload to prevent the
 * timer callback from firing after the plugin instance has been unloaded)
 */
export const cleanupConfigReloadTimer = function (): void {
    if (reloadTimer) {
        window.clearTimeout(reloadTimer)
        reloadTimer = null
    }
    pendingConfigUpdates.clear()
    downgradeBlockedPlugins.clear()
    pluginCodeBackups.clear()
}

// 插件降级守卫（#294）：服务端的 manifest.json 版本低于本地时不覆盖本地插件代码，
// 已在本轮先写入的 main.js / styles.css 用写入前的备份还原，并把本地较新的版本重新上传。
// Plugin downgrade guard (#294): a server manifest.json older than the local one never replaces the
// local plugin code; main.js / styles.css already written this round are restored from their
// pre-write backup, and the newer local files are uploaded again.
const downgradeBlockedPlugins = new Set<string>()
const pluginCodeBackups = new Map<string, ArrayBuffer>()

function parseVersion(v: unknown): number[] | null {
    if (typeof v !== "string") return null
    const m = v.trim().match(/^v?(\d+(?:\.\d+)*)/)
    return m ? m[1].split(".").map(Number) : null
}

/** remote 严格低于 local（无法解析时视为不低）/ remote strictly older than local (unparsable: not older) */
export const isVersionLower = function (remote: unknown, local: unknown): boolean {
    const r = parseVersion(remote), l = parseVersion(local)
    if (!r || !l) return false
    for (let i = 0; i < Math.max(r.length, l.length); i++) {
        const a = r[i] ?? 0, b = l[i] ?? 0
        if (a !== b) return a < b
    }
    return false
}

const readManifestVersion = async function (path: string, plugin: FastSync): Promise<unknown> {
    try {
        if (!(await plugin.app.vault.adapter.exists(path))) return undefined
        return (JSON.parse(await plugin.app.vault.adapter.read(path)) as { version?: unknown }).version
    } catch {
        return undefined
    }
}

// 重新上传本地文件：强制上传，绕过内容未变的拦截（只读端由 configModify 自行拦下）
// Upload the local file again: force upload to bypass unchanged-content interception
// (configModify itself still refuses on a read-only device)
const reuploadLocalConfig = function (path: string, plugin: FastSync) {
    plugin.lastSyncMtime.delete(path)
    void configModify(path, plugin, false, undefined, true)
}

/**
 * 返回 true 表示本次服务端写入被降级守卫拦下 / Returns true when the server write is blocked by the downgrade guard
 */
const guardPluginDowngrade = async function (data: ReceiveMessage, plugin: FastSync): Promise<boolean> {
    const configDir = plugin.app.vault.configDir
    const parts = data.path.split("/")
    if (parts.length !== 4 || parts[0] !== configDir || parts[1] !== "plugins" || !PLUGIN_CODE_FILES.includes(parts[3])) return false
    const id = parts[2]
    const adapter = plugin.app.vault.adapter

    if (parts[3] === "manifest.json") {
        let remoteVersion: unknown
        try {
            remoteVersion = (JSON.parse(data.content) as { version?: unknown }).version
        } catch {
            return false
        }
        const localVersion = await readManifestVersion(normalizePath(data.path), plugin)
        if (!isVersionLower(remoteVersion, localVersion)) {
            downgradeBlockedPlugins.delete(id)
            return false
        }
        downgradeBlockedPlugins.add(id)
        for (const f of PLUGIN_CODE_FILES) {
            const p = `${configDir}/plugins/${id}/${f}`
            const backup = pluginCodeBackups.get(p)
            if (!backup) continue
            pluginCodeBackups.delete(p)
            plugin.addIgnoredConfigFile(p)
            try {
                await adapter.writeBinary(normalizePath(p), backup)
                const stat = await adapter.stat(normalizePath(p))
                if (stat && plugin.configManager) plugin.configManager.updateFileState(normalizePath(p), stat.mtime)
            } finally {
                plugin.removeIgnoredConfigFile(p)
            }
            reuploadLocalConfig(p, plugin)
        }
        reuploadLocalConfig(data.path, plugin)
        SyncLogManager.getInstance().addLog('receive', 'ConfigDowngradeSkipped', `服务端插件版本 ${String(remoteVersion)} 低于本地 ${String(localVersion)}，保留本地并重新上传: ${id}`, 'cancelled', data.path)
        showSyncNotice($("ui.status.plugin_downgrade_blocked", { id, remote: String(remoteVersion), local: String(localVersion) }), 10000)
        return true
    }

    if (downgradeBlockedPlugins.has(id)) {
        SyncLogManager.getInstance().addLog('receive', 'ConfigDowngradeSkipped', `插件 ${id} 的服务端版本较旧，跳过覆盖并重新上传本地文件`, 'cancelled', data.path)
        reuploadLocalConfig(data.path, plugin)
        return true
    }
    // 写入前备份本地文件，供同一轮稍后到达的较旧 manifest.json 还原 / Back up before overwriting, so a
    // downgraded manifest.json arriving later in the round can restore it
    const localPath = normalizePath(data.path)
    if (await adapter.exists(localPath)) pluginCodeBackups.set(data.path, await adapter.readBinary(localPath))
    return false
}

export const configModify = async function (path: string, plugin: FastSync, eventEnter: boolean = false, content?: string, forceUpload: boolean = false, options?: { isConflictResolved?: boolean; baseRevision?: string }) {
    if (plugin.settings.configSyncEnabled == false || plugin.settings.readonlySyncEnabled) return
    if (!isPathInConfigSyncDirs(path, plugin)) return
    if (eventEnter && plugin.ignoredConfigFiles.has(path)) return
    if (configIsPathExcluded(path, plugin)) return
    // 冲突冻结的配置不响应实时写（已解决的提交除外）
    // A frozen conflicted setting ignores live writes (resolved submits excepted)
    if (plugin.syncState?.conflictedPaths?.has(path) && !options?.isConflictResolved) {
        dump(`Config modify paused, unresolved conflict: ${path}`)
        return
    }

    // 如果是文件系统事件（无 content），拦截 LocalStorage 虚拟路径
    if (!content && path.startsWith(plugin.localStorageManager.syncPathPrefix)) return

    plugin.addIgnoredConfigFile(path)

    let contentStr = content || ""
    let contentHash = ""
    let mtime = 0
    let ctime = 0
    let size = -1

    if (content !== undefined) {
        // 直接使用传入的内容（通常是 LocalStorage）
        contentHash = hashContent(content)
        mtime = Date.now()
        ctime = Date.now()
    } else {
        // 从文件系统读取
        const filePath = normalizePath(path)
        try {
            const exists = await plugin.app.vault.adapter.exists(filePath)
            if (exists) {
                const stat = await plugin.app.vault.adapter.stat(filePath)
                if (stat) {
                    if (isLargeBinarySyncRisk(stat.size, plugin)) {
                        plugin.removeIgnoredConfigFile(path)
                        return
                    }
                    // contentHash 始终针对磁盘原始字节；content 用 fns-bin-v1 信封承载二进制
                    // contentHash always hashes the raw on-disk bytes; content wraps binary in
                    // the fns-bin-v1 envelope
                    contentHash = await hashFileAsync(plugin.app, filePath)
                    const contentBuf = await plugin.app.vault.adapter.readBinary(filePath)
                    contentStr = encodeConfigContent(contentBuf)
                    mtime = stat.mtime
                    ctime = getSafeCtime(stat)
                    size = stat.size
                }
            }
        } catch (error) {
            dumpError("Failed to read config file:", error)
        }
    }

    if (contentHash === "" || mtime === 0) {
        plugin.removeIgnoredConfigFile(path)
        return
    }

    // --- 新增：哈希校验 ---
    // 如果当前内容哈希与已记录的哈希一致，说明文件内容并未改变（例如仅 mtime 被 Obsidian 刷新）：
    // 只更新本地记录的 mtime，不重新上传，避免多端同时在线时来回同步（#114）
    const savedHash = plugin.configHashManager?.getPathHash(path)
    const lastSyncMtime = plugin.lastSyncMtime?.get(path)

    if (!forceUpload && savedHash === contentHash && !plugin.pendingConfigModifies?.has(path)) {
        plugin.removeIgnoredConfigFile(path)
        if (lastSyncMtime !== mtime) {
            plugin.lastSyncMtime?.set(path, mtime)
        }
        // 顺便更新一下 ConfigManager 与 ConfigHashManager 的文件状态，防止下次重复触发
        if (plugin.configManager) {
            plugin.configManager.updateFileState(normalizePath(path), mtime)
        }
        if (content === undefined && size >= 0 && plugin.configHashManager?.isReady?.()) {
            plugin.configHashManager.setFileHash?.(path, contentHash, mtime, size)
        }
        dump(`Config modify intercepted (content unchanged): ${path}`)
        return
    }

    const data = {
        vault: plugin.settings.vault,
        path: path,
        pathHash: hashContent(path),
        content: contentStr,
        contentHash: contentHash,
        mtime: mtime,
        ctime: ctime,
        ...buildBaselineFields(plugin, "setting", path, contentHash),
        ...(options?.baseRevision ? { baseRevision: options.baseRevision } : {}),
        ...(options?.isConflictResolved ? { isConflictResolved: true } : {}),
    }
    // 将 hash 暂存到 pending map，等待服务端 SettingModifyAck 后再写入 configHashManager
    // Temporarily store hash in pending map, update configHashManager only after server SettingModifyAck
    plugin.pendingConfigDeleteAcks.delete(path)
    plugin.pendingConfigModifies.set(path, contentHash)
    plugin.localStorageManager.savePending('pendingConfigModifies', plugin.pendingConfigModifies)
    if (!await plugin.concurrencyLimiter.waitForSlot(path)) {
        plugin.removeIgnoredConfigFile(path)
        return
    }
    // 返回发送 Promise：冲突解决弹窗等调用方可以等“已写入连接”后再清理备份
    // Return the send promise so callers such as the conflict resolver can wait for the frame to be
    // written before cleaning up backups
    try {
        await plugin.websocket.SendMessage("SettingModify", data)
    } finally {
        plugin.removeIgnoredConfigFile(path)
    }
}

export const configDelete = async function (path: string, plugin: FastSync, eventEnter: boolean = false) {
    if (plugin.settings.configSyncEnabled == false || plugin.settings.readonlySyncEnabled) return
    if (!isPathInConfigSyncDirs(path, plugin)) return
    if (eventEnter && plugin.ignoredConfigFiles.has(path)) return
    if (configIsPathExcluded(path, plugin)) return

    // --- 新增：删除拦截 ---
    if (plugin.lastSyncPathDeleted.has(path)) {
        dump(`Config delete intercepted: ${path}`)
        return
    }
    // 冲突冻结的配置不自动上传删除 / A frozen conflicted setting never auto-uploads a deletion
    if (plugin.syncState?.conflictedPaths?.has(path)) {
        dump(`Config delete paused, unresolved conflict: ${path}`)
        return
    }

    plugin.addIgnoredConfigFile(path)
    // 删除前快照最后确认的基线，供实时删除、回放与批量删除携带
    // Snapshot the last confirmed baseline before deletion for live/replay/batch deletes
    if (plugin.isSyncBaselineModeEnabled?.() === true) plugin.configHashManager?.recordPendingDeleteBaseline?.(path)
    const data = {
        vault: plugin.settings.vault,
        path: path,
        pathHash: hashContent(path),
        ...buildDeleteBaselineFields(plugin, "setting", path),
    }
    if (!await plugin.concurrencyLimiter.waitForSlot(path)) {
        plugin.removeIgnoredConfigFile(path)
        return
    }
    void plugin.websocket.SendMessage("SettingDelete", data, undefined, () => {
        // 消息真正写入 TCP 缓冲区后加入 pending set，等待 SettingDeleteAck 再删 hash
        // Add to pending set only after message is actually buffered; remove hash only on SettingDeleteAck
        plugin.pendingConfigDeleteAcks.add(path)
    })
    plugin.removeIgnoredConfigFile(path)
}

export const receiveConfigSyncModify = async function (data: ReceiveMessage, plugin: FastSync) {
    if (plugin.settings.configSyncEnabled == false) return

    if (!isPathInConfigSyncDirs(data.path, plugin)) {
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }

    const isVirtual = data.path.startsWith(plugin.localStorageManager.syncPathPrefix)

    if (configIsPathExcluded(data.path, plugin)) {
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }
    if (plugin.ignoredConfigFiles.has(data.path) && !pendingConfigUpdates.has(data.path)) {
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }

    plugin.addIgnoredConfigFile(data.path)
    // 二进制信封只用于传输；配置重载与写入各取所需 / Envelopes are transport-only; reload and write consume the decoded value
    const decodedContent = isVirtual ? null : decodeConfigContent(data.content ?? "")
    try {
        // 拦截 LocalStorage 更新
        if (isVirtual) {
            if (await plugin.localStorageManager.handleReceivedUpdate(data.path, data.content)) {
                // 服务端已落盘虚拟配置：建立/前移可信基线（含 revision）
                // The server landed the virtual config: establish/advance the trusted baseline
                const rawRevision = (data as { revision?: string }).revision
                const revision = typeof rawRevision === "string" ? rawRevision : ""
                if (revision !== "" && plugin.configHashManager?.setConfirmedBaseline) {
                    plugin.configHashManager.setConfirmedBaseline(data.path, data.contentHash, revision, normalizeServerTimestamp(data.mtime), data.content?.length || 0)
                }
                plugin.removeIgnoredConfigFile(data.path)
                advanceLiveSyncTime(plugin, "lastConfigSyncTime", data.lastTime)
                plugin.recordSyncCompleted('setting', data.pageIndex)
                return
            }
            plugin.recordSyncCompleted('setting', data.pageIndex)
            return
        }

        const folder = data.path.split("/").slice(0, -1).join("/")
        if (folder !== "") {
            const fullFolderPath = normalizePath(folder)
            if (!(await plugin.app.vault.adapter.exists(fullFolderPath))) {
                await plugin.app.vault.adapter.mkdir(fullFolderPath)
            }
        }
        const filePath = normalizePath(data.path)

        // Fail-safe：写盘前检查本地是否有未推送的编辑，避免服务端推送盲覆盖用户刚做的改动
        // Fail-safe: before overwriting, check for unsynced local edits so a server push
        // doesn't blindly clobber changes the user just made
        const hasPendingLocalEdit = plugin.pendingConfigModifies.has(data.path)
        const existingStat = await plugin.app.vault.adapter.stat(filePath)
        let localContentHash: string | null = null
        if (existingStat) {
            localContentHash = typeof plugin.configHashManager.getValidHash === "function"
                ? plugin.configHashManager.getValidHash(data.path, existingStat.mtime, existingStat.size)
                : null
            if (localContentHash === null) {
                localContentHash = await hashFileAsync(plugin.app, filePath)
            }
        }
        // 旧版持久化基线只有在本地内容仍等于记录值时才可信；否则按“无可信基线”处理
        // Legacy persisted baselines count only while local content still equals them.
        const knownBaseHash = plugin.configHashManager.getPathHash(data.path)
        const trustedBaseHash = typeof plugin.configHashManager.getVerifiedPathHash === "function"
            ? plugin.configHashManager.getVerifiedPathHash(data.path, localContentHash)
            : knownBaseHash
        // 有可信基线时按内容比较（与 mtime 无关）：本地内容不等于基线即已偏离
        // With a trusted baseline the check is content-based (mtime-independent)
        const hasDivergedSinceLastSync = !hasPendingLocalEdit
            && trustedBaseHash !== null
            && localContentHash !== trustedBaseHash

        if (hasPendingLocalEdit || hasDivergedSinceLastSync) {
            dump(`[FastSync] Skip config overwrite, local unsynced edit detected: ${filePath}`)
            SyncLogManager.getInstance().addLog('receive', 'ConfigModifyConflict', `本地配置存在未同步的改动，跳过服务端覆盖，等待下一轮同步处理冲突: ${filePath}`, 'cancelled', data.path)
            plugin.removeIgnoredConfigFile(data.path)
            plugin.recordSyncCompleted('setting', data.pageIndex)
            return
        }

        if (await guardPluginDowngrade(data, plugin)) {
            plugin.removeIgnoredConfigFile(data.path)
            plugin.recordSyncCompleted('setting', data.pageIndex)
            return
        }

        // 服务端历史数据可能存秒级 mtime/ctime（#461），落盘/比较前先归一化为毫秒
        // Legacy server rows may hold second-scale mtime/ctime (#461); normalize to milliseconds
        const mtime = normalizeServerTimestamp(data.mtime)
        const ctime = normalizeServerTimestamp(data.ctime)
        // fns-bin-v1:b64 信封还原为原始字节写盘；普通文本仍走 write，保持零变化
        // Restore fns-bin-v1:b64 envelopes to raw bytes; plain text still goes through write
        if (decodedContent?.kind === "binary") {
            await plugin.app.vault.adapter.writeBinary(filePath, decodedContent.bytes, { ...(ctime > 0 && { ctime }), ...(mtime > 0 && { mtime }) })
        } else {
            await plugin.app.vault.adapter.write(filePath, decodedContent?.text ?? "", { ...(ctime > 0 && { ctime }), ...(mtime > 0 && { mtime }) })
        }

        // 游标推进放在写盘成功之后：写盘失败走 catch，不应越过本条（service#101）
        // Advance only after the write succeeded: a failure takes the catch path and must
        // not skip this item (service#101)
        advanceLiveSyncTime(plugin, "lastConfigSyncTime", data.lastTime)
    } catch (e) {
        dumpError("[writeConfigFile] error:", e)
        if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'ConfigModify')) {
            SyncLogManager.getInstance().addLog('receive', 'ConfigModify', e instanceof Error ? e.message : String(e), 'error', data.path);
        }
        plugin.configSyncTasks.failed++
    }

    // 保持对该文件的忽略直到 configReload 中的 checkAndReload 落盘并更新状态后再解除（#114）
    // 二进制信封只用于传输，配置重载只需要文本内容
    // Binary envelopes are transport-only; config reload only needs text content
    await configReload(data.path, plugin, false, decodedContent?.kind === "text" ? decodedContent.text : "")

    // 更新 ConfigManager 的文件状态，防止重复触发 configModify
    // （mtime 已归一化为毫秒，与 config_manager 读到的本地 stat.mtime 单位一致）
    // (mtime normalized to milliseconds, matching the unit of the local stat.mtime config_manager reads)
    if (plugin.configManager) {
        const absPath = normalizePath(data.path)
        plugin.configManager.updateFileState(absPath, normalizeServerTimestamp(data.mtime))
    }

    // 更新配置哈希表
    if (plugin.configHashManager && plugin.configHashManager.isReady()) {
        const filePath = normalizePath(data.path);
        const stat = isVirtual ? null : await plugin.app.vault.adapter.stat(filePath);
        // 如果是虚拟路径，mtime 使用推送过来的，size 使用内容长度
        // For virtual paths, use pushed mtime and content length as size
        const size = isVirtual ? (data.content?.length || 0) : (stat?.size || 0);
        const mtime = normalizeServerTimestamp(data.mtime) || (stat?.mtime || 0);

        const revision = (data as { revision?: string }).revision
        if (typeof revision === "string" && revision !== "") {
            plugin.configHashManager.setFileHash(data.path, data.contentHash, mtime, size, revision)
        } else {
            plugin.configHashManager.setFileHash(data.path, data.contentHash, mtime, size)
        }
        // 记录 mtime
        plugin.lastSyncMtime.set(data.path, mtime)
    }

    plugin.recordSyncCompleted('setting', data.pageIndex)
}

export const receiveConfigUpload = async function (data: ReceivePathMessage, plugin: FastSync) {
    if (plugin.settings.configSyncEnabled == false) return;
    // 只读端不响应服务端的配置上传请求，与笔记/附件一致（#275）；本轮入口快照与实时设置
    // fail-closed 取或，轮次中途刚打开只读也要拦住。
    // A read-only device ignores the server's config upload requests, same as notes/attachments
    // (#275); OR the round's entry snapshot with the live setting fail-closed so read-only
    // enabled mid-round still blocks.
    if (plugin.syncRoundReadonly || plugin.settings.readonlySyncEnabled) {
        dump(`Read-only mode: Intercepted config upload request for ${data.path}`)
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }

    if (!isPathInConfigSyncDirs(data.path, plugin)) {
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }

    const isVirtual = data.path.startsWith(plugin.localStorageManager.syncPathPrefix)

    if (configIsPathExcluded(data.path, plugin)) {
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }
    // 虚拟配置（`_localStorage/`）同样要响应上传：服务端需要的是当前 localStorage 值，
    // 直接按虚拟路径条件提交，不能像以前那样一律丢弃
    // Virtual settings (`_localStorage/`) answer uploads too: submit the current localStorage value
    // for the virtual path instead of dropping the request as before
    if (isVirtual) {
        // 走普通上传链路（SettingModify + Ack 归账）；值已不存在时才直接完成该页条目
        // Go through the normal upload path (SettingModify settled by its Ack); only complete the
        // page item directly when the value is already gone
        const key = plugin.localStorageManager.pathToKey(data.path) || ""
        const currentVal = plugin.localStorageManager.getItemValue(key)
        if (currentVal === null) {
            plugin.recordSyncCompleted('setting', data.pageIndex)
            return
        }
        if (data.pageIndex !== undefined) plugin.syncState.pendingConfigPushPageIndex.set(data.path, data.pageIndex)
        await configModify(data.path, plugin, false, currentVal, true)
        return
    }

    plugin.addIgnoredConfigFile(data.path);

    const filePath = normalizePath(data.path);
    let contentStr = "";
    let contentHash = "";
    let contentBuf: ArrayBuffer | null = null;
    let mtime = 0;
    let ctime = 0;

    try {
        const exists = await plugin.app.vault.adapter.exists(filePath);
        if (exists) {
            const stat = await plugin.app.vault.adapter.stat(filePath);
            if (stat) {
                if (isLargeBinarySyncRisk(stat.size, plugin)) {
                    plugin.removeIgnoredConfigFile(data.path);
                    plugin.recordSyncCompleted('setting', data.pageIndex);
                    return;
                }
                contentHash = await hashFileAsync(plugin.app, filePath);
                const contentBufRead = await plugin.app.vault.adapter.readBinary(filePath);
                contentStr = encodeConfigContent(contentBufRead);
                contentBuf = contentBufRead; // 保持兼容性逻辑
                mtime = stat.mtime;
                ctime = getSafeCtime(stat);
            }
        }
    } catch (error) {
        dumpError("Failed to read config file:", error);
        plugin.configSyncTasks.failed++;
        plugin.recordSyncCompleted('setting', data.pageIndex);
        return
    }

    if (!contentBuf || mtime === 0) {
        plugin.recordSyncCompleted('setting', data.pageIndex);
        return;
    }

    plugin.removeIgnoredConfigFile(data.path);

    const sendData = {
        vault: plugin.settings.vault,
        path: data.path,
        pathHash: hashContent(data.path),
        content: contentStr,
        contentHash: contentHash,
        mtime: mtime,
        ctime: ctime,
        ...buildBaselineFields(plugin, "setting", data.path, contentHash),
    };
    // 将 hash 暂存到 pending map，等待服务端 SettingModifyAck 后再写入 configHashManager
    // Temporarily store hash in pending map, update configHashManager only after server SettingModifyAck
    plugin.pendingConfigModifies.set(data.path, contentHash)
    plugin.localStorageManager.savePending('pendingConfigModifies', plugin.pendingConfigModifies)
    // NeedPush 驱动的上传-回执往返：SettingModifyAck 本身不带 pageIndex，按 path 记下所属页供 Ack 归账
    // （见 sync_state.ts pendingConfigPushPageIndex 注释）
    // NeedPush-driven upload/ack round trip: SettingModifyAck carries no pageIndex; record the
    // owning page by path for the Ack to look up (see sync_state.ts pendingConfigPushPageIndex comment)
    if (data.pageIndex !== undefined) {
        plugin.syncState.pendingConfigPushPageIndex.set(data.path, data.pageIndex)
    }
    if (!await plugin.concurrencyLimiter.waitForSlot(data.path)) {
        plugin.removeIgnoredConfigFile(data.path)
        return
    }
    void plugin.websocket.SendMessage("SettingModify", sendData, undefined, function () {
        plugin.removeIgnoredConfigFile(data.path);
    }, (data as ReceivePathMessage & { context?: string }).context);
};

export const receiveConfigSyncMtime = async function (data: ReceiveMtimeMessage, plugin: FastSync) {
    if (plugin.settings.configSyncEnabled == false) return

    if (!isPathInConfigSyncDirs(data.path, plugin)) {
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }

    if (configIsPathExcluded(data.path, plugin)) {
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }
    if (plugin.ignoredConfigFiles.has(data.path)) {
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }

    // 虚拟配置没有磁盘文件：核对当前 localStorage 值的哈希等于消息哈希后直接确认基线
    // Virtual settings have no disk file: confirm the baseline once the current localStorage value
    // hashes to the message hash
    if (data.path.startsWith(plugin.localStorageManager.syncPathPrefix)) {
        try {
            const key = plugin.localStorageManager.pathToKey(data.path) || ""
            const current = plugin.localStorageManager.getItemValue(key)
            const msgHash = typeof data.contentHash === "string" && data.contentHash !== "" ? data.contentHash : ""
            const revision = typeof data.revision === "string" && data.revision !== "" ? data.revision : ""
            if (current !== null && msgHash !== "" && revision !== ""
                && await hashContentAsync(current) === msgHash && plugin.configHashManager?.setConfirmedBaseline) {
                plugin.configHashManager.setConfirmedBaseline(
                    data.path, msgHash, revision,
                    normalizeServerTimestamp(data.mtime), current.length,
                )
            }
            advanceLiveSyncTime(plugin, "lastConfigSyncTime", data.lastTime)
        } catch (e) {
            dumpError("[updateConfigFileTime] virtual config error:", e)
            if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'ConfigMtime')) {
                SyncLogManager.getInstance().addLog('receive', 'ConfigMtime', e instanceof Error ? e.message : String(e), 'error', data.path);
            }
            plugin.configSyncTasks.failed++
        }
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }

    plugin.addIgnoredConfigFile(data.path)
    const filePath = normalizePath(data.path)
    // 服务端历史数据可能存秒级 mtime/ctime（#461），落盘前先归一化为毫秒
    // Legacy server rows may hold second-scale mtime/ctime (#461); normalize to milliseconds
    const mtime = normalizeServerTimestamp(data.mtime)
    const ctime = normalizeServerTimestamp(data.ctime)
    try {
        if (await plugin.app.vault.adapter.exists(filePath)) {
            const content = await plugin.app.vault.adapter.readBinary(filePath)
            // 内容一致确认：只有本地仍是消息内容时才建立可信基线（设计稿 §5.2 第 3 条）
            // Content-equality confirmation: only when local content is still the message's content
            const msgHash = typeof data.contentHash === "string" && data.contentHash !== "" ? data.contentHash : "";
            const revision = typeof data.revision === "string" && data.revision !== "" ? data.revision : "";
            if (msgHash !== "" && revision !== "" && plugin.configHashManager?.setConfirmedBaseline) {
                const localHash = await hashArrayBuffer(content)
                if (localHash === msgHash) {
                    plugin.configHashManager.setConfirmedBaseline(data.path, msgHash, revision, mtime || 0, content.byteLength)
                }
            }
            await plugin.app.vault.adapter.writeBinary(filePath, content, { ...(ctime > 0 && { ctime }), ...(mtime > 0 && { mtime }) })
        }

        // 游标推进放在写盘成功之后：失败走 catch，不应越过本条（service#101）
        // Advance only after the write succeeded: a failure takes the catch path and must
        // not skip this item (service#101)
        advanceLiveSyncTime(plugin, "lastConfigSyncTime", data.lastTime)
    } catch (e) {
        dumpError("[updateConfigFileTime] error:", e)
        if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'ConfigMtime')) {
            SyncLogManager.getInstance().addLog('receive', 'ConfigMtime', e instanceof Error ? e.message : String(e), 'error', data.path);
        }
        plugin.configSyncTasks.failed++
    }
    plugin.removeIgnoredConfigFile(data.path)

    plugin.recordSyncCompleted('setting', data.pageIndex)
}

export const receiveConfigSyncDelete = async function (data: { path: string, lastTime?: number, pageIndex?: number }, plugin: FastSync) {
    if (plugin.settings.configSyncEnabled == false) return

    if (!isPathInConfigSyncDirs(data.path, plugin)) {
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }

    if (configIsPathExcluded(data.path, plugin)) {
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }
    if (plugin.ignoredConfigFiles.has(data.path)) {
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }

    try {
        const fullPath = normalizePath(data.path)
        if (await plugin.app.vault.adapter.exists(fullPath)) {
            // 记录删除路径
            plugin.lastSyncPathDeleted.add(data.path)
            try {
                await plugin.app.vault.adapter.trashLocal(fullPath)
            } finally {
                // 延时 500ms 清理
                window.setTimeout(() => {
                    plugin.lastSyncPathDeleted.delete(data.path)
                }, 500);
            }
        }
    } catch (e) {
        dumpError("[receiveConfigSyncDelete] error:", e)
        SyncLogManager.getInstance().addLog('receive', 'ConfigDelete', e instanceof Error ? e.message : String(e), 'error', data.path);
        plugin.configSyncTasks.failed++
        // Preserve hash/state when moving to trash fails; never fall back to remove.
        if (data.path) plugin.concurrencyLimiter.releaseSlot(data.path)
        plugin.recordSyncCompleted('setting', data.pageIndex)
        return
    }

    // 更新 ConfigManager 的文件状态
    if (plugin.configManager) {
        plugin.configManager.removeFileState(normalizePath(data.path))
    }

    // 从配置哈希表中删除
    if (plugin.configHashManager && plugin.configHashManager.isReady()) {
        plugin.configHashManager.removeFileHash(data.path)
    }

    // 更新同步时间
    advanceLiveSyncTime(plugin, "lastConfigSyncTime", data.lastTime)
    if (data.path) { plugin.concurrencyLimiter.releaseSlot(data.path) }

    plugin.recordSyncCompleted('setting', data.pageIndex)
}

export const receiveConfigSyncEnd = async function (data: unknown, plugin: FastSync) {
    if (plugin.settings.configSyncEnabled == false) return
    dump(`Receive config sync end:`, data)

    const syncData = data as SyncEndData
    // 更新任务统计信息，用于进度条计算 (Update task stats for progress bar)
    plugin.configSyncTasks.needUpload = syncData.needUploadCount || 0
    plugin.configSyncTasks.needModify = syncData.needModifyCount || 0
    plugin.configSyncTasks.needSyncMtime = syncData.needSyncMtimeCount || 0
    plugin.configSyncTasks.needDelete = syncData.needDeleteCount || 0
    // 本轮服务端计数留档，供每轮摘要使用（不改变任何处理行为）
    // Keep this round's server counts for the round summary (no behavior change)
    syncDiagnostics.recordSyncEndCounts?.("config", syncData)

    // 与 note/file/folder 三类一致：无条件暂存（service#101）。服务端 SettingSyncEnd 的
    // lastTime 同样取查询开始时刻（ws_setting.go syncStartTime），无下行更新时也有效；
    // 若仅在 hasUpdates 时暂存，纯上行的一轮结束后游标停在旧值（首次为 0），每轮都触发
    // isCover 全量覆盖比对。该条件系上游 ebaf4b5 给四类统一误加、09ea67b 修三类时漏掉
    // config 的残留，无保留依据。
    // Same as note/file/folder: stash unconditionally (service#101). The server's
    // SettingSyncEnd lastTime is also its query start (ws_setting.go syncStartTime), valid
    // even with no downlink updates; stashing only on hasUpdates left the cursor stale after
    // pure-uplink rounds (0 on first sync), forcing an isCover full comparison every round.
    // The condition was an upstream misapplication (ebaf4b5 added it to all four types,
    // 09ea67b removed three but missed config) with no surviving justification.
    // 暂存，待本类型全部完成且无失败时由 settleSyncTimes 落盘 / Stashed; persisted by settleSyncTimes
    plugin.syncState.pendingSyncEndTime.set("lastConfigSyncTime", syncData.lastTime)
    plugin.syncTypeCompleteCount++
}

export const receiveConfigSyncClear = async function (data: unknown, plugin: FastSync) {
    plugin.localStorageManager.setMetadata("lastConfigSyncTime", 0)
    showSyncNotice($("ui.status.clear_success"))
    plugin.configSyncTasks.completed++

    if (plugin.isWaitClearSync) {
        plugin.isWaitClearSync = false
        const { handleSync } = await import("./operator");
        void handleSync(plugin, false, "config")
    }
}

/**
 * 收到 SettingModifyAck，将 pending hash 转移到正式 configHashManager 并更新 lastConfigSyncTime
 * Receive SettingModifyAck, move pending hash to formal configHashManager and update lastConfigSyncTime
 */
export const receiveConfigModifyAck = async function (data: { lastTime?: number; path?: string; contentHash?: string; revision?: string }, plugin: FastSync, outsideRound = false) {
    if (data.path) {
        const pendingHash = plugin.pendingConfigModifies.get(data.path)
        const ackHash = typeof data.contentHash === "string" && data.contentHash !== "" ? data.contentHash : undefined
        const isVirtual = data.path.startsWith(plugin.localStorageManager.syncPathPrefix)
        if (ackHash && plugin.isSyncBaselineModeEnabled?.() === true && plugin.configHashManager?.setConfirmedBaseline) {
            // 回执只确认发送时的快照；上传途中被继续编辑时绝不能把新内容标为已同步（设计稿 §5.2）
            // The Ack confirms only the sent snapshot; edits made during the upload are never
            // marked as synced (design §5.2)
            let diskHash: string | null = null
            let mtime = 0, size = 0
            try {
                if (isVirtual) {
                    const value = plugin.localStorageManager.getItemValue(plugin.localStorageManager.pathToKey(data.path) || "")
                    diskHash = value === null || value === undefined ? null : hashContent(value)
                    mtime = Date.now()
                    size = value?.length || 0
                } else {
                    const stat = await plugin.app.vault.adapter.stat(normalizePath(data.path))
                    mtime = stat?.mtime || 0
                    size = stat?.size || 0
                    if (stat) diskHash = await hashFileAsync(plugin.app, normalizePath(data.path))
                }
            } catch { diskHash = null }
            plugin.configHashManager.setConfirmedBaseline(data.path, ackHash,
                typeof data.revision === "string" ? data.revision : "", mtime, size)
            if (pendingHash === ackHash) {
                plugin.pendingConfigModifies.delete(data.path)
                plugin.localStorageManager.savePending('pendingConfigModifies', plugin.pendingConfigModifies)
            }
            if (diskHash !== null && diskHash !== ackHash) {
                // 上传途中的新编辑：保留 pending 并立即安排携带新基线的后续上传
                // New edit during upload: keep pending and schedule a follow-up upload with the new baseline
                dump(`[Baseline] Config Ack confirmed ${ackHash}, disk changed to ${diskHash}; scheduling follow-up upload`, data.path)
                plugin.pendingConfigModifies.set(data.path, diskHash)
                plugin.localStorageManager.savePending('pendingConfigModifies', plugin.pendingConfigModifies)
                window.setTimeout(() => { void configModify(data.path as string, plugin, true) }, 0)
            }
        } else if (pendingHash !== undefined) {
            if (plugin.configHashManager && plugin.configHashManager.isReady()) {
                let mtime = 0, size = 0
                if (isVirtual) {
                    mtime = Date.now() // LocalStorage 虚拟时间
                    size = plugin.localStorageManager.getItemValue(plugin.localStorageManager.pathToKey(data.path) || "")?.length || 0
                } else {
                    const stat = await plugin.app.vault.adapter.stat(normalizePath(data.path));
                    mtime = stat?.mtime || 0
                    size = stat?.size || 0
                }
                plugin.configHashManager.setFileHash(data.path, pendingHash, mtime, size)
            }
            plugin.pendingConfigModifies.delete(data.path)
            plugin.localStorageManager.savePending('pendingConfigModifies', plugin.pendingConfigModifies)
        }
    }
    if (!outsideRound) advanceLiveSyncTime(plugin, "lastConfigSyncTime", data.lastTime)
    if (data.path) {
        plugin.concurrencyLimiter.releaseSlot(data.path)
    }
    if (outsideRound) return
    // 查表归账所属下载页（NeedPush 驱动）；查不到说明是本地用户自发编辑触发的 Ack，走旧路径
    // Look up the owning download page (NeedPush-driven); a miss means a local user-initiated
    // edit triggered this Ack, falls back to the legacy path
    const pushPageIndex = data.path ? plugin.syncState.pendingConfigPushPageIndex.get(data.path) : undefined;
    if (data.path) plugin.syncState.pendingConfigPushPageIndex.delete(data.path)
    plugin.recordSyncCompleted('setting', pushPageIndex)
}

/**
 * 收到 SettingDeleteAck，仅当路径仍在 pending set 中时才从 configHashManager 移除并更新 lastConfigSyncTime
 * Receive SettingDeleteAck; only remove from configHashManager if path is still pending and update lastConfigSyncTime
 */
export const receiveConfigDeleteAck = function (data: { lastTime?: number; path?: string }, plugin: FastSync) {
    if (data.path) {
        // 删除已确认：清除待删基线记录
        // Delete confirmed: drop the pre-delete baseline record
        plugin.configHashManager?.clearPendingDeleteBaseline?.(data.path)
    }
    if (data.path && plugin.pendingConfigDeleteAcks.has(data.path)) {
        if (plugin.configHashManager && plugin.configHashManager.isReady()) {
            plugin.configHashManager.removeFileHash(data.path)
        }
        plugin.pendingConfigDeleteAcks.delete(data.path)
    }
    advanceLiveSyncTime(plugin, "lastConfigSyncTime", data.lastTime)
    if (data.path) {
        plugin.concurrencyLimiter.releaseSlot(data.path)
    }
}

/**
 * 辅助逻辑提取
 */

export const configAllPaths = async function (configDirs: string[], plugin: FastSync): Promise<string[]> {
    const paths: string[] = []
    const adapter = plugin.app.vault.adapter
    const isExcluded = (p: string) => configIsPathExcluded(p, plugin)

    /**
     * 递归扫描通用目录；传入 exts 时按资源扩展名过滤并跳过生成目录
     * Recursive directory scan; when exts is provided, filter by resource extension and skip generated dirs
     */
    const scanDirRecursive = async (dirPath: string, exts?: string[]) => {
        try {
            if (!(await adapter.exists(normalizePath(dirPath)))) return
            const result = await adapter.list(normalizePath(dirPath))
            for (const file of result.files) {
                if (isExcluded(file)) continue
                if (exts && !exts.some(ext => file.toLowerCase().endsWith(ext))) continue
                paths.push(file)
            }
            for (const folder of result.folders) {
                if (isExcluded(folder) || (exts && isConfigResourcePathExcluded(folder, plugin.app.vault.configDir))) continue
                await scanDirRecursive(folder, exts)
            }
        } catch (e) {
            dump(`Error scanning directory ${dirPath}:`, e)
        }
    }

    for (const configDir of configDirs) {
        try {
            // 解析目录名称，用于判断是否为自定义目录
            const normalizedConfigDir = configDir.replace(/\\/g, "/")

            // 特殊处理配置目录（为了向后兼容和针对插件/主题的特定扫描逻辑）
            if (normalizedConfigDir.endsWith(plugin.app.vault.configDir)) {
                const rootItems = await adapter.list(normalizePath(configDir))
                for (const file of rootItems.files) {
                    const fileName = file.split("/").pop() || ""
                    if (fileName.endsWith(".json")) {
                        // 1. 白名单最高优先级：命中则直接纳入，跳过所有后续排除规则
                        // 1. Whitelist has highest priority: if matched, include unconditionally
                        if (isInWhitelist(file, plugin)) {
                            paths.push(file)
                            continue
                        }
                        // 2. 硬编码排除（如 workspace.json）
                        // 2. Hard exclude (e.g. workspace.json)
                        if (CONFIG_ROOT_FILES_EXCLUDE.includes(fileName)) continue
                        // 3. 用户自定义排除规则
                        // 3. User-defined exclude rules
                        if (isExcluded(file)) continue
                        paths.push(file)
                    }
                }
                const pluginsPath = normalizePath(`${configDir}/plugins`)
                if (await adapter.exists(pluginsPath)) {
                    const result = await adapter.list(pluginsPath)
                    for (const folderPath of result.folders) {
                        if (isExcluded(folderPath)) continue
                        await scanDirRecursive(folderPath, CONFIG_PLUGIN_EXTS_TO_WATCH)
                    }
                }
                const themesPath = normalizePath(`${configDir}/themes`)
                if (await adapter.exists(themesPath)) {
                    const result = await adapter.list(themesPath)
                    for (const folderPath of result.folders) {
                        if (isExcluded(folderPath)) continue
                        // 主题可能把图片/字体放在子目录（#234），按资源扩展名递归扫描
                        // Themes may nest images/fonts in subfolders (#234); scan recursively by extension
                        await scanDirRecursive(folderPath, CONFIG_THEME_EXTS_TO_WATCH)
                    }
                }
                const snippetsPath = normalizePath(`${configDir}/snippets`)
                if (await adapter.exists(snippetsPath)) {
                    const result = await adapter.list(snippetsPath)
                    for (const filePath of result.files) {
                        const fileName = filePath.split("/").pop() || ""
                        if (!CONFIG_SNIPPET_EXTS_TO_WATCH.some(ext => fileName.toLowerCase().endsWith(ext))) continue
                        const rel = `${configDir}/snippets/${fileName}`
                        if (!isExcluded(rel)) paths.push(rel)
                    }
                }
            } else {
                // 通用递归扫描 (自定义目录同步所有文件)
                await scanDirRecursive(configDir)
            }
        } catch (e) {
            dump(`Error processing config dir ${configDir}:`, e)
        }
    }
    return paths
}

export const configEmptyFoldersClean = async function (configDir: string, plugin: FastSync) {
    if (plugin.settings.configSyncEnabled == false) return
    const folders = [normalizePath(`${configDir}/plugins`), normalizePath(`${configDir}/themes`)]
    for (const root of folders) {
        try {
            if (!(await plugin.app.vault.adapter.exists(root))) continue
            const res = await plugin.app.vault.adapter.list(root)
            for (const folder of res.folders) {
                const itemRes = await plugin.app.vault.adapter.list(folder)
                if (itemRes.files.length === 0 && itemRes.folders.length === 0) {
                    await plugin.app.vault.adapter.rmdir(normalizePath(folder), true)
                }
            }
        } catch { /* ignore */ }
    }
}

export const configReload = async function (path: string, plugin: FastSync, eventEnter: boolean = false, data: string = "") {
    // 将更新加入待处理列表

    pendingConfigUpdates.set(path, data)

    // 清除旧计时器
    if (reloadTimer) {
        window.clearTimeout(reloadTimer)
    }

    // 设置新计时器，延迟 1 秒

    const checkAndReload = async () => {
        // 如果正在同步且配置同步尚未标记结束，或任务尚未全部完成，则继续等待
        // If syncing and config sync not marked as end, or tasks not all completed, continue waiting
        if (plugin.isSyncing) {
            const tasks = plugin.configSyncTasks;
            const totalTasks = tasks.needModify + tasks.needSyncMtime + tasks.needDelete;
            if (!plugin.configSyncEnd || tasks.completed < totalTasks) {
                reloadTimer = window.setTimeout(() => { void checkAndReload(); }, 500);
                return;
            }
        }

        const app = plugin.app as App & {
            vault: {
                reloadConfig?(): Promise<void>;
                getConfig(key: string): unknown;
                setConfig(key: string, value: unknown): void;
            };
            customCss?: {
                themes: Record<string, unknown>;
                theme: string;
                setTheme(theme: string): void;
                onConfigChange(): void;
                readSnippets(): Promise<void>;
            };
            plugins: {
                plugins?: Record<string, { onExternalSettingsChange?(): unknown }>;
                enabledPlugins: Set<string>;
                disablePlugin(id: string): Promise<void>;
                enablePlugin(id: string): Promise<void>;
            };
            hotkeys?: {
                load(): Promise<void>;
            };
            setting?: {
                activeTab?: {
                    display(): void;
                };
            };
        }
        const configDir = plugin.app.vault.configDir

        const updates = Array.from(pendingConfigUpdates.entries())
        const communityPluginsUpdated = updates.some(([p]) => p === `${configDir}/community-plugins.json`)
        pendingConfigUpdates.clear()
        // 本轮写入已全部落定，降级还原用的备份不再需要 / The round's writes are settled; restore backups are no longer needed
        pluginCodeBackups.clear()
        reloadTimer = null

        for (const [p] of updates) {
            plugin.addIgnoredConfigFile?.(p)
        }

        try {
            if (app.vault.reloadConfig) await app.vault.reloadConfig()

            const pluginsToReload = new Set<string>()
            for (const [p, d] of updates) {
                if (p === `${configDir}/app.json` || p === `${configDir}/appearance.json`) {
                    try {
                        const config = JSON.parse(d) as Record<string, unknown>;
                        // 仅在值确实改变时才设置，减少刷新频率
                        for (const key in config) {
                            if (Object.prototype.hasOwnProperty.call(config, key)) {
                                if (app.vault.getConfig(key) !== config[key]) {
                                    app.vault.setConfig(key, config[key]);
                                }
                            }
                        }

                        if (p === `${configDir}/appearance.json` && app.customCss) {
                            // 修正属性名：社区主题使用的是 cssTheme
                            const targetTheme = config.cssTheme as string | undefined;
                            if (targetTheme !== undefined) {
                                // 核心检查：在切换主题前，先检查本地是否存在该主题文件
                                // 防止因为同步延迟导致主题文件夹还没下载完就切换，触发 Obsidian 的自动回落
                                const themes = (app.customCss as unknown as { themes?: Record<string, unknown> }).themes || {};
                                if (targetTheme === "" || Object.prototype.hasOwnProperty.call(themes, targetTheme)) {
                                    if (app.customCss.theme !== targetTheme) {
                                        app.customCss.setTheme(targetTheme)
                                        app.customCss.onConfigChange()
                                    }
                                } else {
                                    console.warn(`[Sync] theme "${targetTheme}" not ready locally, skipping switch to avoid resetting to default`);
                                }
                            }
                        }
                    } catch (e) {
                        dumpError(`[Sync] failed to process ${p}:`, e);
                    }
                } else if (p === `${configDir}/community-plugins.json`) {
                    try {
                        const newP = JSON.parse(d) as string[]
                        const oldP = plugin.configManager ? Array.from(plugin.configManager.enabledPlugins) : []
                        const toE = newP.filter((p: string) => !oldP.includes(p))
                        const toD = oldP.filter((p: string) => !newP.includes(p))
                        if (plugin.configManager) {
                            plugin.configManager.enabledPlugins = new Set(newP)
                        }
                        for (const id of toE) {
                            if (id != "hot-reload" && id != "fast-note-sync") {
                                pluginsToReload.add(id)
                            }
                        }
                        for (const id of toD) {
                            if (id != "hot-reload" && id != "fast-note-sync") await app.plugins.disablePlugin(id)
                        }
                    } catch { /* ignore */ }
                } else if (p === `${configDir}/hotkeys.json`) {
                    if (app.hotkeys) await app.hotkeys.load()
                } else if (p.startsWith(`${configDir}/snippets/`) && p.endsWith(".css")) {
                    if (app.customCss) await app.customCss.readSnippets()
                } else if (p.startsWith(`${configDir}/plugins/`)) {
                    const parts = p.split("/")
                    // .obsidian/plugins/id/file -> parts=[".obsidian", "plugins", "id", "file"]
                    if (parts.length >= 4) {
                        const id = parts[2]
                        pluginsToReload.add(id)
                    }
                }
            }

            // 统一处理插件重载
            // 将 fast-note-sync 移到最后处理，确保其他插件先重载
            // Process fast-note-sync last to ensure other plugins reload first
            const sortedPlugins = Array.from(pluginsToReload);
            const selfId = "fast-note-sync";
            if (sortedPlugins.includes(selfId)) {
                const index = sortedPlugins.indexOf(selfId);
                sortedPlugins.splice(index, 1);
                sortedPlugins.push(selfId);
            }

            for (const id of sortedPlugins) {
                if (id === "hot-reload") continue

                const hasMainJsUpdate = updates.some(([p]) => p === `${configDir}/plugins/${id}/main.js`)
                const hasManifestUpdate = updates.some(([p]) => p === `${configDir}/plugins/${id}/manifest.json`)

                // 特殊处理本插件的更新：
                // 如果 main.js 或 manifest.json 更新了，则进行正常的重载流程
                // 否则（例如仅 data.json 更新），跳过重载以免影响插件运行
                if (id === selfId) {
                    if (hasMainJsUpdate || hasManifestUpdate) {
                        dump(`[FastNoteSync] Detected critical update for self, triggering reload.`);
                        plugin.websocket.unRegister();
                        // Fall through to reload logic
                    } else {
                        continue;
                    }
                }

                const isCurrentlyEnabled = app.plugins.enabledPlugins.has(id)
                const shouldBeEnabled = plugin.configManager && plugin.configManager.enabledPlugins.has(id)
                // 只有代码/样式/清单变化才需要先停再开；data.json 等数据文件变化重载会让插件在加载时写回
                // 本机状态，多端版本不一致时形成无限重载循环（#249 #269）。数据变化改为通知插件自行重读设置
                // Only code/style/manifest changes need a disable+enable. Reloading on data files such as
                // data.json makes plugins write back device state on load, which loops forever across devices
                // running different versions (#249 #269). For data changes, notify the plugin to re-read settings
                const hasCodeUpdate = updates.some(([p]) => PLUGIN_CODE_FILES.some(f => p === `${configDir}/plugins/${id}/${f}`))

                if (isCurrentlyEnabled && !hasCodeUpdate) {
                    if (updates.some(([p]) => p === `${configDir}/plugins/${id}/data.json`)) {
                        try {
                            await app.plugins.plugins?.[id]?.onExternalSettingsChange?.()
                        } catch (e) {
                            dumpError(`[Sync] onExternalSettingsChange failed for ${id}:`, e)
                        }
                    }
                } else if (isCurrentlyEnabled) {
                    // 如果当前已启用，则执行重载逻辑（先停再开）
                    await app.plugins.disablePlugin(id)
                    await app.plugins.enablePlugin(id)
                } else if (communityPluginsUpdated && shouldBeEnabled) {
                    // 如果当前未启用，仅当本次同步包含了最新的 community-plugins.json 且要求启用时才开启
                    await app.plugins.enablePlugin(id)
                }
            }
            if (app.setting?.activeTab) app.setting.activeTab.display()
        } finally {
            // 配置应用与落盘完成后，刷新 ConfigManager 的文件状态并解除忽略保护（#114）
            for (const [p] of updates) {
                const absPath = normalizePath(p)
                try {
                    const stat = await plugin.app?.vault?.adapter?.stat?.(absPath)
                    if (stat && plugin.configManager?.updateFileState) {
                        plugin.configManager.updateFileState(absPath, stat.mtime)
                    }
                } catch { /* ignore */ }
                plugin.removeIgnoredConfigFile?.(p)
            }
        }
    }

    reloadTimer = window.setTimeout(() => { void checkAndReload(); }, 1000)
}


/**
 * 提取 Operator 映射
 */
// type ConfigOperator = (relativePath: string, plugin: FastSync, eventEnter?: boolean, data?: string) => void
// const configOperators: Map<string, ConfigOperator> = new Map([
//     ["ConfigModify", configModify],
//     ["ConfigDelete", configDelete],
//     ["ConfigEmptyFoldersClean", configEmptyFoldersClean],
//     ["ConfigReload", configReload],
//     ["ConfigAllPaths", configAllPaths as unknown as ConfigOperator],
//     ["ConfigIsPathExcluded", configIsPathExcluded],
//     ["ConfigAddPathExcluded", configAddPathExcluded],
// ])
