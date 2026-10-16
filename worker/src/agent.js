// Souk Compass bounded agent loop.
// resolve anchors -> pick entity types/tags -> insights -> coverage check ->
// revise (bounded) -> evidence-linked plan.
// Every recommendation must cite a returned Qloo entity_id; items without
// evidence are dropped. Trace steps carry decided_by: 'rule' | 'llm' | 'api'.

export const MAX_REVISIONS = 2;

export async function runAgent({ brief, qloo, llmPlan = null, trace = [] }) {
  const step = (name, decided_by, detail) => trace.push({ name, decided_by, detail });

  // 1. Resolve taste anchors from the brief (max 3 to bound API calls).
  const anchorQueries = brief.anchors.slice(0, 3);
  const anchors = [];
  for (const q of anchorQueries) {
    const hits = await qloo.search(q, { types: brief.anchorType, take: 3 });
    step('search', 'api', { query: q, hits: hits.length });
    if (hits.length) anchors.push({ query: q, entity_id: hits[0].entity_id, name: hits[0].name });
  }
  if (!anchors.length) {
    step('abort', 'rule', { reason: 'no anchors resolved' });
    return { trace, plan: [], dropped: [], coverage: { anchorsResolved: 0 } };
  }

  // 2. Optional tag grounding for the niche.
  const tags = [];
  if (brief.niche) {
    const t = await qloo.tags(brief.niche, { take: 3 });
    step('tags', 'api', { query: brief.niche, hits: t.length });
    tags.push(...t.slice(0, 2).map((x) => ({ id: x.id, name: x.name })));
  }

  // 3. Insights with coverage check and bounded revision.
  let signalEntities = anchors.map((a) => a.entity_id);
  let signalTags = tags.map((t) => t.id);
  let targetType = brief.targetType;
  let results = [];
  for (let rev = 0; rev <= MAX_REVISIONS; rev++) {
    results = await qloo.insights({
      entityType: targetType,
      signalEntities,
      signalTags,
      locationQuery: brief.location,
      age: brief.age,
      take: 10,
    });
    step('insights', 'api', { revision: rev, results: results.length, targetType });
    const coverage = results.filter((r) => Number.isFinite(r.affinity)).length;
    if (coverage >= 5 || rev === MAX_REVISIONS) break;
    // Rule-based revision: weak coverage -> drop tag filter, then broaden via LLM plan if given.
    if (signalTags.length) {
      signalTags = [];
      step('revise', 'rule', { action: 'drop tag filter', coverage });
    } else if (llmPlan) {
      const revised = await llmPlan({ brief, anchors, coverage });
      if (revised && revised.signalTags?.length) {
        signalTags = revised.signalTags;
        step('revise', 'llm', { action: 'llm tag suggestion', coverage });
      } else { break; }
    } else {
      break;
    }
  }

  // 4. Evidence post-check: only items with a returned entity_id and affinity survive.
  const plan = [];
  const dropped = [];
  for (const r of results) {
    if (r.entity_id && Number.isFinite(r.affinity)) {
      plan.push({ name: r.name, entity_id: r.entity_id, affinity: r.affinity, popularity: r.popularity });
    } else {
      dropped.push({ name: r.name, reason: 'no evidence id/affinity' });
    }
  }
  step('evidence-check', 'rule', { kept: plan.length, dropped: dropped.length });

  return {
    trace,
    anchors,
    tags,
    plan,
    dropped,
    coverage: { anchorsResolved: anchors.length, finalResults: results.length },
  };
}
