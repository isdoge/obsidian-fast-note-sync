import { normalizePath } from "obsidian";

import { dump, dumpError, getFileName, getDirNameOrEmpty, configAddPathExcluded, isPathInConfigSyncDirs, getConfigSyncCustomDirs, isInWhitelist, getPluginDir, configIsPathExcluded } from "../utils/helpers";
import { CONFIG_PLUGIN_EXTS_TO_WATCH, CONFIG_ROOT_FILES_EXCLUDE, CONFIG_THEME_EXTS_TO_WATCH, CONFIG_SNIPPET_EXTS_TO_WATCH, configModify, configDelete, configAllPaths, isConfigResourcePathExcluded } from "./operator_config";
import type FastSync from "../../main";


export class ConfigManager {
  private plugin: FastSync
  private pluginDir: string = ""
  private pluginRealDir: string = ""
  private fileStates: Map<string, number> = new Map()
  private watchedCustomDirs: Set<string> = new Set()
  private customDirWatchCleanups: Map<string, () => Promise<void> | void> = new Map()
  private rootFilesExclude: string[] = []
  private pluginExtsToWatch: string[] = []
  private themeExtsToWatch: string[] = []
  public enabledPlugins: Set<string> = new Set()

  constructor(plugin: FastSync) {
    this.plugin = plugin
    this.rootFilesExclude = CONFIG_ROOT_FILES_EXCLUDE
    this.pluginExtsToWatch = CONFIG_PLUGIN_EXTS_TO_WATCH
    this.themeExtsToWatch = CONFIG_THEME_EXTS_TO_WATCH
    this.pluginRealDir = this.plugin.manifest.dir ?? ""
    const configDir = this.plugin.app.vault.configDir
    this.pluginDir = this.pluginRealDir

    configAddPathExcluded(`${configDir}/plugins/hot-reload/`, this.plugin)
    // 自动将本插件的 data.json 加入内置同步排除列表，防止同步敏感数据及配置冲突
    // Automatically add this plugin's own data.json to built-in sync exclusion to prevent syncing sensitive data and config conflicts
    configAddPathExcluded(`${getPluginDir(this.plugin)}/data.json`, this.plugin)

    void this.loadEnabledPlugins()
    void this.initializeFileStates()
    void this.watchCustomDirs()
  }

  public async reloadCustomDirs() {
    await this.watchCustomDirs()
    await this.initializeFileStates()
  }

  public async stop() {
    await this.clearCustomDirWatches()
  }

  private async clearCustomDirWatches() {
    const adapter = this.plugin.app.vault.adapter as typeof this.plugin.app.vault.adapter & {
      unwatch?: (path: string) => Promise<void> | void
    }
    for (const dir of Array.from(this.watchedCustomDirs)) {
      const cleanup = this.customDirWatchCleanups.get(dir)
      if (cleanup) {
        this.customDirWatchCleanups.delete(dir)
        try {
          await cleanup()
        } catch (e) {
          dumpError(`ConfigManager: Failed to cleanup custom directory watcher ${dir}`, e)
        }
        this.watchedCustomDirs.delete(dir)
      } else if (typeof adapter.unwatch === "function") {
        try {
          await adapter.unwatch(dir)
        } catch (e) {
          dumpError(`ConfigManager: Failed to unwatch custom directory ${dir}`, e)
        }
        this.watchedCustomDirs.delete(dir)
      }
    }
  }

  private async watchCustomDirs() {
    await this.clearCustomDirWatches()
    if (!this.plugin.settings.configSyncEnabled) return
    // Obsidian 默认不监听配置目录之外的隐藏目录；该内部能力并非所有适配器都有。
    const adapter = this.plugin.app.vault.adapter as typeof this.plugin.app.vault.adapter & {
      watchHiddenRecursive?: (path: string) => unknown
    }
    if (typeof adapter.watchHiddenRecursive !== "function") return
    const configDir = this.plugin.app.vault.configDir
    const dirs = new Set(getConfigSyncCustomDirs(this.plugin).map(dir => normalizePath(dir)))
    for (const dir of dirs) {
      const parts = dir.split("/")
      if (dir.startsWith("/") || /^[A-Za-z]:/.test(dir) || /[*?]/.test(dir)
        || parts.some(part => part === ".." || part === ".git" || part === ".trash")
        || !parts.some(part => part.startsWith("."))
        || dir === configDir || dir.startsWith(configDir + "/")
        || configIsPathExcluded(dir, this.plugin)) continue
      // 适配器未提供 unwatch/清理句柄时跳过已注册目录，避免重复挂接相同监听器
      if (this.watchedCustomDirs.has(dir)) continue
      try {
        const result = await adapter.watchHiddenRecursive(dir)
        this.watchedCustomDirs.add(dir)
        if (typeof result === "function") {
          this.customDirWatchCleanups.set(dir, result as () => Promise<void> | void)
        } else if (result && typeof result === "object") {
          const closable = result as { close?: () => Promise<void> | void; unwatch?: () => Promise<void> | void }
          if (typeof closable.close === "function") {
            this.customDirWatchCleanups.set(dir, () => closable.close!())
          } else if (typeof closable.unwatch === "function") {
            this.customDirWatchCleanups.set(dir, () => closable.unwatch!())
          }
        }
      } catch (e) {
        dumpError(`ConfigManager: Failed to watch custom directory ${dir}`, e)
      }
    }
  }

  private async initializeFileStates() {
    if (!this.plugin.settings.configSyncEnabled) {
      this.fileStates.clear()
      return
    }

    const configDir = this.plugin.app.vault.configDir
    const customDirs = getConfigSyncCustomDirs(this.plugin)
    const paths = await configAllPaths([configDir, ...customDirs], this.plugin)

    const nextStates = new Map<string, number>()
    for (const relPath of paths) {
      const fullPath = normalizePath(relPath)
      try {
        const stat = await this.plugin.app.vault.adapter.stat(fullPath)
        if (stat && stat.type === "file") {
          nextStates.set(fullPath, stat.mtime)
        }
      } catch {
        // 忽略读取不到的单个文件
      }
    }
    this.fileStates = nextStates
    dump("ConfigManager: Initialized fileStates with", this.fileStates.size, "files")
  }

  public async handleRawEvent(path: string, eventEnter: boolean = false) {
    if (!this.plugin.settings.configSyncEnabled || this.plugin.isSyncing) return

    const configDir = this.plugin.app.vault.configDir
    if (path.includes("/.git") || path.includes("/.DS_Store") || isConfigResourcePathExcluded(path, configDir)) return

    // 检查路径是否属于配置同步范畴
    if (!isPathInConfigSyncDirs(path, this.plugin) || configIsPathExcluded(path, this.plugin)) return

    // 相对目录
    const relativePath = path

    const fileName = getFileName(path)
    let shouldCheck = false

    // 如果路径不在核心配置目录内 (即自定义同步目录或虚拟路径)，则全量放行（除非被排除）
    if (!path.startsWith(configDir + "/")) {
      shouldCheck = true
    } else {
      // 白名单最高优先级：命中则直接放行，不受任何文件类型/目录结构限制
      // Whitelist has highest priority: bypass all type/structure filtering if matched
      if (isInWhitelist(path, this.plugin)) {
        shouldCheck = true
      } else {
        // 核心配置目录内的路径，按照原有精细化规则分发
        const relativePathInConfig = path.replace(configDir + "/", "")
        const parts = relativePathInConfig.split("/")
        const topDir = parts[0]

        if (parts.length === 1) {
          // 根配置：仅同步 JSON，且不在硬编码排除名单内
          // Root config: only sync JSON files not in the hard exclude list
          if (fileName.endsWith(".json") && !this.rootFilesExclude.includes(fileName)) shouldCheck = true
        } else if (topDir === "plugins" || topDir === "themes") {
          const nameDir = getDirNameOrEmpty(parts[1])
          // 插件或主题
          if (parts.length === 2 && nameDir != "" && fileName == "") {
            // 目录变动
            shouldCheck = true
          } else if (parts.length >= 3 && nameDir != "" && fileName != "") {
            // 插件与主题资源允许位于子目录（主题图片/字体常见于 assets 子目录，#234）。
            // Plugin and theme resources may live in subfolders (theme images/fonts often do, #234).
            const isPluginFile = topDir === "plugins" && this.pluginExtsToWatch.some(ext => fileName.toLowerCase().endsWith(ext))
            const isThemeFile = topDir === "themes" && this.themeExtsToWatch.some(ext => fileName.toLowerCase().endsWith(ext))
            if (isPluginFile || isThemeFile) shouldCheck = true
          }
        } else if (topDir === "snippets" && parts.length === 2 && CONFIG_SNIPPET_EXTS_TO_WATCH.some(ext => fileName.toLowerCase().endsWith(ext))) {
          shouldCheck = true
        }
      }
    }

    if (shouldCheck) {
      // 1. 特殊处理 community-plugins.json 更新 (本地修改场景)
      // 确保 enabledPlugins 集合与磁盘文件同步，防止后续 reload 逻辑误判
      if (fileName === "community-plugins.json" && path === normalizePath(`${configDir}/community-plugins.json`)) {
        await this.loadEnabledPlugins()
      }

      // 2. 特殊处理本插件的 manifest.json 更新 (本地修改场景)
      if (fileName === "manifest.json" && relativePath === `${this.pluginDir}/manifest.json`) {
        window.setTimeout(() => {
          void (async () => {
            try {
              const content = await this.plugin.app.vault.adapter.read(path)
              const manifest = JSON.parse(content) as { version?: string }
              if (manifest.version && manifest.version !== this.plugin.manifest.version) {
                (this.plugin.manifest as { version: string }).version = manifest.version
                dump(`[FastNoteSync] Local manifest updated to ${this.plugin.manifest.version}`)
              }
            } catch (e) {
              dumpError("[FastNoteSync] Failed to read local manifest:", e)
            }
          })();
        }, 500) // 延迟读取确保写入完成
      }

      void this.checkFileChange(path, eventEnter)
    }
  }

  async loadEnabledPlugins() {
    try {
      const filePath = normalizePath(`${this.plugin.app.vault.configDir}/community-plugins.json`)
      if (await this.plugin.app.vault.adapter.exists(filePath)) {
        const plugins = JSON.parse(await this.plugin.app.vault.adapter.read(filePath)) as string[]
        if (Array.isArray(plugins)) this.enabledPlugins = new Set(plugins)
      }
    } catch {
      // Ignore errors when loading community-plugins.json
    }
  }

  private async checkFileChange(filePath: string, eventEnter: boolean = false, isFolder: boolean = false) {
    const relativePath = filePath
    if (this.plugin.ignoredConfigFiles.has(relativePath)) return

    try {
      const stat = await this.plugin.app.vault.adapter.stat(filePath)

      // 1. 处理删除 (包括目录递归删除)
      if (!stat) {
        const prefix = filePath + "/"
        for (const cachedPath of this.fileStates.keys()) {
          if (cachedPath === filePath || cachedPath.startsWith(prefix)) {
            const rel = cachedPath
            this.fileStates.delete(cachedPath)
            void configDelete(rel, this.plugin, eventEnter)
            dump("Config Delete", rel)
          }
        }
        return
      }

      // 2. 目录变动不直接处理文件同步逻辑，仅作为触发点
      if (stat.type === "folder") {
        dump("Config Folder create skip", relativePath)
        return
      }

      // 3. 处理文件同步逻辑
      const lastMtime = this.fileStates.get(filePath)
      if (lastMtime === undefined) {
        this.fileStates.set(filePath, stat.mtime)
        // 初始同步或新文件
        void configModify(relativePath, this.plugin, eventEnter)
        dump("Config Modify", relativePath)
        return
      }

      if (stat.mtime !== lastMtime) {
        this.fileStates.set(filePath, stat.mtime)
        // 初始同步或新文件
        void configModify(relativePath, this.plugin, eventEnter)
        dump("Config Modify", relativePath)
      }
    } catch {
      // Ignore stat errors
    }
  }

  public updateFileState(filePath: string, mtime: number) {
    this.fileStates.set(filePath, mtime)
  }

  public removeFileState(filePath: string) {
    this.fileStates.delete(filePath)
    // 同时尝试删除目录前缀的缓存（如果有）
    const prefix = filePath + "/"
    for (const cachedPath of this.fileStates.keys()) {
      if (cachedPath.startsWith(prefix)) {
        this.fileStates.delete(cachedPath)
      }
    }
  }
}
