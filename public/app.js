const $ = id => document.getElementById(id);
function el(tag,text,cls) { const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function emptyCanvas() {
  const box = el('div','','empty');
  const glyph = el('span','↗','compass'); glyph.setAttribute('aria-hidden','true');
  box.append(glyph,
    el('h2','Gathering evidence...'),
    el('p','Resolving taste anchors, checking coverage, then comparing plans. Previous results are cleared at every run start.'),
    el('p','Same brief and model in both panels. Only the Qloo evidence context changes. This is a qualitative comparison, not a measured performance claim.','hint'));
  return box;
}
function clearResults() {
  $('canvas').replaceChildren(emptyCanvas());
  $('baseline').replaceChildren();
  $('ideas').replaceChildren();
  $('notice').textContent='';
  $('model').textContent='';
  $('results').hidden=true;
}
function renderIdeas(target,ideas) {
  target.replaceChildren();
  if (!ideas?.length) {target.append(el('p','No valid ideas returned. Try another brief.','hint'));return;}
  for (const [n,i] of ideas.entries()) { const box=el('div','','idea');box.append(el('h4',`${n+1}. ${i.title}`),el('p',i.action),el('p',i.reason,'hint'));for(const id of i.evidence_ids || [])box.append(el('p',`Evidence: ${id}`,'id'));target.append(box); }
}
$('brief').addEventListener('submit',async event=>{
  event.preventDefault();$('run').disabled=true;$('status').className='';$('status').textContent='Resolving taste anchors, checking coverage, then comparing plans...';
  clearResults();
  const brief={anchors:$('anchors').value.split(',').map(s=>s.trim()).filter(Boolean),anchorType:$('anchorType').value,targetType:$('targetType').value,location:$('location').value,age:$('age').value,niche:$('niche').value,goal:$('goal').value};
  try {
    let response,data,retries=0;
    while (true) {
      response=await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(brief),signal:AbortSignal.timeout(90000)});
      data=await response.json().catch(()=>({}));
      // 503 = fail-closed at the free-tier per-minute edge; a short wait usually frees a slot.
      if (response.status===503 && retries<2) { retries++;$('status').textContent=`Free-tier capacity is busy. Retrying (${retries}/2)...`;await sleep(6000);continue; }
      break;
    }
    if (!response.ok) {
      if (response.status===503) throw Error('The demo is busy at the free-tier limit. Wait a minute and run again.');
      throw Error(data.error || 'Run unavailable');
    }
    const canvas=$('canvas');canvas.replaceChildren(el('h2','Returned cultural evidence'));
    const anchors=data.grounded?.anchors || [];canvas.append(el('p',`Resolved anchors: ${anchors.map(a=>a.name).join(', ') || 'none'}`,'hint'));
    canvas.append(el('p','Search selects the top match. If these names are not what you meant, refine the anchors and run again.','hint'));
    for(const item of data.grounded?.plan || []) {const row=el('div','','evidence');row.append(el('strong',item.name),el('p',`Qloo affinity: ${item.affinity}`,'hint'),el('p',item.entity_id,'id'));canvas.append(row);}
    const details=document.createElement('details');details.append(el('summary','Inspect the bounded decision trace'));const list=el('ol','','trace');
    for(const step of data.grounded?.trace || [])list.append(el('li',`${step.name} · ${step.decided_by} · ${JSON.stringify(step.detail)}`));details.append(list);canvas.append(details);
    canvas.append(el('p',`Dropped evidence rows: ${data.grounded?.dropped?.length || 0}. Dropped generated ideas: ${data.droppedIdeas?.length || 0}.`,'hint'));
    renderIdeas($('baseline'),data.baseline);renderIdeas($('ideas'),data.ideas);$('notice').textContent=data.notice;$('model').textContent=`Model: ${data.model}. Same task, temperature and output limit. Evidence context differs.`;$('results').hidden=false;$('status').textContent='Run complete. Review the evidence and treat every idea as a hypothesis.';
  } catch(error) { $('status').className='error';$('status').textContent=error.name==='TimeoutError'?'The run timed out. Upstream capacity may be limited.':error.message; }
  finally { $('run').disabled=false; }
});
