import { Database } from 'bun:sqlite';
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
  ended_at: number | null;
  is_history: number;
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
const revealed = `(p.ended_at IS NOT NULL OR EXISTS (SELECT 1 FROM picks newer WHERE newer.guild_id=p.guild_id AND newer.is_history=0 AND newer.id>p.id))`;
const cleanName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ');

function validateNames(title: string, artist: string): void {
  if (!title || !artist || title.length > 150 || artist.length > 150) {
    throw new UserError('Album and artist must each contain 1-150 characters.');
  }
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { strict: true, create: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS user_preferences (user_id TEXT PRIMARY KEY, timezone TEXT NOT NULL);
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
    const columns = this.db.query('PRAGMA table_info(picks)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'message_channel_id')) {
      this.db.exec('ALTER TABLE picks ADD COLUMN message_channel_id TEXT');
    }
    for (const name of ['rerolled_by', 'reroll_notice_id', 'summary_json']) {
      if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE picks ADD COLUMN ${name} TEXT`);
    }
    if (!columns.some(column => column.name === 'summary_pages_sent')) {
      this.db.exec('ALTER TABLE picks ADD COLUMN summary_pages_sent INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some(column => column.name === 'is_history')) {
      this.db.exec('ALTER TABLE picks ADD COLUMN is_history INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some(column => column.name === 'ended_at')) {
      this.transaction(() => {
        this.db.exec('ALTER TABLE picks ADD COLUMN ended_at INTEGER');
        this.db.exec(`UPDATE picks SET ended_at=(SELECT newer.scheduled_at FROM picks newer
          WHERE newer.guild_id=picks.guild_id AND newer.is_history=0 AND newer.id>picks.id ORDER BY newer.id LIMIT 1)`);
      });
    }

  }

  close(): void { this.db.close(); }

  userTimezone(userId: string): string | undefined {
    return (this.db.query('SELECT timezone FROM user_preferences WHERE user_id=?').get(userId) as { timezone: string } | undefined)?.timezone;
  }

  setUserTimezone(userId: string, timezone: string | null): void {
    if (timezone === null) {
      this.db.query('DELETE FROM user_preferences WHERE user_id=?').run(userId);
      return;
    }
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
    catch { throw new UserError('Choose a valid timezone, such as Europe/Amsterdam.'); }
    this.db.query('INSERT INTO user_preferences(user_id,timezone) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET timezone=excluded.timezone').run(userId, timezone);
  }

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
    this.db.query('INSERT OR IGNORE INTO guilds(id) VALUES (?)').run(id);
    return this.db.query('SELECT * FROM guilds WHERE id = ?').get(id) as unknown as Guild;
  }

  configure(id: string, channel: string, role: string, schedule: Schedule = defaultSchedule, now = Date.now()): Guild {
    const next = nextRun(schedule, now);
    return this.transaction(() => {
      const previous = this.guild(id);
      if (previous.channel_id !== channel) {
        // Already delivered fragments remain in the old channel. Retry the complete sequence in the new one.
        this.db.query(`UPDATE picks SET reroll_notice_id=NULL, summary_pages_sent=0
          WHERE guild_id=? AND status='pending'`).run(id);
      }
      this.db.query(`UPDATE guilds SET channel_id=?, role_id=?, weekday=?, hour=?, minute=?, timezone=?,
        enabled=1, next_run=? WHERE id=?`).run(channel, role, schedule.weekday, schedule.hour, schedule.minute, schedule.timezone, next, id);
      return this.guild(id);
    });
  }

  pause(id: string): void {
    this.db.query('UPDATE guilds SET enabled=0 WHERE id=?').run(id);
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
      this.db.query('INSERT OR IGNORE INTO participants(guild_id,user_id,last_round) VALUES (?,?,?)')
        .run(guildId, userId, guild.round - 1);
      const result = this.db.query('INSERT INTO albums(guild_id,user_id,title,artist,title_key,artist_key) VALUES (?,?,?,?,?,?)')
        .run(guildId, userId, title, artist, title.toLowerCase(), artist.toLowerCase());
      return { id: Number(result.lastInsertRowid), guild_id: guildId, user_id: userId, title, artist };
    });
  }

  albums(guildId: string, userId: string): Album[] {
    return this.db.query('SELECT * FROM albums WHERE guild_id=? AND user_id=? ORDER BY id').all(guildId, userId) as unknown as Album[];
  }

  searchAlbums(guildId: string, userId: string, command: 'rename' | 'remove' | 'rate' | 'ratings' | 'edit' | 'delete-history', admin: boolean, query: string) {
    const terms = cleanName(query).toLowerCase().split(' ').filter(Boolean);
    // Use a fresh statement: autocomplete stops early, so its iterator may not be exhausted.
    const statement = this.db.prepare(`
      SELECT id,title,artist,user_id,'queue' AS kind,NULL AS scheduled_at FROM albums
        WHERE guild_id=? AND ? IN ('rename','remove') AND (user_id=? OR (?='rename' AND ?))
      UNION ALL
      SELECT p.id,p.title,p.artist,p.user_id,'pick' AS kind,p.scheduled_at FROM picks p
        WHERE p.guild_id=? AND p.status='sent' AND ? IN ('rate','ratings','edit','delete-history')
          AND (? NOT IN ('edit','delete-history') OR ?)
          AND (? NOT IN ('ratings','delete-history') OR ${revealed})
          AND (?!='delete-history' OR p.id!=COALESCE((SELECT id FROM picks WHERE guild_id=p.guild_id AND is_history=0 AND status='sent' ORDER BY id DESC LIMIT 1),-1))
      ORDER BY kind DESC,id DESC
    `);
    const matches: { id: number; title: string; artist: string; user_id: string; kind: 'queue' | 'pick'; scheduled_at: number | null }[] = [];
    try {
      for (const row of statement.iterate(guildId, command, userId, command, Number(admin), guildId, command, command, Number(admin), command, command)) {
        const album = row as unknown as typeof matches[number];
        const name = cleanName(`${album.title} ${album.artist}`).toLowerCase();
        if (terms.every(term => name.includes(term))) matches.push(album);
        if (matches.length === 25) break;
      }
    } finally { statement.finalize(); }
    return matches;
  }

  removeAlbum(guildId: string, userId: string, id: number): boolean {
    return this.db.query('DELETE FROM albums WHERE guild_id=? AND user_id=? AND id=?').run(guildId, userId, id).changes > 0;
  }

  rename(guildId: string, userId: string, admin: boolean, entry: 'queue' | 'pick', id: number, title: string, artist?: string): Album {
    if (!Number.isSafeInteger(id) || id < 1 || entry !== 'queue') throw new UserError('Select a queued album. Only admins can edit picked albums with /aotw admin edit.');
    return this.transaction(() => {
      const album = this.db.query('SELECT * FROM albums WHERE guild_id=? AND id=?').get(guildId, id) as unknown as Album | null;
      if (!album) throw new UserError('That entry was not found in this server. Check /aotw queue list or /aotw history.');
      if (!admin && album.user_id !== userId) throw new UserError('Only the submitter or someone with Manage Server permission can rename this entry.');
      title = cleanName(title);
      artist = artist === undefined ? album.artist : cleanName(artist);
      validateNames(title, artist);
      if (this.albums(guildId, album.user_id).some(a => a.id !== id && a.title.toLowerCase() === title.toLowerCase() && a.artist.toLowerCase() === artist!.toLowerCase())) {
        throw new UserError('That album is already in this user’s queue.');
      }
      this.db.query('UPDATE albums SET title=?,artist=?,title_key=?,artist_key=? WHERE guild_id=? AND id=?')
        .run(title, artist, title.toLowerCase(), artist.toLowerCase(), guildId, id);
      return { ...album, title, artist };
    });
  }

  removeMember(guildId: string, userId: string): void {
    // Keep round participation: leaving/rejoining must not grant another turn.
    this.db.query('DELETE FROM albums WHERE guild_id=? AND user_id=?').run(guildId, userId);
  }

  queuedUsers(guildId: string): string[] {
    return (this.db.query('SELECT DISTINCT user_id FROM albums WHERE guild_id=?').all(guildId) as { user_id: string }[]).map(r => r.user_id);
  }

  enabledGuilds(): Guild[] {
    return this.db.query('SELECT * FROM guilds WHERE enabled=1').all() as unknown as Guild[];
  }

  pending(guildId: string): Pick | undefined {
    return (this.db.query("SELECT * FROM picks WHERE guild_id=? AND status='pending'").get(guildId) as unknown as Pick | null) ?? undefined;
  }

  history(guildId: string, limit = 10, offset = 0): RatedPick[] {
    return this.db.query(`SELECT p.*, ${revealed} AS ratings_revealed, AVG(r.score) AS average, COUNT(r.user_id) AS rating_count
      FROM picks p LEFT JOIN ratings r ON r.pick_id=p.id WHERE p.guild_id=? AND p.status='sent'
      GROUP BY p.id ORDER BY p.scheduled_at DESC,p.id DESC LIMIT ? OFFSET ?`).all(guildId, limit, offset) as unknown as RatedPick[];
  }

  leaderboard(guildId: string, limit = 5, offset = 0): RatedPick[] {
    return this.db.query(`SELECT p.*, 1 AS ratings_revealed, AVG(r.score) AS average, COUNT(r.user_id) AS rating_count
      FROM picks p JOIN ratings r ON r.pick_id=p.id WHERE p.guild_id=? AND p.status='sent' AND ${revealed}
      GROUP BY p.id ORDER BY average DESC, rating_count DESC, p.id DESC LIMIT ? OFFSET ?`)
      .all(guildId, limit, offset) as unknown as RatedPick[];
  }

  leaderboardCount(guildId: string): number {
    return (this.db.query(`SELECT COUNT(*) AS count FROM picks p WHERE p.guild_id=? AND p.status='sent'
      AND ${revealed} AND EXISTS (SELECT 1 FROM ratings r WHERE r.pick_id=p.id)`).get(guildId) as { count: number }).count;
  }

  private ratedPick(guildId: string, id: number): RatedPick | undefined {
    return (this.db.query(`SELECT p.*, ${revealed} AS ratings_revealed, AVG(r.score) AS average, COUNT(r.user_id) AS rating_count
      FROM picks p LEFT JOIN ratings r ON r.pick_id=p.id WHERE p.guild_id=? AND p.id=? AND p.status='sent'
      GROUP BY p.id`).get(guildId, id) as unknown as RatedPick | null) ?? undefined;
  }

  ratings(guildId: string, id: number, limit = 20, offset = 0) {
    const pick = this.ratedPick(guildId, id);
    if (!pick) throw new UserError('That pick is not in this server’s announced history.');
    if (!pick.ratings_revealed) throw new UserError('Ratings are hidden until the next album is picked.');
    const ratings = this.db.query('SELECT user_id,score FROM ratings WHERE pick_id=? ORDER BY score DESC,user_id LIMIT ? OFFSET ?')
      .all(id, limit, offset) as { user_id: string; score: number }[];
    return { pick, ratings };
  }

  rate(guildId: string, userId: string, score: number, pickId?: number): RatedPick {
    if (!Number.isFinite(score) || score < 0 || score > 10) throw new UserError('Choose a rating from 0 to 10.');
    if (pickId !== undefined && (!Number.isSafeInteger(pickId) || pickId < 1)) throw new UserError('Select a picked album from the suggested matches.');
    return this.transaction(() => {
      if (pickId === undefined && this.pending(guildId)) throw new UserError('An album announcement is pending. Please rate it after delivery finishes, or select a previous album.');
      const current = pickId === undefined ? this.current(guildId) : this.ratedPick(guildId, pickId);
      if (!current) throw new UserError(pickId === undefined ? 'There is no active album to rate yet.' : 'That pick is not in this server’s announced history. Search again with the album option.');
      this.db.query(`INSERT INTO ratings(pick_id,user_id,score) VALUES (?,?,?)
        ON CONFLICT(pick_id,user_id) DO UPDATE SET score=excluded.score`).run(current.id, userId, score);
      return this.ratedPick(guildId, current.id)!;
    });
  }

  historyCount(guildId: string): number {
    return (this.db.query("SELECT COUNT(*) AS count FROM picks WHERE guild_id=? AND status='sent'").get(guildId) as { count: number }).count;
  }

  current(guildId: string): RatedPick | undefined {
    const row = this.db.query("SELECT id FROM picks WHERE guild_id=? AND is_history=0 AND status='sent' ORDER BY id DESC LIMIT 1").get(guildId) as { id: number } | null;
    return row ? this.ratedPick(guildId, row.id) : undefined;
  }

  private requireIdle(guildId: string): void {
    if (this.pending(guildId)) throw new UserError('An announcement is pending. Wait for delivery to finish before changing history or rounds.');
  }

  private validatePeriod(start: number, end: number | null): void {
    if (!Number.isSafeInteger(start) || !Number.isFinite(new Date(start).getTime()) || start > Date.now()) {
      throw new UserError('Start time must be a valid date in the past.');
    }
    if (end !== null && (!Number.isSafeInteger(end) || !Number.isFinite(new Date(end).getTime()) || end <= start || end > Date.now())) {
      throw new UserError('End time must be after the start and no later than now.');
    }
  }

  private requireUniqueStart(guildId: string, start: number, except = -1): void {
    if (this.db.query('SELECT 1 FROM picks WHERE guild_id=? AND scheduled_at=? AND id!=?').get(guildId, start, except)) {
      throw new UserError('Another album already has that start time. Choose a different time.');
    }
  }

  addHistory(guildId: string, userId: string, title: string, artist: string, start: number, end: number): RatedPick {
    title = cleanName(title); artist = cleanName(artist);
    validateNames(title, artist);
    this.validatePeriod(start, end);
    return this.transaction(() => {
      this.requireIdle(guildId);
      this.guild(guildId);
      this.requireUniqueStart(guildId, start);
      const result = this.db.query(`INSERT INTO picks(guild_id,user_id,title,artist,round,scheduled_at,ended_at,is_history,status,nonce)
        VALUES (?,?,?,?,0,?,?,1,'sent',?)`).run(guildId, userId, title, artist, start, end, randomUUID());
      return this.ratedPick(guildId, Number(result.lastInsertRowid))!;
    });
  }

  editPick(guildId: string, id: number, changes: { title?: string; artist?: string; start?: number; end?: number; user?: string }): RatedPick {
    return this.transaction(() => {
      this.requireIdle(guildId);
      const pick = this.ratedPick(guildId, id);
      if (!pick) throw new UserError('That album was not found in this server. Search again.');
      if (Object.values(changes).every(value => value === undefined)) throw new UserError('Choose at least one field to change.');
      if (this.current(guildId)?.id === id && changes.end !== undefined) throw new UserError('The active album ends when the next album is picked.');
      const title = cleanName(changes.title ?? pick.title);
      const artist = cleanName(changes.artist ?? pick.artist);
      const start = changes.start ?? pick.scheduled_at;
      const end = changes.end ?? pick.ended_at;
      validateNames(title, artist);
      this.validatePeriod(start, end);
      this.requireUniqueStart(guildId, start, id);
      this.db.query('UPDATE picks SET title=?,artist=?,scheduled_at=?,ended_at=?,user_id=? WHERE guild_id=? AND id=?')
        .run(title, artist, start, end, changes.user ?? pick.user_id, guildId, id);
      return this.ratedPick(guildId, id)!;
    });
  }

  deleteHistory(guildId: string, id: number): RatedPick {
    return this.transaction(() => {
      this.requireIdle(guildId);
      const pick = this.ratedPick(guildId, id);
      if (!pick) throw new UserError('That album was not found in this server. Search again.');
      if (this.current(guildId)?.id === id) throw new UserError('The active album cannot be deleted from history.');
      this.db.query('DELETE FROM picks WHERE guild_id=? AND id=?').run(guildId, id);
      return pick;
    });
  }

  participantCount(guildId: string): number {
    return (this.db.query('SELECT COUNT(*) AS count FROM participants WHERE guild_id=?').get(guildId) as { count: number }).count;
  }

  participantRounds(guildId: string, limit = 10, offset = 0) {
    return this.db.query(`SELECT p.user_id,p.last_round,COUNT(a.id) AS queued FROM participants p
      LEFT JOIN albums a ON a.guild_id=p.guild_id AND a.user_id=p.user_id WHERE p.guild_id=?
      GROUP BY p.user_id ORDER BY p.last_round,p.user_id LIMIT ? OFFSET ?`).all(guildId, limit, offset) as { user_id: string; last_round: number; queued: number }[];
  }

  setParticipantRound(guildId: string, userId: string, round: number): void {
    this.transaction(() => {
      this.requireIdle(guildId);
      const current = this.guild(guildId).round;
      if (!Number.isSafeInteger(round) || round < 0 || round > current) throw new UserError(`Choose a round from 0 to ${current}, the current server round.`);
      this.db.query(`INSERT INTO participants(guild_id,user_id,last_round) VALUES (?,?,?)
        ON CONFLICT(guild_id,user_id) DO UPDATE SET last_round=excluded.last_round`).run(guildId, userId, round);
    });
  }

  markSent(id: number, messageId: string, channelId?: string): void {
    this.db.query("UPDATE picks SET status='sent', message_id=?, message_channel_id=COALESCE(?,message_channel_id) WHERE id=?").run(messageId, channelId ?? null, id);
  }

  markRerollNotice(id: number, messageId: string): void {
    this.db.query('UPDATE picks SET reroll_notice_id=? WHERE id=?').run(messageId, id);
  }

  markSummaryPage(id: number, pagesSent: number): void {
    this.db.query('UPDATE picks SET summary_pages_sent=? WHERE id=?').run(pagesSent, id);
  }

  reserveNow(guildId: string, now = Date.now(), choose: (size: number) => number = randomInt, rerolledBy?: string): Pick {
    return this.transaction(() => {
      const guild = this.guild(guildId);
      if (!guild.enabled || !guild.channel_id || !guild.role_id) throw new UserError('Run /aotw admin setup to enable announcements first.');
      if (this.pending(guildId)) throw new UserError('An announcement is awaiting delivery. Wait for it to finish before rerolling.');
      const result = this.draw(guild, now, choose);
      if (!result) throw new UserError('No albums are queued. Add one with /aotw queue add first.');
      if (rerolledBy) {
        this.db.query('UPDATE picks SET rerolled_by=? WHERE id=?').run(rerolledBy, result.id);
        result.rerolled_by = rerolledBy;
      }
      // A manual draw at/after a due slot satisfies it; avoid a second draw on the next tick.
      if (guild.next_run !== null && guild.next_run <= now) {
        this.db.query('UPDATE guilds SET next_run=? WHERE id=?').run(nextRun(guild, now), guildId);
      }
      return result;
    });
  }

  reserveDue(guildId: string, now: number, choose: (size: number) => number = randomInt): Pick | undefined {
    return this.transaction(() => {
      const guild = this.guild(guildId);
      if (!guild.enabled || this.pending(guildId) || guild.next_run === null || guild.next_run > now) return undefined;
      // One catch-up after downtime, never a burst of historical announcements.
      this.db.query('UPDATE guilds SET next_run=? WHERE id=?').run(nextRun(guild, now), guildId);
      return this.draw(guild, guild.next_run, choose);
    });
  }

  private draw(guild: Guild, scheduledAt: number, choose: (size: number) => number): Pick | undefined {
    const guildId = guild.id;
    const participants = this.db.query(`SELECT p.user_id, p.last_round FROM participants p
      WHERE p.guild_id=? AND EXISTS (SELECT 1 FROM albums a WHERE a.guild_id=p.guild_id AND a.user_id=p.user_id)
      ORDER BY p.user_id`).all(guildId) as { user_id: string; last_round: number }[];
    if (!participants.length) return undefined;
    let round = guild.round;
    let eligible = participants.filter(p => p.last_round < round);
    if (!eligible.length) {
      round++;
      this.db.query('UPDATE guilds SET round=? WHERE id=?').run(round, guildId);
      eligible = participants;
    }
    const user = eligible[choose(eligible.length)];
    if (!user) throw new Error('Random selector returned an invalid user index.');
    const albums = this.albums(guildId, user.user_id);
    const album = albums[choose(albums.length)];
    if (!album) throw new Error('Random selector returned an invalid album index.');
    this.db.query('UPDATE participants SET last_round=? WHERE guild_id=? AND user_id=?').run(round, guildId, user.user_id);
    this.db.query('DELETE FROM albums WHERE id=?').run(album.id);
    const nonce = randomUUID().replaceAll('-', '').slice(0, 24);
    const previous = this.current(guildId);
    // Freeze the outgoing album's final ratings in the same transaction as the new draw.
    const summary: AlbumSummary | null = previous ? {
      title: previous.title, artist: previous.artist, user_id: previous.user_id,
      average: previous.average, rating_count: previous.rating_count,
      ratings: this.db.query('SELECT user_id,score FROM ratings WHERE pick_id=? ORDER BY score DESC, user_id')
        .all(previous.id) as { user_id: string; score: number }[],
    } : null;
    // Preserve the existing timestamp uniqueness constraint for draws in the same millisecond.
    while (this.db.query('SELECT 1 FROM picks WHERE guild_id=? AND scheduled_at=?').get(guildId, scheduledAt)) scheduledAt++;
    if (previous) this.db.query('UPDATE picks SET ended_at=? WHERE id=?').run(scheduledAt, previous.id);
    this.db.query(`INSERT INTO picks(guild_id,user_id,title,artist,round,scheduled_at,nonce,summary_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(guildId, user.user_id, album.title, album.artist, round, scheduledAt, nonce, summary ? JSON.stringify(summary) : null);
    return this.pending(guildId);
  }
}
