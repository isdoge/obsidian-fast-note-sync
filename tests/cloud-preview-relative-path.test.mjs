import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('src/lib/storage/file_cloud_preview.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
vm.runInNewContext(code, { module, exports: module.exports, console, URLSearchParams,
  require: id => id.includes('helpers') ? { hashContent: p => `hash:${p}` }
    : id.includes('types') ? { CLIENT_TYPE: 'test' } : {} });
const preview = Object.create(module.exports.FileCloudPreview.prototype);
const settings = { cloudPreviewEnabled: true, api: 'https://example.invalid', apiToken: 'test', vault: 'test', cloudPreviewTypeRestricted: true };
preview.plugin = { settings, app: { vault: { getConfig: () => '_attachments' } } };
let cases = 0;
for (const dynamic of [false, true]) {
  settings.cloudPreviewDynamicAttachment = dynamic;
  for (const [path, source, expected] of [
    ['../_attachments/example.png', '02-test/test.md', '_attachments/example.png'],
    ['./images/example.png', '02-test/test.md', '02-test/images/example.png'],
    ['../../images/example.png', 'a/b/test.md', 'images/example.png'],
    ['../images/./sub/../example.png', 'a/test.md', 'images/example.png'],
    ['_attachments/example.png', 'a/test.md', '_attachments/example.png'],
    ['example.png', 'a/test.md', dynamic ? '_attachments/example.png' : 'example.png'],
    ['../../../escape.png', 'a/test.md', null],
  ]) {
    const result = await preview.getCloudUrl(path, source, '#t=2');
    if (expected === null) assert.equal(result, null, 'relative paths cannot escape the vault');
    else {
      const params = new URL(result).searchParams;
      assert.equal(params.get('path'), expected, `${dynamic}: ${path}`);
      assert.equal(params.get('pathHash'), `hash:${expected}`);
    }
    cases++;
  }
}
console.log(`Cloud preview relative links: ${cases} path and hash cases passed`);
