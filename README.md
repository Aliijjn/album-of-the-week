# Album of the week

A TypeScript Discord bot that gives each server one shared album to listen to each week. Uses discord.js, Express health endpoints and SQLite (`node:sqlite`). Default schedule: Sunday at 12:00 UTC/GMT.

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

`node:sqlite` can print an experimental API warning on Node 22; it does not prevent startup.

## Commands

| Command | Purpose |
| --- | --- |
| `/aotw add title artist` | Add a submission, up to five queued albums per user per server |
| `/aotw list` | View your queue and album IDs |
| `/aotw remove id` | Remove an album you own in this server |
| `/aotw current` | View the latest successfully announced album |
| `/aotw history [page]` | Browse albums and average ratings with Previous/Next buttons, five per page |
| `/aotw rate score [id]` | Rate the active album or a previous pick from 0 to 10, updating your existing rating |
| `/aotw leaderboard` | Browse rated albums ranked by average score with Previous/Next buttons |
| `/aotw status` | View schedule, channel, role, round and delivery status |
| `/aotw reroll` | Immediately draw, announce and record a new album (Manage Server required) |
| `/aotw setup channel [role] [day] [time] [timezone]` | Configure or resume weekly announcements |
| `/aotw pause` | Pause announcements while keeping queues and history |

Command replies are private to the invoking user; weekly announcements are posted to the configured channel. Setup accepts `HH:mm` and a searchable timezone dropdown. Common zones appear initially; type a city or region (for example Amsterdam or New York) to filter suggestions. Values are stored as IANA timezones such as `Europe/Amsterdam`. Valid timezone names can still be entered directly. Omitted schedule options retain existing settings; first setup uses Sunday, `12:00`, `UTC`. Local times follow daylight saving time. Avoid times inside DST transition hours if you need an unambiguous wall-clock time every week. Changing settings schedules the next future occurrence; pending new announcements use the updated channel and role. Rerolls publish a new announcement in the configured channel.

All commands are subcommands of `/aotw`. Setup, pause and reroll enforce Manage Server permission in the handler; ordinary members can still submit albums. After upgrading, run `npm run register` in the same scope used previously to replace the old `/album` and `/aotw-admin` commands, then restart the bot. If you previously registered both globally and in a development server, update both scopes.

`/aotw reroll` behaves like a weekly draw: it uses the same fair selection, posts `<user> rerolled...` naming the person who ran the command, summarizes the previous album, then posts a new album announcement with the configured role ping and adds a new history entry. The notice is only sent after a pick is successfully reserved, and its delivery is saved so an album-message retry does not repeat it. Previous announcements, history entries and ratings remain intact. The new album becomes the active album for ratings. The next future weekly occurrence stays unchanged; if a scheduled slot is already due, the manual draw satisfies it. With no queued albums, nothing changes. Announcements must be enabled, and pending delivery or an active draw must finish before another reroll. Failed sends retry the same saved pick automatically.

## Fair selection

Each server has a persistent round counter. Each week the bot chooses uniformly among users with queued albums who have not had a turn in that round, then chooses uniformly among that user's albums. Five submissions give the same user-selection chance as one.

- Once every eligible user has had a turn, the next draw starts a new round. A user may be chosen last in one round and first in the next.
- A newcomer joins the current round and can be chosen once. They do not receive extra turns to catch up with past rounds.
- Users with empty queues are skipped. If they refill, their existing round participation remains, so deleting/re-adding albums cannot grant another turn.
- A selected album is consumed from the queue and copied into history, freeing a submission slot. Users can explicitly submit an album again later. Duplicate title/artist pairs in the same user's current queue are rejected, ignoring case and normalized whitespace.
- Before a due draw, members are checked against Discord. Confirmed departed users' queues are removed, while their round record remains. Network failures leave the schedule due for retry. A server's queues, history, settings and rounds are isolated from all other servers.

## Scheduling and recovery

The scheduler checks every 30 seconds while Discord is connected. SQLite stores the next scheduled time, the draw, the consumed album and round participation transactionally. A pending pick blocks new draws until it is delivered. Failed sends retry every 30 seconds with the same saved selection. Check logs and `/aotw status` for delivery failures; fix channel/role permissions or rerun setup to repair settings. Pause also pauses pending delivery.

Setup waits until no draw is being processed. Changing the channel of a pending pick restarts its notice and summary in the new channel; any fragments already sent to the old channel remain there. Polling and manual draws are serialized across servers in this single-process implementation, so a slow Discord request can temporarily delay other servers. This is intended for small communities, not a large multi-server bot fleet.

After downtime, the bot performs one overdue draw and schedules the next future occurrence instead of flooding the channel with all missed weeks. With no queued albums, it skips the empty week. A previously pending draw is delivered first; an additional overdue slot may be processed on the following tick.

Messages use a stable nonce with Discord's duplicate enforcement. This prevents duplicates during Discord's recent-message deduplication window. **Exactly-once delivery across arbitrary crashes is not guaranteed:** if Discord accepts a message and the process crashes before saving its message ID, a retry after that window may post the same announcement again. Selection itself stays persisted and is never redrawn on a send failure.

Run **one bot process/replica** against the database. This implementation does not coordinate announcement delivery between multiple processes. SQLite uses WAL mode and foreign keys. Schema tables are created on startup; existing databases automatically gain the announcement-channel column used to record delivery locations.

## Cloud / Docker

```bash
docker compose up --build -d
docker compose logs -f bot
```

Register commands locally before deploying. The image runs as the unprivileged `node` user. Compose uses a persistent named volume for `/app/data` and exposes the health endpoint on localhost port 3000. On a cloud host, provide `DISCORD_TOKEN`, `DATABASE_PATH` and `PORT` as environment variables; mount a persistent, writable disk at `/app/data`. Use an always-on service with outbound Discord access, a single replica and no scale-to-zero. An ephemeral/serverless filesystem will lose queues and history.

- `GET /healthz`: process liveness (200).
- `GET /readyz`: Discord connection readiness (200 or 503).
- There is no public HTTP endpoint to change settings or trigger draws.
- SIGINT/SIGTERM stops accepting new work and drains active delivery and interactions before closing SQLite, with a 15-second shutdown deadline. Allow at least that long when stopping containers.
- Back up SQLite using an SQLite-aware backup or stop the bot before copying the database. Do not copy only the main file while WAL writes are active. Keep the persistent volume when redeploying; `docker compose down -v` deletes it.

## Development checks

```bash
npm run check
```

Runs strict TypeScript checks, Node's test runner and the production build. Tests cover queue limits, ownership, server isolation, user-first draws, round completion, late joins, queue reset abuse, persistence, transaction rollback, scheduling/DST, delivery retries, overlapping polls, departed members, HTTP health and command serialization. No Discord token is needed for these checks. A real-server smoke test still requires your bot credentials.

Source layout: `store.ts` owns persistence and draw transactions; `schedule.ts` calculates occurrences; `scheduler.ts` coordinates membership checks and delivery; `discord.ts` handles interactions and announcements; `commands.ts` defines registration payloads; `http.ts` exposes health checks.

Reference docs: [discord.js](https://discord.js.org/docs), [cron-parser](https://github.com/harrisiirak/cron-parser), [Node SQLite](https://nodejs.org/api/sqlite.html).

## Ratings and browsing

Before each new album announcement (scheduled or rerolled), the bot posts a summary of the previous album in the announcement channel. It includes the title, artist, submitter, average score, and every submitted individual rating sorted from highest to lowest (ties use user ID order). Unrated albums explicitly say no ratings were submitted; users who did not rate are not listed. Long lists are split into messages without pinging the listed users. For rerolls the order is `<user> rerolled...`, summary, then the new album announcement. The first-ever pick has no previous-album summary. Ratings are snapshotted when the next pick is reserved, and summary delivery progress is saved so retries resume from the first unfinished page. The same recent-message nonce deduplication limits described above apply to summaries.

Use `/aotw rate score:8.5` to rate the currently announced album, or `/aotw rate score:8.5 id:12` to rate a previous pick. Find the pick ID in history, the leaderboard, or the album announcement; it is different from a queued submission ID. Updating a historical rating immediately affects history and leaderboard averages. Previously posted or pending summary messages remain snapshots of ratings when the next pick was chosen. Scores from 0 through 10 are accepted, including decimals. Each server member gets one rating per weekly pick; rating again updates it. When the next album is announced, previous ratings remain attached to the earlier pick. Rating without an ID is temporarily blocked while a new announcement or reroll is awaiting delivery, so a score cannot land on the wrong album. Explicit IDs can still target already announced picks. Rerolling keeps prior ratings and starts a new unrated pick.

History and current-album results show the average (two decimal places) and number of ratings. Unrated albums show "No ratings". The leaderboard includes only rated picks, ordered by average descending, then rating count, then newest pick for deterministic ties. Separate weeks featuring the same album remain separate entries.

History and leaderboard results have Previous/Next buttons with five entries per page. Buttons edit the same private result, disable at the first/last page, and refresh scores on each click. Existing results do not update automatically when someone rates. History's optional page argument still allows jumping directly to a page. Run `npm run register` and restart after upgrading to register `/aotw rate`, `/aotw leaderboard` and the `/aotw reroll` rename. Existing databases gain the ratings table automatically.
