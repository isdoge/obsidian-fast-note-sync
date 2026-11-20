/**
 * Firefly 博客文章的可视化交互弹窗。
 * Visual modals for Firefly posts:
 *  - `FireflyPostModal`       文章属性 / 封面 / 合规检查 / 一键发布
 *  - `CreateFireflyPostModal` 新建经验分享文章
 *  - `CheckFireflyPostModal`  发布前合规检查与一键修复
 *
 * 只通过 `app.fileManager.processFrontMatter` 与 `vault.modify` 读写当前笔记，
 * 不触碰同步层文件。
 */

import { App, Modal, Setting, TFile, normalizePath } from "obsidian";

import type FastSync from "../main";
import { $ } from "../i18n/lang";
import { showSyncNotice } from "../lib/utils/helpers";
import { GitSyncPublicStatus } from "../lib/api/http_api_service";
import {
    FIREFLY_CATEGORIES,
    FIREFLY_DEFAULT_TAGS,
    FIREFLY_IMAGE_API,
    FireflyCheckIssue,
    FireflyCheckResult,
    buildFireflyPostTemplate,
    formatLocalDate,
    isValidFireflyDate,
    parseFrontmatter,
    stripAuthorReviewBlocks,
    stripSourceIndexLines,
    unquoteFireflyDateFields,
    validateFireflyPostContent,
} from "../lib/blog/firefly-frontmatter";
import {
    copyImageIntoNoteAssets,
    generateSlugForNote,
    inferCategoryFromPath,
    isImageFile,
    joinVaultPath,
    listLocalAssetImages,
    makeImageExistsResolver,
    normalizePostAssets,
    resolveRefToVaultPath,
    todayString,
    writeImageIntoNoteAssets,
} from "../lib/blog/firefly-assets";

type ImageMode = "none" | "api" | "local";

interface FormState {
    title: string;
    slug: string;
    published: string;
    updated: string;
    category: string;
    tags: string;
    description: string;
    draft: boolean;
    scope: string;
    type: string;
    comment: boolean;
    imageMode: ImageMode;
    imagePath: string;
    slugLocked: boolean;
    setUpdatedToday: boolean;
}

function scalarToString(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    return "";
}

function stringValue(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (value instanceof Date) return formatLocalDate(value);
    if (Array.isArray(value)) return value.map((v) => scalarToString(v)).join(", ");
    return scalarToString(value).trim();
}

function boolValue(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        if (/^true$/i.test(value.trim())) return true;
        if (/^false$/i.test(value.trim())) return false;
    }
    return fallback;
}

function splitTags(raw: string): string[] {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const part of raw.split(/[,，;；]/)) {
        const tag = part.trim();
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        tags.push(tag);
    }
    return tags;
}

function issueLabel(issue: FireflyCheckIssue): string {
    const key = `ui.firefly.issue.${issue.code}`;
    return $(key as never, { detail: issue.detail ?? "" });
}

/** 根据当前表单值推断封面模式 */
function detectImageMode(image: string): { mode: ImageMode; path: string } {
    if (!image) return { mode: "none", path: "" };
    if (image === FIREFLY_IMAGE_API) return { mode: "api", path: "" };
    if (/^\.?\/?assets\//i.test(image) || image.startsWith("./")) return { mode: "local", path: image };
    if (/^(?:https?:)?\/\//i.test(image) || image.startsWith("/")) return { mode: "none", path: image };
    return { mode: "local", path: image };
}

export class FireflyPostModal extends Modal {
    private plugin: FastSync;
    private file: TFile;
    private state: FormState | null = null;
    private content = "";
    private frontmatter: Record<string, unknown> = {};
    private check: FireflyCheckResult | null = null;
    private busy = false;
    private lastReceipt = "";
    private pollTimer: number | null = null;
    private categoryCustom = false;

    constructor(app: App, plugin: FastSync, file: TFile) {
        super(app);
        this.plugin = plugin;
        this.file = file;
    }

    async onOpen() {
        this.modalEl.addClass("fns-firefly-modal");
        this.content = await this.app.vault.read(this.file);
        const parsed = parseFrontmatter(this.content);
        this.frontmatter = parsed ?? {};
        const fm = this.frontmatter;
        const fallbackCategory = inferCategoryFromPath(this.file.path);
        const category = stringValue(fm.category) || fallbackCategory.replace(/^\d+[-_.、\s]+/, "");
        const title = stringValue(fm.title) || this.file.basename;
        const existingSlug = stringValue(fm.slug);
        const image = detectImageMode(stringValue(fm.image));
        const scope = stringValue(fm.scope) || "内部";
        const type = stringValue(fm.type);
        const tags = Array.isArray(fm.tags)
            ? (fm.tags as unknown[]).map((t) => String(t)).join(", ")
            : stringValue(fm.tags);

        this.state = {
            title,
            slug: existingSlug || generateSlugForNote(category, title),
            published: stringValue(fm.published) || todayString(),
            updated: stringValue(fm.updated),
            category,
            tags: tags || FIREFLY_DEFAULT_TAGS.join(", "),
            description: stringValue(fm.description),
            draft: boolValue(fm.draft, true),
            scope,
            type: type || "share",
            comment: boolValue(fm.comment, false),
            imageMode: image.mode,
            imagePath: image.path,
            slugLocked: existingSlug.length > 0,
            setUpdatedToday: false,
        };
        this.categoryCustom = !!category && !FIREFLY_CATEGORIES.includes(category);
        this.render();
    }

    onClose() {
        this.stopPolling();
        this.contentEl.empty();
    }

    // ─── 状态同步 ──────────────────────────────────────────────────

    private async refreshContent(): Promise<void> {
        this.content = await this.app.vault.read(this.file);
        this.frontmatter = parseFrontmatter(this.content) ?? {};
    }

    private runCheck(): void {
        if (!this.state) return;
        const frontmatter: Record<string, unknown> = { ...this.frontmatter };
        // 用表单里的待保存值参与校验，让用户保存前就能看到问题
        frontmatter.title = this.state.title;
        frontmatter.slug = this.state.slug;
        frontmatter.published = this.state.published;
        frontmatter.updated = this.state.updated;
        frontmatter.category = this.state.category;
        frontmatter.draft = this.state.draft;
        frontmatter.scope = this.state.scope;
        frontmatter.type = this.state.type;
        if (this.state.description) frontmatter.description = this.state.description;
        this.check = validateFireflyPostContent({
            titleFromFilename: this.file.basename,
            content: this.content,
            frontmatter,
            resolveImageExists: makeImageExistsResolver(this.app, this.file.path),
        });
    }

    // ─── 渲染 ─────────────────────────────────────────────────────

    private render(): void {
        if (!this.state) return;
        this.runCheck();
        const { contentEl, titleEl } = this;
        contentEl.empty();
        titleEl.setText($("ui.firefly.title"));

        const fileBadge = contentEl.createDiv("fns-firefly-file-badge");
        fileBadge.setText(this.file.path);

        const form = contentEl.createDiv("fns-firefly-form");
        this.renderBasics(form);
        this.renderTaxonomy(form);
        this.renderPublishing(form);
        this.renderCover(form);
        this.renderCheck(form);
        this.renderFooter(form);
    }

    private renderBasics(parent: HTMLElement): void {
        const state = this.state!;
        const section = parent.createDiv("fns-firefly-section");
        section.createDiv({ cls: "fns-firefly-section-title", text: $("ui.firefly.field_title") });

        new Setting(section)
            .setName($("ui.firefly.field_title"))
            .addText((text) =>
                text.setValue(state.title).onChange((value) => {
                    state.title = value;
                    if (!state.slugLocked) state.slug = generateSlugForNote(state.category, value);
                    this.scheduleSoftRefresh();
                }),
            );

        const slugSetting = new Setting(section)
            .setName($("ui.firefly.field_slug"))
            .addText((text) => {
                text.setValue(state.slug).onChange((value) => {
                    state.slug = value.trim();
                    state.slugLocked = state.slug.length > 0;
                });
                text.inputEl.addClass("fns-firefly-slug-input");
            })
            .addExtraButton((btn) => {
                btn.setIcon("refresh-cw")
                    .setTooltip($("ui.firefly.slug_regenerate"))
                    .onClick(() => {
                        state.slug = generateSlugForNote(state.category, state.title);
                        state.slugLocked = true;
                        this.render();
                    });
            });
        if (state.slugLocked) {
            slugSetting.setDesc($("ui.firefly.slug_locked_tip"));
        }

        new Setting(section)
            .setName($("ui.firefly.field_published"))
            .addText((text) => {
                text.inputEl.type = "date";
                text.setValue(state.published).onChange((value) => {
                    state.published = value;
                    this.scheduleSoftRefresh();
                });
            });

        new Setting(section)
            .setName($("ui.firefly.field_updated"))
            .addText((text) => {
                text.inputEl.type = "date";
                text.setValue(state.updated).onChange((value) => {
                    state.updated = value;
                    this.scheduleSoftRefresh();
                });
            })
            .addToggle((toggle) =>
                toggle
                    .setTooltip($("ui.firefly.updated_set_today"))
                    .setValue(state.setUpdatedToday)
                    .onChange((value) => {
                        state.setUpdatedToday = value;
                        if (value) {
                            state.updated = todayString();
                            this.render();
                        }
                    }),
            );
    }

    private renderTaxonomy(parent: HTMLElement): void {
        const state = this.state!;
        const section = parent.createDiv("fns-firefly-section");
        section.createDiv({ cls: "fns-firefly-section-title", text: $("ui.firefly.field_category") });

        const categoryOptions = [...FIREFLY_CATEGORIES];
        if (state.category && !categoryOptions.includes(state.category)) categoryOptions.push(state.category);

        new Setting(section)
            .setName($("ui.firefly.field_category"))
            .addDropdown((dropdown) => {
                for (const cat of categoryOptions) dropdown.addOption(cat, cat);
                dropdown.addOption("__custom__", $("ui.firefly.field_category") + " ✎");
                dropdown.setValue(this.categoryCustom ? "__custom__" : state.category || categoryOptions[0]);
                dropdown.onChange((value) => {
                    if (value === "__custom__") {
                        this.categoryCustom = true;
                        this.render();
                        return;
                    }
                    this.categoryCustom = false;
                    state.category = value;
                    if (!state.slugLocked) state.slug = generateSlugForNote(value, state.title);
                    this.scheduleSoftRefresh();
                });
            })
            .addText((text) => {
                text.inputEl.addClass("fns-firefly-custom-category");
                text.setPlaceholder($("ui.firefly.field_category"));
                text.setValue(this.categoryCustom ? state.category : "");
                text.onChange((value) => {
                    if (!this.categoryCustom) return;
                    state.category = value.trim();
                    if (!state.slugLocked) state.slug = generateSlugForNote(value, state.title);
                });
            });

        new Setting(section)
            .setName($("ui.firefly.field_tags"))
            .setDesc($("ui.firefly.field_tags_desc"))
            .addText((text) =>
                text.setValue(state.tags).onChange((value) => {
                    state.tags = value;
                }),
            );

        new Setting(section)
            .setName($("ui.firefly.field_description"))
            .addTextArea((area) => {
                area.inputEl.rows = 2;
                area.setValue(state.description).onChange((value) => {
                    state.description = value;
                });
            });
    }

    private renderPublishing(parent: HTMLElement): void {
        const state = this.state!;
        const section = parent.createDiv("fns-firefly-section");
        section.createDiv({ cls: "fns-firefly-section-title", text: $("ui.firefly.field_scope") });

        new Setting(section)
            .setName($("ui.firefly.field_draft"))
            .addToggle((toggle) =>
                toggle.setValue(state.draft).onChange((value) => {
                    state.draft = value;
                    this.scheduleSoftRefresh();
                }),
            );

        new Setting(section)
            .setName($("ui.firefly.field_scope"))
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("内部", $("ui.firefly.scope_internal"))
                    .addOption("公开", $("ui.firefly.scope_public"))
                    .setValue(state.scope === "公开" ? "公开" : "内部")
                    .onChange((value) => {
                        state.scope = value;
                        this.scheduleSoftRefresh();
                    }),
            );

        new Setting(section)
            .setName($("ui.firefly.field_type"))
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("share", $("ui.firefly.type_share"))
                    .addOption("", $("ui.firefly.type_none"))
                    .setValue(state.type === "share" ? "share" : "")
                    .onChange((value) => {
                        state.type = value;
                    }),
            );

        new Setting(section)
            .setName($("ui.firefly.field_comment"))
            .addToggle((toggle) =>
                toggle.setValue(state.comment).onChange((value) => {
                    state.comment = value;
                }),
            );
    }

    private renderCover(parent: HTMLElement): void {
        const state = this.state!;
        const section = parent.createDiv("fns-firefly-section");
        section.createDiv({ cls: "fns-firefly-section-title", text: $("ui.firefly.field_image") });

        const localImages = listLocalAssetImages(this.app, this.file.path);

        new Setting(section)
            .setName($("ui.firefly.field_image"))
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("none", $("ui.firefly.image_none"))
                    .addOption("api", $("ui.firefly.image_api"))
                    .addOption("local", $("ui.firefly.image_local"))
                    .setValue(state.imageMode)
                    .onChange((value) => {
                        state.imageMode = value as ImageMode;
                        if (state.imageMode === "none") state.imagePath = "";
                        if (state.imageMode === "api") state.imagePath = FIREFLY_IMAGE_API;
                        if (state.imageMode === "local" && !state.imagePath) {
                            state.imagePath = localImages[0] ? `./assets/${localImages[0].name}` : "";
                        }
                        this.render();
                    }),
            );

        if (state.imageMode === "local") {
            const select = section.createEl("select", { cls: "dropdown fns-firefly-cover-select" });
            if (localImages.length === 0) {
                const opt = select.createEl("option", { text: $("ui.firefly.image_pick_none") });
                opt.value = "";
            }
            for (const img of localImages) {
                const opt = select.createEl("option", { text: img.name });
                opt.value = `./assets/${img.name}`;
                if (state.imagePath === opt.value) opt.selected = true;
            }
            select.addEventListener("change", () => {
                if (select.value) state.imagePath = select.value;
            });

            const importRow = section.createDiv("fns-firefly-cover-actions");
            const vaultBtn = importRow.createEl("button", { text: $("ui.firefly.image_import"), cls: "mod-cta" });
            vaultBtn.addEventListener("click", () => {
                new ImagePickModal(this.app, this.plugin, (picked) => {
                    void (async () => {
                        try {
                            const name = await copyImageIntoNoteAssets(this.app, this.file.path, picked);
                            state.imageMode = "local";
                            state.imagePath = `./assets/${name}`;
                            showSyncNotice($("ui.firefly.image_imported", { name }));
                            this.render();
                        } catch (e) {
                            showSyncNotice($("ui.firefly.image_import_failed", { msg: e instanceof Error ? e.message : String(e) }));
                        }
                    })();
                }).open();
            });

            const localBtn = importRow.createEl("button", { text: $("ui.firefly.image_import_local") });
            localBtn.addEventListener("click", () => {
                const input = createEl("input", { type: "file" });
                input.accept = "image/*";
                input.addEventListener("change", () => {
                    const picked = input.files?.[0];
                    if (!picked) return;
                    void (async () => {
                        try {
                            const buffer = await picked.arrayBuffer();
                            const name = await writeImageIntoNoteAssets(this.app, this.file.path, picked.name, buffer);
                            state.imageMode = "local";
                            state.imagePath = `./assets/${name}`;
                            showSyncNotice($("ui.firefly.image_imported", { name }));
                            this.render();
                        } catch (e) {
                            showSyncNotice($("ui.firefly.image_import_failed", { msg: e instanceof Error ? e.message : String(e) }));
                        }
                    })();
                });
                input.click();
            });

            if (state.imagePath) {
                const preview = section.createDiv("fns-firefly-cover-preview");
                const resolved = resolveRefToVaultPath(this.file.path, state.imagePath);
                const imageFile = resolved ? this.app.vault.getAbstractFileByPath(resolved) : null;
                if (imageFile instanceof TFile) {
                    preview.createEl("img", { attr: { src: this.app.vault.getResourcePath(imageFile) } });
                }
                preview.createSpan({ text: state.imagePath });
            }
        }
    }

    private renderCheck(parent: HTMLElement): void {
        const check = this.check;
        if (!check) return;
        const section = parent.createDiv("fns-firefly-check");
        const header = section.createDiv("fns-firefly-section-title");
        header.setText($("ui.firefly.check_title"));

        const status = section.createDiv({
            cls: `fns-firefly-check-status ${check.ok ? "is-ok" : "is-error"}`,
            text: check.ok ? $("ui.firefly.check_ok") : $("ui.firefly.check_blocking"),
        });
        status.setAttribute("aria-live", "polite");

        const list = (title: string, issues: FireflyCheckIssue[], cls: string) => {
            if (issues.length === 0) return;
            const block = section.createDiv(`fns-firefly-issue-group ${cls}`);
            block.createDiv({ cls: "fns-firefly-issue-title", text: title });
            for (const issue of issues) {
                const row = block.createDiv("fns-firefly-issue");
                row.createSpan({ cls: "fns-firefly-issue-dot" });
                row.createSpan({ text: issueLabel(issue) });
            }
        };
        list($("ui.firefly.check_blocking"), check.errors, "is-error");
        list($("ui.firefly.check_fixable"), check.fixable, "is-fixable");
        list($("ui.firefly.check_warning"), check.warnings, "is-warning");

        const needsAssets = check.fixable.some((i) => i.code === "wiki_image" || i.code === "cross_dir_image");
        const needsReview = check.fixable.some((i) => i.code === "public_author_review" || i.code === "public_source_index");
        if (needsAssets || needsReview) {
            const actions = section.createDiv("fns-firefly-check-actions");
            if (needsAssets) {
                const btn = actions.createEl("button", { text: $("ui.firefly.fix_assets"), cls: "mod-cta" });
                btn.addEventListener("click", () => {
                    void (async () => {
                        btn.disabled = true;
                        const res = await normalizePostAssets(this.app, this.file);
                        btn.disabled = false;
                        await this.refreshContent();
                        showSyncNotice($("ui.firefly.fix_assets_done", { count: res.rewrittenCount || res.movedCount }));
                        this.render();
                    })();
                });
            }
            if (needsReview) {
                const btn = actions.createEl("button", { text: $("ui.firefly.fix_review") });
                btn.addEventListener("click", () => {
                    void (async () => {
                        await this.refreshContent();
                        const next = stripSourceIndexLines(stripAuthorReviewBlocks(this.content));
                        await this.app.vault.modify(this.file, next);
                        await this.refreshContent();
                        showSyncNotice($("ui.firefly.fix_review_done"));
                        this.render();
                    })();
                });
            }
        }
    }

    private renderFooter(parent: HTMLElement): void {
        const footer = parent.createDiv("fns-firefly-footer");
        if (this.lastReceipt) {
            footer.createDiv({ cls: "fns-firefly-receipt", text: this.lastReceipt });
        }

        const saveBtn = footer.createEl("button", { text: $("ui.firefly.save") });
        saveBtn.disabled = this.busy;
        saveBtn.addEventListener("click", () => {
            void this.handleSave(false);
        });

        const publishBtn = footer.createEl("button", {
            text: this.busy ? $("ui.firefly.publishing") : $("ui.firefly.save_publish"),
            cls: "mod-cta",
        });
        publishBtn.disabled = this.busy;
        publishBtn.addEventListener("click", () => {
            void this.handleSave(true);
        });

        const closeBtn = footer.createEl("button", { text: $("ui.firefly.close") });
        closeBtn.addEventListener("click", () => this.close());
    }

    private softRefreshTimer: number | null = null;
    private scheduleSoftRefresh(): void {
        if (this.softRefreshTimer) window.clearTimeout(this.softRefreshTimer);
        this.softRefreshTimer = window.setTimeout(() => {
            this.softRefreshTimer = null;
            this.render();
        }, 250);
    }

    // ─── 保存 ─────────────────────────────────────────────────────

    private async handleSave(publish: boolean): Promise<void> {
        if (!this.state || this.busy) return;
        this.busy = true;
        this.render();
        try {
            await this.persist();
            showSyncNotice($("ui.firefly.saved"));
            if (publish) {
                await this.publish();
            } else {
                this.busy = false;
                this.render();
            }
        } catch (e) {
            this.busy = false;
            showSyncNotice($("ui.firefly.save_failed", { msg: e instanceof Error ? e.message : String(e) }));
            this.render();
        }
    }

    private async persist(): Promise<void> {
        const state = this.state!;
        const today = todayString();
        const cover = state.imageMode === "api"
            ? FIREFLY_IMAGE_API
            : state.imageMode === "local"
                ? (state.imagePath || "")
                : "";

        await this.app.fileManager.processFrontMatter(this.file, (fm: Record<string, unknown>) => {
            fm.title = state.title.trim() || this.file.basename;
            if (state.slug.trim()) fm.slug = state.slug.trim();
            else delete fm.slug;
            fm.published = isValidFireflyDate(state.published) ? state.published : today;
            if (state.updated && isValidFireflyDate(state.updated)) fm.updated = state.updated;
            else delete fm.updated;
            fm.category = state.category;
            const tags = splitTags(state.tags);
            fm.tags = tags.length > 0 ? tags : [...FIREFLY_DEFAULT_TAGS];
            fm.description = state.description;
            fm.draft = state.draft;
            fm.scope = state.scope;
            if (state.type) fm.type = state.type;
            else delete fm.type;
            fm.comment = state.comment;
            if (cover) fm.image = cover;
            else delete fm.image;
            if (!fm.lang) fm.lang = "zh-CN";
            if (!fm.sourceVault) fm.sourceVault = this.plugin.settings.vault || "doge";
            if (!fm.createTime) fm.createTime = state.published || today;
            fm.updateTime = today;
        });

        // Obsidian 可能把日期序列化成字符串；Firefly 的 z.date() 只接受 YAML 原生日期
        const raw = await this.app.vault.read(this.file);
        const fixed = unquoteFireflyDateFields(raw);
        if (fixed !== raw) await this.app.vault.modify(this.file, fixed);
        await this.refreshContent();
    }

    // ─── 发布与轮询 ────────────────────────────────────────────────

    private async publish(): Promise<void> {
        const notice = showSyncNotice($("ui.firefly.publishing"), 120000);
        try {
            const status = await this.plugin.api.getGitSyncStatus(this.plugin.settings.vault);
            if (!status.ok) {
                notice.hide();
                showSyncNotice($("ui.firefly.publish_failed", { msg: status.message || `HTTP ${status.status}` }), 8000);
                this.busy = false;
                this.render();
                return;
            }
            if (!status.data || status.data.length === 0) {
                notice.hide();
                showSyncNotice($("ui.firefly.publish_no_config"), 8000);
                this.busy = false;
                this.render();
                return;
            }
            const trigger = await this.plugin.api.triggerGitSync(this.plugin.settings.vault);
            if (!trigger.ok) {
                notice.hide();
                showSyncNotice($("ui.firefly.publish_failed", { msg: trigger.message || `HTTP ${trigger.status}` }), 8000);
                this.busy = false;
                this.render();
                return;
            }
            notice.setMessage($("ui.firefly.publish_triggered"));
            await this.pollStatus(status.data[0]?.id, notice);
        } finally {
            notice.hide();
        }
    }

    private async pollStatus(configId: number | undefined, notice: { setMessage: (m: string) => void; hide: () => void }): Promise<void> {
        const deadline = Date.now() + 20000;
        let last: GitSyncPublicStatus | undefined;
        while (Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 3000));
            const res = await this.plugin.api.getGitSyncStatus(this.plugin.settings.vault);
            if (!res.ok) continue;
            const list = res.data ?? [];
            last = list.find((item) => item.id === configId) ?? list[0];
            if (!last) continue;
            const message = String(last.lastMessage ?? "");
            if (/Saved settings await confirmation/i.test(message)) {
                this.lastReceipt = $("ui.firefly.publish_settings_pending");
                notice.setMessage(this.lastReceipt);
                break;
            }
            if (last.lastStatus !== 0 && message) {
                const failed = last.lastStatus < 0 || /failed|error/i.test(message);
                this.lastReceipt = $(failed ? "ui.firefly.publish_deploy_failed" : "ui.firefly.publish_done", { msg: message });
                notice.setMessage(this.lastReceipt);
                break;
            }
        }
        if (!this.lastReceipt) {
            this.lastReceipt = $("ui.firefly.publish_waiting");
        }
        this.busy = false;
        this.render();
    }

    private stopPolling(): void {
        if (this.pollTimer) window.clearTimeout(this.pollTimer);
        this.pollTimer = null;
        if (this.softRefreshTimer) window.clearTimeout(this.softRefreshTimer);
        this.softRefreshTimer = null;
    }
}

/** 从库内挑选图片（带缩略图） */
class ImagePickModal extends Modal {
    private plugin: FastSync;
    private onPick: (file: TFile) => void;

    constructor(app: App, plugin: FastSync, onPick: (file: TFile) => void) {
        super(app);
        this.plugin = plugin;
        this.onPick = onPick;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("fns-firefly-image-picker");
        this.titleEl.setText($("ui.firefly.image_import"));
        const input = contentEl.createEl("input", {
            type: "search",
            placeholder: $("ui.firefly.image_pick_placeholder"),
            cls: "fns-firefly-image-search",
        });
        const grid = contentEl.createDiv("fns-firefly-image-grid");
        const renderList = (query: string) => {
            grid.empty();
            const q = query.trim().toLowerCase();
            const files = this.app.vault.getFiles().filter((f) => isImageFile(f) && (!q || f.path.toLowerCase().includes(q)));
            for (const file of files.slice(0, 200)) {
                const card = grid.createDiv("fns-firefly-image-card");
                card.createEl("img", { attr: { src: this.app.vault.getResourcePath(file) } });
                card.createSpan({ text: file.name });
                card.addEventListener("click", () => {
                    this.onPick(file);
                    this.close();
                });
            }
            if (files.length === 0) grid.createDiv({ text: $("ui.firefly.image_pick_none") });
        };
        input.addEventListener("input", () => renderList(input.value));
        renderList("");
    }

    onClose() {
        this.contentEl.empty();
    }
}

/** 发布前合规检查与一键修复 */
export class CheckFireflyPostModal extends Modal {
    private plugin: FastSync;
    private file: TFile;
    private check: FireflyCheckResult | null = null;

    constructor(app: App, plugin: FastSync, file: TFile) {
        super(app);
        this.plugin = plugin;
        this.file = file;
    }

    async onOpen() {
        this.modalEl.addClass("fns-firefly-modal");
        await this.refresh();
    }

    onClose() {
        this.contentEl.empty();
    }

    private async refresh(): Promise<void> {
        const content = await this.app.vault.read(this.file);
        this.check = validateFireflyPostContent({
            titleFromFilename: this.file.basename,
            content,
            resolveImageExists: makeImageExistsResolver(this.app, this.file.path),
        });
        this.render();
    }

    private render(): void {
        const check = this.check;
        if (!check) return;
        const { contentEl, titleEl } = this;
        contentEl.empty();
        titleEl.setText($("ui.firefly.check_modal_title"));
        contentEl.createDiv({ cls: "fns-firefly-file-badge", text: this.file.path });

        const section = contentEl.createDiv("fns-firefly-check");
        section.createDiv({
            cls: `fns-firefly-check-status ${check.ok ? "is-ok" : "is-error"}`,
            text: check.ok ? $("ui.firefly.check_ok") : $("ui.firefly.check_blocking"),
        });

        const list = (title: string, issues: FireflyCheckIssue[], cls: string) => {
            if (issues.length === 0) return;
            const block = section.createDiv(`fns-firefly-issue-group ${cls}`);
            block.createDiv({ cls: "fns-firefly-issue-title", text: title });
            for (const issue of issues) {
                const row = block.createDiv("fns-firefly-issue");
                row.createSpan({ cls: "fns-firefly-issue-dot" });
                row.createSpan({ text: issueLabel(issue) });
            }
        };
        list($("ui.firefly.check_blocking"), check.errors, "is-error");
        list($("ui.firefly.check_fixable"), check.fixable, "is-fixable");
        list($("ui.firefly.check_warning"), check.warnings, "is-warning");

        const actions = contentEl.createDiv("fns-firefly-footer");
        if (check.fixable.length > 0) {
            const fixBtn = actions.createEl("button", { text: $("ui.firefly.fix_assets"), cls: "mod-cta" });
            fixBtn.addEventListener("click", () => {
                void (async () => {
                    fixBtn.disabled = true;
                    const res = await normalizePostAssets(this.app, this.file);
                    fixBtn.disabled = false;
                    showSyncNotice($("ui.firefly.fix_assets_done", { count: res.rewrittenCount || res.movedCount }));
                    await this.refresh();
                })();
            });
            const reviewBtn = actions.createEl("button", { text: $("ui.firefly.fix_review") });
            reviewBtn.addEventListener("click", () => {
                void (async () => {
                    const content = await this.app.vault.read(this.file);
                    const next = stripSourceIndexLines(stripAuthorReviewBlocks(content));
                    await this.app.vault.modify(this.file, next);
                    showSyncNotice($("ui.firefly.fix_review_done"));
                    await this.refresh();
                })();
            });
        }
        const closeBtn = actions.createEl("button", { text: $("ui.firefly.close") });
        closeBtn.addEventListener("click", () => this.close());
    }
}

/** 新建 Firefly 经验分享文章 */
export class CreateFireflyPostModal extends Modal {
    private plugin: FastSync;
    private titleValue = "";
    private category: string = FIREFLY_CATEGORIES[0];
    private dir: string;

    constructor(app: App, plugin: FastSync) {
        super(app);
        this.plugin = plugin;
        this.dir = (plugin.settings.fireflyDefaultBlogDir || "Blog").trim() || "Blog";
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        contentEl.empty();
        contentEl.addClass("fns-firefly-modal");
        titleEl.setText($("ui.firefly.create_title"));

        const form = contentEl.createDiv("fns-firefly-form");
        new Setting(form)
            .setName($("ui.firefly.create_name"))
            .addText((text) =>
                text.setPlaceholder($("ui.firefly.create_name")).onChange((value) => {
                    this.titleValue = value;
                }),
            );

        new Setting(form)
            .setName($("ui.firefly.create_category"))
            .addDropdown((dropdown) => {
                for (const cat of FIREFLY_CATEGORIES) dropdown.addOption(cat, cat);
                dropdown.setValue(this.category).onChange((value) => {
                    this.category = value;
                });
            });

        new Setting(form)
            .setName($("ui.firefly.create_dir"))
            .addText((text) =>
                text
                    .setPlaceholder($("ui.firefly.create_dir_placeholder"))
                    .setValue(this.dir)
                    .onChange((value) => {
                        this.dir = value.trim();
                    }),
            );

        const footer = contentEl.createDiv("fns-firefly-footer");
        const createBtn = footer.createEl("button", { text: $("ui.firefly.create_button"), cls: "mod-cta" });
        createBtn.addEventListener("click", () => {
            void this.create();
        });
        const cancelBtn = footer.createEl("button", { text: $("ui.firefly.close") });
        cancelBtn.addEventListener("click", () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }

    private async create(): Promise<void> {
        const title = this.titleValue.trim();
        if (!title) {
            showSyncNotice($("ui.firefly.create_no_title"));
            return;
        }
        const folder = normalizePath(joinVaultPath(this.dir, this.category));
        if (!this.app.vault.getAbstractFileByPath(folder)) {
            await this.app.vault.createFolder(folder);
        }
        const slug = generateSlugForNote(this.category, title);
        const path = normalizePath(joinVaultPath(folder, `${title}.md`));
        if (this.app.vault.getAbstractFileByPath(path)) {
            showSyncNotice($("ui.firefly.create_exists", { path }));
            return;
        }
        const content = buildFireflyPostTemplate({
            title,
            category: this.category,
            slug,
            sourceVault: this.plugin.settings.vault || "doge",
            today: formatLocalDate(),
        });
        const file = await this.app.vault.create(path, content);
        showSyncNotice($("ui.firefly.create_success", { path }));
        this.close();
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
    }
}

/** 供命令与右键菜单共用：取当前活动 Markdown 文件 */
export function activeMarkdownFile(app: App): TFile | null {
    const file = app.workspace.getActiveFile();
    return file && file.extension === "md" ? file : null;
}

/**
 * 「立即发布到 Firefly」：触发服务端 Git 同步，并轮询几秒展示最新构建回执。
 * Trigger the server-side Git sync and poll briefly for the build receipt.
 */
export async function triggerFireflyPublish(plugin: FastSync): Promise<void> {
    const notice = showSyncNotice($("ui.firefly.publishing"), 120000);
    try {
        const status = await plugin.api.getGitSyncStatus(plugin.settings.vault);
        if (!status.ok) {
            showSyncNotice($("ui.firefly.publish_failed", { msg: status.message || `HTTP ${status.status}` }), 8000);
            return;
        }
        if (!status.data || status.data.length === 0) {
            showSyncNotice($("ui.firefly.publish_no_config"), 8000);
            return;
        }
        const trigger = await plugin.api.triggerGitSync(plugin.settings.vault);
        if (!trigger.ok) {
            showSyncNotice($("ui.firefly.publish_failed", { msg: trigger.message || `HTTP ${trigger.status}` }), 8000);
            return;
        }
        notice.setMessage($("ui.firefly.publish_triggered"));

        const configId = status.data[0]?.id;
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 3000));
            const res = await plugin.api.getGitSyncStatus(plugin.settings.vault);
            if (!res.ok) continue;
            const list = res.data ?? [];
            const item = list.find((entry) => entry.id === configId) ?? list[0];
            if (!item) continue;
            const message = String(item.lastMessage ?? "");
            if (/Saved settings await confirmation/i.test(message)) {
                showSyncNotice($("ui.firefly.publish_settings_pending"), 12000);
                return;
            }
            if (item.lastStatus !== 0 && message) {
                const failed = item.lastStatus < 0 || /failed|error/i.test(message);
                showSyncNotice($(failed ? "ui.firefly.publish_deploy_failed" : "ui.firefly.publish_done", { msg: message }), 12000);
                return;
            }
        }
        showSyncNotice($("ui.firefly.publish_waiting"), 8000);
    } finally {
        notice.hide();
    }
}
