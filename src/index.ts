import { Client, Events, GatewayIntentBits } from 'discord.js';
import { requiredEnv, portFromEnv } from './config.js';
import { Store } from './store.js';
import { discordDelivery, handleCommand } from './discord.js';
import { handlePageButton } from './pages.js';
import { Scheduler } from './scheduler.js';
import { createApp } from './http.js';
import { handleAutocomplete } from './timezones.js';

const token = requiredEnv('DISCORD_TOKEN');
const port = portFromEnv();
const store = new Store(process.env.DATABASE_PATH || './data/album-of-the-week.sqlite');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const scheduler = new Scheduler(store, discordDelivery(client));
let stopping = false;
const interactions = new Set<Promise<void>>();
client.once(Events.ClientReady, ready => {
  if (stopping) return;
  console.log(`Connected as ${ready.user.tag}`);
  scheduler.start();
});
client.on(Events.InteractionCreate, interaction => {
  if (stopping) return;
  let work: Promise<void> | undefined;
  if (interaction.isAutocomplete()) {
    work = handleAutocomplete(interaction);
  } else if (interaction.isButton()) {
    work = handlePageButton(interaction, store);
  } else if (interaction.isChatInputCommand()) {
    work = handleCommand(interaction, store, scheduler);
  }
  if (work) {
    const tracked = work.catch(error => console.error('Interaction failed', error));
    interactions.add(tracked);
    void tracked.finally(() => interactions.delete(tracked));
  }
});
client.on(Events.Error, error => console.error('Discord client error', error));
const server = createApp(() => !stopping && client.isReady()).listen(port, () => console.log(`Health endpoint listening on :${port}`));
server.on('error', error => { console.error('HTTP server failed', error); requestShutdown(1); });
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(code || 1), 15_000);
  deadline.unref();
  await scheduler.stop();
  await Promise.allSettled(interactions);
  await client.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  clearTimeout(deadline);
  process.exitCode = code;
}
function requestShutdown(code: number) {
  void shutdown(code).catch(error => { console.error('Shutdown failed', error); process.exit(1); });
}
process.once('SIGINT', () => requestShutdown(0));
process.once('SIGTERM', () => requestShutdown(0));
try {
  await client.login(token);
} catch (error) {
  console.error('Discord login failed', error);
  await shutdown(1);
}
