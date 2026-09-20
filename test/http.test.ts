import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/http.js';
import { commands } from '../src/commands.js';

test('health and readiness distinguish liveness from Discord connectivity', async t => {
  let ready = false;
  const server = createApp(() => ready).listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  ready = true;
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
});

test('slash command payloads pass Discord builder validation', () => {
  assert.deepEqual(commands.map(command => command.toJSON().name), ['aotw']);
  assert.deepEqual(commands[0]!.toJSON().options?.map(option => option.name),
    ['add', 'list', 'remove', 'current', 'history', 'leaderboard', 'rate', 'status', 'reroll', 'setup', 'pause']);
});
