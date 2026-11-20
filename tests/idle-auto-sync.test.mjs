// Server #503 plugin-side closure: idle-connection fallback sync must fire only when connected,
// visible, quiescent and due; must never fire when disabled, busy or invisible; and must release
// its timer on disconnect and unload.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const load = (relPath) => {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(relPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, Number }, { filename: relPath });
  return module.exports;
};

const { IdleAutoSyncScheduler, IDLE_SYNC_TICK_MS, DEFAULT_IDLE_SYNC_INTERVAL_MINUTES } = load("src/lib/sync/idle_auto_sync.ts");
const MIN = 60 * 1000;

class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.handlers = new Map();
    this.intervals = new Map();
    this.cleared = [];
    this.nowMs = 0;
  }
  deps() {
    return {
      setInterval: (fn, ms) => {
        const id = this.nextId++;
        this.handlers.set(id, fn);
        this.intervals.set(id, ms);
        return id;
      },
      clearInterval: (id) => {
        this.cleared.push(id);
        this.handlers.delete(id);
        this.intervals.delete(id);
      },
      now: () => this.nowMs,
    };
  }
  fireAll() {
    for (const fn of [...this.handlers.values()]) fn();
  }
}

const makeHost = (overrides = {}) => {
  const state = { minutes: DEFAULT_IDLE_SYNC_INTERVAL_MINUTES, connected: true, busy: false, visible: true, runs: 0, ...overrides };
  const host = {
    getIntervalMinutes: () => state.minutes,
    isConnected: () => state.connected,
    isBusy: () => state.busy,
    isVisible: () => state.visible,
    runSync: () => { state.runs++; },
  };
  return { state, host };
};

// 1. Fires after the configured interval and not again immediately
{
  const timers = new FakeTimers();
  const { state, host } = makeHost({ minutes: 15 });
  const scheduler = new IdleAutoSyncScheduler(host, timers.deps(), 0);
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  assert.equal(Math.max(...timers.intervals.values()), IDLE_SYNC_TICK_MS, "uses the fixed check cadence");

  timers.nowMs = 15 * MIN - 1;
  timers.fireAll();
  assert.equal(state.runs, 0, "must wait the full interval");
  timers.nowMs = 15 * MIN;
  timers.fireAll();
  assert.equal(state.runs, 1, "fires once the interval elapsed");
  timers.fireAll();
  assert.equal(state.runs, 1, "does not fire twice at the same moment");
  timers.nowMs = 29 * MIN;
  timers.fireAll();
  assert.equal(state.runs, 1, "next window starts from the last trigger");
  timers.nowMs = 30 * MIN;
  timers.fireAll();
  assert.equal(state.runs, 2);
}

// 2. Busy (active round / pending queues) skips the tick, then fires when idle
{
  const timers = new FakeTimers();
  const { state, host } = makeHost({ minutes: 5, busy: true });
  const scheduler = new IdleAutoSyncScheduler(host, timers.deps(), 0);
  scheduler.start();
  timers.nowMs = 30 * MIN;
  timers.fireAll();
  assert.equal(state.runs, 0, "must not trigger while a sync round or queue is pending");
  state.busy = false;
  timers.fireAll();
  assert.equal(state.runs, 1, "triggers once the queues drained");
}

// 3. Invisible page skips the tick
{
  const timers = new FakeTimers();
  const { state, host } = makeHost({ minutes: 5, visible: false });
  const scheduler = new IdleAutoSyncScheduler(host, timers.deps(), 0);
  scheduler.start();
  timers.nowMs = 60 * MIN;
  timers.fireAll();
  assert.equal(state.runs, 0, "must not trigger while the page is hidden");
  state.visible = true;
  timers.fireAll();
  assert.equal(state.runs, 1);
}

// 4. 0 disables the feature entirely
{
  const timers = new FakeTimers();
  const { state, host } = makeHost({ minutes: 0 });
  const scheduler = new IdleAutoSyncScheduler(host, timers.deps(), 0);
  scheduler.start();
  assert.equal(scheduler.isRunning(), false, "disabled interval installs no timer");
  timers.nowMs = 24 * 60 * MIN;
  assert.equal(scheduler.maybeTrigger(), false);
  assert.equal(state.runs, 0);
}

// 5. Disconnect and unload clean the timer up
{
  const timers = new FakeTimers();
  const { state, host } = makeHost({ minutes: 15 });
  const scheduler = new IdleAutoSyncScheduler(host, timers.deps(), 0);
  scheduler.start();
  const id = [...timers.handlers.keys()][0];
  scheduler.setConnected(false);
  assert.equal(scheduler.isRunning(), false);
  assert.deepEqual(timers.cleared, [id], "disconnect clears the interval");
  timers.nowMs = 60 * MIN;
  timers.fireAll();
  assert.equal(state.runs, 0, "a stale handler cannot run after cleanup");

  const timers2 = new FakeTimers();
  const second = makeHost({ minutes: 15 });
  const scheduler2 = new IdleAutoSyncScheduler(second.host, timers2.deps(), 0);
  scheduler2.start();
  scheduler2.stop();
  assert.equal(scheduler2.isRunning(), false);
  assert.equal(timers2.cleared.length, 1, "unload stop releases the timer");
}

// 6. A missed disconnect callback still self-stops on the next tick
{
  const timers = new FakeTimers();
  const { host, state } = makeHost({ minutes: 15 });
  const scheduler = new IdleAutoSyncScheduler(host, timers.deps(), 0);
  scheduler.start();
  state.connected = false;
  timers.nowMs = 60 * MIN;
  timers.fireAll();
  assert.equal(scheduler.isRunning(), false, "tick self-cleans when the connection is gone");
  assert.equal(timers.cleared.length, 1);
  assert.equal(state.runs, 0);
}

// 7. Sync completion restarts the countdown; reconnecting re-arms the timer
{
  const timers = new FakeTimers();
  const { state, host } = makeHost({ minutes: 15 });
  const scheduler = new IdleAutoSyncScheduler(host, timers.deps(), 0);
  scheduler.start();
  timers.nowMs = 15 * MIN;
  timers.fireAll();
  assert.equal(state.runs, 1);
  timers.nowMs = 20 * MIN;
  scheduler.notifySyncCompleted();
  timers.nowMs = 34 * MIN;
  timers.fireAll();
  assert.equal(state.runs, 1, "completion resets the interval baseline");
  timers.nowMs = 35 * MIN;
  timers.fireAll();
  assert.equal(state.runs, 2);

  scheduler.setConnected(false);
  state.connected = true;
  scheduler.setConnected(true);
  assert.equal(scheduler.isRunning(), true, "reconnect re-arms the timer");
}

// 8. Turning the setting off while running stops the timer
{
  const timers = new FakeTimers();
  const { state, host } = makeHost({ minutes: 15 });
  const scheduler = new IdleAutoSyncScheduler(host, timers.deps(), 0);
  scheduler.start();
  state.minutes = 0;
  scheduler.applySettings();
  assert.equal(scheduler.isRunning(), false);
  timers.nowMs = 60 * MIN;
  timers.fireAll();
  assert.equal(state.runs, 0);
  state.minutes = 15;
  scheduler.applySettings();
  assert.equal(scheduler.isRunning(), true, "re-enabling the setting re-arms the timer");
}

console.log("Idle auto sync: interval gating, busy/invisible/disabled skips, disconnect/unload cleanup and re-arm passed");
