# 删除与改名重试队列（#176、#48）

本实现只记录插件运行时观察到的笔记、附件和目录删除/改名事件。扫描不生成队列条目；修改、配置同步、手动模式和只读模式沿用原有入口约束。没有新增设置项或用户提示。

## 持久化格式与边界

`${pluginDir}/retryQueue.json` 复用 `LocalStateFileMirror` 的串行写入和 flush，不创建独立的文件写入器。每次队列变更立即发起 flush；写失败沿用镜像设施的日志处理。该设施使用异步 adapter.write，并不提供 fsync 或事务提交保证。

```json
{
  "version": 1,
  "scope": "computeMirrorDigest 的结果",
  "entries": [
    {
      "id": "UUID",
      "objectType": "note",
      "operation": "rename",
      "path": "notes/new.md",
      "oldPath": "notes/old.md",
      "createdAt": 1795000000000,
      "attempts": 0,
      "baselineHash": "入队时 getPathHash(oldPath) 的值"
    }
  ]
}
```

- `objectType` 为 `note`、`file` 或 `folder`；`operation` 为 `delete` 或 `rename`。删除没有 `oldPath`。
- `scope` 与同步状态镜像相同：对规范化的服务地址、远端库名、令牌计算指纹；不保存令牌和正文。运行期间换作用域也会清空队列。
- `baselineHash` 只取同步基线，不用当前文件哈希冒充。取不到为空；目录没有内容基线，留空。
- `attempts` 统计实际写入 socket 的次数；锁忙和未认证不会增加该值。
- 常量限制为 2000 条、7 天；恢复时按入队时间排序，清理过期项和最旧超限项并记录日志。损坏或不兼容格式安全回退为空队列。
- 硬编码排除与首次安装默认排除都包含该文件，白名单不能覆盖硬排除。

## 入队、合并与确认

`EventManager.watchDelete/watchRename` 在认证、路径锁和发送之前将事件交给队列，替代这些事件原来的有限次内存重试。`watchCreate` 在认证前作废同路径旧删除。修改事件继续使用原有重试策略。改名待确认期间触发的修改只在内存中暂缓，改名确认或作废后恢复原有修改处理；不把正文或修改操作写入队列。

尚未发送的条目按以下规则归并，并保留原始基线和入队时间：

| 事件序列 | 队列结果 |
| --- | --- |
| 删除 A，再创建 A | 作废删除 |
| A→B，再 B→C | A→C |
| A→B，再删除 B | 删除 A |
| A→B，再 B→A | 两者作废 |

已经发出的请求可能已修改服务端，不能再当作未发送请求改写。其后继操作串行排在它后面，并继承原始基线；先以 ACK 或只读状态核对结束前项，再核对后项。扩展名变化沿用删除旧类型、创建新类型；跨排除边界沿用删除旧路径或创建新路径的语义。

确认必须匹配对象类型、删除/改名动作、新路径（删除为原路径）。队列不猜测无路径 ACK，也不使用 FIFO 出队。原有操作处理器继续更新待确认表、同步哈希和并发槽位；队列确认不累计扫描完成数、不推进同步时间。重启后回放改名仍用队列基线更新同步哈希，避免把改名后的本地新编辑误标成已同步。

同一连接已经结束或作废的操作会保留 ACK 身份记录，忽略其迟到/重复 ACK。若需要再发出相同类型、动作和路径的另一操作，先经原有断开清理和重连入口换连接，避免旧 ACK 误确认新操作。

## 回放与退避

认证成功后、启动新一轮扫描前，队列全局串行处理；前一项未确认时不发下一项。手动启动同步也先等队列处理。断线清理停止本连接计时、释放队列槽位，等待下次认证；卸载停止计时并 flush。

每次笔记/附件首次发送和超时重发前，都做本地与服务端核对：

- 删除路径本地已存在：作废。
- 改名新路径不存在：作废。旧路径重新出现且内容不同，或无法核对：作废。
- 每次确认超时重发前还核对新路径的文件身份与发送时元数据；期间继续编辑则作废旧改名，内容上传交回常规修改通道。
- 安全核对失败会写入同步日志 `RetryQueueDiscard`；静默策略仍是不重放，常规同步负责拉回无法安全处理的远端内容。
- 服务端源路径内容哈希必须与入队基线相同；无基线、不同、已删除/不存在、查询失败均作废。
- 改名还要求服务端目标不存在，避免覆盖另一设备占用的目标。
- 请求经过原有 `noteDeleteByPath/noteRename`、`fileDeleteByPath/fileRename`、`folderDeleteByPath/folderRename`、并发槽位、待确认表及 `WebSocketManager.SendMessage`。没有独立 socket 发送旁路。
- 锁等待、并发槽位等待和发送缓冲等待期间保留条目身份守卫；作废、换作用域或断线后，旧异步任务不能补发。

实际发送后，未收到确认按 2 秒、5 秒、15 秒、60 秒重发，之后封顶 60 秒。锁忙维持 2 秒重试，受条目保留时间上限约束，没有原先的 60 次放弃条件。

同轮回放过、仍待处理或安全核对失败的路径不会再被扫描作为删除上传。安全核对失败且本地缺失的路径加入现有 `missingNotes/missingFiles/missingFolders` 只读拉取请求，即使开启 `offlineDeleteSyncEnabled` 也不能在同轮重新删除；这也覆盖本地哈希表已经没有该路径的情况。成功扫描后清理本轮去重记录。

## 使用的现有服务端接口

| 对象 | 接口 | 参数与判定 |
| --- | --- | --- |
| 笔记 | `GET /api/note` | `vault`、`path`、`pathHash`、`isRecycle=false`；读取 `data.path/contentHash` |
| 附件 | `GET /api/file/info` | 同上；读取 `data.path/contentHash` |
| 目录 | 无可用内容版本接口 | 不能跨连接、跨重启回放 |

复用 `HttpApiService.request` 的鉴权、运行时地址、重定向检查及网络库；查询超时 10 秒。不调用可能改变服务端状态的 `NoteCheck` 或 `FileUploadCheck`。

本地服务端源码依据：

- `internal/routers/api_router/handler_note.go`：`NoteHandler.Get` 返回 `contentHash`。
- `internal/service/note_service.go`：`noteService.Get`；`internal/dao/note_repository.go`：`GetByPathHashIncludeRecycle` 在 `isRecycle=false` 时过滤删除记录。
- `internal/routers/api_router/handler_file.go`：`FileHandler.Get` 返回哈希，并将已删除附件视为不存在。
- `internal/routers/websocket_router/ws_folder.go`：目录删除、改名确认携带 `path`；目录本身没有内容哈希。目录同步信息和本地快照只有时间/路径，不能证明其内容仍是操作时版本。

目录采用连接期间的降级方案：只重试同一连续已认证连接中观察到的事件，支持锁忙及确认超时重发；离线观察到、断线遗留或从磁盘恢复的目录条目均作废，交给常规同步拉回。要启用目录跨重启回放，需要可核对目录版本的只读接口及相应本地版本基线。本轮不改协议或服务端。

## 现状核对

- 原认证等待每秒一次、600 次后放弃，属实；事件层锁重排最多 60 次也属实。
- 原改名没有走事件层 `runWithDelay` 外层锁：其操作函数内部抢锁失败后直接返回。因此“改名也统一重试 60 次”不准确。
- `WebSocketClient.Send` 非 OPEN 时直接丢弃，属实。
- 删除/改名待确认表只有内存状态，且无确认超时重发，属实。
- “同步开始清掉所有 pending”不完全准确：同步核心修复已保留空闲轮次槽位所属的条目；旧轮次或旧连接的条目仍会被清理。
- `offlineDeleteSyncEnabled=false` 时扫描不上传本地删除，属实；扫描通过缺失路径拉取服务端数据，不能保留用户操作的改名语义。
- 原目录删除/改名在 socket 发送回调就更新快照，没有注册对应 ACK 处理器。本轮为队列所属目录操作补齐确认和槽位处理，非队列调用保留原入口契约。

## 实现定位

| 文件 | 主要新增或修改入口 |
| --- | --- |
| `src/lib/sync/retry_queue.ts` | `RetryQueue.initialize/observe/onLocalCreate`，`safe/localValid/pump`，`sendGuard/onSent/matchesAck/acknowledge`，`onAuthenticated/drainBeforeSync/onDisconnected/stop`，`shouldSkipScanDelete/getRecoveryPaths/completeScan` |
| `src/lib/utils/events_manager.ts` | `watchCreate/watchDelete/watchRename/watchModify/resumeQueuedRename/stop` |
| `src/lib/api/http_api_service.ts` | `HttpApiService.getRetryQueueState` |
| `src/lib/sync/operator_note.ts` | `noteDelete/noteDeleteByPath/noteRename/receiveNoteDeleteAck/receiveNoteRenameAck` |
| `src/lib/sync/operator_file.ts` | `fileDelete/fileDeleteByPath/fileRename/receiveFileDeleteAck/receiveFileRenameAck` |
| `src/lib/sync/operator_folder.ts` | `folderDelete/folderDeleteByPath/folderRename/receiveFolderRetryAck` |
| `src/lib/sync/websocket_manager.ts` | `SendMessage/StartHandle/cleanupDisconnectedSync/handleStructuredMessage` |
| `src/lib/sync/websocket_client.ts` | `SendMessage` 在缓冲等待后再次检查取消守卫 |
| `src/lib/sync/operator.ts` | `handleSync/handleRequestSend/checkSyncCompletion/receiveOperators` |
| `src/lib/utils/helpers.ts` | `configIsPathExcluded` |
| `src/main.ts` | 初始化和卸载队列、`isSyncing` setter 恢复处理、`loadSettings` 默认排除 |

## 测试证据与验证

先落下测试，再实现。最初失败节选：

```text
retry-queue.test.mjs:
Error: ENOENT ... open 'src/lib/sync/retry_queue.ts'

sync-time-mirror-restore.test.mjs:
AssertionError: retryQueue.json 必须被配置同步排除（含白名单开启时）
false !== true

file-rename-ack-match.test.mjs（确认处理修复前）：
AssertionError: retry ACK must not advance sync time
```

新增测试：

- `retry-queue.test.mjs`：离线/非 OPEN/锁忙保留、重构恢复、退避、四项合并、本地/远端核对各分支、串行确认、作用域/损坏/上限/过期、目录降级、已发送改名后继顺序。
- `retry-queue-integration.test.mjs`：真实事件、操作函数、并发槽位、WebSocket 管理器、ACK 分发、文件镜像和扫描发送；旧轮次 ACK、错误响应、缓冲/锁/槽位等待中的作废、恢复改名基线。
- `retry-queue-api.test.mjs`：既有 GET 接口参数、返回结构、缺失/回收站/错误处理。
- 扩充 `file-rename-ack-match.test.mjs` 和 `sync-time-mirror-restore.test.mjs`：精确确认及游标隔离、白名单下硬排除。

最终候选本地验证全部通过：

| 命令 | 结果 |
| --- | --- |
| `node_modules/.bin/tsc -noEmit -skipLibCheck` | 退出码 0 |
| `node esbuild.config.mjs production` | 退出码 0 |
| `node_modules/.bin/eslint src` | 退出码 0，无诊断 |
| 逐个执行 `tests/*.mjs`，失败即退出 | 55 个文件全部通过 |
| `node tests/download-commit.test.cjs` | 10 个场景全部通过 |
| `git diff --check` | 退出码 0 |

未联网、未监听端口、未提交；没有做真实服务端或 Obsidian 端到端测试。

## 剩余边界

GET 核对和删除/改名并非原子条件更新，现有协议没有 compare-and-swap。别的设备恰好在核对完成后、服务端执行前写入同一路径，仍存在竞态；严格消除此窗口需要服务端支持预期版本条件。本轮按要求只使用现有接口。

目录的连接期间重试缺少内容版本保护，也不能排除同一连接期间其它设备重建目录的竞争。跨连接回放保持关闭。目录子项的笔记、附件事件分别走其自身的哈希核对。

缺基线、远端已变、查询失败、目标被占用、过期、超限等情况下，旧操作不会保证送达，文件可能由常规同步拉回；用户可核对后重新删除或改名。磁盘写入失败或进程在异步写入完成前退出，仍可能丢失尚未落盘的新事件。
