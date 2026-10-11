import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ButtonInteraction } from 'discord.js';
import { Store } from '../src/store.js';
import { albumPage, handlePageButton, ratingsPage, ratingText } from '../src/pages.js';

function publish(store: Store, guild = 'g', title = 'Album') {
  store.addAlbum(guild, 'submitter', title, 'Artist');
  const pick = store.reserveDue(guild, store.guild(guild).next_run!)!;
  store.markSent(pick.id, 'message');
  return pick;
}

test('active ratings stay hidden until a scheduled pick or reroll, including empty weeks and other servers', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (const guild of ['g', 'other']) store.configure(guild, 'channel', 'role', undefined, 0);
  const first = publish(store);
  store.rate('g', 'a', 7.5);
  publish(store, 'other');
  store.reserveDue('g', store.guild('g').next_run!);
  const current = store.history('g')[0]!;
  assert.match(ratingText(current), /hidden/);
  assert.doesNotMatch(ratingText(current), /7.5|1 rating/);
  assert.match(albumPage(store, 'g', 'a', 'history').embeds[0]!.toJSON().description!, /hidden/);
  assert.equal(store.leaderboardCount('g'), 0);
  assert.throws(() => ratingsPage(store, 'g', 'a', first.id), /hidden/);
  const second = publish(store, 'g', 'Next');
  assert.equal(store.ratings('g', first.id).ratings[0]?.score, 7.5);
  assert.throws(() => store.ratings('other', first.id), /this server/);
  assert.throws(() => store.ratings('g', second.id), /hidden/);
  store.rate('g', 'a', 2);
  store.addAlbum('g', 'submitter', 'Reroll', 'Artist');
  store.reserveNow('g');
  assert.equal(store.ratings('g', second.id).ratings[0]?.score, 2);
  store.rate('g', 'a', 9, first.id);
  assert.equal(store.ratings('g', first.id).ratings[0]?.score, 9);
});

test('individual ratings paginate in descending score order and protect the requesting user', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.configure('g', 'channel', 'role', undefined, 0);
  const first = publish(store);
  for (let i = 0; i < 21; i++) store.rate('g', `user${i}`, i / 2);
  publish(store, 'g', 'Next');
  const page = ratingsPage(store, 'g', 'owner', first.id);
  const description = page.embeds[0]!.toJSON().description!;
  assert.match(description, /<@user20>: 10\/10\n<@user19>: 9.5\/10/);
  assert.doesNotMatch(description, /<@user0>:/);
  assert.deepEqual(page.allowedMentions, { parse: [] });
  let updated = false;
  let denied = false;
  const interaction = {
    inGuild: () => true, guildId: 'g', user: { id: 'owner' },
    customId: `aotw:ratings:owner:${first.id}:2`, deferUpdate: async () => {},
    editReply: async (payload: typeof page) => {
      updated = true;
      assert.match(payload.embeds[0]!.toJSON().description!, /<@user0>: 0\/10/);
      assert.match(payload.embeds[0]!.toJSON().footer!.text, /Page 2 of 2/);
      assert.ok(payload.components[0]!.toJSON().components[1]!.disabled);
    },
    reply: async () => { denied = true; },
  } as unknown as ButtonInteraction;
  await handlePageButton(interaction, store);
  assert.ok(updated);
  updated = false;
  Object.assign(interaction, { user: { id: 'stranger' } });
  await handlePageButton(interaction, store);
  assert.ok(denied);
  assert.equal(updated, false);
});

test('rating a previous pick updates only that user and pick, with server and delivery checks', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (const guild of ['g', 'other']) store.configure(guild, 'channel', 'role', undefined, 0);
  const first = publish(store, 'g', 'Previous');
  store.rate('g', 'a', 2);
  store.rate('g', 'b', 8);
  const latest = publish(store, 'g', 'Current');
  store.rate('g', 'a', 3);
  const updated = store.rate('g', 'a', 10, first.id);
  assert.equal(updated.id, first.id);
  assert.equal(updated.average, 9);
  assert.equal(updated.rating_count, 2);
  assert.equal(store.history('g')[0]?.id, latest.id);
  assert.equal(store.history('g')[0]?.average, 3);
  assert.equal(store.leaderboard('g')[0]?.id, first.id);
  const other = publish(store, 'other');
  for (const id of [other.id, 999999]) assert.throws(() => store.rate('g', 'a', 5, id), /this server/);
  for (const id of [0, -1, 1.5, NaN]) assert.throws(() => store.rate('g', 'a', 5, id), /valid pick ID/);
  store.addAlbum('g', 'submitter', 'Pending', 'Artist');
  const pending = store.reserveNow('g');
  const snapshot = pending.summary_json;
  assert.throws(() => store.rate('g', 'a', 5, pending.id), /announced history/);
  assert.throws(() => store.rate('g', 'a', 5), /pending/);
  assert.equal(store.rate('g', 'a', 7, latest.id).average, 7);
  assert.equal(store.pending('g')?.summary_json, snapshot, 'previously captured summaries remain snapshots');
});

test('ratings accept endpoints and decimals, update one vote, and stay with their album and server', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (const guild of ['g', 'other']) store.configure(guild, 'channel', 'role', undefined, 0);
  assert.throws(() => store.rate('g', 'a', 5), /no active album/);
  const first = publish(store);
  for (const score of [-1, 11, NaN, Infinity]) assert.throws(() => store.rate('g', 'a', score), /0 to 10/);
  assert.equal(store.rate('g', 'a', 0).average, 0);
  assert.equal(store.rate('g', 'b', 10).average, 5);
  const updated = store.rate('g', 'a', 7.5);
  assert.equal(updated.average, 8.75);
  assert.equal(updated.rating_count, 2);
  publish(store, 'other');
  store.rate('other', 'a', 1);
  publish(store, 'g', 'Next');
  store.rate('g', 'a', 3);
  assert.equal(store.history('g')[1]?.id, first.id);
  assert.equal(store.history('g')[1]?.average, 8.75);
  assert.equal(store.history('g')[0]?.average, 3);
  assert.equal(store.history('other')[0]?.average, 1);
});

test('leaderboard orders by average then vote count, excludes unrated picks, and preserves ratings across rerolls', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.configure('g', 'channel', 'role', undefined, 0);
  publish(store, 'g', 'Unrated');
  publish(store, 'g', 'One vote');
  store.rate('g', 'a', 8);
  publish(store, 'g', 'Two votes');
  store.rate('g', 'a', 8);
  store.rate('g', 'b', 8);
  publish(store, 'g', 'Winner');
  store.rate('g', 'a', 10);
  assert.deepEqual(store.leaderboard('g').map(p => p.title), ['Two votes', 'One vote']);
  assert.equal(store.leaderboardCount('g'), 2);
  assert.equal(store.leaderboard('g', 1, 1)[0]?.title, 'One vote');
  store.addAlbum('g', 'submitter', 'Replacement', 'Artist');
  const reroll = store.reserveNow('g');
  assert.throws(() => store.rate('g', 'a', 1), /pending/);
  store.markSent(reroll.id, 'message');
  assert.equal(store.history('g')[0]?.average, null);
  assert.equal(store.history('g')[0]?.rating_count, 0);
  assert.equal(store.leaderboardCount('g'), 3);
  assert.equal(store.history('g')[1]?.title, 'Winner');
  assert.equal(store.history('g')[1]?.average, 10);
});

test('button pagination updates the original result and protects the requesting user', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.configure('g', 'channel', 'role', undefined, 0);
  for (let i = 1; i <= 7; i++) { publish(store, 'g', `Album ${i}`); store.rate('g', 'a', i); }
  for (const kind of ['history', 'leaderboard'] as const) {
    const first = albumPage(store, 'g', 'owner', kind);
    const buttons = first.components[0]!.toJSON().components;
    assert.equal(buttons[0]!.disabled, true);
    assert.equal(buttons[1]!.disabled, false);
    let updates = 0;
    let denied = false;
    const interaction = {
      inGuild: () => true, guildId: 'g', user: { id: 'owner' },
      customId: `aotw:${kind}:owner:2`, deferUpdate: async () => {},
      editReply: async (payload: typeof first) => {
        updates++;
        assert.match(payload.embeds[0]!.toJSON().footer!.text, /Page 2 of 2/);
        const lastButtons = payload.components[0]!.toJSON().components;
        assert.equal(lastButtons[0]!.disabled, false);
        assert.equal(lastButtons[1]!.disabled, true);
        assert.match(payload.embeds[0]!.toJSON().description!, /1.00\/10/);
      },
      reply: async () => { denied = true; },
    } as unknown as ButtonInteraction;
    await handlePageButton(interaction, store);
    assert.equal(updates, 1);
    Object.assign(interaction, { user: { id: 'someone-else' } });
    await handlePageButton(interaction, store);
    assert.equal(denied, true);
    assert.equal(updates, 1);
  }
  const empty = albumPage(store, 'empty', 'owner', 'leaderboard', 99);
  assert.match(empty.embeds[0]!.toJSON().description!, /No rated albums/);
  assert.ok(empty.components[0]!.toJSON().components.every(button => button.disabled));
});

test('rating data survives a database restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aotw-ratings-'));
  const path = join(directory, 'test.sqlite');
  const store = new Store(path);
  try {
    store.configure('g', 'channel', 'role', undefined, 0);
    publish(store);
    store.rate('g', 'a', 9);
  } finally { store.close(); }
  const reopened = new Store(path);
  try { assert.equal(reopened.history('g')[0]?.average, 9); }
  finally { reopened.close(); rmSync(directory, { recursive: true, force: true }); }
});
