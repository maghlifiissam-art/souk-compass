import { QlooClient, ENTITY_TYPES, AGE_BUCKETS, ParamError } from './qloo.js';
import { GeminiClient, MODEL_POOL } from './llm.js';
import { worstCaseTokens } from './budget_core.js';
import { runAgent } from './agent.js';
import { parseJson, planningPrompt, verifyIdeas, baselineIdeas, makeTagPlanner } from './planner.js';
export { BudgetDO } from './budget_do.js';

export function sanitizeBrief(body) {
  const allowed = ['anchors','anchorType','targetType','niche','location','age','goal'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) throw new ParamError('Unexpected input fields');
  const text = (v, max, required = false) => {
    if (v === undefined && !required) return '';
    if (typeof v !== 'string' || v.length > max || /[\x00-\x1f]/.test(v) || (required && !v.trim())) throw new ParamError('Invalid text input');
    return v.trim();
  };
  if (!Array.isArray(body.anchors) || body.anchors.length < 1 || body.anchors.length > 3) throw new ParamError('Enter 1-3 taste anchors');
  if (!ENTITY_TYPES.includes(body.anchorType) || !ENTITY_TYPES.includes(body.targetType)) throw new ParamError('Invalid entity type');
  if (body.age && !AGE_BUCKETS.includes(body.age)) throw new ParamError('Invalid age bucket');
  return { anchors: body.anchors.map(x => text(x,80,true)), anchorType: body.anchorType, targetType: body.targetType, niche: text(body.niche,80), location: text(body.location,80,true), age: body.age || '', goal: text(body.goal,300,true) };
}
export async function createBudgetedGenerator(env, fetchImpl = fetch) {
  // One verified model per deployment. No cross-model limit evasion or blind fallback.
  const model = MODEL_POOL.find(m => m.id === env.GEMINI_MODEL);
  if (!model) throw new Error('Model configuration requires verification');
  const budget = env.BUDGET.get(env.BUDGET.idFromName('project-global'));
  const rpc = async (path, body) => {
    const res = await budget.fetch(`https://budget${path}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    if (!res.ok) throw new Error('Budget unavailable');
    return res.json();
  };
  const client = new GeminiClient(env.GEMINI_API_KEY, { fetchImpl });
  let calls = 0;
  return { rpc, model: model.id, generate: async (prompt) => {
    if (++calls > 3) throw new Error('LLM call envelope exceeded');
    const id = crypto.randomUUID();
    const reserved = await rpc('/reserve', { model: model.id, tokens: worstCaseTokens(prompt,1024), limits:model, id });
    if (!reserved.reserved) throw new Error('Free-tier capacity reached');
    let usage = null;
    try {
      const result = await client.generate(model.id,prompt,{maxOutputTokens:1024});
      usage = result.usage?.totalTokens ?? null;
      return result.text;
    } finally {
      // On failure/timeout, unknown usage keeps the full reservation.
      await rpc('/commit',{id,actualTokens:usage});
    }
  } };
}
const headers = {
  'cache-control':'no-store', 'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer',
};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      const res = await env.ASSETS.fetch(request);
      const h = new Headers(res.headers);
      for (const [k,v] of Object.entries(headers)) h.set(k,v);
      h.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return new Response(res.body,{status:res.status,headers:h});
    }
    if (url.pathname !== '/api/run' || request.method !== 'POST') return Response.json({error:'Not found'},{status:404,headers});
    if (request.headers.get('origin') !== url.origin) return Response.json({error:'Same-origin requests only'},{status:403,headers});
    if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({error:'JSON required'},{status:415,headers});
    try {
      // Stream limit, not just a user-controlled content-length header.
      const reader = request.body?.getReader();
      if (!reader) throw new ParamError('Empty request');
      const chunks = []; let size = 0;
      while (true) {
        const {done,value} = await reader.read(); if (done) break;
        size += value.length; if (size > 4096) { await reader.cancel(); throw new ParamError('Request too large'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
      let input; try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ParamError('Invalid JSON'); }
      const brief = sanitizeBrief(input);
      if (!env.GEMINI_API_KEY) throw new Error('Service configuration incomplete');
      const { generate, rpc, model } = await createBudgetedGenerator(env);
      const rawIp = request.headers.get('CF-Connecting-IP');
      if (!rawIp) throw new Error('Trusted network identity unavailable');
      // No raw IP stored: daily-rotating salted hash. Salt is a Worker secret.
      if (!env.IP_HASH_SALT) throw new Error('Abuse-control configuration incomplete');
      const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${env.IP_HASH_SALT}:${new Date().toISOString().slice(0,10)}:${rawIp}`));
      const ip = Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
      if (!(await rpc('/admit',{ip})).allowed) return Response.json({error:'Today\'s free demo capacity is used up. Budgets reset daily - please try again tomorrow.'},{status:429,headers});
      const qloo = QlooClient.fromEnv(env);
      if (!qloo) throw new Error('Service configuration incomplete');
      const grounded = await runAgent({ brief,qloo,llmPlan:makeTagPlanner(generate,qloo) });
      if (!grounded.plan.length) return Response.json({ grounded,ideas:[],baseline:[],model,notice:'No reliable evidence. Try clearer taste anchors.'},{headers});
      const evidence = grounded.plan.slice(0,10);
      const baseline = baselineIdeas(parseJson(await generate(planningPrompt(brief))));
      const checked = verifyIdeas(parseJson(await generate(planningPrompt(brief,evidence))),evidence);
      grounded.trace.push({name:'plan','decided_by':'llm',detail:{ideas:checked.ideas.length}});
      grounded.trace.push({name:'citation-check','decided_by':'rule',detail:{dropped:checked.dropped.length}});
      return Response.json({grounded,ideas:checked.ideas,droppedIdeas:checked.dropped,baseline,model,notice:'Qloo affinity is cultural association, not demand. Both plans are generated hypotheses, not proven business advice.'},{headers});
    } catch (error) {
      // Never expose upstream error messages, keys, prompts or payloads.
      console.error('api/run failed', JSON.stringify({ name: error && error.name, status: error && error.status, msg: String((error && error.message) || '').slice(0, 140) }));
      const bad = error instanceof ParamError;
      return Response.json({error:bad ? error.message : 'This run could not finish. Capacity or an upstream service may be unavailable.'},{status:bad ? 400 : 503,headers});
    }
  },
};
