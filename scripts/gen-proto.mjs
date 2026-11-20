#!/usr/bin/env node
/**
 * 从服务端仓库的 sync.proto 生成 src/pb/v1/sync.js 与 sync.d.ts。
 *
 * 历史问题：package.json 的 proto 脚本原硬编码 `../../../../../@GoApps/fast-note-sync-service/...`，
 * 只在原作者机器上可用，生成物因此无法复现。这里改为：
 *   1. 显式传 FNS_PROTO_PATH 时使用该路径；
 *   2. 否则默认取相邻仓库 `../fast-note-sync-service/internal/proto/v1/sync.proto`。
 * 两端必须用同一份 sync.proto 生成，禁止手工编辑生成文件。
 *
 * Generate src/pb/v1/sync.js and sync.d.ts from the server repo's sync.proto.
 * Set FNS_PROTO_PATH to override the default sibling-repo path.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const protoPath = path.resolve(
  process.env.FNS_PROTO_PATH ||
    path.join(repoRoot, "..", "fast-note-sync-service", "internal", "proto", "v1", "sync.proto"),
);

if (!fs.existsSync(protoPath)) {
  console.error(
    `sync.proto not found: ${protoPath}\n` +
      `Pass FNS_PROTO_PATH=/path/to/fast-note-sync-service/internal/proto/v1/sync.proto`,
  );
  process.exit(1);
}

const binDir = path.join(repoRoot, "node_modules", ".bin");
const pbjs = path.join(binDir, "pbjs");
const pbts = path.join(binDir, "pbts");
const jsOut = path.join(repoRoot, "src", "pb", "v1", "sync.js");
const dtsOut = path.join(repoRoot, "src", "pb", "v1", "sync.d.ts");

const run = (bin, args) => {
  console.log(`> ${path.basename(bin)} ${args.join(" ")}`);
  execFileSync(bin, args, { cwd: repoRoot, stdio: "inherit" });
};

run(pbjs, ["-t", "static-module", "-w", "es6", "-o", jsOut, protoPath]);
run(pbts, ["-o", dtsOut, jsOut]);
run(process.execPath, [path.join(here, "fix-proto.cjs")]);

console.log(`Generated from ${protoPath}`);
