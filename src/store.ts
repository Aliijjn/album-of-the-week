import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { defaultSchedule, nextRun, type Schedule } from './schedule.js';

export interface Guild extends Schedule {
  id: string;
  channel_id: string | null;
  role_id: string | null;
  enabled: number;
  round: number;
  next_run: number | null;
}
export interface Album { id: number; guild_id: string; user_id: string; title: string; artist: string }
export interface Pick extends Album {
  round: number;
  scheduled_at: number;
  status: 'pending' | 'sent';
  nonce: string;
  message_id: string | null;
  message_channel_id: string | null;
  rerolled_by: string | null;
  reroll_notice_id: string | null;
  summary_json: string | null;
  summary_pages_sent: number;
}
export interface AlbumSummary {
  title: string; artist: string; user_id: string;
  average: number | null; rating_count: number;
  ratings: { user_id: string; score: number }[];
}

export class UserError extends Error {}
export interface RatedPick extends Pick { average: number | null; rating_count: number; ratings_revealed: number }
const revealed = `EXISTS (SELECT 1 FROM picks newer WHERE newer.guild_id=p.guild_id AND newer.id>p.id)`;
const cleanName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ');

function validateNames(title: string, artist: string): void {
  if (!title || !artist || title.length > 150 || artist.length > 150) {
    throw new UserError('Album and artist must each contain 1-150 characters.');
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS guilds (
        id TEXT PRIMARY KEY, channel_id TEXT, role_id TEXT, enabled INTEGER NOT NULL DEFAULT 0,
        weekday INTEGER NOT NULL DEFAULT 0, hour INTEGER NOT NULL DEFAULT 12,
        minute INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL DEFAULT 'UTC',
        round INTEGER NOT NULL DEFAULT 1, next_run INTEGER
      );
      CREATE TABLE IF NOT EXISTS participants (
        guild_id TEXT NOT NULL REFERENCES guilds(id), user_id TEXT NOT NULL,
        last_round INTEGER NOT NULL, PRIMARY KEY(guild_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS albums (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
        title TEXT NOT NULL, artist TEXT NOT NULL, title_key TEXT NOT NULL, artist_key TEXT NOT NULL,
        FOREIGN KEY(guild_id, user_id) REFERENCES participants(guild_id, user_id),
        UNIQUE(guild_id, user_id, title_key, artist_key)
      );
      CREATE TABLE IF NOT EXISTS picks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL REFERENCES guilds(id),
        user_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL, round INTEGER NOT NULL,
        scheduled_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        nonce TEXT NOT NULL UNIQUE, message_id TEXT,
        UNIQUE(guild_id, scheduled_at)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_pick ON picks(guild_id) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS album_owner ON albums(guild_id, user_id);
      CREATE TABLE IF NOT EXISTS ratings (
        pick_id INTEGER NOT NULL REFERENCES picks(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, score REAL NOT NULL CHECK(score >= 0 AND score <= 10),
        PRIMARY KEY(pick_id, user_id)
      );
    `);
    const columns = this.db.prepare('PRAGMA table_info(picks)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'message_channel_id')) {
      this.db.exec('ALTER TABLE picks ADD COLUMN message_channel_id TEXT');
    }
    for (const name of ['rerolled_by', 'reroll_notice_id', 'summary_json']) {
      if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE picks ADD COLUMN ${name} TEXT`);
    }
    if (!columns.some(column => column.name === 'summary_pages_sent')) {
      this.db.exec('ALTER TABLE picks ADD COLUMN summary_pages_sent INTEGER NOT NULL DEFAULT 0');
    }
  }

  close(): void { this.db.close(); }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  guild(id: string): Guild {
    this.db.prepare('INSERT OR IGNORE INTO guilds(id) VALUES (?)').run(id);
    return this.db.prepare('SELECT * FROM guilds WHERE id = ?').get(id) as unknown as Guild;
  }

  configure(id: string, channel: string, role: string, schedule: Schedule = defaultSchedule, now = Date.now()): Guild {
    const next = nextRun(schedule, now);
    return this.transaction(() => {
      const previous = this.guild(id);
      if (previous.channel_id !== channel) {
        // Already delivered fragments remain in the old channel. Retry the complete sequence in the new one.
        this.db.prepare(`UPDATE picks SET reroll_notice_id=NULL, summary_pages_sent=0
          WHERE guild_id=? AND status='pending'`).run(id);
      }
      this.db.prepare(`UPDATE guilds SET channel_id=?, role_id=?, weekday=?, hour=?, minute=?, timezone=?,
        enabled=1, next_run=? WHERE id=?`).run(channel, role, schedule.weekday, schedule.hour, schedule.minute, schedule.timezone, next, id);
      return this.guild(id);
    });
  }

  pause(id: string): void {
    this.db.prepare('UPDATE guilds SET enabled=0 WHERE id=?').run(id);
  }

  addAlbum(guildId: string, userId: string, title: string, artist: string): Album {
    title = cleanName(title); artist = cleanName(artist);
    validateNames(title, artist);
    return this.transaction(() => {
      const guild = this.guild(guildId);
      const albums = this.albums(guildId, userId);
      if (albums.length >= 5) throw new UserError('You already have 5 albums queued. Remove one first.');
      if (albums.some(a => a.title.toLowerCase() === title.toLowerCase() && a.artist.toLowerCase() === artist.toLowerCase())) {
        throw new UserError('That album is already in your queue.');
      }
      this.db.prepare('INSERT OR IGNORE INTO participants(guild_id,user_id,last_round) VALUES (?,?,?)')
        .run(guildId, userId, guild.round - 1);
      const result = this.db.prepare('INSERT INTO albums(guild_id,user_id,title,artist,title_key,artist_key) VALUES (?,?,?,?,?,?)')
        .run(guildId, userId, title, artist, title.toLowerCase(), artist.toLowerCase());
      return { id: Number(result.lastInsertRowid), guild_id: guildId, user_id: userId, title, artist };
    });
  }

  albums(guildId: string, userId: string): Album[] {
    return this.db.prepare('SELECT * FROM albums WHERE guild_id=? AND user_id=? ORDER BY id').all(guildId, userId) as unknown as Album[];
  }

  searchAlbums(guildId: string, userId: string, command: 'rename' | 'remove' | 'rate' | 'ratings', admin: boolean, query: string) {
    const terms = cleanName(query).toLowerCase().split(' ').filter(Boolean);
    const rows = this.db.prepare(`
      SELECT id,title,artist,user_id,'queue' AS kind,NULL AS scheduled_at FROM albums
        WHERE guild_id=? AND ? IN ('rename','remove') AND (user_id=? OR (?='rename' AND ?))
      UNION ALL
      SELECT p.id,p.title,p.artist,p.user_id,'pick' AS kind,p.scheduled_at FROM picks p
        WHERE p.guild_id=? AND p.status='sent' AND ? IN ('rename','rate','ratings')
          AND (?!='rename' OR p.user_id=? OR ?)
          AND (?!='ratings' OR ${revealed})
      ORDER BY kind DESC,id DESC
    `).iterate(guildId, command, userId, command, Number(admin), guildId, command, command, userId, Number(admin), command);
    const matches: { id: number; title: string; artist: string; user_id: string; kind: 'queue' | 'pick'; scheduled_at: number | null }[] = [];
    for (const row of rows) {
      const album = row as unknown as typeof matches[number];
      const name = cleanName(`${album.title} ${album.artist}`).toLowerCase();
      if (terms.every(term => name.includes(term))) matches.push(album);
      if (matches.length === 25) break;
    }
    return matches;
  }

  removeAlbum(guildId: string, userId: string, id: number): boolean {
    return this.db.prepare('DELETE FROM albums WHERE guild_id=? AND user_id=? AND id=?').run(guildId, userId, id).changes > 0;
  }

  rename(guildId: string, userId: string, admin: boolean, entry: 'queue' | 'pick', id: number, title: string, artist?: string): Album {
    if (!Number.isSafeInteger(id) || id < 1 || !['queue', 'pick'].includes(entry)) throw new UserError('Choose a valid entry type and ID.');
    return this.transaction(() => {
      const table = entry === 'queue' ? 'albums' : 'picks';
      const album = this.db.prepare(`SELECT * FROM ${table} WHERE guild_id=? AND id=?`).get(guildId, id) as unknown as Album | Pick | undefined;
      if (!album) throw new UserError('That entry was not found in this server. Check /aotw list or /aotw history.');
      if (!admin && album.user_id !== userId) throw new UserError('Only the submitter or someone with Manage Server permission can rename this entry.');
      if ('status' in album && album.status === 'pending') throw new UserError('Wait for this album announcement to finish before renaming it.');
      title = cleanName(title);
      artist = artist === undefined ? album.artist : cleanName(artist);
      validateNames(title, artist);
      if (entry === 'queue') {
        if (this.albums(guildId, album.user_id).some(a => a.id !== id && a.title.toLowerCase() === title.toLowerCase() && a.artist.toLowerCase() === artist!.toLowerCase())) {
          throw new UserError('That album is already in this user’s queue.');
        }
        this.db.prepare('UPDATE albums SET title=?,artist=?,title_key=?,artist_key=? WHERE guild_id=? AND id=?')
          .run(title, artist, title.toLowerCase(), artist.toLowerCase(), guildId, id);
      } else {
        this.db.prepare('UPDATE picks SET title=?,artist=? WHERE guild_id=? AND id=?').run(title, artist, guildId, id);
      }
      return { ...album, title, artist };
    });
  }

  removeMember(guildId: string, userId: string): void {
    // Keep round participation: leaving/rejoining must not grant another turn.
    this.db.prepare('DELETE FROM albums WHERE guild_id=? AND user_id=?').run(guildId, userId);
  }

  queuedUsers(guildId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT user_id FROM albums WHERE guild_id=?').all(guildId) as { user_id: string }[]).map(r => r.user_id);
  }

  enabledGuilds(): Guild[] {
    return this.db.prepare('SELECT * FROM guilds WHERE enabled=1').all() as unknown as Guild[];
  }

  pending(guildId: string): Pick | undefined {
    return this.db.prepare("SELECT * FROM picks WHERE guild_id=? AND status='pending'").get(guildId) as unknown as Pick | undefined;
  }

  history(guildId: string, limit = 10, offset = 0): RatedPick[] {
    return this.db.prepare(`SELECT p.*, ${revealed} AS ratings_revealed, AVG(r.score) AS average, COUNT(r.user_id) AS rating_count
      FROM picks p LEFT JOIN ratings r ON r.pick_id=p.id WHERE p.guild_id=? AND p.status='sent'
      GROUP BY p.id ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(guildId, limit, offset) as unknown as RatedPick[];
  }

  leaderboard(guildId: string, limit = 5, offset = 0): RatedPick[] {
    return this.db.prepare(`SELECT p.*, 1 AS ratings_revealed, AVG(r.score) AS average, COUNT(r.user_id) AS rating_count
      FROM picks p JOIN ratings r ON r.pick_id=p.id WHERE p.guild_id=? AND p.status='sent' AND ${revealed}
      GROUP BY p.id ORDER BY average DESC, rating_count DESC, p.id DESC LIMIT ? OFFSET ?`)
      .all(guildId, limit, offset) as unknown as RatedPick[];
  }

  leaderboardCount(guildId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS count FROM picks p WHERE p.guild_id=? AND p.status='sent'
      AND ${revealed} AND EXISTS (SELECT 1 FROM ratings r WHERE r.pick_id=p.id)`).get(guildId) as { count: number }).count;
  }

  private ratedPick(guildId: string, id: number): RatedPick | undefined {
    return this.db.prepare(`SELECT p.*, ${revealed} AS ratings_revealed, AVG(r.score) AS average, COUNT(r.user_id) AS rating_count
      FROM picks p LEFT JOIN ratings r ON r.pick_id=p.id WHERE p.guild_id=? AND p.id=? AND p.status='sent'
      GROUP BY p.id`).get(guildId, id) as unknown as RatedPick | undefined;
  }

  ratings(guildId: string, id: number, limit = 20, offset = 0) {
    const pick = this.ratedPick(guildId, id);
    if (!pick) throw new UserError('That pick is not in this server’s announced history.');
    if (!pick.ratings_revealed) throw new UserError('Ratings are hidden until the next album is picked.');
    const ratings = this.db.prepare('SELECT user_id,score FROM ratings WHERE pick_id=? ORDER BY score DESC,user_id LIMIT ? OFFSET ?')
      .all(id, limit, offset) as { user_id: string; score: number }[];
    return { pick, ratings };
  }

  rate(guildId: string, userId: string, score: number, pickId?: number): RatedPick {
    if (!Number.isFinite(score) || score < 0 || score > 10) throw new UserError('Choose a rating from 0 to 10.');
    if (pickId !== undefined && (!Number.isSafeInteger(pickId) || pickId < 1)) throw new UserError('Choose a valid pick ID from /aotw history.');
    return this.transaction(() => {
      if (pickId === undefined && this.pending(guildId)) throw new UserError('An album announcement is pending. Please rate it after delivery finishes, or select a previous album.');
      const current = pickId === undefined ? this.history(guildId, 1)[0] : this.ratedPick(guildId, pickId);
      if (!current) throw new UserError(pickId === undefined ? 'There is no active album to rate yet.' : 'That pick is not in this server’s announced history. Search again with the album option.');
      this.db.prepare(`INSERT INTO ratings(pick_id,user_id,score) VALUES (?,?,?)
        ON CONFLICT(pick_id,user_id) DO UPDATE SET score=excluded.score`).run(current.id, userId, score);
      return this.ratedPick(guildId, current.id)!;
    });
  }

  historyCount(guildId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM picks WHERE guild_id=? AND status='sent'").get(guildId) as { count: number }).count;
  }

  markSent(id: number, messageId: string, channelId?: string): void {
    this.db.prepare("UPDATE picks SET status='sent', message_id=?, message_channel_id=COALESCE(?,message_channel_id) WHERE id=?").run(messageId, channelId ?? null, id);
  }

  markRerollNotice(id: number, messageId: string): void {
    this.db.prepare('UPDATE picks SET reroll_notice_id=? WHERE id=?').run(messageId, id);
  }

  markSummaryPage(id: number, pagesSent: number): void {
    this.db.prepare('UPDATE picks SET summary_pages_sent=? WHERE id=?').run(pagesSent, id);
  }

  reserveNow(guildId: string, now = Date.now(), choose: (size: number) => number = randomInt, rerolledBy?: string): Pick {
    return this.transaction(() => {
      const guild = this.guild(guildId);
      if (!guild.enabled || !guild.channel_id || !guild.role_id) throw new UserError('Run /aotw setup to enable announcements first.');
      if (this.pending(guildId)) throw new UserError('An announcement is awaiting delivery. Wait for it to finish before rerolling.');
      const result = this.draw(guild, now, choose);
      if (!result) throw new UserError('No albums are queued. Add one with /aotw add first.');
      if (rerolledBy) {
        this.db.prepare('UPDATE picks SET rerolled_by=? WHERE id=?').run(rerolledBy, result.id);
        result.rerolled_by = rerolledBy;
      }
      // A manual draw at/after a due slot satisfies it; avoid a second draw on the next tick.
      if (guild.next_run !== null && guild.next_run <= now) {
        this.db.prepare('UPDATE guilds SET next_run=? WHERE id=?').run(nextRun(guild, now), guildId);
      }
      return result;
    });
  }

  reserveDue(guildId: string, now: number, choose: (size: number) => number = randomInt): Pick | undefined {
    return this.transaction(() => {
      const guild = this.guild(guildId);
      if (!guild.enabled || this.pending(guildId) || guild.next_run === null || guild.next_run > now) return undefined;
      // One catch-up after downtime, never a burst of historical announcements.
      this.db.prepare('UPDATE guilds SET next_run=? WHERE id=?').run(nextRun(guild, now), guildId);
      return this.draw(guild, guild.next_run, choose);
    });
  }

  private draw(guild: Guild, scheduledAt: number, choose: (size: number) => number): Pick | undefined {
    const guildId = guild.id;
    const participants = this.db.prepare(`SELECT p.user_id, p.last_round FROM participants p
      WHERE p.guild_id=? AND EXISTS (SELECT 1 FROM albums a WHERE a.guild_id=p.guild_id AND a.user_id=p.user_id)
      ORDER BY p.user_id`).all(guildId) as { user_id: string; last_round: number }[];
    if (!participants.length) return undefined;
    let round = guild.round;
    let eligible = participants.filter(p => p.last_round < round);
    if (!eligible.length) {
      round++;
      this.db.prepare('UPDATE guilds SET round=? WHERE id=?').run(round, guildId);
      eligible = participants;
    }
    const user = eligible[choose(eligible.length)];
    if (!user) throw new Error('Random selector returned an invalid user index.');
    const albums = this.albums(guildId, user.user_id);
    const album = albums[choose(albums.length)];
    if (!album) throw new Error('Random selector returned an invalid album index.');
    this.db.prepare('UPDATE participants SET last_round=? WHERE guild_id=? AND user_id=?').run(round, guildId, user.user_id);
    this.db.prepare('DELETE FROM albums WHERE id=?').run(album.id);
    const nonce = randomUUID().replaceAll('-', '').slice(0, 24);
    const previous = this.history(guildId, 1)[0];
    // Freeze the outgoing album's final ratings in the same transaction as the new draw.
    const summary: AlbumSummary | null = previous ? {
      title: previous.title, artist: previous.artist, user_id: previous.user_id,
      average: previous.average, rating_count: previous.rating_count,
      ratings: this.db.prepare('SELECT user_id,score FROM ratings WHERE pick_id=? ORDER BY score DESC, user_id')
        .all(previous.id) as { user_id: string; score: number }[],
    } : null;
    // Preserve the existing timestamp uniqueness constraint for draws in the same millisecond.
    while (this.db.prepare('SELECT 1 FROM picks WHERE guild_id=? AND scheduled_at=?').get(guildId, scheduledAt)) scheduledAt++;
    this.db.prepare(`INSERT INTO picks(guild_id,user_id,title,artist,round,scheduled_at,nonce,summary_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(guildId, user.user_id, album.title, album.artist, round, scheduledAt, nonce, summary ? JSON.stringify(summary) : null);
    return this.pending(guildId);
  }
}
