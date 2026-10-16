// Qloo hackathon API client + strict param validator.
// Live-verified shapes (2026-10-07, hackathon.api.qloo.com):
//   /search   -> { results: [{ entity_id, name, types, popularity }] }
//   /v2/tags  -> { results: { tags: [{ id, name, type, popularity }] } }
//   /v2/insights -> { results: { entities: [{ entity_id, name, popularity, query: { affinity } }] } }
//     affinity requires feature.explainability=true and lives at entity.query.affinity
// Direct mode: hackathon.api.qloo.com ONLY (hackathon rule). Never /recs.
// Relay mode (production): Cloudflare Workers egress to hackathon.api.qloo.com
// fails before any HTTP status (confirmed 2026-10-07), so calls go through the
// authenticated relay at souk-relay.vercel.app, which holds the Qloo key.
// The Worker never sees the Qloo key in relay mode; it sends X-Relay-Key.

export const QLOO_BASE = 'https://hackathon.api.qloo.com';
export const RELAY_BASE = 'https://souk-relay.vercel.app/api/qloo';

export const ENTITY_TYPES = [
  'urn:entity:artist', 'urn:entity:album', 'urn:entity:book', 'urn:entity:brand',
  'urn:entity:destination', 'urn:entity:locality', 'urn:entity:movie',
  'urn:entity:place', 'urn:entity:podcast', 'urn:entity:tv_show', 'urn:entity:videogame',
];

// Exact age buckets returned by the live API error message (2026-10-07).
export const AGE_BUCKETS = [
  '24_and_younger', '25_to_29', '30_to_34', '35_to_44', '45_to_54',
  '55_and_older', '35_and_younger', '36_to_55',
];

export const GENDERS = ['male', 'female'];

export class ParamError extends Error {
  constructor(message) { super(message); this.name = 'ParamError'; }
}

export function clampInt(v, lo, hi, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new ParamError(`${name} must be an integer in [${lo}, ${hi}]`);
  }
  return n;
}

export function validateEntityType(t) {
  if (!ENTITY_TYPES.includes(t)) throw new ParamError(`unknown entity type: ${t}`);
  return t;
}

export function validateEntityId(id) {
  if (typeof id !== 'string' || !/^[0-9A-Fa-f-]{20,64}$/.test(id)) {
    throw new ParamError('entity id must be a Qloo UUID-like string');
  }
  return id;
}

export function validateTagId(id) {
  if (typeof id !== 'string' || !/^urn:tag:[a-z0-9_:]+$/.test(id)) {
    throw new ParamError('tag id must be a urn:tag:* identifier');
  }
  return id;
}

export function validateAgeBucket(a) {
  if (!AGE_BUCKETS.includes(a)) throw new ParamError(`age must be one of ${AGE_BUCKETS.join(', ')}`);
  return a;
}

export class QlooClient {
  constructor(apiKey, { base = QLOO_BASE, relayBase = null, fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error('QlooClient requires an API key');
    this.relay = relayBase;
    this.base = base;
    // workerd throws TypeError "Illegal invocation" when global fetch is called as
    // a method (this = client). Bind to undefined so the call matches a bare fetch().
    // (This was the real cause of the 2026-10-07 "Workers egress" failure.)
    this.fetch = fetchImpl.bind(undefined);
    // Relay mode authenticates to the relay; the Qloo key never leaves the relay host.
    this.headers = relayBase ? { 'x-relay-key': apiKey } : { 'x-api-key': apiKey };
  }

  // Production wiring: relay when RELAY_SHARED_SECRET is set, direct key otherwise.
  // Fail closed (null) when neither exists; caller turns that into a 503.
  static fromEnv(env, opts = {}) {
    if (env.RELAY_SHARED_SECRET) {
      return new QlooClient(env.RELAY_SHARED_SECRET, { relayBase: env.QLOO_RELAY_BASE || RELAY_BASE, ...opts });
    }
    if (env.QLOO_API_KEY) return new QlooClient(env.QLOO_API_KEY, opts);
    return null;
  }

  async get(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
    // Relay: 20s client timeout so the relay's own 15s upstream timeout answers first.
    const url = this.relay
      ? `${this.relay}?__path=${encodeURIComponent(path)}&${qs}`
      : `${this.base}${path}?${qs}`;
    const res = await this.fetch(url, { headers: this.headers, signal: AbortSignal.timeout(this.relay ? 20000 : 12000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.errors?.[0]?.message || body?.error?.message || `HTTP ${res.status}`;
      const err = new Error(`Qloo ${path} failed: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async search(query, { types, take = 5 } = {}) {
    if (typeof query !== 'string' || !query.trim()) throw new ParamError('search query required');
    const body = await this.get('/search', {
      query: query.trim(),
      types: types ? validateEntityType(types) : undefined,
      take: clampInt(take, 1, 25, 'take'),
    });
    return body.results || [];
  }

  async tags(filterQuery, { take = 5 } = {}) {
    if (typeof filterQuery !== 'string' || !filterQuery.trim()) throw new ParamError('tag query required');
    const body = await this.get('/v2/tags', {
      'filter.query': filterQuery.trim(),
      take: clampInt(take, 1, 25, 'take'),
    });
    return (body.results && body.results.tags) || [];
  }

  async insights({
    entityType, signalEntities = [], signalTags = [],
    locationQuery, age, gender, take = 10,
  } = {}) {
    validateEntityType(entityType);
    const params = {
      'filter.type': entityType,
      take: clampInt(take, 1, 50, 'take'),
      'feature.explainability': 'true',
    };
    if (signalEntities.length) params['signal.interests.entities'] = signalEntities.map(validateEntityId).join(',');
    if (signalTags.length) params['signal.interests.tags'] = signalTags.map(validateTagId).join(',');
    if (!signalEntities.length && !signalTags.length) {
      throw new ParamError('insights requires at least one entity or tag signal');
    }
    if (locationQuery) params['filter.location.query'] = String(locationQuery).slice(0, 80);
    if (age) params['signal.demographics.age'] = validateAgeBucket(age);
    if (gender) {
      if (!GENDERS.includes(gender)) throw new ParamError('gender must be male or female');
      params['signal.demographics.gender'] = gender;
    }
    const body = await this.get('/v2/insights', params);
    const entities = (body.results && body.results.entities) || [];
    return entities.map((e) => ({
      entity_id: e.entity_id,
      name: e.name,
      type: e.type,
      popularity: e.popularity,
      affinity: e.query ? e.query.affinity : undefined,
    }));
  }
}
