import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createBudgetCore, DAY_MS, RPD_WINDOW_MS, worstCaseTokens } from '../worker/src/budget_core.js';
import { BudgetDO, adaptSql } from '../worker/src/budget_do.js';
const limits = {rpm:2,tpm:100,rpd:3};
function setup() { const db=new DatabaseSync(':memory:'); let time=DAY_MS+1000; return {db,core:createBudgetCore(db,()=>time),setTime:x=>time=x}; }
test('RPM, TPM, RPD bounds and unknown usage fail closed',()=>{
  const {core,setTime}=setup();
  assert.equal(core.reserve('m',60,limits,'a'),'a');
  assert.equal(core.reserve('m',41,limits,'b'),null);
  assert.equal(core.commit('a',null),true);
  assert.equal(core.usage('m').windowTokens,60);
  assert.equal(core.commit('a',0),false);
  assert.equal(core.reserve('m',40,limits,'b'),'b');
  assert.equal(core.reserve('m',0,limits,'c'),null);
  setTime(DAY_MS+62000);
  assert.equal(core.reserve('m',40,limits,'c'),'c');
  setTime(DAY_MS+125000);
  assert.equal(core.reserve('m',0,limits,'d'),null);
});
test('timeout is not refunded and restart preserves usage',()=>{
  const {db,core,setTime}=setup();
  core.reserve('m',80,limits,'a'); setTime(DAY_MS+4000);
  const restarted=createBudgetCore(db,()=>DAY_MS+4000);
  assert.equal(restarted.usage('m').windowTokens,80);
  assert.equal(restarted.reserve('m',21,limits,'b'),null);
  setTime(DAY_MS+62000);
  assert.equal(core.usage('m').windowTokens,0);
  assert.equal(core.usage('m').dayCalls,1);
});
test('rolling 25h RPD window: 24h later still capped, past 25h free',()=>{
  const {core,setTime}=setup(); setTime(2*DAY_MS);
  assert.equal(core.reserve('m',1,{...limits,rpd:1},'a'),'a');
  assert.equal(core.reserve('m',1,{...limits,rpd:1},'b'),null);
  setTime(3*DAY_MS);
  assert.equal(core.reserve('m',1,{...limits,rpd:1},'c'),null);
  setTime(2*DAY_MS + 25*60*60*1000 + 1000);
  assert.equal(core.reserve('m',1,{...limits,rpd:1},'d'),'d');
});
test('per-IP cap persists and resets',()=>{
  const {core,db,setTime}=setup();
  assert.equal(core.allowIp('hash',2),true);assert.equal(core.allowIp('hash',2),true);
  assert.equal(createBudgetCore(db,()=>DAY_MS+2000).allowIp('hash',2),false);
  setTime(2*DAY_MS); assert.equal(core.allowIp('hash',2),true);
});
test('concurrent contenders cannot over-reserve',async()=>{
  const {core}=setup();
  const results=await Promise.all(Array.from({length:20},(_,i)=>Promise.resolve().then(()=>core.reserve('m',10,{rpm:5,tpm:100,rpd:10},String(i)))));
  assert.equal(results.filter(Boolean).length,5);
});
test('UTF-8 reservation covers multilingual bytes and rejects invalid tokens',()=>{
  assert.ok(worstCaseTokens('سلام',100)>=108);
  const {core}=setup(); assert.equal(core.reserve('m',NaN,limits,'a'),null);
});
test('Cloudflare SQL adapter and explicit transaction boundary',async()=>{
  const db=new DatabaseSync(':memory:');let transactions=0;
  const cfSql={exec:(q,...args)=>q.includes('CREATE TABLE') ? (db.exec(q),[]) : db.prepare(q).all(...args)};
  const adapted=adaptSql(cfSql);adapted.exec('CREATE TABLE z (n INTEGER)');
  assert.equal(adapted.prepare('INSERT INTO z VALUES (?)').run(1).changes,1);
  assert.equal(adapted.prepare('SELECT n FROM z').get().n,1);
  const state={storage:{sql:cfSql,transactionSync:fn=>{transactions++;db.exec('BEGIN');try {const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}}};
  const obj=new BudgetDO(state);
  const req=()=>new Request('https://budget/reserve',{method:'POST',body:JSON.stringify({model:'m',tokens:5,limits,id:crypto.randomUUID()})});
  const results=await Promise.all([obj.fetch(req()),obj.fetch(req()),obj.fetch(req())]);
  const bodies=await Promise.all(results.map(r=>r.json()));assert.equal(bodies.filter(x=>x.reserved).length,2);assert.equal(transactions,3);
});

test('Nov 1 2026 Pacific fall-back: same 25h quota day stays capped after 24h',()=>{
  const {core,setTime}=setup();
  const start=Date.parse('2026-11-01T00:10:00-07:00');
  const later=Date.parse('2026-11-01T23:11:00-08:00');
  assert.ok(later-start>DAY_MS);
  setTime(start);assert.equal(core.reserve('m',1,{...limits,rpd:1},'dst-a'),'dst-a');
  setTime(later);assert.equal(core.reserve('m',1,{...limits,rpd:1},'dst-b'),null);
});
test('IP denial does not burn global slots; global denial does not burn IP slots',()=>{
  const {core,db}=setup();
  const admit=ip=>core.admit([{key:'global',cap:3},{key:ip,cap:1}]);
  assert.equal(admit('ip-a'),true);
  for(let i=0;i<200;i++) assert.equal(admit('ip-a'),false);
  assert.equal(db.prepare("SELECT n FROM ip_requests WHERE ip='global'").get().n,1);
  assert.equal(admit('ip-b'),true);assert.equal(admit('ip-c'),true);
  assert.equal(admit('ip-d'),false);
  assert.equal(db.prepare("SELECT n FROM ip_requests WHERE ip='ip-d'").get(),undefined);
});
