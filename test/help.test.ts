import { handlePageButton } from '../src/pages.js';
import assert from 'node:assert/strict';
import { test, onTestFinished } from 'bun:test';
import { MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { helpReply, commandHelpFields } from '../src/commands.js';
import { handleCommand } from '../src/discord.js';
import { Store } from '../src/store.js';

test('help sections cover every command with compact usage and stay within Discord limits', () => {
  const replies = (['listen', 'queue', 'admin'] as const).map(section => helpReply('user', section));
  const text = replies.map(reply => JSON.stringify(reply.embeds[0]!.toJSON())).join('\n');
  for (const command of commandHelpFields()) assert.ok(text.includes(command.name));
  assert.match(text, /8.5/);
  assert.match(text, /Manage Server/);
  assert.doesNotMatch(text, /\bIDs?\b|pick:\d|queue:\d/);
  for (const reply of replies) {
    const embed = reply.embeds[0]!.toJSON();
    assert.ok(embed.fields!.length <= 25);
    assert.ok(embed.fields!.every(field => field.name.length <= 256 && field.value.length <= 1024));
    assert.ok(reply.embeds[0]!.length <= 6000);
    assert.ok(embed.fields![0]!.value.includes('`/aotw '));
    assert.doesNotMatch(JSON.stringify(embed), /[├└─]|```/);
    assert.equal(reply.components[0]!.toJSON().components.filter(button => button.disabled).length, 1);
    assert.deepEqual(reply.allowedMentions, { parse: [] });
  }
  assert.doesNotMatch(JSON.stringify(replies[0]!.embeds), /\/aotw admin /);
  assert.equal(replies[0]!.embeds[0]!.toJSON().fields![0]!.name, 'See the current album');
});

test('help is available without admin permissions or setup and replies privately', async () => {
  const store = new Store(':memory:');
  onTestFinished(() => store.close());
  let deferred: unknown;
  let reply: unknown;
  const interaction = {
    inGuild: () => true, guildId: 'new-server', user: { id: 'user' }, commandName: 'aotw',
    options: { getSubcommand: () => 'help', getSubcommandGroup: () => null },
    deferReply: async (payload: unknown) => { deferred = payload; },
    editReply: async (payload: unknown) => { reply = payload; },
  } as unknown as ChatInputCommandInteraction;
  await handleCommand(interaction, store);
  assert.deepEqual(deferred, { flags: MessageFlags.Ephemeral });
  assert.deepEqual(reply, helpReply('user'));
});


test('help buttons switch sections in place and protect the original requester', async () => {
  const store = new Store(':memory:');
  onTestFinished(() => store.close());
  let updated = false;
  let denied = false;
  const interaction = {
    inGuild: () => true, user: { id: 'user' }, customId: 'aotw:help:user:admin',
    deferUpdate: async () => {},
    editReply: async (reply: unknown) => { updated = true; assert.deepEqual(reply, helpReply('user', 'admin')); },
    reply: async () => { denied = true; },
  } as unknown as ButtonInteraction;
  await handlePageButton(interaction, store);
  assert.ok(updated);
  updated = false;
  Object.assign(interaction, { user: { id: 'other' } });
  await handlePageButton(interaction, store);
  assert.ok(denied);
  assert.equal(updated, false);
});
