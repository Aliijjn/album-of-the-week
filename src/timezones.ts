import type { AutocompleteInteraction } from 'discord.js';

const commonTimezones = [
  'UTC', 'Europe/Amsterdam', 'Europe/London', 'Europe/Berlin', 'Europe/Paris',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Helsinki', 'Europe/Athens',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Vancouver', 'America/Sao_Paulo',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo',
  'Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland', 'Africa/Johannesburg',
];
const timezones = [...new Set([...commonTimezones, ...Intl.supportedValuesOf('timeZone')])];
const normalize = (value: string) => value.toLowerCase().replaceAll('_', ' ').trim();

export function timezoneChoices(query: string) {
  const search = normalize(query);
  return timezones.filter(zone => normalize(zone === 'UTC' ? 'UTC GMT' : zone).includes(search))
    .slice(0, 25).map(zone => ({ name: zone === 'UTC' ? 'UTC (GMT)' : zone.replaceAll('_', ' '), value: zone }));
}

export async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (interaction.commandName === 'aotw' && interaction.options.getSubcommand() === 'setup' && focused.name === 'timezone') {
    await interaction.respond(timezoneChoices(String(focused.value)));
  } else {
    await interaction.respond([]);
  }
}
