import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown, MessageFlags, type ButtonInteraction } from 'discord.js';
import { Store, UserError, type RatedPick } from './store.js';

export const albumText = (pick: { title: string; artist: string }) => `**${escapeMarkdown(pick.title)}** - ${escapeMarkdown(pick.artist)}`;
export const ratingText = (pick: RatedPick) => !pick.ratings_revealed ? 'Ratings hidden until the next pick' : pick.average === null ? 'No ratings' : `${pick.average.toFixed(2)}/10 (${pick.rating_count} ${pick.rating_count === 1 ? 'rating' : 'ratings'})`;
export type PageKind = 'history' | 'leaderboard';

export function albumPage(store: Store, guildId: string, userId: string, kind: PageKind, requestedPage = 1) {
  const total = kind === 'history' ? store.historyCount(guildId) : store.leaderboardCount(guildId);
  const pages = Math.max(1, Math.ceil(total / 5));
  // Keep requested pages within the current result set, including empty results.
  const page = Math.min(pages, Math.max(1, requestedPage));
  const offset = (page - 1) * 5;
  const picks = kind === 'history' ? store.history(guildId, 5, offset) : store.leaderboard(guildId, 5, offset);
  const embed = new EmbedBuilder().setTitle(kind === 'history' ? 'Album history' : 'Album leaderboard')
    .setDescription(picks.map((pick, i) => `${kind === 'leaderboard' ? `${offset + i + 1}. ` : ''}${albumText(pick)}\nSubmitted by <@${pick.user_id}> · <t:${Math.floor(pick.scheduled_at / 1000)}:D>\n${ratingText(pick)}`).join('\n\n') || (kind === 'history' ? 'No albums announced yet.' : 'No rated albums yet. Use /aotw rate to get started.'))
    .setFooter({ text: `Page ${page} of ${pages} · ${total} albums · Individual scores: /aotw ratings album:<search>` });
  const button = (label: string, target: number, disabled: boolean) => new ButtonBuilder()
    .setCustomId(`aotw:${kind}:${userId}:${target}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  return {
    embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      button('Previous', Math.max(1, page - 1), page === 1), button('Next', page + 1, page === pages),
    )], allowedMentions: { parse: [] as [] }
  };
}

export function ratingsPage(store: Store, guildId: string, userId: string, id: number, requestedPage = 1) {
  const { pick } = store.ratings(guildId, id, 0);
  const pages = Math.max(1, Math.ceil(pick.rating_count / 20));
  const page = Math.min(pages, Math.max(1, requestedPage));
  const { ratings } = store.ratings(guildId, id, 20, (page - 1) * 20);
  return {
    embeds: [new EmbedBuilder().setTitle('Album ratings')
      .setDescription(`${albumText(pick)}\n${ratingText(pick)}\n\n${ratings.map(r => `<@${r.user_id}>: ${r.score}/10`).join('\n') || 'No ratings were submitted.'}`)
      .setFooter({ text: `Page ${page} of ${pages}` })],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`aotw:ratings:${userId}:${id}:${Math.max(1, page - 1)}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
      new ButtonBuilder().setCustomId(`aotw:ratings:${userId}:${id}:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === pages),
    )], allowedMentions: { parse: [] as [] },
  };
}

export async function handlePageButton(interaction: ButtonInteraction, store: Store): Promise<void> {
  const ratingsMatch = /^aotw:ratings:([^:]+):(\d+):(\d+)$/.exec(interaction.customId);
  if (ratingsMatch && interaction.inGuild()) {
    if (ratingsMatch[1] !== interaction.user.id) {
      await interaction.reply({ content: 'Open your own result with /aotw ratings.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    try {
      await interaction.editReply({ content: null, ...ratingsPage(store, interaction.guildId, interaction.user.id, Number(ratingsMatch[2]), Number(ratingsMatch[3])) });
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      await interaction.editReply({ content: error.message, embeds: [], components: [] });
    }
    return;
  }
  const match = /^aotw:(history|leaderboard):([^:]+):(\d+)$/.exec(interaction.customId);
  if (!match || !interaction.inGuild()) return;
  if (match[2] !== interaction.user.id) {
    await interaction.reply({ content: 'Open your own result with /aotw history or /aotw leaderboard.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferUpdate();
  await interaction.editReply(albumPage(store, interaction.guildId, interaction.user.id, match[1] as PageKind, Number(match[3])));
}
