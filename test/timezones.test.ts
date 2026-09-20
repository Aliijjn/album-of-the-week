import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AutocompleteInteraction } from 'discord.js';
import { timezoneChoices, handleAutocomplete } from '../src/timezones.js';
import { commands } from '../src/commands.js';

test('timezone dropdown suggests valid values and filters city names with spaces or underscores', () => {
  const defaults = timezoneChoices('');
  assert.equal(defaults.length, 25);
  assert.equal(defaults[0]?.value, 'UTC');
  assert.ok(defaults.some(choice => choice.value === 'Europe/Amsterdam'));
  for (const choice of defaults) assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: choice.value }).format());
  assert.equal(timezoneChoices('  AMSTERDAM ')[0]?.value, 'Europe/Amsterdam');
  assert.equal(timezoneChoices('new york')[0]?.value, 'America/New_York');
  assert.deepEqual(timezoneChoices('new_york'), timezoneChoices('new york'));
  assert.equal(timezoneChoices('GMT')[0]?.value, 'UTC');
  assert.deepEqual(timezoneChoices('not-a-timezone'), []);
  assert.ok(timezoneChoices('America/').length <= 25);
});

test('timezone autocomplete responds with choices and is enabled in command registration', async () => {
  let choices: unknown;
  const interaction = {
    commandName: 'aotw',
    options: { getSubcommand: () => 'setup', getFocused: () => ({ name: 'timezone', value: 'Tokyo' }) },
    respond: async (result: unknown) => { choices = result; },
  } as unknown as AutocompleteInteraction;
  await handleAutocomplete(interaction);
  assert.deepEqual(choices, [{ name: 'Asia/Tokyo', value: 'Asia/Tokyo' }]);
  const setup = commands[0]!.toJSON().options?.find(option => option.name === 'setup');
  assert.ok(setup && 'options' in setup);
  const timezone = setup.options?.find(option => option.name === 'timezone');
  assert.ok(timezone && 'autocomplete' in timezone && timezone.autocomplete);
});
