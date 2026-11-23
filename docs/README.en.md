[简体中文](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/README.md) / [English](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.en.md) / [日本語](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.ja.md) / [한국어](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.ko.md) / [繁體中文](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.zh-TW.md)

> [!IMPORTANT]
> **This repository is an independently maintained fix edition.** Upstream [haierkeys/obsidian-fast-note-sync](https://github.com/haierkeys/obsidian-fast-note-sync) has not been updated since August 2026. Forked by [isdoge](https://github.com/isdoge) from upstream v2.4.0, this repository merges backlogged upstream PRs and fixes known issues, and evolves independently from here on—its version numbers no longer track upstream. **Do not install or update this plugin through the Obsidian Community Plugins store**, which only serves the upstream release. See "About This Repository" below for details.

If you have questions or feature requests, please open an [issue](https://github.com/isdoge/obsidian-fast-note-sync/issues/new) in this repository.




<h1 align="center">Fast Note Sync For Obsidian</h1>

<p align="center">
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/releases"><img src="https://img.shields.io/github/release/isdoge/obsidian-fast-note-sync?style=flat-square" alt="release"></a>
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/releases"><img src="https://img.shields.io/github/v/tag/isdoge/obsidian-fast-note-sync?label=release-alpha&style=flat-square" alt="alpha-release"></a>
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/blob/master/LICENSE"><img src="https://img.shields.io/github/license/isdoge/obsidian-fast-note-sync?style=flat-square" alt="license"></a>
    <img src="https://img.shields.io/badge/Language-TypeScript-00ADD8?style=flat-square" alt="TypeScript">
</p>



<p align="center">
  <strong>Fast multi-device sync, automatic backup, trackable version history, and shareable collaboration note sync plugin for Obsidian</strong>
  <br>
  <em>Sync your notes in real-time across multiple devices (PC, mobile, web) anytime, anywhere. One-click generation of sharing links to share with friends, easily trace modification history or restore trash bin contents; also supports backup, mirroring, and Git synchronization. With the REST/MCP services of Fast Note Sync Service, you can quickly build your own personal knowledge base.</em>
</p>

<p align="center">
  Requires a standalone server: <a href="https://github.com/isdoge/fast-note-sync-service">Fast Note Sync Service</a>
</p>

<div align="center">
    <img src="/docs/images/demo.gif" alt="fast-note-sync-service-preview" width="800" />
</div>


## 📌 About This Repository

This repository is an independently maintained edition of [haierkeys/obsidian-fast-note-sync](https://github.com/haierkeys/obsidian-fast-note-sync), maintained by [isdoge](https://github.com/isdoge). Thanks to the original author HaierKeys for creating this project.

- **Origin**: Forked from upstream v2.4.0 with 18 pending upstream PRs merged and a batch of known bugs fixed. See the [changelog (Chinese)](/docs/CHANGELOG.zh-CN.md) for the full list.
- **Versioning**: Incremented independently starting from v2.5.0 and no longer tracks upstream.
- **Plugin ID Unchanged**: Remains `fast-note-sync`. Overwrite the files in `.obsidian/plugins/fast-note-sync` with the releases from this repository and all existing settings and sync state will carry over—no reconfiguration needed.
- **Installation & Updates**: Distributed exclusively via [GitHub Releases](https://github.com/isdoge/obsidian-fast-note-sync/releases) in this repository and not listed on the Obsidian Community Plugins store. One-click upgrades inside the plugin download from this repository's Releases; new-version notifications are pushed by the connected server and point to this repository when paired with this repository's server. Obsidian's built-in "Check for updates" checks the upstream version in the store—do not use it to update this plugin.
- **Companion Server**: Use alongside the independently maintained [isdoge/fast-note-sync-service](https://github.com/isdoge/fast-note-sync-service). Basic sync requires server v3.7.0 or later; the full sync-baseline protocol requires v3.8.4 or later; the Firefly blog auto-publish assistant requires v3.8.5 or later; token permission notices require v3.8.8 or later. Some fixes take effect only when both the plugin and the server are updated.
- **Preserved**: Original author credits and sponsorship links remain unchanged.
- **Feedback**: Please report issues and feature requests in this repository's [Issues](https://github.com/isdoge/obsidian-fast-note-sync/issues), not in the upstream repository.

### What Has Been Removed

The following items have been removed in this independently maintained edition. **If you rely on any of them, please [open an issue](https://github.com/isdoge/obsidian-fast-note-sync/issues/new) to let me know** your use case, and I'll consider bringing it back.

| Removed | Notes | What to Use Instead |
| --- | --- | --- |
| Installing via the Obsidian Community Plugins store | This edition is not listed on the store; the store carries the upstream version (stopped at v2.4.0) | Download from this repository's Releases to overwrite-install, then use the plugin's built-in upgrade |
| Tencent `cnb.cool` mirror repo and download source | No longer synced to cnb; only GitHub remains under "Plugin Update Source" in settings, and legacy cnb values automatically fall back to GitHub | GitHub Releases |

### Upgrading from Upstream

- Download `main.js`, `manifest.json`, and `styles.css` (or the zip archive) from this repository's Releases, overwrite the matching files in `.obsidian/plugins/fast-note-sync`, then restart Obsidian or toggle the plugin off and on. Your settings require no changes.
- Upgrading the server to [isdoge/fast-note-sync-service](https://github.com/isdoge/fast-note-sync-service) v3.7.0 or later at the same time is recommended.
- **Behavior Changes**:
  - Files deleted on other devices now follow Obsidian's deleted-file handling setting (system trash / Obsidian trash `.trash` / permanent deletion). When set to permanent deletion, remote deletions permanently delete the file.
  - Read-only devices no longer report local directories to the server.
  - Setting "Hash calculation limit" to `0` means no limit.
  - File modification times already showing 1970 prior to upgrading are not corrected retroactively; this only affects display, and timestamps return to normal on the next modification. Do not try to fix this by deleting local files and re-pulling—deletions in Obsidian sync to the server and other devices.


## ✨ Features

- 🚀 **Minimalist Configuration**:
    - No tedious setup required, just paste the remote service configuration to start using it out of the box.
    - Can also use one-click import on the desktop app to automatically complete authorization.
    - Explains the cause when pasting configuration fails on mobile, and allows pasting JSON manually.
- 📗 **Real-time Note Sync**:
    - Automatically monitors and syncs the creation, update, and deletion of all notes inside the Vault (repository).
    - Files deleted on other devices follow Obsidian's deleted-file handling setting (system trash / Obsidian trash `.trash` / permanent deletion) instead of being permanently deleted directly.
- 🖼️ **Full Attachment Support**:
    - Syncs images, videos, audio, and all other non-configuration files in real-time.
    > ⚠️ **Note**: Requires v1.0+, Server v0.9+. Please manage attachment file sizes; large files may cause synchronization delays.
- ⚙️ **Configuration Sync**:
    - Provides configuration sync, supporting config synchronization across multiple devices. Say goodbye to the pain of manually copying configuration files to multiple devices.
    - Supports syncing text assets in plugin subdirectories (such as dictionary files).
    > ⚠️ **Note**: Requires v1.4+, Server v1.0+. Currently in the testing phase, please use with caution.
- 🛂 **Sync Exclusions & Whitelist**:
    - Provides sync exclusion and whitelist functions, allowing you to customize your own sync strategies.
    - Skips system junk files by default (`.DS_Store`, `Thumbs.db`, `desktop.ini`, and files beginning with `._`). Add them to the whitelist if you need to sync them.
- 🔄 **Multi-device Sync**:
    - Supports Mac, Windows, Android, iOS, and other platforms.
    - Sync state has a file mirror, allowing it to be restored if the system clears mobile local storage, without falling back to a full sync.
    - Deletions and renames not delivered before a disconnect or restart are retried after reconnection; server content is checked before retrying, and the operation is abandoned if it does not match to avoid deleting newer content from other devices.
- 📝 **Note History**:
    - Provides note history functionality, letting you view detailed historical modification records of your notes.
    - You can restore notes to historical versions.
- 🛡️ **Offline Note Editing Auto-Merge**:
    - Automatically merges note modifications made on offline devices when reconnecting to the server, avoiding data loss caused by keeping only the latest update.
- 🚫 **Offline Deletion Sync & Completion**:
    - Deletions of notes, attachments, and configurations during offline periods will be automatically synced to the server or completed from the server upon the next connection.
- 🔍 **Version Detection**:
    - Provides version detection functionality, allowing you to quickly get the latest version info of the plugin and the server for easy upgrading.
    - One-click upgrades download from this repository's GitHub Releases.
- ☁️ **Cloud Preview of Attachments**:
    - Provides online attachment preview, meaning attachments do not need to be synced to the local device, thereby saving local storage space.
    - "Delete After Upload" compares local files with the complete server content before cleaning them up; files are kept locally if they do not match.
    > Combined with the plugin's exclusion settings, you can directly use a third-party repository (like WebDav) for certain types of attachments without uploading via the server.
- 🗒️ **Sync Logs**:
    - Provides sync log functionality, making it easy to view detailed information for each synchronization.
- 🌐 **Astro Firefly Blog Writing & Auto-Publish Assistant**:
    - Validates post frontmatter, converges images into the note's `./assets/` and rewrites references, runs pre-publish checks, and triggers the server-side Git/Firefly build with a live build receipt.
    > ⚠️ **Note**: Requires server v3.8.5+ for auto-publish, and a Firefly Git-sync target configured on the server.
- 🧬 **Sync Baseline Protocol, Conflict Alignment & Batch Handling**:
    - Every write is verified against a server-issued revision token. Conflicts carry the exact remote version, are listed in one panel, and can be resolved in bulk (local / remote / keep both); binary settings and attachments are transferred and restored byte-exactly.
    > ⚠️ **Note**: The full baseline protocol requires server v3.8.4+; older servers fall back to compatibility mode automatically.
- 🔒 **Read-only / Manual Sync Modes & Sync Protection**:
    - Switch "Read-only Sync Mode" and "Manual Sync Mode" with one click from the command palette or status bar menu and see the current mode. These switches only affect this device and do not change the server token's permissions.
    - Automatically checks the token's actual permissions and explains why when the token is read-only, lacks some write permissions, or does not allow access to the current vault.
    - "Mass file disappearance" protection: if a full scan finds that most synced files are missing locally (for example, the vault folder was moved or a disk is not mounted), deletions are not reported to the server for that round and a notice appears.
    > ⚠️ **Note**: Token permission notices require server v3.8.8+. Read-only devices follow the server: when another device deletes a file, the file with the same name on this device is also deleted, even if it has changes that have not been uploaded.
- 🧹 **Automatic Debug Log Redaction**:
    - Debug logs automatically hide tokens, passwords, note contents, local paths, system usernames, server addresses, and vault names when recorded and copied, so you can paste them directly when reporting issues.
- **Cloud Backup**: Provides cloud backup functionality to protect your note data from being lost.

### Recovery of remotely deleted files

Server-requested deletions of notes, attachments and empty folders, and existing targets displaced by a remote rename, follow Obsidian's "Deleted files" preference (system trash, the vault's `.trash` folder, or permanent deletion). Configuration files are not vault items and always go to the vault's local `.trash` directory. If moving an item to trash fails, the operation reports an error and does not fall back to permanent deletion.

The `.trash` directory is excluded from synchronization, including whitelist rules. Recovery copies remain local to that device; restore them manually with your file manager. This does not change temporary-chunk cleanup or the optional cloud-preview feature that removes local attachments after upload.

## 🗺️ Roadmap

The roadmap follows the original author's plan. This independently maintained edition will work through this list item by item, checking off each as it is completed.
- [ ] **End-to-End Encryption**: Provide end-to-end encryption to ensure your note data is safe wherever it is stored.
- [ ] **AI Notes**: Explore innovative ways to use AI with notes, awaiting your valuable suggestions.

> **If you have improvement suggestions or new ideas, feel free to share them with us by submitting an issue — we will carefully evaluate and adopt suitable suggestions.**

## 💖 Sponsorship & Support

- This project was created by HaierKeys. If you find it helpful, you can support the original author through the channels below (all proceeds go to the original author and are unrelated to the maintenance of this repository):

  | Ko-fi *Non-China Region*                                                                         |    | WeChat Pay *China Region*                      |
  |--------------------------------------------------------------------------------------------------|----|------------------------------------------------|
  | [<img src="/docs/images/kofi.png" alt="BuyMeACoffee" height="150">](https://ko-fi.com/haierkeys) | or | <img src="/docs/images/wxds.png" height="150"> |

- Supported List:
  - <a href="https://github.com/isdoge/fast-note-sync-service/blob/master/docs/Support.en.md">Support.en.md</a>


## 🚀 Quick Start

**Step 1: Get the Plugin**

* **Manual Installation:** Download `main.js`, `styles.css`, and `manifest.json` from the [GitHub Releases Page](https://github.com/isdoge/obsidian-fast-note-sync/releases), place them in the `.obsidian/plugins/fast-note-sync` folder, and enable the plugin in Obsidian's Community Plugins list.
* **Already on Upstream:** Overwrite the existing files with the three files above; your settings will carry over.
* This plugin is not listed on the Obsidian Community Plugins store—please do not install it from the store.

**Step 2: Authorize Sync**

1. Access the Web interface of your deployed **[Fast Note Sync Service](https://github.com/isdoge/fast-note-sync-service)**.
2. Select **"Note Vaults"** from the left navigation bar.
3. Click **"One-click Authorization for Obsidian"**. The system will automatically wake up Obsidian and complete the transfer of authorization information. Of course, you can also manually copy the authorization information into the plugin.

## 📦 Server Deployment

For backend service settings, please refer to:
- <a href="https://github.com/isdoge/fast-note-sync-service">Fast Note Sync Service</a>
