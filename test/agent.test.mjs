import test from 'node:test';import assert from 'node:assert/strict';
import { runAgent } from '../worker/src/agent.js';
import { verifyIdeas,makeTagPlanner,planningPrompt } from '../worker/src/planner.js';
import { sanitizeBrief,createBudgetedGenerator } from '../worker/src/index.js';
import { QlooClient } from '../worker/src/qloo.js';
const brief={anchors:['Synthetic anchor'],anchorType:'urn:entity:artist',targetType:'urn:entity:brand',niche:'craft',location:'Casablanca',age:'',goal:'Test one low-cost content idea'};
const id='11111111-1111-4111-8111-111111111111';
const evidence=Array.from({length:5},(_,i)=>({entity_id:id,name:'Synthetic '+i,affinity:0.1}));
function mock(insights) {return {search:async()=>[{entity_id:id,name:'Synthetic'}],tags:async()=>[{id:'urn:tag:genre:synthetic',name:'Synthetic'}],insights};}
test('bounded revisions, decision provenance and dropped evidence',async()=>{
  let n=0,llm=0;const qloo=mock(async()=>++n<3 ? [] : [...evidence,{name:'No id',affinity:1}]);
  const result=await runAgent({brief,qloo,llmPlan:async()=>{llm++;return{signalTags:['urn:tag:genre:test']};}});
  assert.equal(n,3);assert.equal(llm,1);assert.equal(result.plan.length,5);assert.equal(result.dropped.length,1);
  assert.ok(result.trace.some(x=>x.decided_by==='llm'));assert.ok(result.trace.every(x=>['rule','llm','api'].includes(x.decided_by)));
});
test('no anchors stops safely',async()=>{
  const qloo=mock(async()=>{throw Error('must not call');});qloo.search=async()=>[];
  const result=await runAgent({brief,qloo});assert.equal(result.plan.length,0);
});
test('all generated claims require returned evidence IDs',()=>{
  const good={title:'Test',action:'Make one post',reason:'A hypothesis',evidence_ids:[id]};
  const result=verifyIdeas({ideas:[good,{...good,evidence_ids:['invented']},{...good,evidence_ids:[]}]},evidence);
  assert.equal(result.ideas.length,1);assert.equal(result.dropped.length,2);
});
test('LLM keyword resolves against live tag API and is used once',async()=>{
  let calls=0; const planner=makeTagPlanner(async()=>'{"keyword":"music"}',{tags:async()=>{calls++;return[{id:'invented'},{id:'urn:tag:genre:test'}];}});
  assert.deepEqual(await planner({brief}),{signalTags:['urn:tag:genre:test']});assert.equal(await planner({brief}),null);assert.equal(calls,1);
});
test('strict schema rejects unknown fields, overlong input and invalid enums',()=>{
  assert.deepEqual(sanitizeBrief(brief),brief);
  for(const body of [{...brief,apiKey:'x'},{...brief,goal:'x'.repeat(301)},{...brief,targetType:'bad'},{...brief,anchors:[]}]) assert.throws(()=>sanitizeBrief(body));
});
test('compare prompts preserve common task and differ in evidence only',()=>{
  const baseline=planningPrompt(brief);const grounded=planningPrompt(brief,evidence);
  assert.equal(baseline.split('\nEVIDENCE:')[0],grounded.split('\nEVIDENCE:')[0]);
});
test('Qloo exact endpoint and parameter mapping from synthetic fixtures',async()=>{
  const urls=[];const qloo=new QlooClient('not-a-real-key',{fetchImpl:async(url)=>{urls.push(url);return Response.json(url.includes('/v2/tags')?{results:{tags:[{id:'urn:tag:test'}]}}:{results:{entities:[{entity_id:id,name:'Synthetic',query:{affinity:0.2}}]}});}});
  assert.equal((await qloo.tags('music'))[0].id,'urn:tag:test');
  assert.equal((await qloo.insights({entityType:brief.targetType,signalEntities:[id],age:'25_to_29',locationQuery:'Casablanca'}))[0].affinity,0.2);
  const url=new URL(urls[1]);assert.equal(url.hostname,'hackathon.api.qloo.com');assert.equal(url.searchParams.get('feature.explainability'),'true');assert.equal(url.searchParams.get('signal.demographics.age'),'25_to_29');
});
test('LLM errors commit unknown usage and no refund; budget denial never calls model',async()=>{
  const log=[];let allow=true,calls=0;
  const env={GEMINI_MODEL:'gemini-3.1-flash-lite',GEMINI_API_KEY:'synthetic',BUDGET:{idFromName:()=>0,get:()=>({fetch:async(url,req)=>{log.push({url,body:JSON.parse(req.body)});return Response.json(url.endsWith('/reserve')?{reserved:allow}:{committed:true});}})}};
  const gen=await createBudgetedGenerator(env,async()=>{calls++;throw Error('timeout');});
  await assert.rejects(gen.generate('test'));assert.equal(log.at(-1).body.actualTokens,null);assert.equal(calls,1);
  allow=false;await assert.rejects(gen.generate('test'));assert.equal(calls,1);
});

test('full citation list rejects invented fourth ID and overlength valid IDs',()=>{
  const evidence=['a','b','c','d'].map(entity_id=>({entity_id}));
  const base={title:'Test',action:'Test one post',reason:'Hypothesis'};
  const result=verifyIdeas({ideas:[{...base,evidence_ids:['a','b','c','invented']},{...base,evidence_ids:['a','b','c','d']},{...base,evidence_ids:['a','a','b']}]},evidence);
  assert.equal(result.dropped.length,2);assert.equal(result.ideas.length,1);
  assert.deepEqual(result.ideas[0].evidence_ids,['a','b']);
});
