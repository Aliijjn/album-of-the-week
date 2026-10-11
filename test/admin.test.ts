import assert from 'node:assert/strict';
import { test, onTestFinished } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionsBitField, PermissionFlagsBits, type ChatInputCommandInteraction, type ButtonInteraction, type AutocompleteInteraction } from 'discord.js';
import { Store } from '../src/store.js';
import { parseHistoryTime } from '../src/admin.js';
import { handleCommand } from '../src/discord.js';
import { handleAutocomplete } from '../src/autocomplete.js';
import { handlePageButton, roundsPage } from '../src/pages.js';

function fixture() {
  const store = new Store(':memory:');
  onTestFinished(() => store.close());
  store.configure('g', 'channel', 'role', undefined, 0);
  return store;
}
function publish(store: Store, time: number, title = 'Album') {
  store.addAlbum('g', 'owner', title, 'Artist');
  const pick = store.reserveNow('g', time);
  store.markSent(pick.id, 'message');
  return pick;
}

test('history imports cannot replace the active album, reveal its ratings or consume a turn', () => {
  const store = fixture();
  const active = publish(store, 10000);
  store.rate('g', 'voter', 8);
  store.addAlbum('g', 'owner', 'Queued', 'Artist');
  const before = { guild: store.guild('g'), rounds: store.participantRounds('g'), queue: store.albums('g', 'owner') };
  const imported = store.addHistory('g', 'historical-user', 'Imported', 'Artist', 1000, 2000);
  assert.equal(store.current('g')?.id, active.id);
  assert.equal(store.rate('g', 'voter', 9).id, active.id);
  assert.equal(store.current('g')?.ratings_revealed, 0);
  assert.equal(store.rate('g', 'voter', 7, imported.id).ratings_revealed, 1);
  assert.equal(store.ratings('g', imported.id).ratings[0]?.score, 7);
  assert.deepEqual(store.history('g').map(p => p.id), [active.id, imported.id]);
  assert.deepEqual({ guild: store.guild('g'), rounds: store.participantRounds('g'), queue: store.albums('g', 'owner') }, before);
  const next = store.reserveNow('g', 20000);
  assert.equal(JSON.parse(next.summary_json!).title, 'Album');
  assert.equal(store.current('g')?.ended_at, 20000);
  assert.equal(store.current('g')?.ratings_revealed, 1);
});

test('admin edits preserve ratings and current identity; history deletion is scoped and cascades ratings', () => {
  const store = fixture();
  const old = publish(store, 1000);
  store.rate('g', 'voter', 5);
  const active = publish(store, 2000, 'Active');
  store.editPick('g', old.id, { title: 'Corrected', artist: 'Correct artist', user: 'correct-owner', start: 500, end: 1500 });
  assert.equal(store.ratings('g', old.id).pick.title, 'Corrected');
  assert.equal(store.ratings('g', old.id).ratings[0]?.score, 5);
  store.editPick('g', active.id, { title: 'Current correction', start: 1800 });
  assert.equal(store.current('g')?.title, 'Current correction');
  assert.throws(() => store.editPick('g', active.id, { end: 3000 }), /active album/);
  assert.throws(() => store.editPick('g', old.id, {}), /at least one/);
  assert.throws(() => store.editPick('g', old.id, { start: 1800, end: 2000 }), /already has/);
  assert.throws(() => store.deleteHistory('g', active.id), /active album/);
  assert.throws(() => store.editPick('other', old.id, { title: 'Wrong server' }), /not found/);
  assert.throws(() => store.deleteHistory('other', old.id), /not found/);
  const rounds = store.participantRounds('g');
  store.deleteHistory('g', old.id);
  assert.equal(store.historyCount('g'), 1);
  assert.deepEqual(store.db.query('SELECT * FROM ratings WHERE pick_id=?').all(old.id), []);
  assert.deepEqual(store.participantRounds('g'), rounds);
  assert.equal(store.current('g')?.ratings_revealed, 0);
});

test('date parsing is timezone-aware and history periods must be valid and unique', () => {
  assert.equal(parseHistoryTime('2026-10-11T12:00+02:00'), Date.parse('2026-10-11T10:00Z'));
  assert.equal(parseHistoryTime('<t:1000:F>'), 1000000);
  for (const input of ['2026-10-11T12:00', '2026-02-30T12:00Z', '2026-13-01T12:00Z', 'yesterday', '2026-01-01T24:00Z']) {
    assert.throws(() => parseHistoryTime(input), /date with timezone/);
  }
  const store = fixture();
  for (const [start, end] of [[200, 100], [100, 100], [NaN, 200], [100, Date.now() + 100000]]) {
    assert.throws(() => store.addHistory('g', 'u', 'Album', 'Artist', start!, end!));
  }
  store.addHistory('g', 'u', 'Album', 'Artist', 100, 200);
  assert.equal(store.current('g'), undefined);
  assert.throws(() => store.rate('g', 'u', 5), /no active album/);
  assert.throws(() => store.addHistory('g', 'u', 'Other', 'Artist', 100, 200), /already has/);
});

test('round edits change eligibility without altering history and pending deliveries block mutations', () => {
  const store = fixture();
  publish(store, 1000);
  store.addAlbum('g', 'owner', 'Next', 'Artist');
  assert.equal(store.participantRounds('g')[0]?.last_round, 1);
  store.setParticipantRound('g', 'owner', 0);
  assert.equal(store.participantRounds('g')[0]?.last_round, 0);
  assert.equal(store.historyCount('g'), 1);
  assert.throws(() => store.setParticipantRound('g', 'owner', 2), /0 to 1/);
  const pending = store.reserveNow('g', 2000);
  assert.equal(pending.round, 1);
  assert.throws(() => store.setParticipantRound('g', 'owner', 0), /pending/);
  assert.throws(() => store.editPick('g', pending.id, { title: 'New' }), /pending/);
  assert.throws(() => store.deleteHistory('g', 1), /pending/);
  assert.throws(() => store.addHistory('g', 'u', 'Old', 'Artist', 10, 20), /pending/);
});

test('every admin command and admin autocomplete enforce permissions', async () => {
  const store = fixture();
  let command = 'rounds';
  let reply = '';
  const interaction = {
    inGuild: () => true, guildId: 'g', user: { id: 'owner' }, commandName: 'aotw',
    options: { getSubcommand: () => command, getSubcommandGroup: () => 'admin' },
    deferReply: async () => {}, editReply: async (r: { content: string }) => { reply = r.content; },
  } as unknown as ChatInputCommandInteraction;
  for (command of ['setup', 'pause', 'reroll', 'add-history', 'edit', 'delete-history', 'rounds', 'set-round']) {
    await handleCommand(interaction, store);
    assert.match(reply, /Manage Server/);
  }
  let choices: unknown;
  const autocomplete = { ...interaction, options: { getSubcommand: () => 'edit', getSubcommandGroup: () => 'admin', getFocused: () => ({ name: 'album', value: '' }) }, respond: async (r: unknown) => { choices = r; } } as unknown as AutocompleteInteraction;
  await handleAutocomplete(autocomplete, store);
  assert.deepEqual(choices, []);
  const active = publish(store, 1000);
  store.addHistory('g', 'u', 'Imported', 'Artist', 100, 200);
  assert.equal(store.searchAlbums('g', 'admin', 'delete-history', true, '').length, 1);
  assert.ok(!store.searchAlbums('g', 'admin', 'delete-history', true, '').some(a => a.id === active.id));
});

test('round pages paginate and recheck permissions on button clicks', async () => {
  const store = fixture();
  for (let i = 0; i < 11; i++) store.setParticipantRound('g', `user${i}`, 0);
  const first = roundsPage(store, 'g', 'admin');
  assert.match(first.embeds[0]!.toJSON().footer!.text, /Page 1 of 2/);
  let edited = false;
  let denied = false;
  const interaction = {
    inGuild: () => true, guildId: 'g', user: { id: 'admin' }, customId: 'aotw:rounds:admin:2',
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild), deferUpdate: async () => {},
    editReply: async (r: typeof first) => { edited = true; assert.match(r.embeds[0]!.toJSON().footer!.text, /Page 2 of 2/); },
    reply: async () => { denied = true; },
  } as unknown as ButtonInteraction;
  await handlePageButton(interaction, store);
  assert.ok(edited);
  Object.assign(interaction, { memberPermissions: new PermissionsBitField() });
  edited = false;
  await handlePageButton(interaction, store);
  assert.ok(denied);
  assert.equal(edited, false);
});

test('admin commands pass selected albums, dates, submitters and counters through to storage', async () => {
  const store = fixture();
  let command = 'add-history';
  let strings: Record<string, string> = { title: 'Imported', artist: 'Artist', start: '2020-01-01T12:00Z', end: '2020-01-08T12:00Z' };
  let reply = '';
  const interaction = {
    inGuild: () => true, guildId: 'g', user: { id: 'admin' }, commandName: 'aotw',
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    options: {
      getSubcommand: () => command, getSubcommandGroup: () => 'admin',
      getString: (name: string) => strings[name] ?? null,
      getUser: () => ({ id: 'submitter' }), getInteger: () => 1,
    },
    deferReply: async () => {}, editReply: async (r: { content: string }) => { reply = r.content; },
  } as unknown as ChatInputCommandInteraction;
  await handleCommand(interaction, store);
  assert.match(reply, /Added to history/);
  const imported = store.history('g')[0]!;
  assert.equal(imported.user_id, 'submitter');
  command = 'edit';
  strings = { album: `pick:${imported.id}`, title: 'Corrected' };
  await handleCommand(interaction, store);
  assert.match(reply, /Updated:/);
  assert.equal(store.history('g')[0]?.title, 'Corrected');
  command = 'set-round';
  await handleCommand(interaction, store);
  assert.equal(store.participantRounds('g')[0]?.last_round, 1);
  command = 'delete-history';
  await handleCommand(interaction, store);
  assert.match(reply, /Deleted from history/);
  assert.equal(store.historyCount('g'), 0);
});

test('legacy databases gain end times without changing current album, ratings or counters', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aotw-periods-'));
  const path = join(directory, 'test.sqlite');
  const store = new Store(path);
  store.configure('g', 'channel', 'role', undefined, 0);
  const old = publish(store, 1000);
  store.rate('g', 'u', 8);
  const active = publish(store, 2000);
  store.db.exec('ALTER TABLE picks DROP COLUMN ended_at; ALTER TABLE picks DROP COLUMN is_history;');
  store.close();
  const reopened = new Store(path);
  try {
    assert.equal(reopened.current('g')?.id, active.id);
    assert.equal(reopened.current('g')?.ratings_revealed, 0);
    assert.equal(reopened.ratings('g', old.id).pick.ended_at, 2000);
    assert.equal(reopened.ratings('g', old.id).ratings[0]?.score, 8);
    assert.equal(reopened.participantRounds('g')[0]?.last_round, 2);
  } finally { reopened.close(); rmSync(directory, { recursive: true, force: true }); }
});
