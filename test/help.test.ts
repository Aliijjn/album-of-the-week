import assert from 'node:assert/strict';
import { test, onTestFinished } from 'bun:test';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { commands, helpReply, commandHelpFields } from '../src/commands.js';
import { handleCommand } from '../src/discord.js';
import { Store } from '../src/store.js';

test('help lists every other registered command, options and guidance within Discord limits', () => {
  const reply = helpReply();
  const embed = reply.embeds[0]!.toJSON();
  const fields = embed.fields!;
  for (const command of commandHelpFields()) {
    assert.equal(fields.filter(field => field.name === command.name).length, 1);
  }
  assert.ok(fields.some(field => field.name.startsWith('/aotw admin add-history ')));
  assert.ok(fields.some(field => field.name.startsWith('/aotw queue rename ')));
  assert.ok(fields.length <= 25);
  assert.ok(fields.every(field => field.name.length <= 256 && field.value.length <= 1024));
  assert.ok(reply.embeds[0]!.length <= 6000);
  assert.match(JSON.stringify(embed), /8.5/);
  assert.match(JSON.stringify(embed), /Manage Server/);
  assert.match(fields.find(f => f.name.startsWith('/aotw rate '))!.name, /<score> \[album\]/);
  assert.doesNotMatch(JSON.stringify(embed), /\bIDs?\b|pick:\d|queue:\d/);
  assert.deepEqual(reply.allowedMentions, { parse: [] });
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
  assert.deepEqual(reply, helpReply());
});
