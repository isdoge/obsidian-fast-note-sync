import { configAddPathExcluded, dumpError, getPluginDir } from "../utils/helpers";
import type FastSync from "../../main";

/**
 * 设备本地的「云附件已驱逐」日志。
 * Device-local journal of cloud attachments intentionally removed from this device.
 *
 * 开启「附件云预览 - 上传后删除本地」后，上传成功的附件会被移到回收站。普通离线删除扫描
 * 只看到「哈希表里有、本地磁盘没有」，于是会把这次设备本地清理误报成用户删除，要求服务端
 * 也删掉附件——别的设备与云端副本随之丢失。本日志在清理前落下 `{ scope, path, sha256,
 * size, evictedAt }`，扫描时据此排除这些路径；附件重新出现在本机（用户下载回来或新建）后
 * 自动清除记录。
 *
 * With "cloud preview — delete local after upload", an uploaded attachment is moved to the
 * recycle bin. The offline-delete scan only sees "tracked, but not on disk", so that deliberate
 * device-local cleanup would be reported as a user deletion and the server copy would be deleted
 * for every other device. This journal records `{ scope, path, sha256, size, evictedAt }` before
 * cleanup and the scan consults it; when the file reappears locally the record is dropped.
 *
 * 参考 / Reference: OPENSB obsidian-fast-note-sync-safety `src/lib/storage/cloud_attachment_safety.ts`
 * (Apache-2.0). This variant is a minimal, vault-scoped journal only.
 */

export interface CloudAttachmentEvictionRecord {
    /** 远端作用域（规范化 api + vault），不含 token / Remote scope, tokens excluded */
    scope: string;
    path: string;
    sha256: string;
    size: number;
    evictedAt: number;
}

export type CloudAttachmentEvictionInput = Omit<CloudAttachmentEvictionRecord, "scope">;

const JOURNAL_VERSION = 1;
/** 插件目录内的设备本地状态文件；配置同步必须排除它 / Device-local state file inside the plugin dir */
const JOURNAL_NAME = "cloud-attachments-evicted.json";

/**
 * 规范化作用域：同一 API 地址 + 远端库名共享一份驱逐日志，token 轮换不影响。
 * Normalized scope: one journal per API endpoint + remote vault; token rotation does not reset it.
 */
export function computeEvictionScope(settings: { api?: string; vault?: string } | undefined): string {
    const api = (settings?.api ?? "").trim().replace(/\/+$/, "").toLowerCase();
    const vault = (settings?.vault ?? "").trim();
    return `${api}\u0000${vault}`;
}

interface JournalShape {
    version: number;
    entries: CloudAttachmentEvictionRecord[];
}

function isJournal(value: unknown): value is JournalShape {
    if (!value || typeof value !== "object") return false;
    const candidate = value as { version?: unknown; entries?: unknown };
    return candidate.version === JOURNAL_VERSION && Array.isArray(candidate.entries);
}

function isValidRecord(value: unknown): value is CloudAttachmentEvictionRecord {
    if (!value || typeof value !== "object") return false;
    const record = value as Partial<CloudAttachmentEvictionRecord>;
    return typeof record.scope === "string" && record.scope !== ""
        && typeof record.path === "string" && record.path !== ""
        && typeof record.sha256 === "string"
        && typeof record.size === "number" && Number.isFinite(record.size)
        && typeof record.evictedAt === "number" && Number.isFinite(record.evictedAt);
}

export class CloudAttachmentEviction {
    private entries = new Map<string, CloudAttachmentEvictionRecord>();
    private loaded: Promise<void> | null = null;
    private writes: Promise<void> = Promise.resolve();
    /** 日志损坏时禁止清理并停止上报离线删除，绝不拿空日志猜测用户意图 / Corrupt journal disables cleanup */
    private unusable = false;
    private readonly indexPath: string;

    constructor(private readonly plugin: FastSync) {
        this.indexPath = `${getPluginDir(plugin)}/${JOURNAL_NAME}`;
        // 内存级配置同步排除；configIsPathExcluded 里还有固定排除兜底
        // In-memory config-sync exclusion; configIsPathExcluded has the permanent fallback
        configAddPathExcluded(this.indexPath, plugin);
        configAddPathExcluded(`${this.indexPath}.tmp`, plugin);
    }

    private scope(): string {
        return computeEvictionScope(this.plugin.settings);
    }

    private key(scope: string, path: string): string {
        return JSON.stringify([scope, path]);
    }

    public currentScope(): string {
        return this.scope();
    }

    /** 日志不可用时，调用方必须跳过附件离线删除上报 / Callers must skip offline attachment deletes */
    public get isUsable(): boolean {
        return !this.unusable;
    }

    public async initialize(): Promise<void> {
        if (!this.loaded) this.loaded = this.load();
        return this.loaded;
    }

    private async load(): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        const temporary = `${this.indexPath}.tmp`;
        try {
            const source = await adapter.exists(temporary) ? temporary : this.indexPath;
            if (!await adapter.exists(source)) return;
            const parsed: unknown = JSON.parse(await adapter.read(source));
            if (!isJournal(parsed)) throw new Error("Invalid cloud attachment eviction journal");
            const entries = new Map<string, CloudAttachmentEvictionRecord>();
            for (const record of parsed.entries) {
                if (!isValidRecord(record)) throw new Error("Invalid cloud attachment eviction journal entry");
                entries.set(this.key(record.scope, record.path), record);
            }
            this.entries = entries;
        } catch (error) {
            this.unusable = true;
            dumpError("Cloud attachment eviction journal unavailable; local attachment cleanup is disabled", error);
        }
    }

    public isEvicted(path: string): boolean {
        return this.entries.has(this.key(this.scope(), path));
    }

    /** 记录一条驱逐；必须先于回收站移动完成落盘 / Persist before moving the file to the bin */
    public async record(input: CloudAttachmentEvictionInput): Promise<void> {
        await this.initialize();
        if (this.unusable) throw new Error("Cloud attachment eviction journal is unavailable");
        const entry: CloudAttachmentEvictionRecord = { scope: this.scope(), ...input };
        const key = this.key(entry.scope, entry.path);
        await this.mutate(next => { next.set(key, entry); });
    }

    /** 撤销一条驱逐记录（移动失败回滚）/ Drop one record (rollback when the move failed) */
    public async remove(path: string): Promise<void> {
        await this.initialize();
        if (this.unusable) throw new Error("Cloud attachment eviction journal is unavailable");
        const scope = this.scope();
        if (!this.entries.has(this.key(scope, path))) return;
        await this.mutate(next => { next.delete(this.key(scope, path)); });
    }

    /** 附件重新出现在本地：清除其驱逐记录 / The file reappeared locally: forget its eviction */
    public async forget(paths: Iterable<string>): Promise<void> {
        await this.initialize();
        if (this.unusable) return;
        const scope = this.scope();
        const targets = Array.from(new Set(paths)).filter(path => this.entries.has(this.key(scope, path)));
        if (targets.length === 0) return;
        await this.mutate(next => {
            for (const path of targets) next.delete(this.key(scope, path));
        });
    }

    /** 按作用域清理（切换远端库时调用）/ Clear one scope (used when the remote vault changes) */
    public async clearScope(scope: string = this.scope()): Promise<void> {
        await this.initialize();
        if (this.unusable) return;
        if (!Array.from(this.entries.values()).some(entry => entry.scope === scope)) return;
        await this.mutate(next => {
            for (const [key, entry] of next) {
                if (entry.scope === scope) next.delete(key);
            }
        });
    }

    private mutate(apply: (next: Map<string, CloudAttachmentEvictionRecord>) => void): Promise<void> {
        const operation = this.writes.then(async () => {
            const next = new Map(this.entries);
            apply(next);
            await this.persist(next);
            this.entries = next;
        });
        this.writes = operation.catch(() => undefined);
        return operation;
    }

    private async persist(entries: Map<string, CloudAttachmentEvictionRecord>): Promise<void> {
        const serialized = JSON.stringify({
            version: JOURNAL_VERSION,
            entries: Array.from(entries.values()),
        });
        const adapter = this.plugin.app.vault.adapter;
        const temporary = `${this.indexPath}.tmp`;
        // 先写 .tmp 再原子重命名；个别平台不允许覆盖已存在目标，回退为覆盖写
        // Write .tmp first, then atomically rename; some platforms refuse to overwrite, fall back
        await adapter.write(temporary, serialized);
        try {
            await adapter.rename(temporary, this.indexPath);
        } catch {
            await adapter.write(this.indexPath, serialized);
            if (await adapter.exists(temporary)) await adapter.remove(temporary);
        }
    }
}
