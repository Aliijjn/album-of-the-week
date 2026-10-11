import assert from 'node:assert/strict';
import { test, onTestFinished } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { databasePath } from '../src/database-path.js';
import { Store } from '../src/store.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aotw-storage-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const mount = join(root, 'volume');
  mkdirSync(mount);
  const env = { RAILWAY_SERVICE_ID: 'service', RAILWAY_VOLUME_MOUNT_PATH: mount };
  return { root, mount, env };
}

test('Railway refuses missing volumes and paths outside the volume', () => {
  const { root, mount, env } = fixture();
  assert.throws(() => databasePath({ RAILWAY_SERVICE_ID: 'service' }, root), /persistent volume/);
  assert.throws(() => databasePath({ ...env, RAILWAY_VOLUME_MOUNT_PATH: join(root, 'missing') }, root), /unavailable/);
  for (const path of [join(root, 'temporary.sqlite'), join(root, 'volume-other', 'db.sqlite'), ':memory:', mount]) {
    assert.throws(() => databasePath({ ...env, DATABASE_PATH: path }, root));
  }
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(mount, 'link'));
  assert.throws(() => databasePath({ ...env, DATABASE_PATH: join(mount, 'link', 'db.sqlite') }, root), /inside the Railway volume/);
});

test('database selection preserves old filenames and rejects ambiguous or mistaken paths', () => {
  const { root, mount, env } = fixture();
  const legacy = join(mount, 'aotw.sqlite');
  const current = join(mount, 'album-of-the-week.sqlite');
  assert.equal(databasePath(env, root), current);
  writeFileSync(legacy, 'fixture');
  assert.equal(databasePath(env, root), legacy);
  assert.throws(() => databasePath({ ...env, DATABASE_PATH: current }, root), /empty replacement/);
  writeFileSync(current, 'fixture');
  assert.throws(() => databasePath(env, root), /Multiple database/);
  assert.equal(databasePath({ ...env, DATABASE_PATH: legacy }, root), legacy);
  assert.equal(databasePath({ ...env, DATABASE_PATH: current }, root), current);
});

test('a replacement application directory reuses volume data across redeployments', () => {
  const { root, mount, env } = fixture();
  const firstApp = join(root, 'deployment-one');
  const nextApp = join(root, 'deployment-two');
  mkdirSync(firstApp); mkdirSync(nextApp);
  const first = new Store(databasePath(env, firstApp));
  first.configure('server', 'channel', 'role', undefined, 0);
  first.addAlbum('server', 'user', 'Preserved album', 'Artist');
  const pick = first.reserveNow('server', 1000);
  first.markSent(pick.id, 'message');
  first.rate('server', 'user', 8.5);
  first.setUserTimezone('user', 'Europe/Amsterdam');
  first.close();
  rmSync(firstApp, { recursive: true });
  const reopened = new Store(databasePath(env, nextApp));
  try {
    assert.equal(reopened.current('server')?.title, 'Preserved album');
    assert.equal(reopened.current('server')?.average, 8.5);
    assert.equal(reopened.guild('server').channel_id, 'channel');
    assert.equal(reopened.userTimezone('user'), 'Europe/Amsterdam');
    assert.equal(databasePath(env, nextApp), join(mount, 'album-of-the-week.sqlite'));
  } finally { reopened.close(); }
});

test('local development retains explicit paths and detects the old default filename', () => {
  const { root } = fixture();
  mkdirSync(join(root, 'data'));
  assert.equal(databasePath({}, root), join(root, 'data', 'album-of-the-week.sqlite'));
  writeFileSync(join(root, 'data', 'aotw.sqlite'), 'fixture');
  assert.equal(databasePath({}, root), join(root, 'data', 'aotw.sqlite'));
  assert.equal(databasePath({ DATABASE_PATH: './data/aotw.sqlite' }, root), join(root, 'data', 'aotw.sqlite'));
});
