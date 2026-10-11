import { PermissionFlagsBits, type AutocompleteInteraction } from 'discord.js';
import { Store, UserError } from './store.js';
import { handleAutocomplete as handleTimezoneAutocomplete } from './timezones.js';

export function pickedTime(timestamp: number, timezone: string, locale = 'en-GB'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone, year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset',
  }).format(timestamp);
}

export function parseAlbum(value: string, expected?: 'queue' | 'pick') {
  const match = /^(queue|pick):([1-9]\d*)$/.exec(value);
  const id = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(id) || (expected && match[1] !== expected)) {
    throw new UserError('Select an album from the suggested matches. Type part of its title or artist to search.');
  }
  return { kind: match[1] as 'queue' | 'pick', id };
}

export async function handleAutocomplete(interaction: AutocompleteInteraction, store: Store): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const command = interaction.options.getSubcommand();
  if (interaction.commandName !== 'aotw' || focused.name !== 'album') {
    await handleTimezoneAutocomplete(interaction);
    return;
  }
  const group = interaction.options.getSubcommandGroup(false);
  const admin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  const valid = group === 'queue' ? ['rename', 'remove'] : group === 'admin' && admin ? ['edit', 'delete-history'] : group === null ? ['rate', 'ratings'] : [];
  if (!interaction.inGuild() || !valid.includes(command)) {
    await interaction.respond([]);
    return;
  }
  const albums = store.searchAlbums(interaction.guildId, interaction.user.id,
    command as 'rename' | 'remove' | 'rate' | 'ratings' | 'edit' | 'delete-history',
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false, String(focused.value));
  const timezone = store.userTimezone(interaction.user.id) ?? store.guild(interaction.guildId).timezone;
  const times = albums.map(album => album.kind === 'pick' ? pickedTime(album.scheduled_at!, timezone, interaction.locale) : '');
  const occurrences = new Map<string, number>();
  await interaction.respond(albums.map((album, index) => {
    const time = times[index]!;
    const occurrence = (occurrences.get(time) ?? 0) + 1;
    occurrences.set(time, occurrence);
    // Same-minute rerolls still need distinct labels after dropping seconds and milliseconds.
    const duplicate = times.filter(candidate => candidate === time).length > 1 ? ` (${occurrence})` : '';
    const owner = interaction.guild?.members.cache.get(album.user_id)?.displayName ?? 'another member';
    const suffix = album.kind === 'queue'
      ? ` [Queued${album.user_id === interaction.user.id ? '' : ` by ${owner.slice(0, 20)}`}]`
      : ` [Picked ${time}${duplicate}]`;
    const title = `${album.title} - ${album.artist}`;
    const available = 100 - suffix.length;
    const name = title.length <= available ? title : `${title.slice(0, available - 1)}…`;
    return { name: name + suffix, value: `${album.kind}:${album.id}` };
  }));
}
