# Album of the week

A Discord bot that gives each server one shared album to listen to each week. Default schedule: Sunday at 12:00 UTC/GMT.
Uses TS, Express, discord.js and SQLite. Vibe coded for 99% by Astra :))

## Run in WSL

Use Node **22.18 or newer** (Node 22 is recorded in `.nvmrc`). The system Node 18 installation is too old. From this project directory in Ubuntu:

```bash
source ~/.nvm/nvm.sh
nvm use
npm ci
cp .env.example .env
```

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications). Put its bot token in `DISCORD_TOKEN` and application ID in `DISCORD_APPLICATION_ID` in `.env`. Keep the token private.
2. Install the bot in your server with the `bot` and `applications.commands` scopes. Grant **View Channel**, **Send Messages** and **Embed Links** in the announcement channel. No privileged gateway intents are needed.
3. Create a mentionable role named `album-of-the-week` (or choose another role during setup). Alternatively, allow the bot **Mention Everyone** in that channel. The bot restricts announcement mentions to the configured role.
4. Optionally set `DISCORD_GUILD_ID` to your test server ID for server-scoped commands. Leave it empty for global registration. Registration replaces this application's commands in the selected scope; it is intentionally separate from startup.
5. Register and start:

```bash
npm run register
npm run dev
```

In Discord, run `/aotw setup channel:#album-club`. The account configuring the bot needs **Manage Server**. The role defaults to `album-of-the-week`; if there are duplicate roles with that name, select the intended role explicitly. Submit your first album with `/aotw add`.

For a compiled production run:

```bash
npm run build
npm start
```

## Commands

| Command | Purpose |
| --- | --- |
| `/aotw add title artist` | Add a submission, up to five queued albums per user per server |
| `/aotw timezone [timezone]` | Set your personal timezone for album pickers; omit to reset to the server setting |
| `/aotw list` | View your queued albums |
| `/aotw rename album title [artist]` | Correct a queued or picked album (submitter or Manage Server required) |
| `/aotw remove album` | Remove an album you own in this server |
| `/aotw current` | View the latest successfully announced album |
| `/aotw history [page]` | Browse albums and average ratings with Previous/Next buttons, five per page |
| `/aotw rate score [album]` | Rate the active album or a previous pick from 0 to 10, updating your existing rating |
| `/aotw leaderboard` | Browse rated albums ranked by average score with Previous/Next buttons |
| `/aotw ratings album` | Look back at individual scores for a previous pick, highest first, with Previous/Next buttons |
| `/aotw status` | View schedule, channel, role, round and delivery status |
| `/aotw reroll` | Immediately draw, announce and record a new album (Manage Server required) |
| `/aotw setup channel [role] [day] [time] [timezone]` | Configure or resume weekly announcements |
| `/aotw pause` | Pause announcements while keeping queues and history |

Ratings and averages stay hidden until the next album is picked, whether scheduled or rerolled. The active album is excluded from the leaderboard. Your rating confirmation shows your own score. Once revealed, individual scores are available through `/aotw ratings album:<selection>`. Previous ratings can still be updated with `/aotw rate score:8.5 album:<selection>`.

The `album` option is a searchable picker: type part of the title or artist, then select a suggestion. It shows up to 25 matches; narrow your search to find older albums. Rename combines queued and picked albums, with labels indicating which is which; picked albums include their selection date and time in your saved timezone (or the server timezone by default), formatted using your Discord language to distinguish repeat picks. Only entries you can change are suggested. Omit `album` when rating the active album.

For rename, the artist is unchanged if omitted. Renaming keeps the entry's owner and ratings; it updates future results but does not edit previously sent Discord messages or captured summaries.

## Deploy to Railway

Deploy the repository using its Dockerfile. Attach a **Railway Volume** to the bot service with mount path `/app/data`. Railway does not support Dockerfile `VOLUME` instructions; configure persistence on the service instead.

Set these service variables:

```text
DISCORD_TOKEN=<your bot token>
DATABASE_PATH=/app/data/album-of-the-week.sqlite
RAILWAY_RUN_UID=0
```

`RAILWAY_RUN_UID=0` overrides the image's default `node` user so the bot can write to Railway's root-owned volume, following [Railway's permissions guidance](https://docs.railway.com/volumes#permissions).

Keep one replica and disable service sleeping. Leave the start command unset to use the Dockerfile's command. If configuring an HTTP health check, use `/readyz`. Register commands locally using the steps above, then redeploy after saving the volume and variables. Mount only `/app/data`, not `/app`, so application files remain available.

Local Docker Compose continues to use the named volume configured in `compose.yaml`:

```bash
docker compose up --build -d
```

Discord does not expose your device timezone to bots. Set `/aotw timezone timezone:Europe/Amsterdam` once to personalize picker times across servers. Daylight saving is handled automatically; the UTC offset is shown to avoid ambiguity. This does not change the weekly schedule.
