/**
 * 诊断日志脱敏。
 * Diagnostic log redaction.
 *
 * 用户把调试日志复制/导出给开发者时，日志里常带有 API token、Bearer/JWT 凭据、
 * 笔记正文和附件二进制。这里在日志写入与导出出口统一脱敏：凭据替换为占位符，
 * 正文与二进制整段省略，但 Error 的 name / message / stack 仍然保留（仅做文本脱敏），
 * 以便排障信息不丢失。
 *
 * Diagnostic logs pasted into issue reports regularly contain API tokens, Bearer/JWT
 * credentials, note bodies and attachment bytes. Redaction runs on both the write path and
 * the export/copy path: credentials become placeholders, bodies and binary payloads are
 * omitted, while an Error's name / message / stack survive (textually redacted) so the
 * diagnostics remain useful.
 *
 * 参考 / Reference: OPENSB obsidian-fast-note-sync-safety `src/lib/utils/redact_log.ts`
 * (Apache-2.0). This implementation keeps Error stacks and handles Map/Set and cycles.
 */

/** 命中这些键名时整体替换 / Replaced as a whole when a key matches */
const SENSITIVE_KEY = /^(?:[a-z0-9]+[_-])*(?:api[_-]?token|access[_-]?token|authorization|password|passwd|pwd|secret|cookie|private[_-]?key|api[_-]?key|credentials?|token)$/i;

/** 命中这些键名时省略正文 / Body content is omitted when a key matches */
const CONTENT_KEY = /^(?:content|body|local[_-]?content|remote[_-]?content|note[_-]?content|diffs)$/i;

/**
 * 文本里嵌入的 JSON 正文字段：键名与 CONTENT_KEY 中的字符串型正文键一致，值整体省略。
 * 结尾的 `"?` 有意允许字符串没有闭合引号（上游文本已被截断），此时一直省略到文本末尾。
 * Body fields inside pre-stringified JSON text (same string keys as CONTENT_KEY): the value is
 * omitted wholesale. The trailing `"?` deliberately allows an unterminated value (upstream text
 * was truncated) and then swallows the rest of the text.
 */
const CONTENT_JSON_FIELD_RE = /("(?:content|body|local[_-]?content|remote[_-]?content|note[_-]?content)"\s*[:：]\s*)"(?:[^"\\]|\\.)*"?/gi;

/** 库名字段：`vault` / `vaultName` / `vault_name` / `remoteVault` 等 / Vault-name keys */
const VAULT_KEY = /^(?:(?:remote|local|target|source)[_-]?)?vault(?:[_-]?name)?$/i;
/** JSON 字符串里的库名字段 / Vault-name fields inside pre-stringified JSON */
const VAULT_JSON_FIELD_RE = new RegExp(`("(?:(?:remote|local|target|source)[_-]?)?vault(?:[_-]?name)?"\\s*[:：]\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi");
/** URL 查询串里的库名参数 / Vault-name query parameter */
const VAULT_QUERY_RE = /([?&]vault=)([^&#\s"']+)/gi;

const PLACEHOLDER_VAULT_PATH = "[vault-path]";
const PLACEHOLDER_SERVER = "[server]";
const PLACEHOLDER_VAULT = "[vault]";
const PLACEHOLDER_USER = "[user]";

/** 脱敏时可用的运行时上下文（路径、库名、服务器地址） / Runtime redaction context */
export interface DiagnosticRedactionContext {
    /** 当前库的磁盘绝对路径；移动端取不到时留空 / Vault base path; omitted on mobile */
    vaultPath?: string;
    /** 当前配置的库名 / Configured vault name */
    vaultName?: string;
    /** 服务地址（可带协议与路径）或裸主机名 / Server URLs or bare host names */
    serverHosts?: readonly string[];
}

type DiagnosticRedactionContextProvider = () => DiagnosticRedactionContext | null | undefined;

let redactionContextProvider: DiagnosticRedactionContextProvider | null = null;

/**
 * 注册脱敏上下文提供者。每次脱敏时现取，用户中途改设置也能按新值遮住。
 * 传 null / undefined 清除，回到只做凭据脱敏的旧行为。
 *
 * Register the redaction-context provider. It is read on every redaction, so mid-session
 * setting changes are honoured. Passing null/undefined restores credential-only redaction.
 */
export function setDiagnosticRedactionContext(provider?: DiagnosticRedactionContextProvider | null): void {
    redactionContextProvider = typeof provider === "function" ? provider : null;
}

function currentRedactionContext(): DiagnosticRedactionContext | null {
    if (!redactionContextProvider) return null;
    try {
        const context = redactionContextProvider();
        return context && typeof context === "object" ? context : null;
    } catch {
        return null;
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTrailingSeparators(value: string): string {
    return value.replace(/[\\/]+$/, "");
}

/** 生成库绝对路径的各种写法：正/反斜杠、百分号编码、file:// 前缀由正则统一处理 */
function buildVaultPathVariants(vaultPath: string): string[] {
    const raw = vaultPath.trim();
    if (!raw) return [];
    const forward = stripTrailingSeparators(raw.replace(/\\/g, "/"));
    const backward = stripTrailingSeparators(raw.replace(/\//g, "\\"));
    const variants = new Set<string>();
    const add = (value: string) => {
        if (!value || !value.trim()) return;
        // 根目录或盘符根做前缀会把日志里所有位置都替换掉
        if (value === "/" || /^[a-z]:$/i.test(value)) return;
        variants.add(value);
    };
    for (const base of [forward, backward]) {
        add(base);
        // file:///C:/... 在盘符路径前会多一个斜杠
        if (/^[a-z]:[\\/]/i.test(base)) add(`/${base}`);
        const uriEncoded = encodeURI(base);
        const componentEncoded = encodeURIComponent(base);
        add(uriEncoded);
        add(componentEncoded);
        add(uriEncoded.replace(/%20/g, "+"));
        add(componentEncoded.replace(/%20/g, "+"));
        add(uriEncoded.replace(/%[0-9A-F]{2}/g, match => match.toLowerCase()));
        add(componentEncoded.replace(/%[0-9A-F]{2}/g, match => match.toLowerCase()));
    }
    // 长前缀优先，避免短路径先命中长路径的一部分
    return Array.from(variants).sort((left, right) => right.length - left.length);
}

function redactVaultPath(text: string, vaultPath: string): string {
    const variants = buildVaultPathVariants(vaultPath);
    if (variants.length === 0) return text;
    const alternation = variants.map(escapeRegExp).join("|");
    const re = new RegExp(
        `(^|[^A-Za-z0-9_.\\/-])(?:file:\\/\\/)?(?:${alternation})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`,
        "gi",
    );
    return text.replace(re, (_match, prefix: string) => `${prefix}${PLACEHOLDER_VAULT_PATH}`);
}

/** 非库路径里的用户名：`/Users/x/`、`/home/x/`、`C:\Users\x\`、`C:/Users/x/` */
const POSIX_HOME_USER_RE = /(\/(?:Users|home)\/)(?!\[user\])([^\\/\s"'<>|:,;)\]}]+)/gi;
const WINDOWS_HOME_USER_RE = /([A-Za-z]:[\\/]Users[\\/])(?!\[user\])([^\\/\s"'<>|:,;)\]}]+)/gi;

function redactUserPaths(text: string): string {
    return text
        .replace(POSIX_HOME_USER_RE, (_match, prefix: string) => `${prefix}${PLACEHOLDER_USER}`)
        .replace(WINDOWS_HOME_USER_RE, (_match, prefix: string) => `${prefix}${PLACEHOLDER_USER}`);
}

function normalizeHost(value: string): string {
    return value.trim().replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}

function isPlausibleHost(host: string): boolean {
    if (host.length < 2 || /\s/.test(host)) return false;
    // IPv6 字面量 / IPv6 literal
    if (host.includes(":")) return /^[0-9a-f:]+$/i.test(host);
    // 允许 `+`、括号等字符，转义后进正则不会出错 / Allow escaped regex metacharacters
    return /^[a-z0-9][a-z0-9._+()%-]*[a-z0-9]$/i.test(host);
}

/** 从地址、主机名或多行配置里取出主机名（去掉协议、路径、端口） */
function extractServerHost(value: unknown): string {
    if (typeof value !== "string") return "";
    const raw = value.trim();
    if (!raw) return "";
    if (typeof URL === "function" && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
        try { return normalizeHost(new URL(raw).hostname); } catch { /* fall through */ }
    }
    let rest = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\/\//, "");
    rest = rest.replace(/^[^@/?#\s]*@/, "");
    rest = rest.split(/[/?#\s]/)[0] || "";
    if (rest.startsWith("[")) {
        const end = rest.indexOf("]");
        if (end > 1) return normalizeHost(rest.slice(1, end));
    }
    const firstColon = rest.indexOf(":");
    if (firstColon > 0 && rest.indexOf(":", firstColon + 1) === -1 && /^\d+$/.test(rest.slice(firstColon + 1))) {
        rest = rest.slice(0, firstColon);
    }
    return normalizeHost(rest);
}

function buildServerHosts(serverHosts: readonly string[] | undefined): string[] {
    const hosts = new Set<string>();
    for (const entry of serverHosts ?? []) {
        const host = extractServerHost(entry);
        if (isPlausibleHost(host)) hosts.add(host);
    }
    return Array.from(hosts).sort((left, right) => right.length - left.length);
}

function redactServerHosts(text: string, serverHosts: readonly string[] | undefined): string {
    const hosts = buildServerHosts(serverHosts);
    if (hosts.length === 0) return text;
    let result = text;
    for (const host of hosts) {
        const pattern = host.includes(":") ? `\\[${escapeRegExp(host)}\\]` : escapeRegExp(host);
        // 先替换带协议头的地址，保留协议与后面的接口路径（userinfo 也保留）
        const urlRe = new RegExp(
            `((?:https?|wss?):\\/\\/)([^\\/\\s"'<>@]*@)?(?:${pattern})(?::\\d{1,5})?(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`,
            "gi",
        );
        result = result.replace(urlRe, (_match, scheme: string, userinfo: string | undefined) =>
            `${scheme}${userinfo ?? ""}${PLACEHOLDER_SERVER}`);
        // 再替换裸主机名（报错信息里的 ENOTFOUND / ECONNREFUSED 等）
        const bareRe = new RegExp(
            `(^|[^A-Za-z0-9_.-])(?:${pattern})(?::\\d{1,5})?(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`,
            "gi",
        );
        result = result.replace(bareRe, (_match, prefix: string) => `${prefix}${PLACEHOLDER_SERVER}`);
    }
    return result;
}

function isWordChar(char: string | undefined): boolean {
    return !!char && /[A-Za-z0-9_\u4e00-\u9fff]/.test(char);
}

/**
 * 自由文本里的库名：整词相等才替换。`doge-notes.md` 里只作为文件名一部分出现的库名不替换，
 * 单独出现的库名仍替换。
 */
function redactVaultNameInText(text: string, vaultName: string): string {
    const name = vaultName.trim();
    if (!name) return text;
    const re = new RegExp(`(^|[^A-Za-z0-9_\\u4e00-\\u9fff])(${escapeRegExp(name)})(?![A-Za-z0-9_\\u4e00-\\u9fff])`, "g");
    return text.replace(re, (match: string, prefix: string, _name: string, offset: number) => {
        const start = offset + prefix.length;
        const end = start + name.length;
        const prev = start > 0 ? text[start - 1] : "";
        const prev2 = start > 1 ? text[start - 2] : "";
        const next = text[end] ?? "";
        const next2 = text[end + 1] ?? "";
        // 文件名/标识符的一部分（doge-notes.md、my-doge）不替换
        if ((prev === "-" || prev === ".") && isWordChar(prev2)) return match;
        if ((next === "-" || next === ".") && isWordChar(next2)) return match;
        // 已经是占位符，避免 `[vault]` 变成 `[[vault]]`
        if (prev === "[" && next === "]") return match;
        // JSON 键名本身（"vault":）不替换；对应的值已由字段规则处理
        if (prev === '"' && next === '"' && /^\s*[:：]/.test(text.slice(end + 1))) return match;
        return `${prefix}${PLACEHOLDER_VAULT}`;
    });
}

function redactWithContext(text: string, context: DiagnosticRedactionContext | null): string {
    if (!context) return text;
    const vaultPath = typeof context.vaultPath === "string" ? context.vaultPath : "";
    const vaultName = typeof context.vaultName === "string" ? context.vaultName.trim() : "";
    let result = text;
    if (vaultPath.trim()) result = redactVaultPath(result, vaultPath);
    result = redactUserPaths(result);
    result = redactServerHosts(result, context.serverHosts);
    if (vaultName) {
        result = result.replace(VAULT_QUERY_RE, `$1${PLACEHOLDER_VAULT}`);
        result = result.replace(VAULT_JSON_FIELD_RE, `$1"${PLACEHOLDER_VAULT}"`);
        result = redactVaultNameInText(result, vaultName);
        // 库名含空格 / 中文时，网址路径里出现的是编码形式（`Private Vault` -> `Private%20Vault`）
        // A vault name with spaces or non-ASCII text appears URL-encoded in paths
        let encodedVaultName = "";
        try { encodedVaultName = encodeURIComponent(vaultName); } catch { /* 孤立代理项等无法编码的库名：跳过 */ }
        if (encodedVaultName && encodedVaultName !== vaultName) {
            result = result.replace(new RegExp(escapeRegExp(encodedVaultName), "gi"), PLACEHOLDER_VAULT);
        }
    }
    return result;
}

/** 凭据类字段名（可带 `x-` 之类前缀）；Authorization/Cookie 单独处理，见下 */
const CREDENTIAL_NAME = "(?:[a-z0-9]+[_-])*(?:api[_-]?token|access[_-]?token|password|passwd|pwd|secret|private[_-]?key|api[_-]?key|credentials?|token)";

const URL_PARAM_RE = /([?&](?:token|api[_-]?token|access[_-]?token|authorization|password|passwd|secret|cookie|private[_-]?key|api[_-]?key)=)[^&#\s"']*/gi;
const JSON_FIELD_RE = new RegExp(`("(?:[a-z0-9]+[_-])*(?:api[_-]?token|access[_-]?token|authorization|password|passwd|pwd|secret|cookie|private[_-]?key|api[_-]?key|credentials?|token)"\\s*[:：]\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi");
/** Cookie 头整行值全部脱敏（一个头里可能带多个 cookie） / Redact the whole Cookie header value */
const COOKIE_HEADER_RE = /\b(cookie)\s*[:：][ \t]*[^\r\n]*/gi;
/** Authorization 头：方案名后的整段凭据替换，不能留下 `[redacted] <原凭据>` / Replace the whole credential after the scheme */
const AUTH_SCHEME_RE = /\b(authorization)\s*[:：]\s*([A-Za-z][A-Za-z0-9._~+/-]*)[ \t]+([^\s,;"'&]+)/gi;
/** 无方案名的 Authorization 头（`Authorization: abc`）；已带方案名的由 AUTH_SCHEME_RE 处理 */
const AUTH_SINGLE_RE = /\b(authorization)\s*[:：]\s*(?!\[redacted\])(?![A-Za-z][A-Za-z0-9._~+/-]*\s)([^\s,;"'&]+)/gi;
/** `token: xxx` / `apiToken：xxx` / `x-api-token: xxx`，含全角冒号 */
const COLON_FIELD_RE = new RegExp(`\\b(${CREDENTIAL_NAME})([ \\t]*[:：][ \\t]*)(?![ \\t]*\\[redacted\\])(?![ \\t]*Bearer[ \\t]+\\[redacted\\])(?:"(?:[^"\\\\]|\\\\.)*"|[^\\s,;"'&]+)`, "gi");
/** URL userinfo：`//user:pass@host` 只替换密码 / Only the password in URL userinfo is replaced */
const URL_USERINFO_RE = /(\/\/[^/\s:@]+:)([^/\s@]*)@/g;
const KEY_VALUE_RE = /\b(token|api[_-]?token|access[_-]?token|authorization|password|passwd|secret|cookie|private[_-]?key)\s*=\s*(?!\[redacted\])[^\s&#,;"'[\]]+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** 文本级脱敏：URL 参数与 userinfo、JSON 字段、Authorization/Cookie、Bearer、JWT、私钥块 */
function redactCredentialText(text: string): string {
    return text
        .replace(PRIVATE_KEY_BLOCK_RE, "[redacted private key]")
        .replace(CONTENT_JSON_FIELD_RE, '$1"[content omitted]"')
        .replace(URL_PARAM_RE, "$1[redacted]")
        .replace(URL_USERINFO_RE, "$1[redacted]@")
        .replace(JSON_FIELD_RE, (_match, prefix: string) => `${prefix}"[redacted]"`)
        .replace(COOKIE_HEADER_RE, (_match, name: string) => `${name}: [redacted]`)
        .replace(AUTH_SCHEME_RE, (_match, name: string, scheme: string) => `${name}: ${scheme} [redacted]`)
        .replace(AUTH_SINGLE_RE, (_match, name: string) => `${name}: [redacted]`)
        .replace(BEARER_RE, "Bearer [redacted]")
        .replace(JWT_RE, "[redacted token]")
        .replace(COLON_FIELD_RE, (_match, name: string, separator: string) => `${name}${separator}[redacted]`)
        .replace(KEY_VALUE_RE, "$1=[redacted]");
}

function redactDiagnosticTextWithContext(text: string, context: DiagnosticRedactionContext | null): string {
    if (typeof text !== "string") return text;
    return redactWithContext(redactCredentialText(text), context);
}

/**
 * 文本级脱敏：凭据 + 运行时上下文（库路径、用户名、服务器地址、库名）。
 * 未注册上下文时只做凭据脱敏，与原行为一致。
 */
export function redactDiagnosticText(text: string): string {
    return redactDiagnosticTextWithContext(text, currentRedactionContext());
}

function describeError(error: Error, context: DiagnosticRedactionContext | null): string {
    const name = error.name || "Error";
    const message = redactDiagnosticTextWithContext(error.message ?? "", context);
    const header = `${name}: ${message}`;
    let stack = error.stack ? redactDiagnosticTextWithContext(String(error.stack), context) : "";
    // stack 的第一行通常就是错误头，去掉避免重复 / Drop the duplicated header line
    if (stack.startsWith(header)) stack = stack.slice(header.length).replace(/^\n/, "");
    return stack ? `${header}\n${stack}` : header;
}

function isBinary(value: unknown): boolean {
    if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return true;
    return typeof ArrayBuffer !== "undefined" && typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(value);
}

/**
 * 诊断对象转字符串：保留排障信息，同时去掉凭据、正文与二进制。
 * Format a diagnostic value without credentials, note bodies or binary payloads.
 */
export function formatDiagnostic(value: unknown): string {
    const seen = new WeakSet<object>();
    const context = currentRedactionContext();
    const vaultName = typeof context?.vaultName === "string" ? context.vaultName.trim() : "";
    const visit = (item: unknown, key = ""): unknown => {
        if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
        if (key && CONTENT_KEY.test(key)) return "[content omitted]";
        if (key && vaultName && VAULT_KEY.test(key)) return PLACEHOLDER_VAULT;
        if (item instanceof Error) return describeError(item, context);
        if (isBinary(item)) return "[binary omitted]";
        if (typeof item === "string") {
            const trimmed = item.trimStart();
            // 日志里的对象通常已被 safeStringify 成 JSON：解析后再按字段脱敏，避免正文被当普通文本保留
            // Objects in logs are often pre-stringified JSON: parse first so body fields can be omitted
            if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
                try { return visit(JSON.parse(item) as unknown); } catch { /* ordinary diagnostic text */ }
            }
            return redactDiagnosticTextWithContext(item, context);
        }
        if (typeof item === "bigint") return String(item);
        if (typeof item === "function") {
            const fn = item as { name?: string };
            return `[Function ${fn.name || "anonymous"}]`;
        }
        if (item && typeof item === "object") {
            if (seen.has(item)) return "[circular]";
            seen.add(item);
            if (Array.isArray(item)) return item.map(entry => visit(entry));
            if (item instanceof Map) {
                return Array.from(item.entries()).map(([mapKey, mapValue]) =>
                    [visit(mapKey), visit(mapValue, typeof mapKey === "string" ? mapKey : "")]);
            }
            if (item instanceof Set) return Array.from(item.values()).map(entry => visit(entry));
            return Object.fromEntries(Object.entries(item).map(([entryKey, entryValue]) => [entryKey, visit(entryValue, entryKey)]));
        }
        return item;
    };
    const result = visit(value);
    if (typeof result === "string") return result;
    try {
        const serialized = JSON.stringify(result);
        return serialized === undefined ? String(result) : serialized;
    } catch {
        return "[unserializable]";
    }
}
