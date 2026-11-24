import { dumpError } from "../utils/helpers";
import type FastSync from "../../main";

/**
 * 作用域变化后的冲突记录清理调度器。
 *
 * 三个存储管理器（笔记/配置/文件夹）在远端目标变化时要清掉旧目标的冲突记录。它们是底层
 * 存储模块，不能静态依赖 conflict_store（会形成循环依赖），过去只能 fire-and-forget 地
 * 动态导入——同步进行中旧目标的清理可能和新目标的冲突写入交错，失败也没人知道。
 *
 * 这里把清理登记成插件上的待执行 Promise：写入新冲突前、每轮同步开始时都会先 await 它；
 * 失败则保留 `conflictResetFailed`，由下一轮同步重试。
 *
 * Scheduler for conflict-record cleanup after a remote-scope change.
 *
 * The three storage managers (note/config/folder) must clear old-target conflict records when
 * the remote target changes. As low-level storage modules they cannot statically depend on
 * conflict_store (that would be a cycle), so they used a fire-and-forget dynamic import — old
 * cleanup could interleave with new conflict writes during a sync, and failures went unnoticed.
 *
 * Cleanup is registered as a pending promise on the plugin. New conflict writes and every sync
 * round await it first; a failure keeps `conflictResetFailed` set so the next round retries.
 */
export function scheduleConflictRecordReset(plugin: FastSync, reason: string): void {
    const run = (): Promise<void> =>
        import("./conflict_store")
            .then(({ resetConflictRecords }) => resetConflictRecords(plugin))
            .then((ok) => {
                if (!ok) {
                    plugin.conflictResetFailed = true;
                    dumpError(`[Conflict] Conflict records were not fully cleared (${reason}); will retry at the next sync round`);
                }
            })
            .catch((error) => {
                plugin.conflictResetFailed = true;
                dumpError(`[Conflict] Unable to load the conflict store to clear records (${reason}); will retry at the next sync round`, error);
            });

    const previous = plugin.pendingConflictReset;
    plugin.conflictResetFailed = false;
    // 多次作用域变化按顺序执行；前一次失败也继续链下去，失败状态由标志表达
    // Serialize multiple scope changes; a failed previous run must not break the chain — the
    // failure is reported through the flag instead
    const next = previous ? previous.then(run, run) : run();
    plugin.pendingConflictReset = next;
    // 调用方不阻塞；下一轮同步开始 / 写入新冲突前通过 awaitPendingConflictReset 等待
    // Callers are never blocked; the next sync round / conflict write awaits it explicitly
    void next;
}
