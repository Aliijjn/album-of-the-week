import { PermissionFlagsBits, type AutocompleteInteraction } from 'discord.js';
import { Store, UserError } from './store.js';
import { handleAutocomplete as handleTimezoneAutocomplete } from './timezones.js';

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
  if (!interaction.inGuild() || !['rename', 'remove', 'rate', 'ratings'].includes(command)) {
    await interaction.respond([]);
    return;
  }
  const albums = store.searchAlbums(interaction.guildId, interaction.user.id,
    command as 'rename' | 'remove' | 'rate' | 'ratings',
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false, String(focused.value));
  await interaction.respond(albums.map(album => {
    const owner = interaction.guild?.members.cache.get(album.user_id)?.displayName ?? album.user_id;
    const suffix = album.kind === 'queue'
      ? ` [Queued${album.user_id === interaction.user.id ? '' : ` by ${owner.slice(0, 20)}`}]`
      : ` [Picked ${new Date(album.scheduled_at!).toISOString()}]`;
    const title = `${album.title} - ${album.artist}`;
    const available = 100 - suffix.length;
    const name = title.length <= available ? title : `${title.slice(0, available - 1)}…`;
    return { name: name + suffix, value: `${album.kind}:${album.id}` };
  }));
}
