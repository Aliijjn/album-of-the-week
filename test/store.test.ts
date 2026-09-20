import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const start = Date.parse('2026-09-18T10:00:00Z');
function fixture(t: { after: (fn: () => void) => void }) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.configure('guild', 'channel', 'role', undefined, start);
  return store;
}
function pick(store: Store) {
  const result = store.reserveDue('guild', store.guild('guild').next_run!, () => 0)!;
  assert.ok(result);
  store.markSent(result.id, `message-${result.id}`);
  return result;
}

test('limits, normalization, ownership and server isolation', t => {
  const store = fixture(t);
  const first = store.addAlbum('guild', 'alice', '  Album   One  ', 'ARTIST');
  assert.equal(first.title, 'Album One');
  assert.throws(() => store.addAlbum('guild', 'alice', 'album one', 'artist'), /already in your queue/);
  for (let i = 0; i < 4; i++) store.addAlbum('guild', 'alice', `Album ${i}`, 'Artist');
  assert.throws(() => store.addAlbum('guild', 'alice', 'Sixth', 'Artist'), /5 albums/);
  assert.throws(() => store.addAlbum('guild', 'bob', ' ', 'Artist'), /1–150/);
  assert.throws(() => store.addAlbum('guild', 'bob', 'a'.repeat(151), 'Artist'), /1–150/);
  assert.equal(store.removeAlbum('guild', 'bob', first.id), false);
  assert.equal(store.removeAlbum('other', 'alice', first.id), false);
  store.addAlbum('other', 'alice', 'Album One', 'Artist');
  assert.equal(store.albums('other', 'alice').length, 1);
  assert.equal(store.removeAlbum('guild', 'alice', first.id), true);
  assert.equal(store.albums('guild', 'alice').length, 4);
});

test('draw is user-first and users cannot repeat before the round completes', t => {
  const store = fixture(t);
  for (let i = 0; i < 5; i++) store.addAlbum('guild', 'alice', `A${i}`, 'Artist');
  store.addAlbum('guild', 'bob', 'B', 'Artist');
  const sizes: number[] = [];
  const first = store.reserveDue('guild', store.guild('guild').next_run!, size => { sizes.push(size); return 0; })!;
  assert.deepEqual(sizes, [2, 5]);
  assert.equal(first.user_id, 'alice');
  store.markSent(first.id, 'message');
  assert.equal(pick(store).user_id, 'bob');
  const third = pick(store);
  assert.equal(third.user_id, 'alice');
  assert.equal(third.round, 2);
  assert.equal(store.history('other').length, 0);
});

test('late joiners get one current-round turn, without historical catch-up', t => {
  const store = fixture(t);
  for (const user of ['alice', 'bob']) {
    store.addAlbum('guild', user, 'One', 'Artist');
    store.addAlbum('guild', user, 'Two', 'Artist');
  }
  assert.equal(pick(store).user_id, 'alice');
  store.addAlbum('guild', 'charlie', 'One', 'Artist');
  store.addAlbum('guild', 'charlie', 'Two', 'Artist');
  assert.equal(pick(store).user_id, 'bob');
  const late = pick(store);
  assert.equal(late.user_id, 'charlie');
  assert.equal(late.round, 1);
  assert.equal(pick(store).round, 2);
});

test('removing and re-adding a queue does not reset participation', t => {
  const store = fixture(t);
  store.addAlbum('guild', 'alice', 'A', 'Artist');
  store.addAlbum('guild', 'bob', 'B', 'Artist');
  assert.equal(pick(store).user_id, 'alice');
  store.removeMember('guild', 'alice');
  store.addAlbum('guild', 'alice', 'New', 'Artist');
  assert.equal(pick(store).user_id, 'bob');
});

test('empty schedules advance, paused servers do not draw, and downtime catches up once', t => {
  const store = fixture(t);
  const due = store.guild('guild').next_run!;
  assert.equal(store.reserveDue('guild', due - 1), undefined);
  assert.equal(store.reserveDue('guild', due), undefined);
  assert.ok(store.guild('guild').next_run! > due);
  store.addAlbum('guild', 'alice', 'A', 'Artist');
  store.pause('guild');
  assert.equal(store.reserveDue('guild', due + 30 * 86400000), undefined);
  store.configure('guild', 'channel', 'role', undefined, start);
  const now = due + 30 * 86400000;
  assert.ok(store.reserveDue('guild', now));
  assert.ok(store.guild('guild').next_run! > now);
  assert.equal(store.reserveDue('guild', now), undefined);
});

test('failed selection rolls back all changes', t => {
  const store = fixture(t);
  store.addAlbum('guild', 'alice', 'A', 'Artist');
  const due = store.guild('guild').next_run!;
  assert.throws(() => store.reserveDue('guild', due, () => 99), /invalid user/);
  assert.equal(store.guild('guild').next_run, due);
  assert.equal(store.albums('guild', 'alice').length, 1);
  assert.equal(store.pending('guild'), undefined);
});

test('pending picks and fairness survive reopening a database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aotw-'));
  let store: Store | undefined;
  try {
    store = new Store(join(directory, 'test.sqlite'));
    store.configure('guild', 'channel', 'role', undefined, start);
    store.addAlbum('guild', 'alice', 'A', 'Artist');
    store.addAlbum('guild', 'alice', 'A2', 'Artist');
    store.addAlbum('guild', 'bob', 'B', 'Artist');
    const pending = store.reserveDue('guild', store.guild('guild').next_run!, () => 0)!;
    store.close();
    store = new Store(join(directory, 'test.sqlite'));
    assert.equal(store.pending('guild')?.nonce, pending.nonce);
    assert.equal(store.albums('guild', 'alice').length, 1);
    assert.equal(store.history('guild').length, 0);
    assert.equal(store.reserveDue('guild', store.guild('guild').next_run!), undefined);
    store.markSent(pending.id, 'sent');
    assert.equal(pick(store).user_id, 'bob');
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reroll adds a new pick, preserves all history and the schedule, and uses fair turns', t => {
  const store = fixture(t);
  for (const user of ['alice', 'bob', 'charlie']) store.addAlbum('guild', user, user, 'Artist');
  const older = pick(store);
  const current = pick(store);
  store.markSent(current.id, 'announcement', 'original-channel');
  const next = store.guild('guild').next_run;
  const replacement = store.reserveNow('guild', start, () => 0);
  assert.notEqual(replacement.id, current.id);
  assert.equal(replacement.user_id, 'charlie');
  assert.equal(replacement.message_id, null);
  assert.equal(replacement.message_channel_id, null);
  assert.equal(replacement.scheduled_at, start);
  assert.equal(store.guild('guild').next_run, next);
  assert.throws(() => store.reserveNow('guild'), /awaiting delivery/);
  store.markSent(replacement.id, 'announcement');
  assert.deepEqual(store.history('guild').map(p => p.id), [replacement.id, current.id, older.id]);
  assert.equal(store.history('guild')[0]?.title, 'charlie');
  assert.equal(store.albums('guild', 'bob').length, 0);
});

test('now can make the first pick, while empty and paused rerolls leave the current pick intact', t => {
  const store = fixture(t);
  store.addAlbum('guild', 'alice', 'A', 'Artist');
  const next = store.guild('guild').next_run;
  const first = store.reserveNow('guild', start, () => 0);
  store.markSent(first.id, 'message');
  assert.equal(store.guild('guild').next_run, next);
  assert.throws(() => store.reserveNow('guild'), /No albums/);
  assert.equal(store.history('guild')[0]?.title, 'A');
  assert.equal(store.pending('guild'), undefined);
  store.pause('guild');
  assert.throws(() => store.reserveNow('guild'), /enable announcements/);
  assert.equal(store.history('guild')[0]?.title, 'A');
});

test('a manual draw at the due time satisfies that slot without a duplicate scheduled draw', t => {
  const store = fixture(t);
  store.addAlbum('guild', 'alice', 'A', 'Artist');
  store.addAlbum('guild', 'bob', 'B', 'Artist');
  const due = store.guild('guild').next_run!;
  const manual = store.reserveNow('guild', due, () => 0);
  store.markSent(manual.id, 'message');
  assert.ok(store.guild('guild').next_run! > due);
  assert.equal(store.reserveDue('guild', due), undefined);
  assert.equal(store.albums('guild', 'bob').length, 1);
});

test('changing channels resets pending delivery progress without changing the saved draw', t => {
  const store = fixture(t);
  store.addAlbum('guild', 'alice', 'Album', 'Artist');
  const pending = store.reserveNow('guild', start, () => 0, 'admin');
  store.markRerollNotice(pending.id, 'notice');
  store.markSummaryPage(pending.id, 2);
  store.configure('guild', 'channel', 'role', undefined, start);
  assert.equal(store.pending('guild')!.summary_pages_sent, 2, 'same-channel updates keep progress');
  store.configure('guild', 'new-channel', 'role', undefined, start);
  const retry = store.pending('guild')!;
  assert.equal(retry.id, pending.id);
  assert.equal(retry.nonce, pending.nonce);
  assert.equal(retry.rerolled_by, 'admin');
  assert.equal(retry.reroll_notice_id, null);
  assert.equal(retry.summary_pages_sent, 0);
});

test('an original database upgrades without losing albums, history or server settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aotw-migration-'));
  const path = join(directory, 'test.sqlite');
  const original = new Store(path);
  try {
    original.configure('guild', 'channel', 'role', undefined, start);
    original.addAlbum('guild', 'alice', 'First', 'Artist');
    pick(original);
    original.addAlbum('guild', 'alice', 'Queued', 'Artist');
    // Recreate the schema before delivery tracking and ratings were added.
    original.db.exec('DROP TABLE ratings');
    for (const name of ['message_channel_id', 'rerolled_by', 'reroll_notice_id', 'summary_json', 'summary_pages_sent']) {
      original.db.exec(`ALTER TABLE picks DROP COLUMN ${name}`);
    }
  } finally { original.close(); }
  const upgraded = new Store(path);
  try {
    assert.equal(upgraded.guild('guild').channel_id, 'channel');
    assert.equal(upgraded.history('guild')[0]?.title, 'First');
    assert.equal(upgraded.history('guild')[0]?.summary_pages_sent, 0);
    assert.equal(upgraded.albums('guild', 'alice')[0]?.title, 'Queued');
    assert.equal(upgraded.rate('guild', 'bob', 8).average, 8);
  } finally { upgraded.close(); rmSync(directory, { recursive: true, force: true }); }
});
