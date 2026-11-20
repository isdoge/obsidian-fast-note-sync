/**
 * Firefly / Git 同步回执本地化。
 * Localize the server's English Git-sync receipts for the UI.
 *
 * 服务端回执仍是英文（例如 `Sync completed at 2026-11-20 10:00:00`）。这里按行识别
 * 已知的回执形态并交给当前插件语言输出，未知行原样保留，避免把构建日志吞掉。
 *
 * Pure module: no Obsidian/i18n imports, so it is directly unit-testable from Node (.mjs).
 * The caller injects the current translator.
 */

export type ReceiptTranslator = (key: string, params?: Record<string, unknown>) => string

function trimDetail(value: string | undefined): string {
  return String(value ?? "").trim().replace(/^[:：\s]+/, "").trim()
}

function translateLine(line: string, tr: ReceiptTranslator): string {
  if (!line) return line

  const completed = /^sync completed at\s+(.+)$/i.exec(line)
  if (completed) {
    return tr("ui.firefly.receipt_sync_completed", { time: completed[1].trim() })
  }

  const skipped = /^(?:skipped\s+)?(\d+)\s+invalid post\(s\)(?:\s+skipped)?(?:\s*[:：-]\s*(.*))?$/i.exec(line)
  if (skipped) {
    const count = Number(skipped[1])
    const detail = trimDetail(skipped[2])
    return detail
      ? tr("ui.firefly.receipt_skipped", { count, detail })
      : tr("ui.firefly.receipt_skipped_brief", { count })
  }

  const deployed = /^(?:unified\s+)?preview deployed\s*[:：-]?\s*(.*)$/i.exec(line)
  if (deployed) {
    const detail = trimDetail(deployed[1])
    return detail
      ? tr("ui.firefly.receipt_preview_deployed", { detail })
      : tr("ui.firefly.receipt_preview_deployed_brief")
  }

  if (/^saved settings await confirmation\b/i.test(line)) {
    return tr("ui.firefly.receipt_settings_pending")
  }

  const failed = /^(?:unified\s+)?preview deployment failed\s*[:：.]?\s*(.*)$/i.exec(line)
  if (failed) {
    const detail = trimDetail(failed[1])
    return detail
      ? tr("ui.firefly.receipt_deploy_failed", { detail })
      : tr("ui.firefly.receipt_deploy_failed_brief")
  }

  return line
}

/**
 * 把服务端回执转为当前语言。多行回执逐行处理，空串原样返回。
 * Convert a server receipt into the current language, line by line. Empty input returns "".
 */
export function formatGitSyncReceipt(raw: string | null | undefined, tr: ReceiptTranslator): string {
  const text = String(raw ?? "")
  if (!text.trim()) return ""
  return text
    .split(/\r?\n/)
    .map((line) => translateLine(line.trim(), tr))
    .filter((line) => line.length > 0)
    .join("\n")
}
