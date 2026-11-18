import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
// 直接执行 handleSync 中这五条初始化语句，确认新轮不会丢掉空闲请求的基线资料。
const source = ts.createSourceFile('operator.ts', fs.readFileSync('src/lib/sync/operator.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const statements = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleSync') {
    function collect(child) {
      if (ts.isExpressionStatement(child) && /^plugin\.pending(?:FileRenames|NoteRenames|NoteDeleteAcks|FileDeleteAcks|ConfigDeleteAcks)(?:\s*=|\.clear\()/.test(child.getText(source))) statements.push(child.getText(source));
      ts.forEachChild(child, collect);
    }
    collect(node);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(statements.length, 5);
const entries = ['idle', 'old-round', 'inactive'].map(newPath => ({ oldPath: `old-${newPath}`, newPath, contentHash: newPath }));
const plugin = {
  concurrencyLimiter: { getSlotContext: path => path === 'idle' ? null : path === 'old-round' ? 'retired' : undefined },
  pendingFileRenames: entries.slice(), pendingNoteRenames: new Map(entries.map(e => [e.newPath, e])),
  pendingNoteDeleteAcks: new Set(entries.map(e => e.newPath)),
  pendingFileDeleteAcks: new Set(entries.map(e => e.newPath)),
  pendingConfigDeleteAcks: new Set(entries.map(e => e.newPath)),
};
vm.runInNewContext(ts.transpileModule(statements.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, { plugin, Map, Set });
assert.deepEqual(Array.from(plugin.pendingFileRenames, e => e.newPath), ['idle'], 'keep idle file rename baseline');
assert.deepEqual([...plugin.pendingNoteRenames.keys()], ['idle'], 'keep idle note rename baseline');
for (const key of ['pendingNoteDeleteAcks', 'pendingFileDeleteAcks', 'pendingConfigDeleteAcks']) assert.deepEqual([...plugin[key]], ['idle'], `keep idle ${key}`);
console.log('PASS: starting a round preserves idle rename/delete baselines and removes retired or inactive entries');
