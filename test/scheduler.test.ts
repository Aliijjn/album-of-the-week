import assert from 'node:assert/strict';
import { test, onTestFinished } from 'bun:test';
import { Scheduler, type Delivery } from '../src/scheduler.js';
import { Store } from '../src/store.js';

function setup() {
  const store = new Store(':memory:');
  onTestFinished(() => store.close());
  store.configure('g', 'channel', 'role', undefined, Date.parse('2026-09-18T00:00:00Z'));
  store.addAlbum('g', 'alice', 'A', 'Artist');
  return { store, due: store.guild('g').next_run! };
}
const delivery = (overrides: Partial<Delivery> = {}): Delivery => ({
  available: () => true, isMember: async () => true, send: async () => 'message', ...overrides,
});

test('shutdown succeeds after a rejected reroll and prevents new work', async () => {
  const { store, due } = setup();
  const scheduler = new Scheduler(store, delivery({ send: async () => { throw new Error('Offline'); } }), () => {});
  await assert.rejects(scheduler.reroll('g', 'admin'), /retry automatically/);
  const pending = store.pending('g')!;
  await scheduler.stop();
  await assert.rejects(scheduler.reroll('g', 'admin'), /shutting down/);
  await scheduler.tick(due);
  assert.equal(store.pending('g')!.id, pending.id);
  assert.equal(store.historyCount('g'), 0);
});

test('shutdown drains an in-flight send before returning', async () => {
  const { store, due } = setup();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sending = new Promise<void>(resolve => { entered = resolve; });
  const scheduler = new Scheduler(store, delivery({ send: async () => { entered(); await gate; return 'message'; } }));
  const tick = scheduler.tick(due);
  await sending;
  let stopped = false;
  const stop = scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([tick, stop]);
  assert.equal(stopped, true);
  assert.equal(store.historyCount('g'), 1);
});

test('manual rerolls share the polling lock and retry the same new announcement', async () => {
  const { store, due } = setup();
  store.addAlbum('g', 'bob', 'B', 'Artist');
  let calls = 0;
  const targets: (string | null)[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new Scheduler(store, delivery({ send: async (_guild, pick) => {
    targets.push(pick.message_id);
    calls++;
    if (calls === 2) { await gate; throw new Error('Offline'); }
    return 'announcement';
  } }), () => {});
  await scheduler.tick(due);
  const reroll = scheduler.reroll('g', 'admin');
  await assert.rejects(scheduler.reroll('g', 'admin'), /already running/);
  await scheduler.tick(due);
  release();
  await assert.rejects(reroll, /saved.*retry automatically/);
  assert.ok(store.pending('g'));
  await scheduler.tick(due + 30000);
  assert.deepEqual(targets, [null, null, null]);
  assert.equal(store.history('g').length, 2);
  assert.equal(store.pending('g'), undefined);
});

test('retries the same pick after send failure, then records delivery exactly once', async () => {
  const { store, due } = setup();
  const nonces: string[] = [];
  const errors: unknown[] = [];
  const scheduler = new Scheduler(store, delivery({ send: async (_guild, pick) => {
    nonces.push(pick.nonce);
    if (nonces.length === 1) throw new Error('Discord down');
    return 'sent';
  } }), error => errors.push(error));
  await scheduler.tick(due);
  assert.equal(errors.length, 1);
  assert.ok(store.pending('g'));
  assert.equal(store.history('g').length, 0);
  await scheduler.tick(due + 30000);
  await scheduler.tick(due + 60000);
  assert.equal(nonces.length, 2);
  assert.equal(nonces[0], nonces[1]);
  assert.equal(store.pending('g'), undefined);
  assert.equal(store.history('g').length, 1);
});

test('prunes departed members before drawing', async () => {
  const { store, due } = setup();
  store.addAlbum('g', 'bob', 'B', 'Artist');
  const scheduler = new Scheduler(store, delivery({ isMember: async (_guild, user) => user === 'bob' }));
  await scheduler.tick(due);
  assert.equal(store.history('g')[0]?.user_id, 'bob');
  assert.equal(store.albums('g', 'alice').length, 0);
});

test('membership API failure preserves queues and due time', async () => {
  const { store, due } = setup();
  const scheduler = new Scheduler(store, delivery({ isMember: async () => { throw new Error('Network failure'); } }), () => {});
  await scheduler.tick(due);
  assert.equal(store.albums('g', 'alice').length, 1);
  assert.equal(store.guild('g').next_run, due);
});

test('overlapping ticks cannot send duplicate announcements', async () => {
  const { store, due } = setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const scheduler = new Scheduler(store, delivery({ send: async () => { calls++; await gate; return 'sent'; } }));
  const first = scheduler.tick(due);
  await scheduler.tick(due);
  release();
  await first;
  assert.equal(calls, 1);
});

test('one server failure does not block another and disconnected guilds remain due', async () => {
  const { store, due } = setup();
  for (const id of ['other', 'offline']) {
    store.configure(id, 'channel', 'role', undefined, due - 1000);
    store.addAlbum(id, 'bob', 'B', 'Artist');
  }
  const scheduler = new Scheduler(store, delivery({ available: id => id !== 'offline', send: async guild => {
    if (guild.id === 'g') throw new Error('Missing permissions');
    return 'sent';
  } }), () => {});
  await scheduler.tick(due);
  assert.ok(store.pending('g'));
  assert.equal(store.history('other').length, 1);
  assert.equal(store.guild('offline').next_run, due);
});
