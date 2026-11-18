import type FastSync from "../../main";

// 每个连接内因"无同步基线"被保留并已重新上传过的路径。连接对象更换（重连）后重新计。
// Paths kept and re-uploaded on the current connection because they had no sync baseline.
// A new connection (a new socket object) starts over.
const keptWithoutBaseline = new WeakMap<FastSync, { conn: unknown; paths: Set<string> }>();

/**
 * 无同步基线的本地文件收到远端删除时登记一次保留。
 * 返回 true：本连接内首次，调用方保留并重新上传；false：本连接内已重传过，调用方只保留、不再上传。
 * 服务端拒收重传（内容与墓碑相同）时先回 Ack 再下发删除：Ack 写入基线后，那次删除按"内容与基线一致"
 * 照常执行，所以往返一定终止；没等到 Ack 的副本始终保留，不会删掉服务端未确认过的内容
 * （haierkeys/fast-note-sync-service#514 #391）。
 *
 * Registers one keep for a local file without a sync baseline that received a remote delete.
 * true: first time on this connection, the caller keeps it and uploads it again; false: already
 * re-uploaded on this connection, the caller keeps it without uploading. A server that refuses the
 * re-upload (content equals the tombstone) acks first and then deletes again: the ack records the
 * baseline, so that delete is carried out as an unchanged copy and the exchange always terminates.
 * A copy that was never acked is always kept.
 */
export function firstKeepWithoutBaseline(plugin: FastSync, path: string): boolean {
  const conn: unknown = plugin.websocket?.ws ?? null;
  let state = keptWithoutBaseline.get(plugin);
  if (!state || state.conn !== conn) {
    state = { conn, paths: new Set<string>() };
    keptWithoutBaseline.set(plugin, state);
  }
  if (state.paths.has(path)) return false;
  state.paths.add(path);
  return true;
}
