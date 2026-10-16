import test from 'node:test';
import assert from 'node:assert/strict';
import { QlooClient, RELAY_BASE } from '../worker/src/qloo.js';

const okJson = (obj) => Response.json(obj);

test('relay mode: URL carries __path + query, sends X-Relay-Key, never x-api-key', async () => {
  const seen = [];
  const qloo = new QlooClient('relay-secret', {
    relayBase: RELAY_BASE,
    fetchImpl: async (url, init) => { seen.push({ url, headers: init.headers }); return okJson({ results: [] }); },
  });
  await qloo.search('gnawa', { types: 'urn:entity:artist', take: 3 });
  assert.equal(seen.length, 1);
  const u = new URL(seen[0].url);
  assert.equal(u.origin + u.pathname, RELAY_BASE);
  assert.equal(u.searchParams.get('__path'), '/search');
  assert.equal(u.searchParams.get('query'), 'gnawa');
  assert.equal(u.searchParams.get('types'), 'urn:entity:artist');
  assert.equal(seen[0].headers['x-relay-key'], 'relay-secret');
  assert.equal(seen[0].headers['x-api-key'], undefined);
});

test('relay mode: multi-segment upstream path survives encoding', async () => {
  const seen = [];
  const qloo = new QlooClient('s', { relayBase: RELAY_BASE, fetchImpl: async (url) => { seen.push(url); return okJson({ results: { entities: [] } }); } });
  await qloo.insights({ entityType: 'urn:entity:book', signalTags: ['urn:tag:genre:x'] });
  assert.equal(new URL(seen[0]).searchParams.get('__path'), '/v2/insights');
});

test('fromEnv: relay secret wins, direct key is fallback, neither fails closed', () => {
  assert.equal(QlooClient.fromEnv({ RELAY_SHARED_SECRET: 'r', QLOO_API_KEY: 'q' }).relay, RELAY_BASE);
  assert.equal(QlooClient.fromEnv({ QLOO_API_KEY: 'q' }).relay, null);
  assert.equal(QlooClient.fromEnv({}), null);
});

test('relay mode: upstream error status propagates, message stays sanitized', async () => {
  const qloo = new QlooClient('s', { relayBase: RELAY_BASE, fetchImpl: async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }) });
  await assert.rejects(() => qloo.search('x'), (e) => { assert.equal(e.status, 401); return true; });
});
