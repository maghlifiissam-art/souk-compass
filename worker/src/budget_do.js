import { createBudgetCore } from './budget_core.js';

// Cloudflare SqlStorage uses exec(), not node:sqlite prepare().
export function adaptSql(sql) {
  return {
    exec: (query) => sql.exec(query),
    prepare: (query) => ({
      get: (...args) => [...sql.exec(query, ...args)][0],
      run: (...args) => { sql.exec(query, ...args); return { changes: [...sql.exec('SELECT changes() AS n')][0].n }; },
    }),
  };
}
export class BudgetDO {
  constructor(state) {
    this.state = state;
    this.core = createBudgetCore(adaptSql(state.storage.sql));
  }
  async fetch(request) {
    if (request.method !== 'POST') return new Response('not found', { status: 404 });
    const body = await request.json();
    const path = new URL(request.url).pathname;
    return this.state.storage.transactionSync(() => {
      if (path === '/reserve') {
        const id = this.core.reserve(body.model, body.tokens, body.limits, body.id);
        return Response.json({ reserved: id !== null, id });
      }
      if (path === '/commit') return Response.json({ committed: this.core.commit(body.id, body.actualTokens) });
      if (path === '/admit') {
        // Check project-wide Qloo/demo budget before taking the IP slot.
        if (!this.core.allowIp('global', 200)) return Response.json({ allowed: false });
        return Response.json({ allowed: this.core.allowIp(body.ip, 10) });
      }
      return new Response('not found', { status: 404 });
    });
  }
}
