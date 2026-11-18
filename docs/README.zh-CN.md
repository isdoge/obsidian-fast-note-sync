[简体中文](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.zh-CN.md) / [English](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/README.md) / [日本語](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.ja.md) / [한국어](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.ko.md) / [繁體中文](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.zh-TW.md)

> [!IMPORTANT]
> **本仓库是独立维护的修复版。** 上游 [haierkeys/obsidian-fast-note-sync](https://github.com/haierkeys/obsidian-fast-note-sync) 自 2026 年 8 月起没有再更新。本仓库由 [isdoge](https://github.com/isdoge) 从上游 v2.4.0 分出，合并了上游积压的 PR 并修复已知问题，此后独立演进，版本号不再跟随上游。**请不要通过 Obsidian 社区插件商店安装或更新**，商店里是上游版本。详见下文「关于本仓库」。

有问题或需求，请在本仓库新建 [issue](https://github.com/isdoge/obsidian-fast-note-sync/issues/new)。




<h1 align="center">Fast Note Sync For Obsidian</h1>

<p align="center">
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/releases"><img src="https://img.shields.io/github/release/isdoge/obsidian-fast-note-sync?style=flat-square" alt="release"></a>
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/releases"><img src="https://img.shields.io/github/v/tag/isdoge/obsidian-fast-note-sync?label=release-alpha&style=flat-square" alt="alpha-release"></a>
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/blob/master/LICENSE"><img src="https://img.shields.io/github/license/isdoge/obsidian-fast-note-sync?style=flat-square" alt="license"></a>
    <img src="https://img.shields.io/badge/Language-TypeScript-00ADD8?style=flat-square" alt="TypeScript">
</p>



<p align="center">
  <strong>快速多端同步、自动备份、版本可追溯，可分享协作的 Obsidian 笔记同步插件</strong>
  <br>
  <em>随时随地，多端实时同步你的笔记（电脑、手机、网页）。一键生成分享链接与好友共用，轻松回溯修改历史或恢复回收站内容；还支持备份、镜像与 Git 同步。借助 Fast Note Sync Service 的 REST/MCP 服务，你可以快速搭建属于自己的个人知识库。</em>
</p>

<p align="center">
  需配合独立服务端使用：<a href="https://github.com/isdoge/fast-note-sync-service">Fast Note Sync Service</a>
</p>

<div align="center">
    <img src="/docs/images/demo.gif" alt="fast-note-sync-service-preview" width="800" />
</div>


## 📌 关于本仓库

本仓库是 [haierkeys/obsidian-fast-note-sync](https://github.com/haierkeys/obsidian-fast-note-sync) 的独立维护版本，维护者 [isdoge](https://github.com/isdoge)。感谢原作者 HaierKeys 创建了这个项目。

- **来源**：从上游 v2.4.0 分出，合并了上游当时未处理的 18 个 PR，并修复了一批已知问题。完整清单见[更新日志](/docs/CHANGELOG.zh-CN.md)。
- **版本号**：自 v2.5.0 起独立递增，不再跟随上游。
- **插件 ID 不变**：仍是 `fast-note-sync`。把本仓库发布的文件覆盖到 `.obsidian/plugins/fast-note-sync` 即可，原有设置和同步记录都会沿用，不需要重新配置。
- **安装与更新**：只在本仓库的 [GitHub Releases](https://github.com/isdoge/obsidian-fast-note-sync/releases) 发布，不上架 Obsidian 社区插件商店。插件内的一键升级从本仓库的 Releases 下载；新版本提示由所连接的服务端下发，搭配本仓库的服务端时指向本仓库。Obsidian 自带的「检查更新」查的是商店里的上游版本，请不要用它来更新本插件。
- **配套服务端**：请搭配同样独立维护的 [isdoge/fast-note-sync-service](https://github.com/isdoge/fast-note-sync-service)（v3.7.0 及以上）。部分修复需要插件和服务端都升级才生效。
- **保持不变**：原作者的版权署名与赞助信息。
- **反馈**：问题和需求请提到本仓库的 [Issues](https://github.com/isdoge/obsidian-fast-note-sync/issues)，不要提到上游仓库。

### 已移除的内容

下面这些在独立维护版里已经移除。**如果你需要其中某一项，请[提 issue](https://github.com/isdoge/obsidian-fast-note-sync/issues/new) 告诉我**，说明使用场景，我会评估是否恢复。

| 已移除 | 说明 | 现在请用 |
| --- | --- | --- |
| 通过 Obsidian 社区插件商店安装 | 本仓库不上架商店；商店里是上游版本（停在 v2.4.0） | 从本仓库 Releases 下载后覆盖安装，之后用插件内的升级功能 |
| 腾讯 `cnb.cool` 镜像仓库与下载源 | 不再同步到 cnb；设置里的「插件更新源」只保留 GitHub，旧设置中的 cnb 取值自动按 GitHub 处理 | GitHub Releases |

### 从上游版本升级

- 从本仓库 Releases 下载 `main.js`、`manifest.json`、`styles.css`（或 zip 包），覆盖 `.obsidian/plugins/fast-note-sync` 里的同名文件，然后重启 Obsidian 或重新启用插件。设置不用改。
- 建议服务端同时升级到 [isdoge/fast-note-sync-service](https://github.com/isdoge/fast-note-sync-service) v3.7.0 及以上。
- **行为变化**：
  - 其它设备删除的文件，现在按 Obsidian 里设置的删除文件处理方式执行（系统回收站 / Obsidian 回收站 `.trash` / 永久删除）。设为永久删除时，远端删除就是永久删除。
  - 只读设备不再向服务端上报本地目录。
  - 「哈希计算数量限制」填 `0` 表示不限制。
  - 升级前已经显示为 1970 年的文件修改时间不会自动更正，只影响显示，文件下次修改后恢复正常。不要用「删除本地文件再重新拉取」来更正：在 Obsidian 里删除会同步到服务端和其它设备。


## ✨ 插件功能

- 🚀 **极简配置**：
    - 无需繁琐设置，只需粘贴远端服务配置即可开箱即用。
    - 也可以在桌面端使用一键导入，自动完成授权。
    - 移动端粘贴配置失败时会说明原因，并可以手动粘贴 JSON。
- 📗 **笔记实时同步**：
    - 自动监听并同步 Vault (仓库) 内所有笔记的创建、更新与删除操作。
    - 其它设备删除的文件按 Obsidian 里设置的删除文件处理方式执行（系统回收站 / Obsidian 回收站 `.trash` / 永久删除），不再直接永久删除。
- 🖼️ **附件全面支持**：
    - 实时同步图片、视频、音频等各类非设置文件。
    > ⚠️ **注意**：需要 v1.0+，服务端 v0.9+。请控制附件文件大小，大文件可能会导致同步延迟。
- ⚙️ **配置同步**：
    - 提供配置同步功能，支持多台设备的配置同步, 告别手动给多端设备拷贝配置文件的痛苦。
    - 支持同步插件子目录中的文本资源（如字典文件）。
    > ⚠️ **注意**：需要 v1.4+，服务端 v1.0+。目前还在测试阶段，请谨慎使用。
- 🛂 **同步排除与白名单**：
    - 提供同步排除与白名单功能，您针同步指定属于你的同步策略。
- 🔄 **多端同步**：
    - 支持 Mac、Windows、Android、iOS 等平台。
- 📝 **笔记历史**：
    - 提供笔记历史功能，您可以查看笔记的所有历史修改详情。
    - 您可以恢复笔记到历史版本。
- 🛡️ **离线笔记编辑自动合并**：
    - 对离线设备的笔记修改，在重新连接服务端时自动合并，避免因只保留最新更新，导致的笔记内容丢失。
- 🚫 **离线删除同步与补全**：
    - 离线期间 笔记、附件、配置 的删除操作，下次连接时将自动同步到服务端或自动从服务端补全。
- 🔍 **版本检测**：
    - 提供版本检测功能，你可以快速的获取 插件端/服务端 最新的版本信息，方便快速升级。
    - 一键升级从本仓库的 GitHub Releases 下载。
- ☁️ **附件云预览**：
    - 提供附件在线预览功能，附件无需同步到本地设备，从而节省本地存储空间。
    > 配合插件的排除设置，可对某类附件直接使用第三方资源库(例如 WebDav)而不通过服务端上传。
- 🗒️ **同步日志**：
    - 提供同步日志功能，便于查看每次同步的详细信息。
- **云存储备份**：提供云存储备份功能，保护您的笔记数据不丢失。

## 🗺️ 路线图 (Roadmap)

路线图沿用原作者的规划。独立维护版会按这份清单逐项推进，完成一项勾选一项。
- [ ] **端到端加密**：提供端到端加密功能，保证您的笔记数据在任何地方保存都是安全的。
- [ ] **AI笔记**：探索 AI+ 笔记相关的创新玩法， 等待您提供宝贵的建议。

> **如果您有改进建议或新想法，欢迎通过提交 issue 与我们分享——我们会认真评估并采纳合适的建议。**

## 💖 赞助与支持

- 本项目由 HaierKeys 创建。如果它对你有帮助，可以通过以下方式支持原作者（款项归原作者，与本仓库的维护无关）：

  | Ko-fi *非中国地区*                                                                               |    | 微信扫码打赏 *中国地区*                        |
  |--------------------------------------------------------------------------------------------------|----|------------------------------------------------|
  | [<img src="/docs/images/kofi.png" alt="BuyMeACoffee" height="150">](https://ko-fi.com/haierkeys) | 或 | <img src="/docs/images/wxds.png" height="150"> |

- 已支持名单：
  - <a href="https://github.com/isdoge/fast-note-sync-service/blob/master/docs/Support.zh-CN.md">Support.zh-CN.md</a>


## 🚀 快速开始

**第一步：获取插件**

* **手动安装：** 从 [GitHub 发布页](https://github.com/isdoge/obsidian-fast-note-sync/releases) 获取 `main.js`, `styles.css`, `manifest.json`，放入 `.obsidian/plugins/fast-note-sync` 文件夹中，然后在 Obsidian 的社区插件列表里启用。
* **已安装上游版本：** 直接用上面三个文件覆盖同名文件即可，设置会沿用。
* 本插件不在 Obsidian 社区插件商店上架，请不要从商店安装。

**第二步：授权同步**

1. 访问您搭建的 **[Fast Note Sync Service](https://github.com/isdoge/fast-note-sync-service)** Web 界面。
2. 在左侧导航栏中选择 **「笔记库」**。
3. 点击 **「一键授权 Obsidian」**，系统会自动唤起 Obsidian 并自动完成传递授权信息，当然你也可以手动复制授权到插件内。

## 📦 服务端部署

后端服务设置，请参考：
- <a href="https://github.com/isdoge/fast-note-sync-service">Fast Note Sync Service</a>
