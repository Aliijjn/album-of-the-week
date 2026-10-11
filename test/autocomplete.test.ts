import assert from 'node:assert/strict';
import { test, onTestFinished } from 'bun:test';
import { PermissionsBitField, PermissionFlagsBits, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { Store } from '../src/store.js';
import { handleAutocomplete, parseAlbum, pickedTime } from '../src/autocomplete.js';
import { handleCommand } from '../src/discord.js';
import { commands } from '../src/commands.js';

function publish(store: Store, title: string, guild = 'g', owner = 'owner') {
  store.addAlbum(guild, owner, title, 'Artist');
  const pick = store.reserveDue(guild, store.guild(guild).next_run!)!;
  store.markSent(pick.id, 'message');
  return pick;
}

test('search filters before limiting and respects server, ownership, delivery and rating visibility', () => {
  const store = new Store(':memory:');
  onTestFinished(() => store.close());
  for (const guild of ['g', 'other']) store.configure(guild, 'channel', 'role', undefined, 0);
  const old = publish(store, 'Rare ÉCHO');
  for (let i = 0; i < 27; i++) publish(store, `Album ${i}`);
  const latest = store.history('g')[0]!;
  publish(store, 'Foreign', 'other');
  const ownQueue = store.addAlbum('g', 'owner', 'Own queued', 'Artist');
  const otherQueue = store.addAlbum('g', 'someone', 'Other queued', 'Artist');
  const search = (command: 'rename' | 'remove' | 'rate' | 'ratings', query = '', admin = false) => store.searchAlbums('g', 'owner', command, admin, query);
  assert.equal(search('rate').length, 25);
  assert.equal(search('rate', 'artist écho')[0]?.id, old.id);
  assert.equal(search('rate', 'foreign').length, 0);
  assert.equal(search('rate')[0]?.id, latest.id);
  assert.ok(!search('ratings').some(a => a.id === latest.id));
  assert.deepEqual(search('remove', '', true).map(a => a.id), [ownQueue.id]);
  assert.equal(search('rename', 'Other queued').length, 0);
  assert.equal(search('rename', 'Other queued', true)[0]?.id, otherQueue.id);
  assert.equal(search('rename', 'Rare').length, 0);
  assert.equal(store.searchAlbums('g', 'owner', 'edit', true, 'Rare')[0]?.kind, 'pick');
  assert.equal(store.searchAlbums('g', 'someone', 'rename', false, 'Rare').length, 0);
  store.reserveNow('g');
  assert.ok(search('rate').every(a => a.id !== store.pending('g')!.id));
  assert.ok(search('ratings').some(a => a.id === latest.id));
});

test('autocomplete returns bounded labels, distinct repeat picks, and typed selection values', async () => {
  const store = new Store(':memory:');
  onTestFinished(() => store.close());
  store.configure('g', 'channel', 'role', undefined, 0);
  publish(store, 'A'.repeat(150));
  publish(store, 'A'.repeat(150));
  store.addAlbum('g', 'someone', 'Queued', 'Artist');
  let choices: { name: string; value: string }[] = [];
  let query = '';
  let command = 'rename';
  const interaction = {
    commandName: 'aotw', inGuild: () => true, guildId: 'g', user: { id: 'owner' },
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    options: { getSubcommand: () => command, getSubcommandGroup: () => command === 'rename' ? 'queue' : command === 'edit' ? 'admin' : null, getFocused: () => ({ name: 'album', value: query }) },
    respond: async (result: typeof choices) => { choices = result; },
  } as unknown as AutocompleteInteraction;
  await handleAutocomplete(interaction, store);
  assert.equal(choices.length, 1);
  assert.match(choices[0]!.name, /Queued by another member/);
  assert.ok(choices.every(c => c.name.length <= 100));
  command = 'edit';
  await handleAutocomplete(interaction, store);
  assert.equal(choices.length, 2);
  assert.notEqual(choices[0]!.name, choices[1]!.name);
  assert.equal(parseAlbum(choices[0]!.value).kind, 'pick');
  query = 'missing';
  await handleAutocomplete(interaction, store);
  assert.deepEqual(choices, []);
  for (const value of ['Album title', '1', 'pick:0', 'queue:1x', 'pick:99999999999999999']) {
    assert.throws(() => parseAlbum(value), /Select an album/);
  }
  assert.throws(() => parseAlbum('queue:1', 'pick'), /Select an album/);
});

test('submitted selections enforce ownership, server and reveal checks even when forged or stale', async () => {
  const store = new Store(':memory:');
  onTestFinished(() => store.close());
  for (const guild of ['g', 'other']) store.configure(guild, 'channel', 'role', undefined, 0);
  const active = publish(store, 'Active');
  const foreign = publish(store, 'Foreign', 'other');
  const queue = store.addAlbum('g', 'owner', 'Queue', 'Artist');
  let command = 'remove';
  let selected = `queue:${queue.id}`;
  let reply = '';
  const interaction = {
    inGuild: () => true, guildId: 'g', user: { id: 'stranger' }, commandName: 'aotw',
    deferReply: async () => {}, editReply: async (r: { content: string }) => { reply = r.content; },
    options: { getSubcommand: () => command, getSubcommandGroup: () => command === 'remove' ? 'queue' : null, getString: () => selected, getNumber: () => 8 },
  } as unknown as ChatInputCommandInteraction;
  await handleCommand(interaction, store);
  assert.match(reply, /not in your queue/);
  command = 'ratings'; selected = `pick:${active.id}`;
  await handleCommand(interaction, store);
  assert.match(reply, /hidden/);
  command = 'rate'; selected = `pick:${foreign.id}`;
  await handleCommand(interaction, store);
  assert.match(reply, /this server/);
  selected = 'Some title';
  await handleCommand(interaction, store);
  assert.match(reply, /Select an album/);
  command = 'remove'; selected = `queue:${queue.id}`;
  Object.assign(interaction, { user: { id: 'owner' } });
  await handleCommand(interaction, store);
  assert.match(reply, /Album removed/);
  await handleCommand(interaction, store);
  assert.match(reply, /not in your queue/);
});

test('album commands register searchable string options and rate keeps selection optional', () => {
  const options = commands[0]!.toJSON().options!;
  for (const name of ['rename', 'remove', 'rate', 'ratings']) {
    const queue = options.find(o => o.name === 'queue')!;
    const command = (['rename', 'remove'].includes(name) && 'options' in queue ? queue.options : options)!.find(o => o.name === name)!;
    assert.ok('options' in command);
    const album = command.options!.find(o => o.name === 'album')!;
    assert.ok('autocomplete' in album && album.autocomplete);
    assert.equal(album.type, 3);
    assert.equal(Boolean(album.required), name !== 'rate');
    assert.ok(!command.options!.some(o => ['id', 'entry'].includes(o.name)));
  }
});


test('picker times use personal timezone, daylight saving, locale and server fallback', async () => {
  const store = new Store(':memory:');
  onTestFinished(() => store.close());
  store.configure('g', 'channel', 'role', { weekday: 0, hour: 12, minute: 0, timezone: 'Asia/Tokyo' }, 0);
  publish(store, 'Album');
  let label = '';
  const command = 'rate';
  const interaction = {
    commandName: 'aotw', inGuild: () => true, guildId: 'g', user: { id: 'owner' }, locale: 'en-GB',
    options: { getSubcommand: () => command, getSubcommandGroup: () => null, getFocused: () => ({ name: 'album', value: '' }) },
    respond: async (choices: { name: string }[]) => { label = choices[0]!.name; },
  } as unknown as AutocompleteInteraction;
  await handleAutocomplete(interaction, store);
  assert.match(label, /GMT\+9/);
  store.setUserTimezone('owner', 'Europe/Amsterdam');
  await handleAutocomplete(interaction, store);
  assert.match(label, /GMT\+1/);
  assert.doesNotMatch(label, /T\d\d:|\.000Z/);
  assert.match(pickedTime(Date.parse('2026-10-11T10:54:20.651Z'), 'Europe/Amsterdam'), /12:54 GMT\+2/);
  assert.match(pickedTime(Date.parse('2026-12-11T10:54:20.651Z'), 'Europe/Amsterdam'), /11:54 GMT\+1/);
  assert.notEqual(pickedTime(0, 'UTC', 'en-US'), pickedTime(0, 'UTC', 'nl'));
  assert.throws(() => store.setUserTimezone('owner', 'invalid'), /valid timezone/);
  assert.equal(store.userTimezone('owner'), 'Europe/Amsterdam');
  store.setUserTimezone('owner', null);
  await handleAutocomplete(interaction, store);
  assert.match(label, /GMT\+9/);
});
