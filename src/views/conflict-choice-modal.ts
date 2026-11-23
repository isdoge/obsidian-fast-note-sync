import { App, Modal, Notice } from "obsidian";

import { $ } from "../i18n/lang";
import { ConflictResolveMode, readonlyResolutionBlocked, resolveConflictEntry } from "../lib/sync/conflict_resolve";
import { conflictKindLabel, conflictReasonLabel, readUnifiedConflictMeta } from "../lib/sync/conflict_store";
import type FastSync from "../main";

/**
 * 附件与目录冲突的三选一处置框（差异编辑器不适用于二进制与目录）。
 * Three-way resolution modal for attachment and folder conflicts (a diff editor does not apply
 * to binaries or directories).
 */
export class ConflictChoiceModal extends Modal {
  private plugin: FastSync;
  private path: string;

  constructor(app: App, plugin: FastSync, path: string) {
    super(app);
    this.plugin = plugin;
    this.path = path;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText($("ui.conflict.modal_title") || "冲突解决");
    void this.render(contentEl);
  }

  private async render(containerEl: HTMLElement): Promise<void> {
    const meta = await readUnifiedConflictMeta(this.plugin, this.path);
    containerEl.createDiv({ text: this.path, cls: "conflict-choice-path" });
    containerEl.createDiv({
      text: `${conflictKindLabel(meta?.kind)} · ${conflictReasonLabel(meta?.reason)}`,
      cls: "conflict-choice-reason",
    });

    const actions = containerEl.createDiv({ cls: "conflict-resolve-actions" });
    const run = async (mode: ConflictResolveMode) => {
      // “保留本地 / 保留双份”必然上传：只读下先提示并保持弹窗打开，任何本地改动都不执行。
      // “采用远端”可能是纯本地动作（如远端已是墓碑），交给 resolver 逐条判断，不在这里一刀切。
      // "Keep local / keep both" always upload: in read-only mode warn and keep the modal open
      // with no local change. "Use remote" can be local-only (e.g. remote tombstone), so it is
      // left to the resolver instead of being blocked outright here.
      if (mode !== "remote" && readonlyResolutionBlocked(this.plugin)) {
        new Notice($("ui.conflict.readonly_blocked") || "只读同步模式已开启，请先关闭后再处理冲突");
        return;
      }
      this.close();
      const result = await resolveConflictEntry(this.plugin, this.path, mode);
      if (result.ok) {
        new Notice($("ui.conflict.resolved_notice") || "冲突已解决");
      } else if (result.reason === "readonly") {
        new Notice($("ui.conflict.readonly_blocked") || "只读同步模式已开启，请先关闭后再处理冲突");
      } else if (result.reason === "new_edit") {
        new Notice($("ui.conflict.batch_skipped_new_edit", { count: "1", paths: this.path }) || "条目在待处理期间已被编辑，请重新打开核对");
      } else if (result.reason === "missing_remote") {
        // 远端正文拿不到时绝不写入空串，提示先同步刷新
        // Never write an empty body when the remote is unavailable; ask for a refresh first
        new Notice($("ui.conflict.remote_unavailable") || "无法取得远端内容，请先同步刷新后再试");
      } else {
        new Notice($("ui.conflict.action_failed") || "处理冲突失败，请重试");
      }
    };

    const localBtn = actions.createEl("button", { text: $("ui.conflict.use_local") || "采用本地版本", cls: "mod-cta" });
    localBtn.onClickEvent(() => { void run("local"); });

    const remoteBtn = actions.createEl("button", { text: $("ui.conflict.use_remote") || "采用远端版本" });
    remoteBtn.onClickEvent(() => { void run("remote"); });

    const bothBtn = actions.createEl("button", { text: $("ui.conflict.batch_keep_both") || "保留双份" });
    bothBtn.onClickEvent(() => { void run("both"); });

    const cancelBtn = actions.createEl("button", { text: $("ui.button.cancel") || "稍后处理" });
    cancelBtn.onClickEvent(() => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
