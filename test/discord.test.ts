import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Collection, PermissionsBitField, PermissionFlagsBits, type ChatInputCommandInteraction, type Client, type EmbedBuilder } from 'discord.js';
import { discordDelivery, handleCommand } from '../src/discord.js';
import { Store, type Guild, type Pick } from '../src/store.js';

test('rate command forwards an optional history ID and reports the selected album', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.configure('guild', 'channel', 'role', undefined, 0);
  const ids: number[] = [];
  for (const title of ['Old album', 'Current album']) {
    store.addAlbum('guild', 'a', title, 'Artist');
    const pick = store.reserveDue('guild', store.guild('guild').next_run!)!;
    store.markSent(pick.id, 'message');
    ids.push(pick.id);
  }
  let id: number | null = ids[0]!;
  const replies: { content: string }[] = [];
  const interaction = {
    inGuild: () => true, deferReply: async () => {},
    editReply: async (reply: { content: string }) => { replies.push(reply); },
    guildId: 'guild', user: { id: 'a' }, commandName: 'aotw',
    options: { getSubcommand: () => 'rate', getNumber: () => 8, getInteger: () => id },
  } as unknown as ChatInputCommandInteraction;
  await handleCommand(interaction, store);
  assert.match(replies[0]!.content, /Old album/);
  assert.equal(store.history('guild')[0]?.rating_count, 0);
  id = null;
  await handleCommand(interaction, store);
  assert.match(replies[1]!.content, /Current album/);
  assert.equal(store.history('guild')[0]?.average, 8);
});

test('setup cannot move an announcement while delivery is running', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.configure('guild', 'original-channel', 'role');
  const replies: { content: string }[] = [];
  const role = { id: 'role', name: 'album-of-the-week', mentionable: true };
  const interaction = {
    inGuild: () => true, deferReply: async () => {},
    editReply: async (reply: { content: string }) => { replies.push(reply); },
    guildId: 'guild', user: { id: 'admin' }, commandName: 'aotw',
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    guild: {
      channels: { fetch: async () => ({ permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.Administrator) }) },
      roles: { fetch: async () => new Collection([['role', role]]) },
      members: { fetchMe: async () => ({}) },
    },
    options: {
      getSubcommand: () => 'setup', getChannel: () => ({ id: 'new-channel' }),
      getRole: () => role, getString: () => null, getInteger: () => null,
    },
  } as unknown as ChatInputCommandInteraction;
  await handleCommand(interaction, store, { isRunning: () => true, reroll: async () => {} });
  assert.match(replies[0]!.content, /being processed/);
  assert.equal(store.guild('guild').channel_id, 'original-channel');
});

test('outdated subcommands are rejected instead of silently showing the current album', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const replies: { content: string }[] = [];
  const interaction = {
    inGuild: () => true, deferReply: async () => {},
    editReply: async (reply: { content: string }) => { replies.push(reply); },
    guildId: 'guild', user: { id: 'alice' }, commandName: 'aotw',
    options: { getSubcommand: () => 'now' },
  } as unknown as ChatInputCommandInteraction;
  await handleCommand(interaction, store);
  assert.match(replies[0]!.content, /out of date/);
});

test('history pages reach older picks, exclude other servers and pending picks, and handle invalid pages', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.configure('guild', 'channel', 'role', undefined, 0);
  for (let i = 1; i <= 8; i++) {
    store.addAlbum('guild', 'alice', `Album ${i}`, 'Artist');
    const pick = store.reserveDue('guild', store.guild('guild').next_run!, () => 0)!;
    if (i <= 7) store.markSent(pick.id, `message-${i}`);
  }
  store.configure('other', 'channel', 'role', undefined, 0);
  store.addAlbum('other', 'bob', 'Other server', 'Artist');
  const other = store.reserveDue('other', store.guild('other').next_run!)!;
  store.markSent(other.id, 'other-message');
  let page: number | null = null;
  const replies: { content?: string; embeds?: EmbedBuilder[] }[] = [];
  const interaction = {
    inGuild: () => true, deferReply: async () => {},
    editReply: async (reply: typeof replies[number]) => { replies.push(reply); },
    guildId: 'guild', user: { id: 'alice' }, commandName: 'aotw',
    options: { getSubcommand: () => 'history', getInteger: () => page },
  } as unknown as ChatInputCommandInteraction;
  await handleCommand(interaction, store);
  const first = replies[0]!.embeds![0]!.toJSON();
  assert.match(first.footer!.text, /Page 1 of 2 · 7 albums/);
  assert.match(first.description!, /Album 7/);
  assert.doesNotMatch(first.description!, /Album [128]|Other server/);
  page = 2;
  await handleCommand(interaction, store);
  const last = replies[1]!.embeds![0]!.toJSON();
  assert.match(last.description!, /Album 2[\s\S]*Album 1/);
  assert.doesNotMatch(last.description!, /Album [3-8]|Other server/);
  page = 3;
  await handleCommand(interaction, store);
  assert.match(replies[2]!.embeds![0]!.toJSON().footer!.text, /Page 2 of 2/);
  Object.assign(interaction, { guildId: 'empty' });
  page = null;
  await handleCommand(interaction, store);
  const empty = replies[3]!.embeds![0]!.toJSON();
  assert.equal(empty.description, 'No albums announced yet.');
  assert.match(empty.footer!.text, /Page 1 of 1 · 0 albums/);
});

test('runtime permission checks reject admin commands even if command visibility is overridden', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.configure('guild', 'channel', 'role');
  const replies: { content: string }[] = [];
  const interaction = {
    inGuild: () => true,
    deferReply: async () => {},
    editReply: async (reply: { content: string }) => { replies.push(reply); },
    guildId: 'guild', user: { id: 'alice' },
    commandName: 'aotw', options: { getSubcommand: () => 'pause' },
    memberPermissions: new PermissionsBitField(),
  } as unknown as ChatInputCommandInteraction;
  await handleCommand(interaction, store);
  assert.match(replies[0]!.content, /Manage Server/);
  assert.equal(store.guild('guild').enabled, 1);
  interaction.options.getSubcommand = () => 'reroll';
  let rerolled = false;
  await handleCommand(interaction, store, { isRunning: () => false, reroll: async () => { rerolled = true; } });
  assert.equal(rerolled, false);
  assert.match(replies[1]!.content, /Manage Server/);
  Object.assign(interaction, { memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) });
  await handleCommand(interaction, store, { isRunning: () => false, reroll: async () => { rerolled = true; } });
  assert.equal(rerolled, true);
});

test('announcements allow only the configured role ping and reuse the saved nonce', async () => {
  const sent: Record<string, unknown>[] = [];
  const channel = {
    guildId: 'guild', isTextBased: () => true, isDMBased: () => false, isSendable: () => true,
    guild: { roles: { fetch: async () => ({ id: 'role', mentionable: true }) }, members: { fetchMe: async () => ({}) } },
    permissionsFor: () => new PermissionsBitField([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    ]),
    send: async (payload: Record<string, unknown>) => { sent.push(payload); return { id: 'message' }; },

  };
  const client = { channels: { fetch: async () => channel } } as unknown as Client;
  const guild = { id: 'guild', channel_id: 'channel', role_id: 'role' } as Guild;
  const pick = { id: 1, user_id: 'alice', title: '@everyone', artist: '<@123>', round: 1, scheduled_at: Date.now(), nonce: 'saved-nonce' } as Pick;
  assert.equal(await discordDelivery(client).send(guild, pick), 'message');
  assert.deepEqual(sent[0]!.allowedMentions, { parse: [], roles: ['role'], users: [], repliedUser: false });
  assert.equal(sent[0]!.nonce, 'saved-nonce');
  assert.equal(sent[0]!.enforceNonce, true);
  assert.equal(await discordDelivery(client).send(guild, { ...pick, id: 2, nonce: 'new-nonce' }), 'message');
  assert.equal(sent.length, 2, 'every new draw sends its own announcement');
  assert.equal(sent[1]!.content, '<@&role> this week’s album is here!');
  assert.deepEqual(sent[1]!.allowedMentions, sent[0]!.allowedMentions);
  channel.permissionsFor = () => new PermissionsBitField();
  await assert.rejects(() => discordDelivery(client).send(guild, pick), /permissions/);
  assert.equal(sent.length, 2);
});

test('reroll notice precedes the album and is not repeated after an album send failure', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.configure('guild', 'channel', 'role');
  store.addAlbum('guild', 'submitter', 'Album', 'Artist');
  const pick = store.reserveNow('guild', Date.now(), undefined, 'admin');
  const messages: Record<string, unknown>[] = [];
  let failAlbum = true;
  const channel = {
    guildId: 'guild', isTextBased: () => true, isDMBased: () => false, isSendable: () => true,
    guild: { roles: { fetch: async () => ({ id: 'role', mentionable: true }) }, members: { fetchMe: async () => ({}) } },
    permissionsFor: () => new PermissionsBitField([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    ]),
    send: async (payload: Record<string, unknown>) => {
      messages.push(payload);
      if (payload.embeds && failAlbum) throw new Error('Offline');
      return { id: payload.embeds ? 'album-message' : 'notice-message' };
    },
  };
  const delivery = discordDelivery({ channels: { fetch: async () => channel } } as unknown as Client);
  await assert.rejects(delivery.send(store.guild('guild'), pick, id => store.markRerollNotice(pick.id, id)), /Offline/);
  assert.equal(messages[0]!.content, '<@admin> rerolled...');
  assert.deepEqual(messages[0]!.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  assert.ok(messages[1]!.embeds);
  assert.notEqual(messages[0]!.nonce, messages[1]!.nonce);
  const pending = store.pending('guild')!;
  assert.equal(pending.rerolled_by, 'admin');
  assert.equal(pending.reroll_notice_id, 'notice-message');
  failAlbum = false;
  await delivery.send(store.guild('guild'), pending);
  assert.equal(messages.length, 3);
  assert.ok(messages[2]!.embeds);
});
