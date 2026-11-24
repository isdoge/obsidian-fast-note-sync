import { App, Modal, Notice } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import * as React from "react";

import type FastSync from "../main";
import { $ } from "../i18n/lang";
import { LucideIcon } from "./note-history/lucide-icon";
import { alignConflictEntries, listUnalignedPaths, ConflictAlignMode, ConflictAlignResult } from "../lib/sync/conflict_align";
import { ConfirmModal } from "./confirm-modal";
import { conflictKindLabel, conflictReasonLabel, readUnifiedConflictMeta } from "../lib/sync/conflict_store";

export class ConflictListModal extends Modal {
    private root: Root | null = null;
    private plugin: FastSync;
    public static activeInstance: ConflictListModal | null = null;

    constructor(app: App, plugin: FastSync) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        // 保证全局最多只打开一个冲突列表窗口，防抖避重叠
        if (ConflictListModal.activeInstance && ConflictListModal.activeInstance !== this) {
            try {
                ConflictListModal.activeInstance.close();
            } catch {
                // Ignore error on close // 忽略关闭时的异常
            }
        }
        ConflictListModal.activeInstance = this;

        const { contentEl } = this;
        this.titleEl.setText($("ui.menu.conflicts") || "笔记冲突");
        this.containerEl.addClass("fns-ws-clients-modal-container"); // 复用样式，保持一致

        this.root = createRoot(contentEl);
        this.root.render(
            <ConflictListView plugin={this.plugin} modal={this} />
        );
    }

    onClose() {
        if (ConflictListModal.activeInstance === this) {
            ConflictListModal.activeInstance = null;
        }
        this.containerEl.removeClass("fns-ws-clients-modal-container");
        if (this.root) {
            this.root.unmount();
            this.root = null;
        }
        this.contentEl.empty();
    }
}

const sameList = (a: string[], b: string[]) =>
    a.length === b.length && a.every((path, index) => path === b[index]);

const ConflictListView = ({ plugin, modal }: { plugin: FastSync, modal: ConflictListModal }) => {
    // 动态同步 conflictedPaths 列表，检测到发生解决或新增时刷新
    const [conflicts, setConflicts] = React.useState<string[]>(Array.from(plugin.syncState.conflictedPaths));
    // 待对齐路径（本地有内容但无可信基线）；普通双端冲突不在其中
    const [unaligned, setUnaligned] = React.useState<string[]>([]);
    const [busy, setBusy] = React.useState<ConflictAlignMode | null>(null);
    // 四类资源与原因标签（阶段 E）/ Kind and reason labels for all four kinds (stage E)
    const [metas, setMetas] = React.useState<Record<string, { kind: string; reason: string }>>({});

    React.useEffect(() => {
        let disposed = false;
        const refresh = async () => {
            const current = Array.from(plugin.syncState.conflictedPaths);
            setConflicts(previous => (sameList(current, previous) ? previous : current));
            const pending = await listUnalignedPaths(plugin, current);
            if (!disposed) setUnaligned(previous => (sameList(pending, previous) ? previous : pending));
            const nextMetas: Record<string, { kind: string; reason: string }> = {};
            for (const path of current) {
                const meta = await readUnifiedConflictMeta(plugin, path);
                nextMetas[path] = { kind: meta?.kind || (path.endsWith(".md") ? "note" : "file"), reason: meta?.reason || "" };
            }
            if (!disposed) setMetas(nextMetas);
        };
        void refresh();
        const timer = window.setInterval(() => { void refresh(); }, 500);
        return () => {
            disposed = true;
            window.clearInterval(timer);
        };
    }, [plugin]);

    const handleResolve = async (path: string) => {
        // 在去解决冲突时不再提前强制关闭列表页，以便用户回到列表页时能继续解决其他文件的冲突
        await plugin.menuManager.openConflictResolverForPath(path);
    };

    const runBatch = (mode: ConflictAlignMode) => {
        if (unaligned.length === 0 || busy) return;
        const targets = [...unaligned];
        const title = $("ui.conflict.batch_confirm_title") || "批量对齐待对齐笔记";
        const message = mode === "local"
            ? ($("ui.conflict.batch_confirm_local", { count: String(targets.length) }) || "")
            : mode === "remote"
                ? ($("ui.conflict.batch_confirm_remote", { count: String(targets.length) }) || "")
                : ($("ui.conflict.batch_confirm_both", { count: String(targets.length) }) || "");
        new ConfirmModal(
            plugin.app,
            title,
            message,
            () => { void executeBatch(mode, targets); },
            $("ui.conflict.batch_confirm_ok") || "继续",
            $("ui.button.cancel") || "取消",
            mode === "remote"
        ).open();
    };

    const executeBatch = async (mode: ConflictAlignMode, targets: string[]) => {
        setBusy(mode);
        let results: ConflictAlignResult[] = [];
        try {
            results = await alignConflictEntries(plugin, targets, mode);
        } finally {
            setBusy(null);
            setConflicts(Array.from(plugin.syncState.conflictedPaths));
            void listUnalignedPaths(plugin).then(setUnaligned);
        }
        const readonlyBlocked = results.filter(r => r.reason === "readonly").length;
        if (readonlyBlocked > 0) {
            // 只读模式下需要上行的处置被整体拒绝：提示先关闭只读，不并入普通失败计数
            // Uplink resolutions were rejected in read-only mode: ask to turn it off first and
            // keep them out of the generic failure count
            new Notice($("ui.conflict.readonly_blocked") || "只读同步模式已开启，请先关闭后再处理冲突", 10000);
        }
        const actionable = results.filter(r => r.reason !== "readonly");
        const succeeded = actionable.filter(r => r.ok).length;
        const skippedNewEdit = actionable.filter(r => r.reason === "new_edit").map(r => r.path);
        const failed = actionable.filter(r => !r.ok && r.reason !== "new_edit").length;
        if (actionable.length > 0) {
            new Notice($("ui.conflict.batch_result", { ok: String(succeeded), failed: String(failed) }), 8000);
        }
        const missingRemote = results.filter(r => r.reason === "missing_remote").length;
        if (missingRemote > 0) {
            // 远端正文未取得：拒绝清空本地，提示先同步刷新
            // Remote body unavailable: never clear the local copy; ask for a refresh first
            new Notice($("ui.conflict.remote_unavailable") || "无法取得远端内容，请先同步刷新后再试", 12000);
        }
        if (skippedNewEdit.length > 0) {
            // 待对齐期间又被编辑的条目一律跳过，提示用户逐条核对
            // Entries edited while pending are always skipped; ask the user to check them one by one
            new Notice($("ui.conflict.batch_skipped_new_edit", {
                count: String(skippedNewEdit.length),
                paths: skippedNewEdit.slice(0, 5).join("\n"),
            }), 15000);
        }
    };

    const renderItem = (path: string) => {
        const fileName = path.split(/[\\/]/).pop() || "";
        const isUnaligned = unaligned.includes(path);
        return (
            <div
                key={path}
                className="fns-ws-clients-item mod-clickable"
                onClick={() => { void handleResolve(path); }}
                style={{ cursor: 'pointer' }}
            >
                <div className="fns-ws-clients-item-top">
                    <div className="fns-ws-clients-item-main">
                        <div className="fns-ws-clients-item-icon-wrapper">
                            <LucideIcon icon={isUnaligned ? "git-compare" : "file-warning"} size={16} style={{ color: 'var(--text-warning)' }} />
                        </div>
                        <div className="fns-ws-clients-item-identity">
                            <div className="fns-ws-clients-item-name-row" style={{ fontWeight: 'bold' }}>
                                {fileName}
                            </div>
                            <div className="fns-ws-clients-item-address-line">
                                {path}
                            </div>
                            <div className="fns-conflict-kind-line">
                                {conflictKindLabel(metas[path]?.kind)}
                                {" · "}
                                {conflictReasonLabel(metas[path]?.reason)}
                            </div>
                            {isUnaligned && (
                                <div className="fns-conflict-unaligned-tag">
                                    {$("ui.conflict.unaligned_tag") || "待对齐：本地有内容、无共同基线"}
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="fns-conflict-item-actions">
                        <button
                            className="fns-conflict-remove-btn"
                            aria-label={$("ui.conflict.remove_from_list")}
                            title={$("ui.conflict.remove_from_list")}
                            onClick={(e) => {
                                e.stopPropagation();
                                plugin.menuManager.removeConflictedPath(path);
                                setConflicts(Array.from(plugin.syncState.conflictedPaths));
                            }}
                        >
                            <LucideIcon icon="x" size={14} />
                        </button>
                        <button
                            className="fns-ws-clients-item-type-tag"
                            onClick={(e) => {
                                e.stopPropagation();
                                void handleResolve(path);
                            }}
                            style={{
                                background: 'var(--interactive-accent)',
                                color: 'var(--text-on-accent)',
                                border: 'none',
                                borderRadius: '4px',
                                padding: '4px 8px',
                                cursor: 'pointer'
                            }}
                        >
                            {$("ui.conflict.menu_item")}
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="fns-ws-clients-view">
            <div className="fns-ws-clients-header">
                <div className="fns-ws-clients-title-group">
                    <LucideIcon icon="alert-triangle" size={20} style={{ color: 'var(--text-warning)' }} />
                    {$("ui.menu.conflicts") || "笔记冲突"}
                </div>
                <div className="fns-ws-clients-stats-group">
                    {conflicts.length > 0 && (
                        <span className="fns-ws-clients-count-badge">
                            {$("ui.conflict.list_count", { count: conflicts.length })}
                        </span>
                    )}
                </div>
            </div>

            {unaligned.length > 0 && (
                <div className="fns-conflict-batch-panel">
                    <div className="fns-conflict-batch-info">
                        <LucideIcon icon="layers" size={16} />
                        <span>{$("ui.conflict.batch_pending_info", { count: String(unaligned.length) })}</span>
                    </div>
                    <div className="fns-conflict-batch-actions">
                        <button
                            className="fns-conflict-batch-btn"
                            disabled={busy !== null}
                            onClick={() => runBatch("local")}
                            title={$("ui.conflict.batch_local_hint") || ""}
                        >
                            <LucideIcon icon="file-check" size={14} />
                            {$("ui.conflict.batch_use_local")}
                        </button>
                        <button
                            className="fns-conflict-batch-btn mod-warning"
                            disabled={busy !== null}
                            onClick={() => runBatch("remote")}
                            title={$("ui.conflict.batch_remote_hint") || ""}
                        >
                            <LucideIcon icon="cloud-download" size={14} />
                            {$("ui.conflict.batch_use_remote")}
                        </button>
                        <button
                            className="fns-conflict-batch-btn"
                            disabled={busy !== null}
                            onClick={() => runBatch("both")}
                            title={$("ui.conflict.batch_both_hint") || ""}
                        >
                            <LucideIcon icon="copy" size={14} />
                            {$("ui.conflict.batch_keep_both")}
                        </button>
                    </div>
                </div>
            )}

            <div className="fns-ws-clients-list">
                {conflicts.length === 0 ? (
                    <div className="fns-ws-clients-empty-state">
                        <div className="fns-empty-state fns-padding-60 fns-text-center fns-muted-text">
                            <div className="fns-margin-b-15 fns-opacity-6" style={{ color: 'var(--text-success)' }}>
                                <LucideIcon icon="check-circle" size={48} />
                            </div>
                            <div className="fns-font-lg">
                                {$("ui.conflict.list_empty")}
                            </div>
                        </div>
                    </div>
                ) : (
                    conflicts.map(renderItem)
                )}
            </div>
        </div>
    );
};
