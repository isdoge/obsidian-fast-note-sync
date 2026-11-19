import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const notices = [];
const logs = [];
let shouldFailDecode = false;
let serializedMessages = 0;
const noop = () => undefined;

class MockWebSocketClient {
  constructor(plugin, options) {
    this.plugin = plugin;
    this.options = options;
    this.isOpen = true;
    this.isAuth = false;
    this.useProtobuf = false;
    this.count = 0;
    this.sent = [];
    this.reconnects = 0;
  }

  get ws() { return {}; }
  registerBinaryHandler() {}
  Send(action, data, after) { this.sent.push({ action, data }); after?.(); }
  register() {}
  triggerReconnect() { this.reconnects++; }
  unRegister() {}
  addStatusListener() {}
  removeStatusListener() {}
  addActivityListener() {}
  notifyActivity() {}
  notifyStatusChange() {}
}

const sourcePath = path.join(root, "src", "lib", "sync", "websocket_manager.ts");
const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
const requireStub = id => {
  switch (id) {
    case "obsidian":
      return {
        moment: Object.assign(() => ({ format: () => "" }), { locale: () => "en" }),
        Platform: { isDesktop: true, isMobile: false },
        normalizePath: value => value,
      };
    case "../utils/helpers":
      return new Proxy({
        addRandomParam: value => value,
        showSyncNotice: message => notices.push(message),
        safeStringify: value => typeof value === "string" ? value : JSON.stringify(value),
      }, { get: (target, name) => target[name] ?? noop });
    case "../../pb/protobuf_mapper":
      return {
        enSendDTOToProtobuf: () => { serializedMessages++; return new Uint8Array(); },
        deReceivePacket: () => {
          if (shouldFailDecode) throw new Error("invalid wire-format data");
          return { action: "NoteSyncEnd", code: 200, status: true };
        },
      };
    case "./sync_log_manager":
      return { SyncLogManager: { getInstance: () => ({
        addLog: (...args) => logs.push(args),
        logReceivedMessage: noop,
        logSentMessage: noop,
      }) } };
    case "./websocket_client":
      return { WebSocketClient: MockWebSocketClient };
    case "../utils/types":
      return { CLIENT_TYPE: "obsidianPlugin" };
    case "../../i18n/lang":
      return { $: key => key };
    case "./operator_file":
      return new Proxy({ BINARY_PREFIX_FILE_SYNC: "fs" }, { get: (target, name) => target[name] ?? noop });
    case "./operator_note":
      return { clearEmptyNoteProbes: noop };
    case "./operator":
      return new Proxy({}, { get: () => noop });
    case "./websocket_action":
      return new Proxy({ ClientReceiveAuth: "Authorization", ClientReceiveInfo: "ClientInfo" }, {
        get: (target, name) => target[name] ?? String(name),
      });
    default:
      throw new Error(`Unexpected require: ${id}`);
  }
};
vm.runInNewContext(transpiled, {
  require: requireStub,
  module,
  exports: module.exports,
  console,
  TextDecoder,
  setTimeout,
  clearTimeout,
  window: { setTimeout, clearTimeout },
}, { filename: sourcePath });

function fixture(protobufEnabled = true) {
  const plugin = {
    settings: { protobufEnabled, apiToken: "token", offlineSyncStrategy: "", startupDelay: 0 },
    manifest: { version: "2.5.0" },
    runWsApi: "wss://example.test",
    getClientName: () => "test-client",
    syncState: { activeSyncContext: null, negotiated: false },
    localStorageManager: { getMetadata: noop, setMetadata: noop },
    shareIndicatorManager: { updateSharedPaths: noop },
    versionManager: { updateFromClientInfo: noop },
    concurrencyLimiter: { clear: noop, releaseSlot: noop },
    isSyncing: false,
    isSyncRequesting: false,
  };
  const manager = new module.exports.WebSocketManager(plugin);
  return { plugin, manager, client: manager.client };
}

function authenticate(client) {
  client.options.onMessage(client, "Authorization", {
    code: 200,
    data: { protobufAck: true, paths: [] },
  });
}

function assertSingleFallback(plugin, manager, client, noticeStart, logStart) {
  assert.equal(notices.length, noticeStart + 1);
  assert.equal(notices.at(-1), "ui.notice.protobuf_fallback");
  assert.equal(logs.length, logStart + 1);
  assert.equal(logs.at(-1)[0], "error");
  assert.equal(logs.at(-1)[1], "ProtobufFallback");
  assert.equal(client.useProtobuf, false);
  assert.equal(client.reconnects, 0, "authenticated connections downgrade without reconnecting");
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].action, "ClientInfo");
  assert.equal(client.sent[0].data.protobuf, false);
  assert.equal(plugin.settings.protobufEnabled, true, "saved setting must not be changed");
  assert.match(client.options.getWsUrl(1), /pv=2&pb=0/, "future reconnects stay on JSON");
  assert.equal(manager.useProtobuf, false);

  authenticate(client);
  assert.equal(client.useProtobuf, false, "a late auth response cannot re-enable protobuf");
  assert.equal(client.sent.at(-1).data.protobuf, false);

  shouldFailDecode = true;
  client.options.deserializeMessage(new Uint8Array());
  client.options.onMessage(client, "NoteSync", { code: 305, details: "Protobuf decode failed: bad wire data" });
  assert.equal(notices.length, noticeStart + 1, "only one notice per plugin session");
  assert.equal(logs.length, logStart + 1, "only one fallback log per plugin session");
  assert.equal(client.sent.filter(message => message.action === "ClientInfo").length, 2,
    "only the initial auth and the one fallback send ClientInfo");
  assert.equal(client.sent.at(-1).data.protobuf, false);
  client.useProtobuf = true;
  assert.throws(() => client.options.serializeMessage("NoteSync", {}), /Protobuf disabled/);

  // After the fallback, unrelated service errors must still be shown.
  client.options.onMessage(client, "NoteSync", { code: 500, message: "内部错误", details: "db timeout" });
  assert.equal(notices.at(-1), "Service Error: Code=500 Message=内部错误 Details=db timeout");
}

// Normal negotiation and encoding retain the existing protobuf behavior.
{
  const { plugin, client } = fixture();
  assert.match(client.options.getWsUrl(0), /pv=2&pb=1/);
  authenticate(client);
  assert.equal(client.useProtobuf, true);
  assert.equal(client.sent.filter(message => message.action === "ClientInfo").length, 1);
  assert.equal(client.sent[0].data.protobuf, true);
  client.options.serializeMessage("NoteSync", {});
  assert.equal(serializedMessages, 1);
  client.options.deserializeMessage(new Uint8Array());
  assert.equal(notices.length, 0);
  assert.equal(logs.length, 0);
  assert.equal(plugin.settings.protobufEnabled, true);
}

// A local decode failure downgrades this authenticated connection and the plugin session.
{
  const { plugin, manager, client } = fixture();
  authenticate(client);
  client.sent.length = 0;
  const noticeStart = notices.length;
  const logStart = logs.length;
  shouldFailDecode = true;
  client.options.deserializeMessage(new Uint8Array());
  assertSingleFallback(plugin, manager, client, noticeStart, logStart);
}

// The issue's Code=305 is a valid error envelope for an uplink DTO decode failure.
{
  const { plugin, manager, client } = fixture();
  authenticate(client);
  client.sent.length = 0;
  const noticeStart = notices.length;
  const logStart = logs.length;
  client.options.onMessage(client, "NoteSync", {
    code: 305,
    message: "参数验证失败",
    details: "Protobuf decode failed: proto: cannot parse invalid wire-format data",
  });
  assertSingleFallback(plugin, manager, client, noticeStart, logStart);
}

// If decoding fails before authentication, reconnect once with pb=0 rather than send an unauthenticated downgrade.
{
  const { plugin, manager, client } = fixture();
  const noticeStart = notices.length;
  const logStart = logs.length;
  shouldFailDecode = true;
  client.options.deserializeMessage(new Uint8Array());
  assert.equal(client.reconnects, 1);
  assert.equal(client.sent.length, 0);
  assert.match(client.options.getWsUrl(1), /pv=2&pb=0/);
  assert.equal(plugin.settings.protobufEnabled, true);
  assert.equal(manager.useProtobuf, false);
  // The pre-auth path notifies exactly once, same as the authenticated path.
  assert.equal(notices.length, noticeStart + 1);
  assert.equal(notices.at(-1), "ui.notice.protobuf_fallback");
  assert.equal(logs.length, logStart + 1);
  assert.equal(logs.at(-1)[1], "ProtobufFallback");
}

// Other service errors retain their existing visible error behavior.
{
  const { client } = fixture();
  authenticate(client);
  client.options.onMessage(client, "NoteSync", { code: 305, message: "参数验证失败", details: "Invalid message format" });
  assert.equal(notices.at(-1), "Service Error: Code=305 Message=参数验证失败 Details=Invalid message format");
}

// An error reply that only carries a path releases both the uplink slot and the download slot.
{
  const releases = [];
  const { plugin, client } = fixture();
  plugin.fileSyncTasks = { completed: 0 };
  plugin.concurrencyLimiter = { clear: noop, releaseSlot: key => releases.push(key) };
  authenticate(client);
  client.options.onMessage(client, "FileSyncUpdate", { code: 500, message: "内部错误", data: { path: "attachments/a.png" } });
  assert.deepEqual(releases, ["attachments/a.png", "download_attachments/a.png"],
    "a path-only error releases a download_<path> slot as well");
  assert.equal(plugin.fileSyncTasks.completed, 1, "the failed item is still counted as completed");
}

// Exercise the real WebSocketClient binary message path, not only the manager's deserialize callback.
{
  const clientModule = { exports: {} };
  const clientSource = ts.transpileModule(fs.readFileSync(path.join(root, "src", "lib", "sync", "websocket_client.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  class TestSocket {
    constructor() {
      this.readyState = TestSocket.OPEN;
      this.sent = [];
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = TestSocket.CLOSED; }
  }
  TestSocket.CONNECTING = 0;
  TestSocket.OPEN = 1;
  TestSocket.CLOSED = 3;
  vm.runInNewContext(clientSource, {
    module: clientModule,
    exports: clientModule.exports,
    console,
    WebSocket: TestSocket,
    ArrayBuffer,
    Blob,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    JSON,
    require: id => {
      if (id === "obsidian") return { moment: () => ({ format: () => "" }) };
      if (id.includes("helpers")) return { dump: noop, dumpError: noop, isWsUrl: () => true, showSyncNotice: noop };
      if (id.includes("i18n")) return { $: key => key };
      throw new Error(`Unexpected client import: ${id}`);
    },
  });
  const RealClient = clientModule.exports.WebSocketClient;
  const plugin = {
    app: { vault: { getName: () => "test" }, loadLocalStorage: () => null, saveLocalStorage: noop },
    settings: { protobufEnabled: true },
  };
  const received = [];
  const realClient = new RealClient(plugin, {
    getWsUrl: () => "wss://example.test",
    deserializeMessage: () => ({ action: "ClientInfo", code: 200 }),
    serializeMessage: () => { serializedMessages++; return new Uint8Array([1]); },
    onMessage: (_client, action) => received.push(action),
  });
  await realClient.register();
  const prefix = new TextEncoder().encode("pb");
  realClient.ws.onmessage({ data: new Uint8Array([...prefix, 0]).buffer });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(realClient.useProtobuf, true, "normal protobuf ClientInfo still upgrades");
  assert.deepEqual(received, ["ClientInfo"]);
  realClient.Send("NoteSync", {});
  assert.ok(realClient.ws.sent[0] instanceof Uint8Array);

  const fallbackClient = new RealClient(plugin, {
    getWsUrl: () => "wss://example.test",
    deserializeMessage: () => null,
    onMessage: () => { throw new Error("failed decode must not reach the message handler"); },
  });
  await fallbackClient.register();
  fallbackClient.useProtobuf = true;
  fallbackClient.ws.onmessage({ data: new Uint8Array([...prefix, 0]).buffer });
  await new Promise(resolve => setImmediate(resolve));
  fallbackClient.Send("ClientInfo", { protobuf: false });
  assert.equal(fallbackClient.ws.sent.length, 1);
  assert.equal(typeof fallbackClient.ws.sent[0], "string");
  assert.equal(fallbackClient.ws.sent[0], 'ClientInfo|{"protobuf":false}');

  // While the setting was just disabled but the connection's useProtobuf is not reset yet,
  // Send must go out as a JSON text frame without touching serializeMessage.
  const disabledPlugin = {
    app: plugin.app,
    settings: { protobufEnabled: false },
  };
  const disabledClient = new RealClient(disabledPlugin, {
    getWsUrl: () => "wss://example.test",
    serializeMessage: () => { throw new Error("serializeMessage must not be called once the setting is off"); },
  });
  await disabledClient.register();
  disabledClient.useProtobuf = true;
  disabledClient.Send("NoteSync", { a: 1 });
  assert.equal(disabledClient.ws.sent.length, 1);
  assert.equal(disabledClient.ws.sent[0], 'NoteSync|{"a":1}');

  // A throwing serializeMessage (the manager's defensive guard) must not lose the message either.
  const guardPlugin = {
    app: plugin.app,
    settings: { protobufEnabled: true },
  };
  const guardClient = new RealClient(guardPlugin, {
    getWsUrl: () => "wss://example.test",
    serializeMessage: () => { throw new Error("Protobuf disabled after a decode failure"); },
  });
  await guardClient.register();
  guardClient.useProtobuf = true;
  guardClient.Send("NoteSync", { b: 2 });
  assert.equal(guardClient.ws.sent.length, 1);
  assert.equal(guardClient.ws.sent[0], 'NoteSync|{"b":2}');
}

console.log("protobuf decode fallback: local and server errors, one notice/log, JSON reconnect and normal protocol passed");
