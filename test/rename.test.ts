import assert from 'node:assert/strict';
import { test, onTestFinished } from 'bun:test';
import { Store } from '../src/store.js';
import { handleCommand } from '../src/discord.js';
import { PermissionsBitField, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';

test('rename enforces ownership and server boundaries and preserves queue constraints', () => {
  const store = new Store(':memory:');
  onTestFinished(() => store.close());
  const album = store.addAlbum('g', 'owner', 'Original', 'Artist');
  store.addAlbum('g', 'owner', 'Duplicate', 'Artist');
  assert.throws(() => store.rename('g', 'stranger', false, 'queue', album.id, 'Bad'), /Only the submitter/);
  assert.throws(() => store.rename('other', 'admin', true, 'queue', album.id, 'Bad'), /not found/);
  assert.throws(() => store.rename('g', 'admin', true, 'queue', album.id, ' DUPLICATE '), /already/);
  assert.throws(() => store.rename('g', 'owner', false, 'queue', album.id, ' '), /1-150/);
  assert.throws(() => store.rename('g', 'owner', false, 'queue', album.id, 'x', 'a'.repeat(151)), /1-150/);
  assert.equal(store.rename('g', 'owner', false, 'queue', album.id, '  Correct  title ').title, 'Correct title');
  assert.equal(store.rename('g', 'admin', true, 'queue', album.id, 'Correct title', 'New artist').artist, 'New artist');
  assert.throws(() => store.addAlbum('g', 'owner', 'correct title', 'new artist'), /already/);
});

test('queue rename rejects picked albums even for admins', () => {
  const store = new Store(':memory:');
  onTestFinished(() => store.close());
  store.configure('g', 'channel', 'role', undefined, 0);
  store.addAlbum('g', 'owner', 'Original', 'Artist');
  const pick = store.reserveNow('g');
  store.markSent(pick.id, 'message');
  assert.throws(() => store.rename('g', 'owner', true, 'pick', pick.id, 'New'), /Only admins can edit/);
  assert.equal(store.current('g')?.title, 'Original');
});

test('rename command allows the submitter or Manage Server, including Administrator', async () => {
  const store = new Store(':memory:');
  onTestFinished(() => store.close());
  const album = store.addAlbum('g', 'owner', 'Original', 'Artist');
  let reply = '';
  const interaction = {
    inGuild: () => true, deferReply: async () => {},
    editReply: async (payload: { content: string }) => { reply = payload.content; },
    guildId: 'g', user: { id: 'stranger' }, commandName: 'aotw',
    memberPermissions: new PermissionsBitField(),
    options: { getSubcommand: () => 'rename', getSubcommandGroup: () => 'queue', getInteger: () => album.id,
      getString: (name: string) => name === 'album' ? `queue:${album.id}` : name === 'title' ? 'Correct' : null },
  } as unknown as ChatInputCommandInteraction;
  await handleCommand(interaction, store);
  assert.match(reply, /Only the submitter/);
  for (const [user, permissions] of [['owner', 0n], ['admin', PermissionFlagsBits.ManageGuild], ['admin', PermissionFlagsBits.Administrator]] as const) {
    Object.assign(interaction, { user: { id: user }, memberPermissions: new PermissionsBitField(permissions) });
    await handleCommand(interaction, store);
    assert.match(reply, /Renamed:/);
  }
});
