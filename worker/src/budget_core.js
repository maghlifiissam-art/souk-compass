// Synchronous, transactional budget core over SQLite (single Durable Object).
// Audited design constraints:
//  - fail closed: expired reservations are NOT refunded (usage may have been consumed)
//  - request counts never refunded; commits are idempotent (first commit wins)
//  - commit reconciles only from provider-reported usage; unknown usage keeps the full reservation
//  - retries create NEW reservations
//  - storage guard: row cap fails closed; rows pruned after 2 days
// Windows: 60s sliding RPM/TPM + conservative rolling-25h RPD.
// Pacific calendar days can last 25 hours at DST fall-back. Retaining a full
// 25-hour window caps every provider day without depending on reset timing.

export const RESERVATION_TTL_MS = 60_000;
export const DAY_MS = 86_400_000;
export const RPD_WINDOW_MS = 25 * 60 * 60 * 1000;
export const PRUNE_AFTER_MS = 2 * DAY_MS;
export const ROW_CAP = 5000;

export function utcDayStart(nowMs) {
  return nowMs - (nowMs % DAY_MS);
}

export function worstCaseTokens(text, maxOutputTokens) {
  // Conservative reservation target: UTF-8 bytes + output + framing margin.
  // Not a tokenizer proof; provider usage is reconciled on completion.
  const bytes = new TextEncoder().encode(typeof text === 'string' ? text : '').length;
  return bytes + maxOutputTokens + 512;
}

export function createBudgetCore(sql, now = () => Date.now()) {
  // sql: node:sqlite DatabaseSync-compatible object (exec/prepare/get/run style via prepare()).
  sql.exec(`CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    committed INTEGER NOT NULL DEFAULT 0
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ip_requests (
    ip TEXT NOT NULL,
    day INTEGER NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (ip, day)
  )`);

  const stmts = {
    insert: sql.prepare('INSERT INTO reservations (id, model, tokens, created_at, committed) VALUES (?, ?, ?, ?, 0)'),
    commit: sql.prepare('UPDATE reservations SET tokens = ?, committed = 1 WHERE id = ? AND committed = 0'),
    active: sql.prepare('SELECT model, tokens FROM reservations WHERE created_at > ? AND committed = 0'),
    countWindow: sql.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(tokens),0) AS t FROM reservations WHERE model = ? AND created_at > ?'),
    countDay: sql.prepare('SELECT COUNT(*) AS n FROM reservations WHERE model = ? AND created_at >= ?'),
    rowCount: sql.prepare('SELECT COUNT(*) AS n FROM reservations'),
    prune: sql.prepare('DELETE FROM reservations WHERE created_at < ?'),
    ipGet: sql.prepare('SELECT n FROM ip_requests WHERE ip = ? AND day = ?'),
    ipUpsert: sql.prepare('INSERT INTO ip_requests (ip, day, n) VALUES (?, ?, 1) ON CONFLICT(ip, day) DO UPDATE SET n = n + 1'),
    ipPrune: sql.prepare('DELETE FROM ip_requests WHERE day < ?'),
  };

  function windowState(model, nowMs) {
    const { n, t } = stmts.countWindow.get(model, nowMs - RESERVATION_TTL_MS);
    const { n: d } = stmts.countDay.get(model, nowMs - RPD_WINDOW_MS);
    return { windowCalls: n, windowTokens: t, dayCalls: d };
  }

  return {
    // Returns reservation id or null when the reservation does not fit (fail closed).
    reserve(model, tokens, limits, id) {
      if (!Number.isInteger(tokens) || tokens < 0 || !id || !limits || ![limits.rpm,limits.tpm,limits.rpd].every(x => Number.isInteger(x) && x > 0)) return null;
      const nowMs = now();
      stmts.prune.run(nowMs - PRUNE_AFTER_MS);
      if (stmts.rowCount.get().n >= ROW_CAP) return null; // fail closed on storage guard
      const { windowCalls, windowTokens, dayCalls } = windowState(model, nowMs);
      if (windowCalls + 1 > limits.rpm) return null;
      if (windowTokens + tokens > limits.tpm) return null;
      if (dayCalls + 1 > limits.rpd) return null;
      stmts.insert.run(id, model, tokens, nowMs);
      return id;
    },

    // Idempotent commit: first commit wins. actualTokens from provider usage only;
    // pass null/undefined to keep the full reservation (fail closed).
    commit(id, actualTokens) {
      const t = Number.isInteger(actualTokens) && actualTokens >= 0 ? actualTokens : worstCaseFromReservation(id);
      return stmts.commit.run(t, id).changes === 1;
    },

    // Check every admission counter before incrementing any. Caller wraps this
    // synchronous operation in one storage transaction.
    admit(counters) {
      if (!Array.isArray(counters) || !counters.length || counters.some(x => !x || typeof x.key !== 'string' || !Number.isInteger(x.cap) || x.cap < 1) || new Set(counters.map(x => x.key)).size !== counters.length) return false;
      const day = utcDayStart(now());
      stmts.ipPrune.run(day - DAY_MS);
      let newRows = 0;
      for (const {key,cap} of counters) {
        const row = stmts.ipGet.get(key, day);
        if (row && row.n >= cap) return false;
        if (!row) newRows++;
      }
      if (sql.prepare('SELECT COUNT(*) AS n FROM ip_requests').get().n + newRows > ROW_CAP) return false;
      for (const {key} of counters) stmts.ipUpsert.run(key, day);
      return true;
    },

    allowIp(ip, capPerDay) {
      return this.admit([{key:ip,cap:capPerDay}]);
    },

    usage(model) {
      const nowMs = now();
      const { windowCalls, windowTokens, dayCalls } = windowState(model, nowMs);
      return { windowCalls, windowTokens, dayCalls };
    },
  };

  function worstCaseFromReservation(id) {
    const row = sql.prepare('SELECT tokens FROM reservations WHERE id = ?').get(id);
    return row ? row.tokens : 0;
  }
}
