import {
  ApplicationCommandOptionType, ChannelType, EmbedBuilder, InteractionContextType, SlashCommandBuilder,
} from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('aotw').setDescription('Manage album of the week')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand(c => c.setName('help').setDescription('List all commands and how to use them'))
    .addSubcommand(c => c.setName('timezone').setDescription('Set your timezone for album pickers; omit timezone to use each server’s setting')
      .addStringOption(o => o.setName('timezone').setDescription('Your timezone, e.g. Europe/Amsterdam').setAutocomplete(true).setMaxLength(80)))
    .addSubcommand(c => c.setName('current').setDescription('Show the most recently announced album'))
    .addSubcommand(c => c.setName('history').setDescription('Browse album history, newest start time first')
      .addIntegerOption(o => o.setName('page').setDescription('Page number (5 albums per page)').setMinValue(1)))
    .addSubcommand(c => c.setName('leaderboard').setDescription('Browse albums ranked by average rating'))
    .addSubcommand(c => c.setName('ratings').setDescription('View individual ratings for a previous album')
      .addStringOption(o => o.setName('album').setDescription('Search previous albums by title or artist').setRequired(true).setAutocomplete(true)))
    .addSubcommand(c => c.setName('rate').setDescription('Rate the active album or a previous pick, or update your rating')
      .addNumberOption(o => o.setName('score').setDescription('Your rating from 0 to 10').setRequired(true).setMinValue(0).setMaxValue(10))
      .addStringOption(o => o.setName('album').setDescription('Search picked albums; omit for the active album').setAutocomplete(true)))
    .addSubcommand(c => c.setName('status').setDescription('Show the weekly schedule and settings'))
    .addSubcommandGroup(g => g.setName('queue').setDescription('Manage queued albums')
      .addSubcommand(c => c.setName('add').setDescription('Add an album (up to 5 queued per server)')
        .addStringOption(o => o.setName('title').setDescription('Album name').setRequired(true).setMaxLength(150))
        .addStringOption(o => o.setName('artist').setDescription('Artist name').setRequired(true).setMaxLength(150)))
      .addSubcommand(c => c.setName('list').setDescription('Show your queued albums'))
      .addSubcommand(c => c.setName('rename').setDescription('Rename a queued album you submitted (or any queued album with Manage Server)')
        .addStringOption(o => o.setName('album').setDescription('Search queued albums by title or artist').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('title').setDescription('Correct album title').setRequired(true).setMaxLength(150))
        .addStringOption(o => o.setName('artist').setDescription('Correct artist name (optional)').setMaxLength(150)))
      .addSubcommand(c => c.setName('remove').setDescription('Remove one of your queued albums')
        .addStringOption(o => o.setName('album').setDescription('Search your queued albums by title or artist').setRequired(true).setAutocomplete(true))))
    .addSubcommandGroup(g => g.setName('admin').setDescription('Manage the schedule, history and rotation (Manage Server required)')
      .addSubcommand(c => c.setName('reroll').setDescription('Draw and announce a new album now (Manage Server required)'))
      .addSubcommand(c => c.setName('setup').setDescription('Enable weekly picks or update settings')
        .addChannelOption(o => o.setName('channel').setDescription('Announcement channel').setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption(o => o.setName('role').setDescription('Role to ping; defaults to album-of-the-week'))
        .addIntegerOption(o => o.setName('day').setDescription('Day of the week; default Sunday')
          .addChoices(...['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((name, value) => ({ name, value }))))
        .addStringOption(o => o.setName('time').setDescription('24-hour HH:mm; default 12:00').setMinLength(5).setMaxLength(5))
        .addStringOption(o => o.setName('timezone').setDescription('Search and select a timezone; default UTC (GMT)').setMaxLength(80).setAutocomplete(true)))
      .addSubcommand(c => c.setName('pause').setDescription('Pause weekly announcements; keep all data (Manage Server required)'))
      .addSubcommand(c => c.setName('add-history').setDescription('Add a past album without changing the active album or rotation')
        .addStringOption(o => o.setName('title').setDescription('Album name').setRequired(true).setMaxLength(150))
        .addStringOption(o => o.setName('artist').setDescription('Artist name').setRequired(true).setMaxLength(150))
        .addStringOption(o => o.setName('start').setDescription('Start: 2026-10-11T12:00+02:00 or a Discord timestamp').setRequired(true))
        .addStringOption(o => o.setName('end').setDescription('End: 2026-10-18T12:00+02:00 or a Discord timestamp').setRequired(true))
        .addUserOption(o => o.setName('user').setDescription('Who submitted this album').setRequired(true)))
      .addSubcommand(c => c.setName('edit').setDescription('Edit a historical or active album; existing ratings are kept')
        .addStringOption(o => o.setName('album').setDescription('Search historical or active albums').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('title').setDescription('New album name').setMaxLength(150))
        .addStringOption(o => o.setName('artist').setDescription('New artist name').setMaxLength(150))
        .addStringOption(o => o.setName('start').setDescription('Start: 2026-10-11T12:00+02:00 or a Discord timestamp'))
        .addStringOption(o => o.setName('end').setDescription('End for historical albums only; include timezone offset'))
        .addUserOption(o => o.setName('user').setDescription('Correct submitter')))
      .addSubcommand(c => c.setName('delete-history').setDescription('Delete a past album and its ratings; cannot delete the active album')
        .addStringOption(o => o.setName('album').setDescription('Search past albums').setRequired(true).setAutocomplete(true)))
      .addSubcommand(c => c.setName('rounds').setDescription('See each participant’s last selected round and eligibility'))
      .addSubcommand(c => c.setName('set-round').setDescription('Set a participant’s last selected round; affects their next turn')
        .addUserOption(o => o.setName('user').setDescription('Participant to update').setRequired(true))
        .addIntegerOption(o => o.setName('round').setDescription('Last selected round: 0 through the current server round').setMinValue(0).setRequired(true)))),
];

export function commandHelpFields() {
  return (commands[0]!.toJSON().options ?? []).flatMap(command => {
    if (command.name === 'help') return [];
    const children = command.type === ApplicationCommandOptionType.SubcommandGroup ? command.options ?? [] : [command];
    return children.map(child => ({
      name: `/aotw ${command.type === ApplicationCommandOptionType.SubcommandGroup ? command.name + ' ' : ''}${child.name}${'options' in child ? (child.options ?? []).map(option => option.required ? ` <${option.name}>` : ` [${option.name}]`).join('') : ''}`,
      value: child.description,
    }));
  });
}

export function helpReply() {
  return {
    embeds: [new EmbedBuilder().setTitle('Album of the week - Help')
      .setDescription('<required> options must be filled in; [optional] options can be omitted. For **album**, search by title or artist and select a match. Browse results using Previous/Next.')
      .addFields(commandHelpFields())
      .addFields({ name: 'Ratings', value: 'Rate from 0 to 10 (decimals such as 8.5 work). Omit album for the active pick. Rating again replaces your score. Scores and averages are hidden until the next pick.' },
        { name: 'Permissions and dates', value: 'All admin commands require Manage Server. Queue rename is for the submitter or someone with Manage Server; remove only affects your own queue. Admin dates accept Discord timestamps or ISO dates with an explicit offset, such as 2026-10-11T12:00+02:00. Your personal timezone only affects picker dates.' })],
    allowedMentions: { parse: [] as [] },
  };
}
