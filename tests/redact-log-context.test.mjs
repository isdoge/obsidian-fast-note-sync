import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Diagnostics copied from the debug-log modal are pasted into public issue reports. Beyond
// credentials and note bodies, they must not leak the local vault path, the OS user name,
// the configured vault name or the sync server address. The runtime values are injected
// through a context provider so user setting changes are honoured on every redaction.
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
    module, exports: module.exports, console, Map, Set, WeakSet, ArrayBuffer, Uint8Array, Error, JSON,
    Object, String, Number, Date, BigInt, URL, encodeURI, encodeURIComponent,
    require(id) {
      if (id === './redact_log') return redactModule;
      if (id in extra) return extra[id];
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename: sourcePath });
  return module.exports;
}

const { setDiagnosticRedactionContext, redactDiagnosticText, formatDiagnostic } = redactModule;
assert.equal(typeof setDiagnosticRedactionContext, 'function');
assert.equal(typeof redactDiagnosticText, 'function');
assert.equal(typeof formatDiagnostic, 'function');

const setContext = (context) => setDiagnosticRedactionContext(() => context);

// 0. No context registered: behaviour is byte-for-byte the pre-context behaviour.
{
  setDiagnosticRedactionContext(null);
  const text = 'vault acme at /Users/alice/My Vault/notes/a.md via https://api.example.com/api';
  assert.equal(redactDiagnosticText(text), text, 'no context means no path/vault/server redaction');
  const object = formatDiagnostic({ vault: 'acme', path: '/Users/alice/My Vault/a.md' });
  assert.ok(object.includes('"vault":"acme"'), 'no context keeps vault keys as-is');
  assert.ok(object.includes('/Users/alice/My Vault/a.md'), 'no context keeps paths as-is');
}

// 1. Vault base path: macOS, Linux and Windows spellings, plus file:// and percent encoding.
{
  setContext({ vaultPath: '/Users/alice/My Vault', vaultName: '', serverHosts: [] });
  assert.equal(
    redactDiagnosticText('read /Users/alice/My Vault/notes/a.md'),
    'read [vault-path]/notes/a.md',
    'macOS path is replaced and the vault-relative remainder survives',
  );
  assert.equal(
    redactDiagnosticText('read file:///Users/alice/My%20Vault/notes/a.md'),
    'read [vault-path]/notes/a.md',
    'file:// and percent encoding are recognised',
  );
  assert.equal(
    redactDiagnosticText('path=%2FUsers%2Falice%2FMy%20Vault%2Fnotes%2Fa.md'),
    'path=[vault-path]%2Fnotes%2Fa.md',
    'fully percent-encoded path is recognised',
  );
  assert.equal(
    redactDiagnosticText('read /Users/alice/My Vault/notes/a.md and /Users/alice/My VaultX/b.md'),
    'read [vault-path]/notes/a.md and /Users/[user]/My VaultX/b.md',
    'a sibling directory with the path as a prefix is not taken as the vault path',
  );

  setContext({ vaultPath: '/home/alice/linux-vault', vaultName: '', serverHosts: [] });
  assert.equal(
    redactDiagnosticText('/home/alice/linux-vault/notes/x.md'),
    '[vault-path]/notes/x.md',
    'Linux path is replaced',
  );

  setContext({ vaultPath: 'C:\\Users\\alice\\WinVault', vaultName: '', serverHosts: [] });
  assert.equal(
    redactDiagnosticText('C:\\Users\\alice\\WinVault\\notes\\x.md'),
    '[vault-path]\\notes\\x.md',
    'Windows backslash path is replaced',
  );
  assert.equal(
    redactDiagnosticText('C:/Users/alice/WinVault/notes/x.md'),
    '[vault-path]/notes/x.md',
    'Windows forward-slash path is replaced',
  );
  assert.equal(
    redactDiagnosticText('file:///C:/Users/alice/WinVault/notes/x.md'),
    '[vault-path]/notes/x.md',
    'file:/// Windows path is replaced',
  );
}

// 2. OS user names outside the vault path.
{
  setContext({ vaultPath: '/Users/alice/My Vault', vaultName: '', serverHosts: [] });
  assert.equal(
    redactDiagnosticText('/Users/alice/Other/x.md'),
    '/Users/[user]/Other/x.md',
    'macOS user name is hidden',
  );
  assert.equal(
    redactDiagnosticText('/home/alice/Other/x.md'),
    '/home/[user]/Other/x.md',
    'Linux user name is hidden',
  );
  assert.equal(
    redactDiagnosticText('C:\\Users\\alice\\Other\\x.md'),
    'C:\\Users\\[user]\\Other\\x.md',
    'Windows backslash user name is hidden',
  );
  assert.equal(
    redactDiagnosticText('C:/Users/alice/Other/x.md'),
    'C:/Users/[user]/Other/x.md',
    'Windows forward-slash user name is hidden',
  );
}

// 3. Server address: protocol preserved, host/IP and port replaced, bare hosts in error text.
{
  setContext({
    vaultPath: '',
    vaultName: '',
    serverHosts: ['https://api.example.com:9000/base', 'http://192.0.2.5:9000'],
  });

  const urls = [
    ['https://api.example.com:9000/api/sync?x=1', 'https://[server]/api/sync?x=1'],
    ['http://api.example.com/api/sync', 'http://[server]/api/sync'],
    ['ws://api.example.com:9000/api/user/sync', 'ws://[server]/api/user/sync'],
    ['wss://api.example.com/api/user/sync', 'wss://[server]/api/user/sync'],
    ['http://192.0.2.5:9000/api/sync', 'http://[server]/api/sync'],
  ];
  for (const [input, expected] of urls) {
    assert.equal(redactDiagnosticText(input), expected, `server URL is masked: ${input}`);
  }

  assert.equal(
    redactDiagnosticText('connect ECONNREFUSED 192.0.2.5:9000'),
    'connect ECONNREFUSED [server]',
    'bare IP with port is masked',
  );
  assert.equal(
    redactDiagnosticText('getaddrinfo ENOTFOUND API.EXAMPLE.COM'),
    'getaddrinfo ENOTFOUND [server]',
    'bare host is masked case-insensitively',
  );
  assert.equal(
    redactDiagnosticText('https://other.example.org/x and getaddrinfo ENOTFOUND other.example.org'),
    'https://other.example.org/x and getaddrinfo ENOTFOUND other.example.org',
    'unrelated domains are untouched',
  );
  assert.equal(
    redactDiagnosticText('https://api.example.com.evil/x'),
    'https://api.example.com.evil/x',
    'a domain that merely starts with the configured host is untouched',
  );
}

// 4. Vault name: structured keys, JSON strings, URL query and whole-word free text.
{
  setContext({ vaultPath: '', vaultName: 'acme', serverHosts: [] });

  const object = formatDiagnostic({
    vault: 'acme',
    vaultName: 'acme',
    vault_name: 'acme',
    remoteVault: 'acme',
    nested: { local_vault_name: 'acme' },
    other: 'kept',
  });
  for (const key of ['"vault"', '"vaultName"', '"vault_name"', '"remoteVault"', '"local_vault_name"']) {
    assert.ok(object.includes(`${key}:"[vault]"`), `structured vault key is masked: ${key}`);
  }
  assert.ok(object.includes('"other":"kept"'));

  assert.equal(
    redactDiagnosticText('{"vault":"acme","path":"a.md"}'),
    '{"vault":"[vault]","path":"a.md"}',
    'JSON string vault field is masked in text redaction',
  );
  assert.equal(
    formatDiagnostic('{"vault":"acme","path":"a.md"}'),
    '{"vault":"[vault]","path":"a.md"}',
    'pre-stringified JSON is parsed and masked',
  );

  assert.equal(
    redactDiagnosticText('https://unrelated.example/x?vault=acme&token=abc'),
    'https://unrelated.example/x?vault=[vault]&token=[redacted]',
    'vault query parameter and credentials are both masked',
  );

  assert.equal(redactDiagnosticText('opened acme now'), 'opened [vault] now', 'standalone vault name is masked');
  assert.equal(redactDiagnosticText('(acme)'), '([vault])', 'punctuation boundaries still match');
  assert.equal(redactDiagnosticText('acme-notes.md'), 'acme-notes.md', 'file name containing the vault name is kept');
  assert.equal(redactDiagnosticText('acme.md'), 'acme.md', 'file name with a dot suffix is kept');
  assert.equal(redactDiagnosticText('myacme'), 'myacme', 'letters around the vault name prevent a match');
  assert.equal(redactDiagnosticText('[vault]'), '[vault]', 'an existing placeholder is not doubled');

  // Context changes between calls are picked up.
  setContext({ vaultPath: '', vaultName: 'beta', serverHosts: [] });
  assert.equal(redactDiagnosticText('acme beta'), 'acme [vault]', 'new context value is used');
  assert.equal(redactDiagnosticText('acme'), 'acme', 'old name is no longer masked as free text');

  // A vault literally named "vault" must not corrupt JSON keys (values are already masked).
  setContext({ vaultPath: '', vaultName: 'vault', serverHosts: [] });
  assert.equal(
    formatDiagnostic('{"vault":"vault","other":"vault"}'),
    '{"vault":"[vault]","other":"[vault]"}',
    'JSON keys survive when the vault name is "vault"',
  );
  assert.equal(
    redactDiagnosticText('{"vault":"vault"}'),
    '{"vault":"[vault]"}',
    'text-level JSON keeps its key when the vault name is "vault"',
  );

  // Empty vault name does not perform free-text or structured replacement.
  setContext({ vaultPath: '', vaultName: '   ', serverHosts: [] });
  assert.equal(redactDiagnosticText('acme'), 'acme');
  assert.ok(formatDiagnostic({ vault: 'acme' }).includes('"vault":"acme"'));
}

// 5. Regex metacharacters in user-provided values are escaped.
{
  setContext({
    vaultPath: '/Users/alice/A.B+(x)',
    vaultName: 'a+b(c)',
    serverHosts: ['https://api+edge.example.com'],
  });
  assert.equal(redactDiagnosticText('/Users/alice/A.B+(x)/n.md'), '[vault-path]/n.md');
  assert.equal(redactDiagnosticText('a+b(c)'), '[vault]');
  assert.equal(redactDiagnosticText('xa+b(c)'), 'xa+b(c)', 'prefix letters prevent the vault-name match');
  assert.equal(
    redactDiagnosticText('ENOTFOUND api+edge.example.com'),
    'ENOTFOUND [server]',
    'regex metacharacters in the server host are escaped, not interpreted',
  );
  assert.equal(redactDiagnosticText('ENOTFOUND apixedge.example.com'), 'ENOTFOUND apixedge.example.com');
}

// 6. Credential redaction composes with server/vault redaction.
{
  setContext({ vaultPath: '/Users/alice/My Vault', vaultName: 'acme', serverHosts: ['https://api.example.com:9000'] });
  const password = ['s3cr', 'et-pass', Math.random().toString(36).slice(2)].join('');
  const token = ['s3cr', 'et-token', Math.random().toString(36).slice(2)].join('');
  const text = `https://alice:${password}@api.example.com:9000/api?token=${token}&vault=acme`;
  const redacted = redactDiagnosticText(text);
  assert.ok(!redacted.includes(password), 'password must not survive');
  assert.ok(!redacted.includes(token), 'token must not survive');
  assert.ok(!redacted.includes('api.example.com'), 'host must not survive');
  assert.equal(redacted, 'https://alice:[redacted]@[server]/api?token=[redacted]&vault=[vault]');
}

// 7. Error message and stack are redacted with the same context.
{
  setContext({ vaultPath: '/Users/alice/My Vault', vaultName: 'acme', serverHosts: ['https://api.example.com'] });
  const error = new Error('failed reading /Users/alice/My Vault/x.md from https://api.example.com/api');
  error.stack = 'Error: failed\n    at read (/Users/alice/Other/app.js:1:2)';
  const output = formatDiagnostic(error);
  assert.ok(output.includes('[vault-path]/x.md'), output);
  assert.ok(output.includes('[server]/api'), output);
  assert.ok(output.includes('/Users/[user]/Other/app.js:1:2'), output);
  assert.ok(!output.includes('api.example.com'));
}

// 8. Nested/pre-stringified values and DebugLogManager write/export paths.
{
  setContext({ vaultPath: '/Users/alice/My Vault', vaultName: 'acme', serverHosts: ['https://api.example.com'] });
  const nested = formatDiagnostic({ payload: JSON.stringify({ vault: 'acme', path: '/Users/alice/My Vault/n.md' }) });
  assert.ok(nested.includes('"vault":"[vault]"'), nested);
  assert.ok(nested.includes('[vault-path]/n.md'), nested);

  const manager = load('src/lib/utils/debug_log_manager.ts').DebugLogManager;
  const instance = manager.getInstance();
  instance.clearLogs();
  instance.addLog(
    'reading /Users/alice/My Vault/notes/a.md',
    { vault: 'acme' },
    new Error('connect ECONNREFUSED api.example.com'),
  );
  for (const text of [instance.getLogs().join('\n'), instance.getRedactedLogs().join('\n')]) {
    assert.ok(!text.includes('/Users/alice/My Vault'), text);
    assert.ok(!text.includes('api.example.com'), text);
    assert.ok(text.includes('[vault-path]/notes/a.md'), text);
    assert.ok(text.includes('"vault":"[vault]"'), text);
    assert.ok(text.includes('[server]'), text);
  }
}

setDiagnosticRedactionContext(null);

console.log('PASS: diagnostic logs redact vault paths, user names, vault names and server addresses');
