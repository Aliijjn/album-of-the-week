import type { Guild, Pick, Store } from './store.js';
import { UserError } from './store.js';

export interface Delivery {
  available(guildId: string): boolean;
  isMember(guildId: string, userId: string): Promise<boolean>;
  send(guild: Guild, pick: Pick, noticeSent?: (messageId: string) => void, summaryPageSent?: (pagesSent: number) => void): Promise<string>;
}

export class Scheduler {
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopped = false;

  constructor(private store: Store, private delivery: Delivery,
    private report: (error: unknown, guildId: string) => void = (error, guildId) => console.error('Weekly announcement failed', { guildId, error })) {}

  isRunning(): boolean { return this.running; }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const poll = () => { void this.tick().catch(error => this.report(error, 'scheduler')); };
    this.timer = setInterval(poll, 30_000);
    poll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    // Command callers already receive reroll failures; they must not abort shutdown.
    await this.active?.catch(() => {});
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.active = this.run(now).finally(() => { this.running = false; });
    await this.active;
  }

  async reroll(guildId: string, userId: string): Promise<void> {
    if (this.stopped) throw new UserError('The bot is shutting down. Please try again after it restarts.');
    if (this.running) throw new UserError('A draw is already running. Please try again shortly.');
    if (!this.delivery.available(guildId)) throw new UserError('Discord is not ready for this server. Please try again shortly.');
    this.running = true;
    this.active = this.performReroll(guildId, userId).finally(() => { this.running = false; });
    await this.active;
  }

  private async performReroll(guildId: string, userId: string): Promise<void> {
    for (const userId of this.store.queuedUsers(guildId)) {
      if (!(await this.delivery.isMember(guildId, userId))) this.store.removeMember(guildId, userId);
    }
    const pick = this.store.reserveNow(guildId, Date.now(), undefined, userId);
    const guild = this.store.guild(guildId);
    try {
      const messageId = await this.deliver(guild, pick);
      this.store.markSent(pick.id, messageId, guild.channel_id!);
    } catch (error) {
      this.report(error, guildId);
      throw new UserError('The reroll was saved, but Discord delivery failed. It will retry automatically; check /aotw status.');
    }
  }

  private deliver(guild: Guild, pick: Pick): Promise<string> {
    return this.delivery.send(guild, pick,
      id => this.store.markRerollNotice(pick.id, id),
      pages => this.store.markSummaryPage(pick.id, pages));
  }

  private async run(now: number): Promise<void> {
    for (const guild of this.store.enabledGuilds()) {
      if (this.stopped) break;
      try {
        if (!this.delivery.available(guild.id)) continue;
        let pick = this.store.pending(guild.id);
        if (!pick && guild.next_run !== null && guild.next_run <= now) {
          // Fetch individual members; no privileged Guild Members intent required.
          // Only definitive Unknown Member responses remove submissions.
          for (const userId of this.store.queuedUsers(guild.id)) {
            if (!(await this.delivery.isMember(guild.id, userId))) this.store.removeMember(guild.id, userId);
          }
          pick = this.store.reserveDue(guild.id, now);
        }
        // A command may have changed/paused settings during the membership fetch.
        const current = this.store.guild(guild.id);
        if (pick && current.enabled && current.channel_id) {
          const messageId = await this.deliver(current, pick);
          this.store.markSent(pick.id, messageId, current.channel_id);
        }
      } catch (error) {
        this.report(error, guild.id);
      }
    }
  }
}
