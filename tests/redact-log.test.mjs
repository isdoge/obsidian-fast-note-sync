import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Diagnostics copied from the debug-log modal are pasted into public issue reports. Credentials,
// note bodies and binary payloads must never leave the device, while Error name/message/stack
// must survive (textually redacted) for troubleshooting.
const root = path.resolve(import.meta.dirname, '..');
const redactModule = load('src/lib/utils/redact_log.ts');

function load(relPath, extra = {}) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, Map, Set, WeakSet, ArrayBuffer, Uint8Array, Error, JSON, Object, String, Number, Date, BigInt,
    require(id) {
      if (id === './redact_log') return redactModule;
      if (id in extra) return extra[id];
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename: sourcePath });
  return module.exports;
}

const { redactDiagnosticText, formatDiagnostic } = redactModule;
assert.equal(typeof redactDiagnosticText, 'function');
assert.equal(typeof formatDiagnostic, 'function');

// Build test secrets at runtime so no literal credential-like string lives in the repo.
const s1 = ['abc', '123'].join('');
const s2 = ['top', 'secret'].join('');
const s3 = ['url', 'secret'].join('');
const s4 = ['pk', 'value'].join('');
const bearer = ['abc', 'def', 'ghi'].join('.');
const jwtHeader = ['eyJ', 'hbGciOiJIUzI1NiJ9'].join('');
const jwtPayload = ['eyJ', 'zdWIiOiIxMjMifQ'].join('');
const jwt = [jwtHeader, jwtPayload, 'c2lnbmF0dXJl'].join('.');

// 1. URL parameters and header-like text
{
  const text = [
    `GET https://api.example.com/sync?vault=v&token=${s1}`,
    `https://api.example.com/sync?apiToken=${s2}`,
    `https://api.example.com/x?authorization=Basic%20Zm9v&password=p%40ss`,
    `https://api.example.com/x?secret=${s3}`,
    `https://api.example.com/x?cookie=cookievalue&privateKey=${s4}`,
    `plain token=${s1}`,
  ].join('\n');
  const redacted = redactDiagnosticText(text);
  for (const secret of [s1, s2, s3, s4, 'Zm9v', 'p%40ss', 'cookievalue']) {
    assert.ok(!redacted.includes(secret), `secret must be redacted: ${secret}`);
  }
  assert.ok(redacted.includes('token=[redacted]'));
  assert.ok(redacted.includes('apiToken=[redacted]'));
  assert.ok(redacted.includes('privateKey=[redacted]'));
}

// 2. Bearer tokens and JWTs (URL or plain text)
{
  const redacted = redactDiagnosticText(`Authorization: Bearer ${bearer} token=${jwt} ${jwt}`);
  assert.ok(!redacted.includes(bearer), 'bearer token is redacted');
  assert.ok(redacted.includes('Bearer [redacted]'));
  assert.ok(!redacted.includes(jwtHeader), 'JWT is redacted');
}

// 3. Sensitive object keys, including nested and JSON-string logs
{
  const output = formatDiagnostic({
    path: 'a.png',
    token: s1,
    apiToken: s2,
    nested: { access_token: s3, privateKey: s4, password: 'pass-value', cookie: 'cookie-value', secret: 'secret-value' },
    ok: 'kept',
  });
  for (const secret of [s1, s2, s3, s4, 'pass-value', 'cookie-value', 'secret-value']) {
    assert.ok(!output.includes(secret), `object secret must be redacted: ${secret}`);
  }
  assert.ok(output.includes('"path":"a.png"'));
  assert.ok(output.includes('"ok":"kept"'));

  const jsonLog = JSON.stringify({ path: 'b.png', token: s1, content: 'note body' });
  const fromString = formatDiagnostic(jsonLog);
  assert.ok(!fromString.includes(s1));
  assert.ok(!fromString.includes('note body'));
  assert.ok(fromString.includes('[content omitted]'));
}

// 4. Note bodies are omitted for every known field name
{
  const omitted = formatDiagnostic({
    content: 'note body',
    body: 'body text',
    localContent: 'local body',
    remoteContent: 'remote body',
    noteContent: 'note content',
    diffs: [{ Text: 'diff text' }],
    path: 'keep.md',
  });
  for (const body of ['note body', 'body text', 'local body', 'remote body', 'note content', 'diff text']) {
    assert.ok(!omitted.includes(body), `body must be omitted: ${body}`);
  }
  assert.ok(omitted.includes('[content omitted]'));
  assert.ok(omitted.includes('keep.md'));
}

// 5. Binary payloads are omitted
{
  assert.equal(formatDiagnostic(new Uint8Array([1, 2, 3, 4]).buffer), '[binary omitted]');
  assert.equal(formatDiagnostic(new Uint8Array([9, 9, 9])), '[binary omitted]');
  assert.ok(!formatDiagnostic({ file: new Uint8Array([7, 7, 7]) }).includes('7,7,7'));
}

// 6. Errors keep name, message and stack, with secrets redacted inside them
{
  const error = new Error(`request failed for token=${s1}`);
  error.stack = `Error: request failed for token=${s1}\n    at send (sync.ts:10:3)`;
  const output = formatDiagnostic(error);
  assert.ok(output.startsWith('Error: request failed for token=[redacted]'), output);
  assert.ok(output.includes('at send (sync.ts:10:3)'), 'stack must survive');
  assert.ok(!output.includes(s1));
  assert.ok(!output.includes('\nError: request failed'), 'error header must not be duplicated');

  const named = new Error('bad');
  named.name = 'HashError';
  assert.ok(formatDiagnostic(named).startsWith('HashError: bad'));
}

// 7. Cycles do not throw and are marked
{
  const cyclic = { path: 'x.png' };
  cyclic.self = cyclic;
  const output = formatDiagnostic(cyclic);
  assert.ok(output.includes('"path":"x.png"'));
  assert.ok(output.includes('[circular]'));
  const arrayCycle = [];
  arrayCycle.push(arrayCycle);
  assert.ok(formatDiagnostic(arrayCycle).includes('[circular]'));
}

// 8. DebugLogManager redacts on write and on export
{
  const manager = load('src/lib/utils/debug_log_manager.ts').DebugLogManager;
  const instance = manager.getInstance();
  instance.clearLogs();
  instance.addLog(`token=${s1}`, { content: 'note body', password: 'pass-value' }, new Error(`Bearer ${bearer}`));
  const stored = instance.getLogs().join('\n');
  const exported = instance.getRedactedLogs().join('\n');
  for (const text of [stored, exported]) {
    assert.ok(!text.includes(s1));
    assert.ok(!text.includes('note body'));
    assert.ok(!text.includes('pass-value'));
    assert.ok(!text.includes(bearer));
  }
  assert.ok(exported.includes('Bearer [redacted]'));
}

// 9. `name: value` colon forms, auth schemes, whole Cookie header and URL userinfo
{
  const secret = (n) => ['s3cr', 'et-', n, '-', Math.random().toString(36).slice(2)].join('');
  const colon = secret('colon');
  const apiToken = secret('apitoken');
  const xApi = secret('xapi');
  const xApiUpper = secret('xapiupper');
  const fullWidth = secret('fullwidth');
  const jsonToken = secret('json');
  const basic = secret('basic');
  const tokenScheme = secret('scheme');
  const lowerScheme = secret('lower');
  const cookie1 = secret('cookie1');
  const cookie2 = secret('cookie2');
  const userinfo = secret('userinfo');

  const text = [
    `token: ${colon}`,
    `apiToken: ${apiToken}`,
    `x-api-token: ${xApi}`,
    `X-Api-Token: ${xApiUpper}`,
    `token：${fullWidth}`,
    `{"x-api-token":"${jsonToken}"}`,
    `Authorization: Basic ${basic}`,
    `Authorization: Token ${tokenScheme}`,
    `authorization: token ${lowerScheme}`,
    `Cookie: sid=${cookie1}; theme=${cookie2}`,
    `https://user:${userinfo}@host.example/x`,
  ].join('\n');
  const redacted = redactDiagnosticText(text);
  for (const value of [colon, apiToken, xApi, xApiUpper, fullWidth, jsonToken, basic, tokenScheme, lowerScheme, cookie1, cookie2, userinfo]) {
    assert.ok(!redacted.includes(value), `secret must be redacted: ${value}`);
  }
  assert.ok(redacted.includes(`token: [redacted]`), 'colon form is redacted');
  assert.ok(redacted.includes(`apiToken: [redacted]`));
  assert.ok(redacted.includes(`x-api-token: [redacted]`));
  assert.ok(redacted.includes(`X-Api-Token: [redacted]`));
  assert.ok(redacted.includes(`token：[redacted]`), 'full-width colon keeps its separator');
  assert.ok(redacted.includes(`"x-api-token":"[redacted]"`), 'JSON field with a header-style key is redacted');
  assert.ok(redacted.includes('Authorization: Basic [redacted]'), 'scheme name survives, credential does not');
  assert.ok(redacted.includes('Authorization: Token [redacted]'));
  assert.ok(redacted.includes('authorization: token [redacted]'));
  assert.ok(!redacted.includes('[redacted] ' + basic), 'scheme credential must not follow the placeholder');
  assert.ok(redacted.includes('Cookie: [redacted]'), 'the whole Cookie header is replaced');
  assert.ok(!redacted.includes('theme='), 'later cookies in the header do not survive');
  assert.ok(redacted.includes('https://user:[redacted]@host.example/x'), 'URL userinfo password is replaced');

  // Bearer keeps its existing behaviour
  const bearerRedacted = redactDiagnosticText(`Authorization: Bearer ${bearer}`);
  assert.ok(bearerRedacted.includes('Authorization: Bearer [redacted]'));

  // Object keys written like headers are redacted too
  const objectOut = formatDiagnostic({ 'x-api-token': xApi, headers: { 'X-Api-Token': xApiUpper } });
  assert.ok(!objectOut.includes(xApi) && !objectOut.includes(xApiUpper));
}

// 10. Body fields embedded in free-form text (prefixed / truncated JSON) are omitted too
{
  const marker = ['PRIVATE', 'NOTE', 'BODY', 'TEST'].join('_');

  const closed = redactDiagnosticText(`Code=500 details={"content":"${marker}"}`);
  assert.ok(!closed.includes(marker), 'embedded JSON content value is omitted');
  assert.ok(closed.includes('Code=500'), 'the diagnostic context survives');
  assert.ok(closed.includes('"content":"[content omitted]"'), 'the body key is kept, the value replaced');

  const unclosed = redactDiagnosticText(`Code=500 details={"content":"${marker}`);
  assert.ok(!unclosed.includes(marker), 'an unterminated body value (truncated upstream) is omitted too');
  assert.ok(unclosed.includes('Code=500'), 'the diagnostic context survives for the truncated form');

  for (const field of ['body', 'localContent', 'local_content', 'local-content', 'remoteContent', 'remote_content', 'remote-content', 'noteContent', 'note_content', 'note-content']) {
    const out = redactDiagnosticText(`x={"${field}":"${marker}"}`);
    assert.ok(!out.includes(marker), `embedded ${field} value is omitted`);
  }

  // Ordinary text without sensitive values or body keys is unchanged.
  const ordinary = 'NoteSync page 3/20 finished in 412ms, 12 notes confirmed, path=folder/a.md';
  assert.equal(redactDiagnosticText(ordinary), ordinary, 'new rules do not touch ordinary text');
}

console.log('PASS: diagnostic logs redact credentials, bodies and binary while keeping Error stacks');
