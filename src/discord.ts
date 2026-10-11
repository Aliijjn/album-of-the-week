import { parseAlbum } from './autocomplete.js';
import {
  Client, DiscordAPIError, EmbedBuilder, MessageFlags, PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Delivery, Scheduler } from './scheduler.js';
import { createHash } from 'node:crypto';
import { Store, UserError, type AlbumSummary } from './store.js';

import { albumText, ratingText, albumPage, ratingsPage } from './pages.js';

export function discordDelivery(client: Client): Delivery {
  return {
    available: id => client.isReady() && (client.guilds.cache.get(id)?.available ?? false),
    async isMember(guildId, userId) {
      try {
        await client.guilds.cache.get(guildId)!.members.fetch({ user: userId, force: true });
        return true;
      } catch (error) {
        if (error instanceof DiscordAPIError && error.code === 10007) return false;
        throw error;
      }
    },
    async send(guild, pick, noticeSent, summaryPageSent) {
      const channel = await client.channels.fetch(guild.channel_id!);
      if (!channel || !channel.isTextBased() || channel.isDMBased() || !channel.isSendable() || channel.guildId !== guild.id) {
        throw new Error('The configured announcement channel is unavailable. Run /aotw setup.');
      }
      const role = guild.role_id ? await channel.guild.roles.fetch(guild.role_id) : null;
      const me = await channel.guild.members.fetchMe();
      const permissions = channel.permissionsFor(me);
      if (!role || role.id === guild.id || !permissions?.has([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
      ]) || (!role.mentionable && !permissions.has(PermissionFlagsBits.MentionEveryone))) {
        throw new Error('Announcement permissions or ping role need repair. Run /aotw setup.');
      }
      if (pick.rerolled_by && !pick.reroll_notice_id) {
        const notice = await channel.send({
          content: `<@${pick.rerolled_by}> rerolled...`,
          allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
          nonce: `r${pick.nonce}`, enforceNonce: true,
        });
        noticeSent?.(notice.id);
      }
      if (pick.summary_json) {
        const summary = JSON.parse(pick.summary_json) as AlbumSummary;
        const pages = Math.max(1, Math.ceil(summary.ratings.length / 30));
        for (let page = pick.summary_pages_sent ?? 0; page < pages; page++) {
          const ratings = summary.ratings.slice(page * 30, (page + 1) * 30);
          await channel.send({
            embeds: [new EmbedBuilder().setColor(0x815ac0).setTitle('Previous album - final ratings')
              .setDescription(`${albumText(summary)}\nSubmitted by <@${summary.user_id}>\nAverage: ${summary.average === null ? 'No ratings' : `${summary.average.toFixed(2)}/10 (${summary.rating_count} ratings)`}\n\n${ratings.map(r => `<@${r.user_id}>: ${r.score}/10`).join('\n') || 'No ratings were submitted.'}`)
              .setFooter({ text: `Ratings summary · Page ${page + 1} of ${pages}` })],
            allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
            nonce: createHash('sha256').update(`${pick.nonce}:summary:${page}`).digest('hex').slice(0, 24),
            enforceNonce: true,
          });
          summaryPageSent?.(page + 1);
        }
      }
      const payload = {
        content: `<@&${role.id}> this week’s album is here!`,
        embeds: [new EmbedBuilder().setColor(0x815ac0).setTitle('Album of the week')
          .setDescription(albumText(pick)).addFields({ name: 'Submitted by', value: `<@${pick.user_id}>` })
          .setFooter({ text: `Round ${pick.round}` }).setTimestamp(pick.scheduled_at)],
        allowedMentions: { parse: [] as [], roles: [role.id], users: [], repliedUser: false },
      };
      const message = await channel.send({ ...payload, nonce: pick.nonce, enforceNonce: true });
      return message.id;
    },
  };
}

export async function handleCommand(interaction: ChatInputCommandInteraction, store: Store, scheduler?: Pick<Scheduler, 'reroll' | 'isRunning'>): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Use this command inside a server.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const sub = interaction.options.getSubcommand();
  const respond = async (content: string) => { await interaction.editReply({ content, allowedMentions: { parse: [] } }); };
  try {
    if (interaction.commandName !== 'aotw') throw new UserError('This command has moved. Use /aotw.');
    if (!['add', 'list', 'timezone', 'rename', 'remove', 'rate', 'ratings', 'setup', 'pause', 'reroll', 'status', 'history', 'leaderboard', 'current'].includes(sub)) {
      throw new UserError('This command is out of date. Refresh Discord and choose a current /aotw command.');
    }
    if (['add', 'list', 'remove'].includes(sub)) {
      if (sub === 'add') {
        const album = store.addAlbum(guildId, userId, interaction.options.getString('title', true), interaction.options.getString('artist', true));
        await respond(`Added: ${albumText(album)}. You have ${store.albums(guildId, userId).length}/5 albums queued.`);
      } else if (sub === 'list') {
        const albums = store.albums(guildId, userId);
        // Embeds accommodate five maximum-length album + artist names safely.
        await interaction.editReply({
          embeds: [new EmbedBuilder().setTitle(`Your queue (${albums.length}/5)`)
            .setDescription(albums.map(a => albumText(a)).join('\n') || 'Your queue is empty. Use /aotw add.')], allowedMentions: { parse: [] }
        });
      } else if (sub === 'remove') {
        const removed = store.removeAlbum(guildId, userId, parseAlbum(interaction.options.getString('album', true), 'queue').id);
        await respond(removed ? 'Album removed from your queue.' : 'That album is not in your queue. Search again with /aotw remove.');
      }
    } else if (sub === 'timezone') {
      const timezone = interaction.options.getString('timezone');
      store.setUserTimezone(userId, timezone);
      await respond(timezone ? `Album picker times will use ${timezone}.` : 'Album picker times will use each server’s configured timezone.');
    } else if (sub === 'rename') {
      const { kind: entry, id } = parseAlbum(interaction.options.getString('album', true));
      const album = store.rename(guildId, userId, interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
        entry, id, interaction.options.getString('title', true), interaction.options.getString('artist') ?? undefined);
      await respond(`Renamed: ${albumText(album)}.`);
    } else if (sub === 'ratings') {
      await interaction.editReply(ratingsPage(store, guildId, userId, parseAlbum(interaction.options.getString('album', true), 'pick').id));
    } else if (sub === 'rate') {
      const score = interaction.options.getNumber('score', true);
      const selected = interaction.options.getString('album');
      const pick = store.rate(guildId, userId, score, selected === null ? undefined : parseAlbum(selected, 'pick').id);
      await respond(`Your rating for ${albumText(pick)} is ${score}/10. ${ratingText(pick)}.`);
    } else if (['setup', 'pause', 'reroll'].includes(sub)) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new UserError('You need Manage Server permission.');
      if (sub === 'reroll') {
        if (!scheduler) throw new Error('Scheduler unavailable.');
        await scheduler.reroll(guildId, userId);
        await respond('A new album has been announced and added to history.');
      } else if (sub === 'pause') {
        store.pause(guildId);
        await respond('Weekly announcements are paused. Use /aotw setup to resume.');
      } else if (sub === 'setup') {
        const guild = interaction.guild ?? await interaction.client.guilds.fetch(guildId);
        const old = store.guild(guildId);
        const channelId = interaction.options.getChannel('channel', true).id;
        const channel = await guild.channels.fetch(channelId);
        const roles = await guild.roles.fetch();
        const roleId = interaction.options.getRole('role')?.id ?? old.role_id;
        const matches = roles.filter(r => r.name === 'album-of-the-week');
        const role = roleId ? roles.get(roleId) : matches.size === 1 ? matches.first() : undefined;
        if (!role || role.id === guildId) throw new UserError('Choose a role explicitly, or create one role named album-of-the-week. @everyone is not supported.');
        const me = await guild.members.fetchMe();
        const permissions = channel?.permissionsFor(me);
        if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
          throw new UserError('I need View Channel, Send Messages and Embed Links in that channel.');
        }
        if (!role.mentionable && !permissions.has(PermissionFlagsBits.MentionEveryone)) {
          throw new UserError('Make the chosen role mentionable, or grant me Mention Everyone in the announcement channel.');
        }
        const time = interaction.options.getString('time') ?? `${String(old.hour).padStart(2, '0')}:${String(old.minute).padStart(2, '0')}`;
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new UserError('Use a 24-hour time such as 12:00 or 18:30.');
        let configured;
        try {
          // Settings must not move a multi-message delivery between channels mid-flight.
          if (scheduler?.isRunning()) throw new UserError('An announcement is being processed. Please try setup again shortly.');
          configured = store.configure(guildId, channelId, role.id, {
            weekday: interaction.options.getInteger('day') ?? old.weekday,
            hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)),
            timezone: interaction.options.getString('timezone') ?? old.timezone,
          });
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Use a valid timezone')) throw new UserError(error.message);
          throw error;
        }
        await respond(`Weekly picks enabled in <#${channelId}>, pinging <@&${role.id}>. Next pick: <t:${Math.floor(configured.next_run! / 1000)}:F> (${configured.timezone}).`);
      }
    } else if (interaction.commandName === 'aotw') {
      if (sub === 'status') {
        const guild = store.guild(guildId);
        const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][guild.weekday];
        const next = guild.enabled && guild.next_run ? `<t:${Math.floor(guild.next_run / 1000)}:F>` : 'Paused / not configured';
        await respond(`Schedule: ${day} ${String(guild.hour).padStart(2, '0')}:${String(guild.minute).padStart(2, '0')} (${guild.timezone})\nNext: ${next}\nChannel: ${guild.channel_id ? `<#${guild.channel_id}>` : 'Not configured'}\nRole: ${guild.role_id ? `<@&${guild.role_id}>` : 'Not configured'}\nRound: ${guild.round}\nParticipants with albums: ${store.queuedUsers(guildId).length}\nAnnouncement awaiting delivery: ${store.pending(guildId) ? 'Yes' : 'No'}`);
      } else {
        if (sub === 'history' || sub === 'leaderboard') {
          const page = sub === 'history' ? interaction.options.getInteger('page') ?? 1 : 1;
          await interaction.editReply(albumPage(store, guildId, userId, sub, page));
        } else {
          const current = store.history(guildId, 1)[0];
          await interaction.editReply({
            embeds: [new EmbedBuilder().setTitle('Current album of the week')
              .setDescription(current ? `${albumText(current)}\nSubmitted by <@${current.user_id}>\n${ratingText(current)}` : 'No albums announced yet.')], allowedMentions: { parse: [] }
          });
        }
      }
    }
  } catch (error) {
    if (!(error instanceof UserError)) console.error('Command failed', error);
    await respond(error instanceof UserError ? error.message : 'Something went wrong. Please try again; the error has been logged.');
  }
}
