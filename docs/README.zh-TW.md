[简体中文](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/README.md) / [English](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.en.md) / [日本語](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.ja.md) / [한국어](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.ko.md) / [繁體中文](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.zh-TW.md)

> [!IMPORTANT]
> **本儲存庫是獨立維護的修復版。** 上游 [haierkeys/obsidian-fast-note-sync](https://github.com/haierkeys/obsidian-fast-note-sync) 自 2026 年 8 月起未再更新。本儲存庫由 [isdoge](https://github.com/isdoge) 從上游 v2.4.0 分支而出，合併了上游積壓的 PR 並修復已知問題，之後獨立演進，版本號不再跟隨上游。**請不要透過 Obsidian 社群外掛商店安裝或更新**，商店裡仍是上游版本。詳見下方「關於本儲存庫」。

若有問題或需求，請在本儲存庫建立 [issue](https://github.com/isdoge/obsidian-fast-note-sync/issues/new)。




<h1 align="center">Fast Note Sync For Obsidian</h1>

<p align="center">
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/releases"><img src="https://img.shields.io/github/release/isdoge/obsidian-fast-note-sync?style=flat-square" alt="release"></a>
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/releases"><img src="https://img.shields.io/github/v/tag/isdoge/obsidian-fast-note-sync?label=release-alpha&style=flat-square" alt="alpha-release"></a>
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/blob/master/LICENSE"><img src="https://img.shields.io/github/license/isdoge/obsidian-fast-note-sync?style=flat-square" alt="license"></a>
    <img src="https://img.shields.io/badge/Language-TypeScript-00ADD8?style=flat-square" alt="TypeScript">
</p>



<p align="center">
  <strong>快速多端同步、自動備份、版本可追溯，可分享協作的 Obsidian 筆記同步插件</strong>
  <br>
  <em>隨時隨地，多端即時同步你的筆記（電腦、手機、網頁）。一鍵生成分享連結與好友共用，輕鬆回溯修改歷史或恢復回收站內容；還支持備份、鏡像與 Git 同步。借助 Fast Note Sync Service 的 REST/MCP 服務，你可以快速搭建屬於自己的個人知識庫。</em>
</p>

<p align="center">
  需配合獨立服務端使用：<a href="https://github.com/isdoge/fast-note-sync-service">Fast Note Sync Service</a>
</p>

<div align="center">
    <img src="/docs/images/demo.gif" alt="fast-note-sync-service-preview" width="800" />
</div>


## 📌 關於本儲存庫

本儲存庫是 [haierkeys/obsidian-fast-note-sync](https://github.com/haierkeys/obsidian-fast-note-sync) 的獨立維護版本，維護者為 [isdoge](https://github.com/isdoge)。感謝原作者 HaierKeys 建立了這個專案。

- **來源**：從上游 v2.4.0 分支而出，合併了上游當時尚未處理的 18 個 PR，並修復了一批已知問題。完整清單見[更新日誌（簡體中文）](/docs/CHANGELOG.zh-CN.md)。
- **版本號**：自 v2.5.0 起獨立遞增，不再跟隨上游。
- **外掛 ID 不變**：仍是 `fast-note-sync`。將本儲存庫發佈的檔案覆蓋到 `.obsidian/plugins/fast-note-sync` 即可，原有設定與同步紀錄都會沿用，不需要重新設定。
- **安裝與更新**：僅在本儲存庫的 [GitHub Releases](https://github.com/isdoge/obsidian-fast-note-sync/releases) 發佈，不上架 Obsidian 社群外掛商店。外掛內的一鍵升級從本儲存庫的 Releases 下載；新版本提示由所連接的服務端下發，搭配本儲存庫的服務端時指向本儲存庫。Obsidian 內建的「檢查更新」查詢的是商店裡的上游版本，請不要用它來更新本外掛。
- **搭配服務端**：請搭配同樣獨立維護的 [isdoge/fast-note-sync-service](https://github.com/isdoge/fast-note-sync-service)。基礎同步需服務端 v3.7.0 及以上；完整同步基線協定需 v3.8.4 及以上；Firefly 部落格自動發佈需 v3.8.5 及以上；權杖權限提示需 v3.8.8 及以上。部分修復需要外掛與服務端同時升級才會生效。
- **保持不變**：原作者的版權署名與贊助資訊。
- **回饋**：問題與需求請提交到本儲存庫的 [Issues](https://github.com/isdoge/obsidian-fast-note-sync/issues)，不要提交到上游儲存庫。

### 已移除的內容

以下項目在獨立維護版中已經移除。**如果你需要其中某一項，請[提 issue](https://github.com/isdoge/obsidian-fast-note-sync/issues/new) 告訴我**，說明使用情境，我會評估是否恢復。

| 已移除 | 說明 | 現在請改用 |
| --- | --- | --- |
| 透過 Obsidian 社群外掛商店安裝 | 本儲存庫不上架商店；商店裡是上游版本（停在 v2.4.0） | 從本儲存庫 Releases 下載後覆蓋安裝，之後使用外掛內的升級功能 |
| 騰訊 `cnb.cool` 鏡像儲存庫與下載來源 | 不再同步到 cnb；設定中的「外掛更新來源」只保留 GitHub，舊設定中的 cnb 數值會自動改走 GitHub | GitHub Releases |

### 從上游版本升級

- 從本儲存庫 Releases 下載 `main.js`、`manifest.json`、`styles.css`（或 zip 壓縮檔），覆蓋 `.obsidian/plugins/fast-note-sync` 裡的同名檔案，然後重新啟動 Obsidian 或重新啟用外掛。設定不需變更。
- 建議服務端同步升級至 [isdoge/fast-note-sync-service](https://github.com/isdoge/fast-note-sync-service) v3.7.0 及以上。
- **行為變化**：
  - 其他裝置刪除的檔案，現在依 Obsidian 裡設定的刪除檔案處理方式執行（系統資源回收筒 / Obsidian 資源回收筒 `.trash` / 永久刪除）。設為永久刪除時，遠端刪除就是永久刪除。
  - 唯讀裝置不再向服務端上報本地目錄。
  - 「雜湊計算數量限制」填入 `0` 表示不限制。
  - 升級前已經顯示為 1970 年的檔案修改時間不會自動更正，僅影響顯示，檔案下次修改後就會恢復正常。請勿以「刪除本地檔案再重新拉取」的方式來更正：在 Obsidian 中刪除會同步到服務端與其他裝置。


## ✨ 插件功能

- 🚀 **極簡配置**：
    - 無需繁瑣設置，只需粘貼遠端服務配置即可開箱即用。
    - 也可以在桌面端使用一鍵導入，自動完成授權。
    - 行動端貼上設定失敗時會說明原因，並可手動貼上 JSON。
- 📗 **筆記即時同步**：
    - 自動監聽並同步 Vault (倉庫) 內所有筆記的創建、更新與刪除操作。
    - 其他裝置刪除的檔案依 Obsidian 裡設定的刪除檔案處理方式執行（系統資源回收筒 / Obsidian 資源回收筒 `.trash` / 永久刪除），不再直接永久刪除。
- 🖼️ **附件全面支持**：
    - 即時同步圖片、視頻、音頻等各類非設置文件。
    > ⚠️ **注意**：需要 v1.0+，服務端 v0.9+。請控制附件文件大小，大文件可能會導致同步延遲。
- ⚙️ **配置同步**：
    - 提供配置同步功能，支持多台設備的配置同步，告別手動給多端設備拷貝配置文件的痛苦。
    - 支援同步外掛子目錄中的文字資源（例如字典檔）。
    > ⚠️ **注意**：需要 v1.4+，服務端 v1.0+。目前還在測試階段，請謹慎使用。
- 🛂 **同步排除與白名單**：
    - 提供同步排除與白名單功能，您可以指定屬於您的同步策略。
    - 預設略過系統垃圾檔案（`.DS_Store`、`Thumbs.db`、`desktop.ini`、`._` 開頭的檔案），確需同步時可加入白名單放行。
- 🔄 **多端同步**：
    - 支持 Mac、Windows、Android、iOS 等平台。
    - 同步狀態會保存檔案鏡像，行動端本機儲存被系統清理後可以從鏡像復原，不會退化成全量同步。
    - 斷線或重新啟動前尚未送達的刪除、重新命名會在重新連線後補發；補發前核對服務端內容，不一致就放棄，避免誤刪其他裝置上的新內容。
- 📝 **筆記歷史**：
    - 提供筆記歷史功能，您可以查看筆記的所有歷史修改詳情。
    - 您可以恢復筆記到歷史版本。
- 🛡️ **離線筆記編輯自動合併**：
    - 對離线設備的筆記修改，在重新連接服務端時自動合併，避免因只保留最新更新，導致的筆記內容丟失。
- 🚫 **離線刪除同步與補全**：
    - 離線期間 筆記、附件、配置 的刪除操作，下次連接時將自動同步到服務端或自動從服務端補全。
- 🔍 **版本檢測**：
    - 提供版本檢測功能，你可以快速地獲取 插件端/服務端 最新的版本資訊，方便快速升級。
    - 一鍵升級從本儲存庫的 GitHub Releases 下載。
- ☁️ **附件雲預覽**：
    - 提供附件線上預覽功能，附件無需同步到本地設備，從而節省本地存儲空間。
    - 「上傳後刪除」在清理本地檔案前，會先與服務端上的內容完整比對，對不上就保留本地檔案。
    > 配合外掛的排除設置，可對某類附件直接使用第三方資源庫（例如 WebDav）而不通過服務端上傳。
- 🗒️ **同步日誌**：
    - 提供同步日誌功能，便於查看每次同步的詳細資訊。
    - 「複製同步診斷」可一鍵複製最近幾輪同步的概況與失敗、衝突記錄（包含檔案路徑，不含伺服器位址與權杖），不用開啟偵錯日誌也有記錄，方便反饋問題。
- 🌐 **Astro Firefly 部落格寫作與自動發佈助手**：
    - 校驗文章 frontmatter、把圖片彙整並規範到筆記同目錄的 `./assets/` 並改寫引用、發佈前合規檢查，並可一鍵觸發服務端 Git/Firefly 建置、即時顯示建置回執。
    > ⚠️ **注意**：自動發佈需服務端 v3.8.5+，且服務端已設定 Firefly 的 Git 同步目標。
- 🧬 **同步基線協定、衝突對齊與批次處理**：
    - 每次寫入都帶服務端簽發的版本權杖核對；衝突會附帶準確的遠端版本，在統一面板中列出並支援批次解決（本地 / 遠端 / 保留雙份），二進位設定與附件逐位元組零損傳輸與還原。
    > ⚠️ **注意**：完整基線協定需服務端 v3.8.4+；舊服務端會自動退回相容模式。
- 🔒 **唯讀 / 手動同步模式與同步保護**：
    - 命令面板與狀態列選單可一鍵切換「唯讀同步模式」「手動同步模式」，並顯示目前模式；開關只影響本裝置，不改變服務端權杖的權限。
    - 自動檢查權杖的實際權限：權杖唯讀、缺少部分寫入權限或目前庫不在允許範圍內時直接提示原因。
    - 「大批檔案消失」保護：全量掃描發現絕大部分已同步檔案在本機找不到時（例如庫目錄被搬走、磁碟未掛載），本輪不向服務端上報刪除並彈出提示。
    > ⚠️ **注意**：權杖權限提示需服務端 v3.8.8+。唯讀裝置以服務端為準：其他裝置刪除某個檔案後，本機的同名檔案會一併刪除，即使它有尚未上傳的修改。
- 🧹 **偵錯日誌自動脫敏**：
    - 偵錯日誌在記錄與複製時自動隱藏權杖、密碼、筆記正文，以及本機路徑、系統使用者名稱、伺服器位址與庫名，回報問題時可以直接貼上。
- **雲存儲備份**：提供雲存儲備份功能，保護您的筆記數據不丟失。

## 🗺️ 路線圖 (Roadmap)

路線圖沿用原作者的規劃。獨立維護版會按這份清單逐項推進，完成一項勾選一項。
- [ ] **端到端加密**：提供端到端加密功能，保證您的筆記數據在任何地方保存都是安全的。
- [ ] **AI筆記**：探索 AI+ 筆記相關的創新玩法，等待您提供寶貴的建議。

> **如果您有改進建議或新想法，歡迎通過提交 issue 與我们分享——我們會認真評估並採納合適的建議。**

## 💖 贊助與支持

- 本專案由 HaierKeys 建立。如果它對你有幫助，可以透過以下方式支持原作者（款項歸原作者，與本儲存庫的維護無關）：

  | Ko-fi *非中國地區*                                                                               |    | 微信掃碼打賞 *中國地區*                        |
  |--------------------------------------------------------------------------------------------------|----|------------------------------------------------|
  | [<img src="/docs/images/kofi.png" alt="BuyMeACoffee" height="150">](https://ko-fi.com/haierkeys) | 或 | <img src="/docs/images/wxds.png" height="150"> |

- 已支持名單：
  - <a href="https://github.com/isdoge/fast-note-sync-service/blob/master/docs/Support.zh-TW.md">Support.zh-TW.md</a>


## 🚀 快速開始

**第一步：獲取插件**

* **手動安裝：** 從 [GitHub 發佈頁](https://github.com/isdoge/obsidian-fast-note-sync/releases) 取得 `main.js`、`styles.css`、`manifest.json`，放入 `.obsidian/plugins/fast-note-sync` 資料夾中，然後在 Obsidian 的社群外掛清單中啟用。
* **已安裝上游版本：** 直接用上面三個檔案覆蓋同名檔案即可，設定會沿用。
* 本外掛不上架 Obsidian 社群外掛商店，請不要從商店安裝。

**第二步：授權同步**

1. 訪問您搭建的 **[Fast Note Sync Service](https://github.com/isdoge/fast-note-sync-service)** Web 界面。
2. 在左側導航欄中選擇 **「筆記庫」**。
3. 點擊 **「一鍵授權 Obsidian」**，系統會自動喚起 Obsidian 並自動完成傳遞授權信息，當然你也可以手動複製授權到插件內。

## 📦 服務端部署

後端服務設置，請參考：
- <a href="https://github.com/isdoge/fast-note-sync-service">Fast Note Sync Service</a>
