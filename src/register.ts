import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { requiredEnv } from './config.js';

const rest = new REST({ version: '10' }).setToken(requiredEnv('DISCORD_TOKEN'));
const applicationId = requiredEnv('DISCORD_APPLICATION_ID');
const guildId = process.env.DISCORD_GUILD_ID?.trim();
await rest.put(guildId ? Routes.applicationGuildCommands(applicationId, guildId) : Routes.applicationCommands(applicationId), {
  body: commands.map(command => command.toJSON()),
});
console.log(`Registered commands ${guildId ? `in server ${guildId}` : 'globally'}.`);
