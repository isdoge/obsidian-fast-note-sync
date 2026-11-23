/**
 * 大批消失护栏（Fail-Closed）。
 * Mass-disappearance guard (fail-closed).
 *
 * 全量/增量扫描会用本地 Vault 与基线哈希表做对比：基线里有、本地没有的路径会被推断为
 * "用户已离线删除"，并在 offlineDeleteSyncEnabled 打开时上报服务端删除。若本地 Vault 因
 * 挂载失败、目录未加载完成、误移库等原因暂时为空或大面积缺失，这套推断会把远端数据也删掉。
 *
 * Full/incremental scans diff the local vault against the baseline hash map: paths present in
 * the baseline but missing locally are inferred as "deleted offline" and reported to the server
 * as deletes when offlineDeleteSyncEnabled is on. If the local vault is temporarily empty or
 * mostly missing (mount failure, directory not loaded yet, moved vault, ...), that inference
 * would delete the remote copies too.
 *
 * 本模块只做纯判定：输入"已确认基线条目数"与"其中本次推断为本地缺失、准备上报删除的数量"，
 * 输出是否必须中止本轮删除上报。调用方负责清空待上报删除清单、冻结同步游标、写日志和通知。
 *
 * This module is a pure decision function: given the number of server-confirmed baseline entries
 * and how many of them are inferred missing and queued for remote deletion, it decides whether
 * the round's delete reporting must be aborted. The caller clears the pending delete lists,
 * freezes the sync cursors, and writes the log / notice.
 *
 * 注意 / Notes:
 * - 用户主动逐条触发的删除事件不经过扫描清单，因此不会调用本护栏，也不会被阻断。
 *   User-triggered per-item deletes do not go through the scan list, so they never call this
 *   guard and are never blocked.
 * - 首次同步、空基线、小库（确认基线数低于阈值）不会触发。
 *   First sync, empty baseline, and small vaults (confirmed baseline below the threshold) never
 *   trigger it.
 */

/** 触发护栏所需的最少已确认基线条目数 / Minimum confirmed baseline entries required to trigger */
export const MASS_DELETE_GUARD_MIN_BASELINE = 100;

/**
 * 触发护栏所需的缺失占比下限（严格大于）。
 * 恰好 80%（例如 100 条里缺 80 条）不会触发，避免边界抖动。
 * Minimum missing ratio required to trigger (strictly greater). Exactly 80% (e.g. 80 of 100)
 * does not trigger, avoiding boundary flapping.
 */
export const MASS_DELETE_GUARD_MISSING_RATIO = 0.8;

export interface MassDeleteGuardInput {
  /** 本轮参与判定的已确认基线条目总数 / Total server-confirmed baseline entries in scope */
  confirmedBaselineCount: number;
  /** 其中本次被推断为本地缺失、准备上报删除的数量 / Of those, inferred missing and queued for delete */
  pendingDeleteCount: number;
  /** 覆盖默认最小基线数（测试用）/ Override the minimum baseline count (tests) */
  minBaselineCount?: number;
  /** 覆盖默认缺失占比（测试用）/ Override the missing ratio threshold (tests) */
  missingRatio?: number;
}

export interface MassDeleteGuardVerdict {
  /** 是否必须中止本轮删除上报 / Whether this round's delete reporting must be aborted */
  triggered: boolean;
  /** 规范化后的已确认基线总数 / Normalized confirmed baseline count */
  confirmedBaselineCount: number;
  /** 规范化后的待删除数量 / Normalized pending delete count */
  pendingDeleteCount: number;
  /** 规范化后的缺失占比 / Normalized missing ratio */
  missingRatio: number;
  /** 实际生效的最小基线数 / Effective minimum baseline count */
  minBaselineCount: number;
  /** 实际生效的缺失占比阈值 / Effective missing ratio threshold */
  ratioThreshold: number;
}

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function toRatio(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * 判定是否触发大批消失护栏。纯函数，不读取任何全局状态。
 * Decide whether the mass-disappearance guard triggers. Pure function, no global state.
 */
export function evaluateMassDeleteGuard(input: MassDeleteGuardInput): MassDeleteGuardVerdict {
  const confirmedBaselineCount = toCount(input.confirmedBaselineCount);
  // 待删除数不可能超过基线总数；超出按基线总数截断，避免占比失真。
  // Pending deletes can never exceed the baseline total; clamp to keep the ratio meaningful.
  const pendingDeleteCount = Math.min(confirmedBaselineCount, toCount(input.pendingDeleteCount));
  const minBaselineCount = toCount(input.minBaselineCount ?? MASS_DELETE_GUARD_MIN_BASELINE);
  const ratioThreshold = toRatio(input.missingRatio, MASS_DELETE_GUARD_MISSING_RATIO);
  const missingRatio = confirmedBaselineCount > 0 ? pendingDeleteCount / confirmedBaselineCount : 0;
  const triggered = confirmedBaselineCount >= minBaselineCount
    && minBaselineCount > 0
    && missingRatio > ratioThreshold;

  return {
    triggered,
    confirmedBaselineCount,
    pendingDeleteCount,
    missingRatio,
    minBaselineCount,
    ratioThreshold,
  };
}
