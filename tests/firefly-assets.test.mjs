import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// P2-02 / P2-03: Firefly asset collection and clipboard/device import.
// - a same-name asset with DIFFERENT bytes must be saved under a new name, never silently reused;
// - an identical same-name asset is reused (no duplicate copies);
// - clipboard/device file names are sanitized (path separators, control characters, dot prefixes).
const root = path.resolve(import.meta.dirname, "..");
const noop = () => undefined;

class TFile {
  constructor(p, bytes = []) { this.path = p; this.name = p.split("/").pop(); this.extension = this.name.split(".").pop(); this.stat = { size: bytes.length ?? 0, mtime: 0 }; }
}
class TFolder {
  constructor(p) { this.path = p; this.children = []; }
}

const frontmatterStub = new Proxy({}, { get: (_t, key) => (key === "FIREFLY_IMAGE_API" ? "" : () => "") });
const pinyinStub = { pinyin: (s) => [s] };

function loadModule(relPath) {
  const sourcePath = path.join(root, relPath);
  const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    require: (id) => {
      if (id === "obsidian") return { TFile, TFolder, normalizePath: (p) => p };
      if (id === "pinyin-pro") return pinyinStub;
      if (id === "./firefly-frontmatter") return frontmatterStub;
      throw new Error(`Unexpected require in firefly-assets: ${id}`);
    },
    module, exports: module.exports, console, Map, Set, Uint8Array, ArrayBuffer, TextDecoder,
  });
  return module.exports;
}

const assets = loadModule("src/lib/blog/firefly-assets.ts");

/** 最小 vault：路径 → TFile，二进制内容按路径保存 */
function makeApp() {
  const files = new Map();
  const folders = new Map();
  const vault = {
    getAbstractFileByPath: (p) => files.get(p) ?? folders.get(p) ?? null,
    readBinary: async (f) => files.get(f.path).__bytes,
    createBinary: async (p, data) => { files.set(p, Object.assign(new TFile(p, data), { __bytes: new Uint8Array(data) })); },
    copy: async (source, target) => { files.set(target, Object.assign(new TFile(target), { __bytes: files.get(source.path).__bytes })); },
    createFolder: async (p) => { folders.set(p, new TFolder(p)); },
  };
  const put = (p, bytes) => { files.set(p, Object.assign(new TFile(p, bytes), { __bytes: new Uint8Array(bytes) })); };
  return { app: { vault }, files, folders, put };
}

// 1. Same name, different bytes: a fresh `-1` copy is created and returned.
{
  const { app, files, put } = makeApp();
  put("posts/assets/cover.png", [1, 2, 3]);
  put("other/cover.png", [4, 5, 6]);
  const name = await assets.copyImageIntoNoteAssets(app, "posts/a.md", files.get("other/cover.png"));
  assert.equal(name, "cover-1.png", "a same-name, different-content asset is disambiguated");
  assert.deepEqual(Array.from(files.get("posts/assets/cover-1.png").__bytes), [4, 5, 6]);
  assert.deepEqual(Array.from(files.get("posts/assets/cover.png").__bytes), [1, 2, 3], "the existing asset is untouched");
}

// 2. Same name, identical bytes: reuse the existing file (no duplicate).
{
  const { app, files, put } = makeApp();
  put("posts/assets/cover.png", [1, 2, 3]);
  put("other/cover.png", [1, 2, 3]);
  const name = await assets.copyImageIntoNoteAssets(app, "posts/a.md", files.get("other/cover.png"));
  assert.equal(name, "cover.png");
  assert.equal(files.has("posts/assets/cover-1.png"), false, "identical content does not duplicate the asset");
}

// 3. No existing target: plain copy under the same name.
{
  const { app, files, put } = makeApp();
  put("other/photo.jpg", [9, 9]);
  const name = await assets.copyImageIntoNoteAssets(app, "posts/a.md", files.get("other/photo.jpg"));
  assert.equal(name, "photo.jpg");
  assert.ok(files.has("posts/assets/photo.jpg"));
}

// 4. Write from an untrusted (clipboard/device) name: separators, control chars and dot prefixes
//    are stripped, and collisions get a numeric suffix.
{
  const { app, files } = makeApp();
  const bytes = new Uint8Array([7, 7, 7]).buffer;
  const name = await assets.writeImageIntoNoteAssets(app, "posts/a.md", "../../evil\u0000.png", bytes);
  assert.equal(name, "evil.png", "path traversal and NUL bytes are removed");
  assert.ok(files.has("posts/assets/evil.png"), "the asset lands inside the note's assets folder");
  const second = await assets.writeImageIntoNoteAssets(app, "posts/a.md", "evil.png", bytes);
  assert.equal(second, "evil-1.png", "a name collision gets a suffix");
}

// 5. sanitizeAssetFileName unit behaviour.
{
  assert.equal(assets.sanitizeAssetFileName("a\\b\\c.png"), "c.png");
  assert.equal(assets.sanitizeAssetFileName(".hidden.png"), "hidden.png");
  assert.equal(assets.sanitizeAssetFileName(""), "image");
  assert.equal(assets.sanitizeAssetFileName(".."), "image");
  assert.equal(assets.sanitizeAssetFileName("  spaced  .png  "), "spaced  .png");
}

console.log("PASS: Firefly asset same-name disambiguation and clipboard file-name sanitization");
