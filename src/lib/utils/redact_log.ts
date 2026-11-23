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
export function redactDiagnosticText(text: string): string {
    if (typeof text !== "string") return text;
    return text
        .replace(PRIVATE_KEY_BLOCK_RE, "[redacted private key]")
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

function describeError(error: Error): string {
    const name = error.name || "Error";
    const message = redactDiagnosticText(error.message ?? "");
    const header = `${name}: ${message}`;
    let stack = error.stack ? redactDiagnosticText(String(error.stack)) : "";
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
    const visit = (item: unknown, key = ""): unknown => {
        if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
        if (key && CONTENT_KEY.test(key)) return "[content omitted]";
        if (item instanceof Error) return describeError(item);
        if (isBinary(item)) return "[binary omitted]";
        if (typeof item === "string") {
            const trimmed = item.trimStart();
            // 日志里的对象通常已被 safeStringify 成 JSON：解析后再按字段脱敏，避免正文被当普通文本保留
            // Objects in logs are often pre-stringified JSON: parse first so body fields can be omitted
            if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
                try { return visit(JSON.parse(item) as unknown); } catch { /* ordinary diagnostic text */ }
            }
            return redactDiagnosticText(item);
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
