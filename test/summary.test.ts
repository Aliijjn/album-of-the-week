import assert from 'node:assert/strict';
import { test, onTestFinished } from 'bun:test';
import { PermissionsBitField, PermissionFlagsBits, type Client, type EmbedBuilder } from 'discord.js';
import { Store, type AlbumSummary } from '../src/store.js';
import { discordDelivery } from '../src/discord.js';
import { Scheduler } from '../src/scheduler.js';

for (const trigger of ['scheduled', 'reroll'] as const) {
  test(`${trigger} publishes the notice before sorted ratings and the next album and resumes a partially delivered summary`, async () => {
    const store = new Store(':memory:');
    onTestFinished(() => store.close());
    store.configure('guild', 'channel', 'role', undefined, 0);
    store.addAlbum('guild', 'submitter', 'Previous album', 'Artist');
    type Payload = { content?: string; embeds?: EmbedBuilder[]; allowedMentions: unknown; nonce: string };
    const delivered: Payload[] = [];
    let failSecondPage = true;
    const channel = {
      guildId: 'guild', isTextBased: () => true, isDMBased: () => false, isSendable: () => true,
      guild: { roles: { fetch: async () => ({ id: 'role', mentionable: true }) }, members: { fetchMe: async () => ({}) } },
      permissionsFor: () => new PermissionsBitField([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
      ]),
      send: async (payload: Payload) => {
        if (failSecondPage && payload.embeds?.[0]?.toJSON().footer?.text.includes('Page 2')) throw new Error('Network failure');
        delivered.push(payload);
        return { id: `message-${delivered.length}` };
      },
    };
    const delivery = discordDelivery({ channels: { fetch: async () => channel } } as unknown as Client);
    const scheduler = new Scheduler(store, { ...delivery, available: () => true, isMember: async () => true }, () => {});
    await scheduler.tick(store.guild('guild').next_run!);
    assert.equal(delivered.length, 1, 'first-ever album has no preceding summary');
    for (let i = 0; i < 65; i++) store.rate('guild', `rater-${String(i).padStart(2, '0')}`, i % 11);
    store.configure('other', 'channel', 'role', undefined, 0);
    store.addAlbum('other', 'other-user', 'Other server album', 'Artist');
    const other = store.reserveNow('other');
    store.markSent(other.id, 'other-message');
    store.rate('other', 'outsider', 10);
    store.addAlbum('guild', 'submitter', 'Next album', 'Artist');
    if (trigger === 'reroll') await assert.rejects(scheduler.reroll('guild', 'admin'), /retry automatically/);
    else await scheduler.tick(store.guild('guild').next_run!);
    const pending = store.pending('guild')!;
    assert.equal(pending.summary_pages_sent, 1);
    const snapshot = JSON.parse(pending.summary_json!) as AlbumSummary;
    assert.equal(snapshot.ratings.length, 65);
    assert.equal(snapshot.title, 'Previous album');
    assert.equal(store.historyCount('guild'), 1);
    assert.throws(() => store.rate('guild', 'late-rater', 4), /pending/);
    failSecondPage = false;
    await scheduler.tick(0);
    assert.equal(store.historyCount('guild'), 2);
    assert.equal(store.history('guild')[1]?.rating_count, 65);
    const summaryStart = trigger === 'reroll' ? 2 : 1;
    const summaryPages = delivered.slice(summaryStart, summaryStart + 3);
    for (let i = 0; i < 3; i++) {
      const page = summaryPages[i]!;
      const embed = page.embeds![0]!.toJSON();
      assert.equal(embed.title, 'Previous album - final ratings');
      assert.match(embed.footer!.text, new RegExp(`Page ${i + 1} of 3`));
      assert.ok(embed.description!.length <= 4096);
      assert.deepEqual(page.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
    }
    const text = summaryPages.map(p => p.embeds![0]!.toJSON().description).join('\n');
    for (let i = 0; i < 65; i++) assert.ok(text.includes(`<@rater-${String(i).padStart(2, '0')}>: ${i % 11}/10`));
    assert.doesNotMatch(text, /outsider|Other server/);
    if (trigger === 'reroll') {
      assert.equal(delivered[1]!.content, '<@admin> rerolled...');
      assert.equal(delivered.filter(p => p.content === '<@admin> rerolled...').length, 1);
    }
    const scores = [...text.matchAll(/<@rater-\d+>: (\d+)\/10/g)].map(match => Number(match[1]));
    assert.equal(scores.length, 65);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.ok(text.indexOf('<@rater-10>') < text.indexOf('<@rater-21>'), 'ties use stable user ordering');
    assert.match(delivered.at(-1)!.embeds![0]!.toJSON().description!, /Next album/);
    assert.equal(new Set(delivered.map(p => p.nonce)).size, delivered.length);
  });
}

test('a previous album without ratings still has a summary snapshot', () => {
  const store = new Store(':memory:');
  onTestFinished(() => store.close());
  store.configure('g', 'channel', 'role', undefined, 0);
  store.addAlbum('g', 'a', 'Unrated', 'Artist');
  const first = store.reserveNow('g');
  store.markSent(first.id, 'first');
  store.addAlbum('g', 'a', 'Next', 'Artist');
  const next = store.reserveNow('g');
  const snapshot = JSON.parse(next.summary_json!) as AlbumSummary;
  assert.equal(snapshot.average, null);
  assert.deepEqual(snapshot.ratings, []);
});
