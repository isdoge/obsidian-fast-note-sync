/**
 * 配置通道内容编解码（与服务端 v3.8.1 逐字节一致） / Config-channel content codec
 * (byte-for-byte compatible with server v3.8.1)
 *
 * 历史配置通道只按 UTF-8 文本传输，遇到 PNG/JPG/WOFF2 等二进制资源时会被破坏或跳过。
 * 本模块用带前缀的纯文本信封承载二进制与转义文本：
 * - 二进制：`fns-bin-v1:b64:<base64>`
 * - 文本：原文；若原文本身以 `fns-bin-v1:` 开头，则写成 `fns-bin-v1:esc:<原文>`
 * 普通 JSON/CSS/JS 等文本不增加任何前缀，保持零变化。
 *
 * The historical config channel only carried UTF-8 text and corrupted or skipped binary
 * assets such as PNG/JPG/WOFF2. This module wraps them in prefixed text envelopes:
 * - binary: `fns-bin-v1:b64:<base64>`
 * - text: as-is; text already starting with `fns-bin-v1:` becomes `fns-bin-v1:esc:<text>`
 * Plain JSON/CSS/JS text is passed through unchanged.
 */

export const CONFIG_BINARY_ENVELOPE_PREFIX = "fns-bin-v1:"
export const CONFIG_BINARY_B64_PREFIX = "fns-bin-v1:b64:"
export const CONFIG_BINARY_ESC_PREFIX = "fns-bin-v1:esc:"

export type DecodedConfigContent =
    | { kind: "binary"; bytes: ArrayBuffer }
    | { kind: "text"; text: string }

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// 解码查表：-1 表示非法字符 / Decode lookup table; -1 marks an invalid character
const BASE64_LOOKUP: Int16Array = (() => {
    const table = new Int16Array(128).fill(-1)
    for (let i = 0; i < BASE64_ALPHABET.length; i++) table[BASE64_ALPHABET.charCodeAt(i)] = i
    return table
})()

const toUint8Array = function (buf: ArrayBuffer | Uint8Array): Uint8Array {
    if (ArrayBuffer.isView(buf)) {
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    }
    return new Uint8Array(buf)
}

/**
 * 分块把字节转 Base64：避免 `String.fromCharCode(...bytes)` 在数 MB 数组上爆调用栈。
 * Chunked byte->Base64 conversion: avoids blowing the call stack with
 * `String.fromCharCode(...bytes)` on multi-megabyte arrays.
 */
export const bytesToBase64 = function (bytes: Uint8Array): string {
    const len = bytes.length
    // 24576 = 8192 * 3，保证除最后一块外每个分块都完整覆盖 3 字节组
    // 24576 = 8192 * 3 so every chunk except the last covers whole 3-byte groups
    const chunkSize = 24576
    let out = ""
    for (let start = 0; start < len; start += chunkSize) {
        const end = Math.min(len, start + chunkSize)
        const parts: string[] = []
        let i = start
        for (; i + 2 < end; i += 3) {
            const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
            parts.push(
                BASE64_ALPHABET[(n >> 18) & 63] +
                BASE64_ALPHABET[(n >> 12) & 63] +
                BASE64_ALPHABET[(n >> 6) & 63] +
                BASE64_ALPHABET[n & 63]
            )
        }
        if (i < end) {
            const b0 = bytes[i]
            const b1 = i + 1 < end ? bytes[i + 1] : 0
            parts.push(
                BASE64_ALPHABET[b0 >> 2] +
                BASE64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)] +
                (i + 1 < end ? BASE64_ALPHABET[(b1 & 15) << 2] : "=") +
                "="
            )
        }
        out += parts.join("")
    }
    return out
}

/**
 * Base64 解码（忽略空白字符，其他非法字符抛错）
 * Base64 decode (whitespace ignored; other invalid characters throw)
 */
export const base64ToBytes = function (base64: string): Uint8Array {
    const maxLen = Math.floor((base64.length * 3) / 4) + 3
    const out = new Uint8Array(maxLen)
    let buffer = 0
    let bits = 0
    let written = 0
    for (let i = 0; i < base64.length; i++) {
        const code = base64.charCodeAt(i)
        if (code === 61 /* '=' */) break
        if (code === 32 || code === 9 || code === 10 || code === 13) continue
        const value = code < 128 ? BASE64_LOOKUP[code] : -1
        if (value < 0) throw new Error(`Invalid base64 character at index ${i}`)
        buffer = (buffer << 6) | value
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out[written++] = (buffer >> bits) & 0xff
        }
    }
    return written === out.length ? out : out.slice(0, written)
}

/**
 * 把配置文件的原始字节编码为可放进文本字段的字符串。
 * 普通文本原样返回；二进制（含 NUL 或严格 UTF-8 解码失败）走 Base64；
 * 以 `fns-bin-v1:` 开头的普通文本做一次转义，避免与服务端信封冲突。
 *
 * Encode raw config-file bytes into a string suitable for the text field.
 * Plain text passes through; binary (contains NUL or fails strict UTF-8 decoding) is
 * Base64-wrapped; plain text that starts with `fns-bin-v1:` is escaped so it cannot be
 * mistaken for an envelope.
 */
export const encodeConfigContent = function (buf: ArrayBuffer | Uint8Array): string {
    const bytes = toUint8Array(buf)

    let hasNul = false
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) {
            hasNul = true
            break
        }
    }

    let text: string | null = null
    if (!hasNul) {
        try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        } catch {
            text = null
        }
    }

    if (text === null) {
        return CONFIG_BINARY_B64_PREFIX + bytesToBase64(bytes)
    }
    if (text.startsWith(CONFIG_BINARY_ENVELOPE_PREFIX)) {
        return CONFIG_BINARY_ESC_PREFIX + text
    }
    return text
}

/**
 * 解码服务端或发送端编码后的配置内容。
 * Decode config content produced by the sender.
 */
export const decodeConfigContent = function (encoded: string): DecodedConfigContent {
    if (encoded.startsWith(CONFIG_BINARY_B64_PREFIX)) {
        const bytes = base64ToBytes(encoded.slice(CONFIG_BINARY_B64_PREFIX.length))
        return {
            kind: "binary",
            bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        }
    }
    if (encoded.startsWith(CONFIG_BINARY_ESC_PREFIX)) {
        return { kind: "text", text: encoded.slice(CONFIG_BINARY_ESC_PREFIX.length) }
    }
    return { kind: "text", text: encoded }
}
