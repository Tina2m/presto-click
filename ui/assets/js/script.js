// Enhanced UI logic with right-side pipeline panel and click-ordered pipeline.
let SID = null;
let UNITS_META = [];
let PIPELINE = []; // keeps {unit, label, card} in the order of user clicks
let CURRENT_RUN_START_STEP = null; // Track starting step index for current pipeline run
let PIPELINE_RUNNING = false; // Track if pipeline is currently running
let PIPELINE_STOP_REQUESTED = false; // Flag to stop pipeline execution

const $  = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const esc = s => (s??'').toString().replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// This page is BULK only
const UNIT_GROUP = 'bulk';

/* ---------- Category config to reduce scrolling ---------- */
const CATEGORIES = {
  "Filtering and Quality Control": [
    "filter_quality","filter_length","filter_missing",
    "filter_repeats","filter_trimqual","filter_maskqual"
  ],
  "Tecnical processing(Primers)": [
    "mask_primers"
  ],
  "Pairing & Assembly": [
    "pairseq","assemble_align","assemble_join","assemble_sequential"
  ],
  "Clustering & Consensus": [
    "collapse_seq","build_consensus"
  ],
};
const CAT_BY_ID = {};
Object.entries(CATEGORIES).forEach(([cat, ids])=>ids.forEach(id=>CAT_BY_ID[id]=cat));
function unitCategory(id){ return CAT_BY_ID[id] || "Other"; }

function selectedSteps(){
  // Return pipeline in click order, but drop items whose checkbox is no longer checked
  PIPELINE = PIPELINE.filter(s => s.card && s.card.querySelector('.pipe-add')?.checked);
  return [...PIPELINE];
}

function drawFlow(){
  const steps = selectedSteps();
  const flow = $('#flow'); flow.innerHTML = '';
  if(steps.length === 0){ flow.innerHTML = '<span class="muted">no steps selected</span>'; return; }
  steps.forEach((s,i) => {
    const n = document.createElement('div'); n.className = 'node'; n.textContent = s.label;
    flow.appendChild(n);
    if(i < steps.length-1){ const a = document.createElement('div'); a.className = 'arrow'; a.textContent = '→'; flow.appendChild(a); }
  });
}

function pipeMsg(text, cls='muted'){ const p = $('#pipe-msg'); p.className = cls; p.textContent = text; }
function setRunStatus(text){ $('#run-status').innerHTML = text; }
function setProgress(i, n){ const pct = n ? Math.round((i/n)*100) : 0; $('#run-bar').style.width = pct + '%'; }

/* ===== Read Statistics Visualization ===== */
function formatNumber(num){
  if(!num && num !== 0) return '—';
  if(num >= 1000000) return (num/1000000).toFixed(3).replace(/\.?0+$/, '') + 'M';
  if(num >= 1000) return (num/1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return num.toString();
}

async function updateReadStats(clearFirst = false){
  if(!SID) return;
  const container = $('#read-stats');
  if(!container) return;
  
  // Clear container if requested (e.g., at start of new pipeline run)
  if(clearFirst) {
    container.innerHTML = '<span class="muted">Running pipeline...</span>';
    return;
  }
  
  try{
    const r = await fetch(`/session/${SID}/stats`);
    if(!r.ok) throw new Error('Failed to fetch stats');
    const data = await r.json();
    
    if(!data.steps || data.steps.length === 0){
      container.innerHTML = '<span class="muted">No statistics available yet. Run pipeline steps to see read counts.</span>';
      return;
    }
    
    // Filter to only show steps from the current pipeline run
    let filteredSteps = data.steps;
    if(CURRENT_RUN_START_STEP !== null) {
      filteredSteps = data.steps.filter(step => step.step_index >= CURRENT_RUN_START_STEP);
    }
    
    if(filteredSteps.length === 0){
      container.innerHTML = '<span class="muted">No statistics available yet. Run pipeline steps to see read counts.</span>';
      return;
    }
    
    // Get initial reads from the first step of current run
    const firstStep = filteredSteps[0];
    const initialReads = firstStep?.input || firstStep?.total || data.initial_reads;
    if(!initialReads){
      container.innerHTML = '<span class="muted">Waiting for initial read count...</span>';
      return;
    }
    
    const chart = document.createElement('div');
    chart.className = 'funnel-chart';
    
    // Calculate max width for funnel effect (100% for first bar)
    const maxWidth = 100; // percentage
    
    // Add initial reads bar (Total reads)
    if(initialReads){
      const firstBar = document.createElement('div');
      firstBar.className = 'funnel-bar initial';
      firstBar.style.width = maxWidth + '%';
      firstBar.innerHTML = `
        <div class="funnel-bar-label">Total reads</div>
        <div class="funnel-bar-value">${formatNumber(initialReads)}</div>
        <div class="funnel-bar-percentage">100%</div>
      `;
      chart.appendChild(firstBar);
      
      if(filteredSteps.length > 0){
        const sep = document.createElement('div');
        sep.className = 'funnel-separator';
        chart.appendChild(sep);
      }
    }
    
    // Add bars for each filtering step (showing passed reads)
    filteredSteps.forEach((step, idx) => {
      // Use pass count if available, otherwise use total
      const passCount = step.pass !== null && step.pass !== undefined ? step.pass : (step.total || 0);
      if(passCount === 0 && !step.pass) return; // Skip if no meaningful data
      
      const bar = document.createElement('div');
      bar.className = 'funnel-bar filter';
      const percentage = initialReads ? Math.round((passCount / initialReads) * 100) : 0;
      
      // Calculate width as percentage of initial reads to create funnel effect
      const widthPercent = initialReads ? Math.max(15, (passCount / initialReads) * 100) : 15;
      bar.style.width = widthPercent + '%';
      
      // Shorten label if too long
      let label = esc(step.label || step.unit);
      if(label.length > 30) label = label.substring(0, 27) + '...';
      
      bar.innerHTML = `
        <div class="funnel-bar-label">${label}</div>
        <div class="funnel-bar-value">passed ${formatNumber(passCount)}</div>
        <div class="funnel-bar-percentage">${percentage}%</div>
      `;
      chart.appendChild(bar);
      
      // Add separator between steps (except after last)
      if(idx < filteredSteps.length - 1){
        const sep = document.createElement('div');
        sep.className = 'funnel-separator';
        chart.appendChild(sep);
      }
    });
    
    container.innerHTML = '';
    container.appendChild(chart);
  }catch(e){
    console.error('Failed to update read stats:', e);
    container.innerHTML = '<span class="muted">Statistics unavailable</span>';
  }
}

async function startSession(){
  const r = await fetch('/session/start',{method:'POST'});
  const j = await r.json();
  SID = j.session_id; $('#sid').textContent = SID;
  PIPELINE = []; // reset
  await renderUnits();
  drawFlow();
  await refreshState();
  $('#validation').textContent = '—';
  setRunStatus('—'); setProgress(0,1);
}

async function uploadReads(){
  const r1 = $('#r1f').files[0]; if(!r1){ alert('Choose R1'); return; }
  const fd = new FormData(); fd.append('r1', r1);
  const r2 = $('#r2f').files[0]; if(r2) fd.append('r2', r2);
  const r = await fetch(`/session/${SID}/upload`, {method:'POST', body:fd});
  if(!r.ok){ alert('Upload failed'); return; }
  await refreshState();
}

async function uploadAux(){
  const f = $('#auxf').files[0]; if(!f){ alert('Choose file'); return; }
  const fd = new FormData(); fd.append('file', f);
  const name = $('#auxname').value.trim(); if(name) fd.append('name', name);
  const r = await fetch(`/session/${SID}/upload-aux`, {method:'POST', body:fd});
  const j = await r.json();
  $('#aux-out').textContent = `Stored as: ${j.stored_as}` + (j.role && j.role!=='other' ? ` (auto as ${j.role})` : '');
  // auto-fill in MaskPrimers cards
  if(j.role === 'v_primers' || j.role === 'other'){
    $$('.card[data-unit="mask_primers"] input[name="v_primers_fname"]').forEach(el => { if(!el.value) el.value = j.stored_as; });
  }
  if(j.role === 'c_primers'){
    $$('.card[data-unit="mask_primers"] input[name="c_primers_fname"]').forEach(el => { if(!el.value) el.value = j.stored_as; });
  }
}

function collectParams(card){
  const params = {};
  card.querySelectorAll('input,select,textarea').forEach(el => {
    if(!el.name) return;
    if(el.type === 'file') return;
    if(el.classList.contains('pipe-add')) return;
    params[el.name] = (el.type === 'checkbox') ? (el.checked ? 'true' : 'false') : el.value;
  });
  return params;
}

async function runUnit(card, unitId){
  const params = collectParams(card);
  const r = await fetch(`/session/${SID}/run`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ unit_id: unitId, params })
  });
  const j = await r.json();
  if(!r.ok){
    alert(`Error: ${(j.detail && (j.detail.error||j.detail)) || r.statusText}`);
    $('#log').textContent = (j.detail && j.detail.log_tail) ? j.detail.log_tail : '';
    return false;
  }
  await refreshState();
  await updateReadStats(); // Update statistics after each step
  const stepIdx = j.step.step_index;
  const lr = await fetch(`/session/${SID}/log/${stepIdx}`);
  $('#log').textContent = await lr.text();
  return true;
}

async function refreshState(){
  const r = await fetch(`/session/${SID}/state`);
  const s = await r.json();
  const chips = Object.entries(s.current||{}).map(([k,v]) => `<span class="chip">${esc(k)}: ${esc(v)}</span>`).join(' ');
  $('#state').innerHTML = chips || '<span class="muted">no state</span>';
  const arts = Object.values(s.artifacts||{}).map(a => `<div>${esc(a.name)} — <a href="/session/${SID}/download/${encodeURIComponent(a.name)}">download</a></div>`).join('');
  $('#arts').innerHTML = arts || '<span class="muted">none</span>';
  window.__SESSION_STATE__ = s;
  await updateReadStats(); // Update statistics visualization
}

/* -------------------- New grouped render -------------------- */
function makeUnitCard(u){
  const card = document.createElement('div');
  card.className = 'card compact';
  card.dataset.unit = u.id;

  const req = (u.requires||[]).map(x=>`<span class="chip">${esc(x)}</span>`).join(' ') || '<span class="muted">none</span>';
  let paramsHTML = '';
  if (u.params_schema && Object.keys(u.params_schema).length){
    let inner = '';
    for (const [k,v] of Object.entries(u.params_schema||{})){
      const help = v.help ? ` <span class="muted">— ${esc(v.help)}</span>` : '';
      const label = `<label>${esc(k)}${help}</label>`;
      if (v.type === 'select') {
        const opts = (v.options||[]).map(o => `<option value="${esc(o)}" ${o===v.default?'selected':''}>${esc(o)}</option>`).join('');
        inner += `${label}<select name="${esc(k)}">${opts}</select>`;
      } else if (v.type === 'file') {
        inner += `${label}<input name="${esc(k)}" placeholder="${esc(v.accept||'')}" />` +
                 `<div class="muted">Upload in section 1 → aux; I'll fill this automatically.</div>`;
      } else {
        const val = v.default ?? ''; const ph = v.placeholder ?? '';
        const typeAttr = (v.type === 'int') ? 'type="number"' : 'type="text"';
        inner += `${label}<input ${typeAttr} name="${esc(k)}" value="${esc(val)}" placeholder="${esc(ph)}">`;
      }
    }
    paramsHTML = `
      <details class="params">
        <summary>Parameters</summary>
        <div class="param-wrap">${inner}</div>
      </details>`;
  }

  card.innerHTML = `
    <div class="card-head"><h3>${esc(u.label)}</h3></div>
    <div class="reqs">requires: ${req}</div>
    ${paramsHTML}
    <div class="actions">
      <button class="run">Run</button>
      <label class="row"><input type="checkbox" class="pipe-add" data-unit-id="${esc(u.id)}"> Add to pipeline</label>
    </div>`;

  card.querySelector('.run').addEventListener('click', ()=>runUnit(card,u.id));
  const chk = card.querySelector('.pipe-add');
  chk.addEventListener('change', () => {
    const unitId = chk.dataset.unitId || card.dataset.unit;
    const meta = UNITS_META.find(m => m.id === unitId) || {};
    const label = meta.label || unitId;

    if (chk.checked) {
      PIPELINE = PIPELINE.filter(s => s.unit !== unitId);
      PIPELINE.push({unit: unitId, label, card});
    } else {
      PIPELINE = PIPELINE.filter(s => s.unit !== unitId);
    }
    drawFlow();
  });

  // searchable haystack
  card.dataset.haystack = [u.id, u.label, ...(u.requires||[]), unitCategory(u.id)].join(' ').toLowerCase();
  return card;
}

async function renderUnits(){
  let all = [];
  try {
    const res = await fetch(`/session/${SID}/units?group=bulk`);
    all = await res.json();
  } catch (e) {
    try {
      const res2 = await fetch(`/session/${SID}/units`);
      all = await res2.json();
    } catch (e2) { all = []; }
  }

  UNITS_META = (all || []).filter(u => {
    const id     = (u.id || '').toLowerCase();
    const label  = (u.label || '').toLowerCase();
    const group  = (u.group || '').toLowerCase(); // if backend sends it

    if (group) return group === 'bulk';          // preferred path
    if (id.startsWith('sc_')) return false;      // legacy naming
    if (label.startsWith('sc:')) return false;   // visible label hint
    return true;                                 // treat everything else as bulk
  });

  const byCat = {};
  UNITS_META.forEach(u => {
    const cat = unitCategory(u.id);
    if(!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(makeUnitCard(u));
  });

  const mount = $('#unit-groups');
  if (!mount){ console.warn('unit-groups container not found'); return; }
  mount.innerHTML = '';

  Object.keys(CATEGORIES).concat(Object.keys(byCat).filter(c => !(c in CATEGORIES))).forEach(cat => {
    if(!byCat[cat] || byCat[cat].length === 0) return;
    const det = document.createElement('details');
    det.className = 'group';
    det.open = (cat === 'Filtering');

    const sum = document.createElement('summary');
    sum.innerHTML = `<span class="group-title">${esc(cat)}</span><span class="group-count">${byCat[cat].length}</span>`;
    const body = document.createElement('div'); body.className = 'group-body';
    byCat[cat].forEach(card => body.appendChild(card));

    det.appendChild(sum); det.appendChild(body);
    mount.appendChild(det);
  });

  // Search & bulk expand/collapse
  const q = $('#unit-search');
  if (q && !q.dataset.wired){
    q.dataset.wired = '1';
    q.addEventListener('input', () => {
      const needle = q.value.trim().toLowerCase();
      const groups = mount.querySelectorAll('details.group');
      groups.forEach(g => {
        const cards = g.querySelectorAll('.card');
        let visible = 0;
        cards.forEach(c => {
          const hit = !needle || c.dataset.haystack.includes(needle);
          c.style.display = hit ? '' : 'none';
          if(hit) visible++;
        });
        g.style.display = visible ? '' : 'none';
        if(needle && visible) g.open = true;
        const countEl = g.querySelector('.group-count'); if(countEl) countEl.textContent = String(visible);
      });
    });
  }
  const expandBtn = $('#expand-all'); const collapseBtn = $('#collapse-all');
  if(expandBtn && !expandBtn.dataset.wired){
    expandBtn.dataset.wired = '1';
    expandBtn.addEventListener('click', ()=>mount.querySelectorAll('details.group').forEach(d=>d.open=true));
  }
  if(collapseBtn && !collapseBtn.dataset.wired){
    collapseBtn.dataset.wired = '1';
    collapseBtn.addEventListener('click', ()=>mount.querySelectorAll('details.group').forEach(d=>d.open=false));
  }
}

/* ===== Validation ===== */
function validateMaskPrimers(step){
  const card = step.card;
  const variant = (card.querySelector('[name="variant"]')?.value || 'align').toLowerCase();
  if(variant === 'align' || variant === 'score'){
    const vbox = card.querySelector('input[name="v_primers_fname"]');
    const vFilled = vbox && vbox.value.trim().length > 0;
    const aux = (window.__SESSION_STATE__ && window.__SESSION_STATE__.aux) || {};
    const ok = vFilled || !!aux?.v_primers;
    return ok ? {ok:true,msg:'MaskPrimers primers: OK'} : {ok:false,msg:'MaskPrimers needs V primers (upload aux or fill filename).'};
  }
  return {ok:true,msg:'MaskPrimers extract: OK'};
}
function validateAssemble(step){
  const s = window.__SESSION_STATE__ || {};
  const needBoth = !!(step.unit.startsWith('assemble_'));
  if(needBoth){
    const haveR1 = !!(s.current && s.current.R1);
    const haveR2 = !!(s.current && s.current.R2);
    if(!(haveR1 && haveR2)){
      return {ok:false,msg:'AssemblePairs likely needs both R1 and R2 present (or run PairSeq).'};
    }
  }
  return {ok:true,msg:'AssemblePairs: basic check passed'};
}
function validateConsensus(step){
  return {ok:true,msg:'BuildConsensus: ensure BARCODE exists (MaskPrimers extract tag).'};
}

function validatePipeline(){
  const steps = selectedSteps();
  drawFlow();
  if(steps.length===0){ $('#validation').innerHTML = '<span class="warn">No steps selected.</span>'; return; }
  const msgs = [];
  let okAll = true;
  // Filter out any single-cell units that might have been added
  const bulkSteps = steps.filter(st => !(st.unit || '').startsWith('sc_'));
  if(bulkSteps.length !== steps.length){
    okAll = false;
    msgs.push(`<div class="err">• Single-cell units detected and removed from pipeline</div>`);
  }
  for(const st of bulkSteps){
    let res = {ok:true,msg:'OK'};
    if(st.unit === 'mask_primers') res = validateMaskPrimers(st);
    else if(st.unit.startsWith('assemble_')) res = validateAssemble(st);
    else if(st.unit === 'build_consensus') res = validateConsensus(st);
    okAll = okAll && res.ok;
    msgs.push(`<div class="${res.ok?'ok':'err'}">• ${esc(st.label)}: ${esc(res.msg)}</div>`);
  }
  $('#validation').innerHTML = msgs.join('') || '—';
  pipeMsg(okAll ? 'Validation passed' : 'Validation found issues', okAll ? 'ok' : 'warn');
}

/* ===== Run Pipeline ===== */
async function runPipeline(){
  if(PIPELINE_RUNNING) return;
  
  const steps = selectedSteps();
  const bulkSteps = steps.filter(st => !(st.unit || '').startsWith('sc_'));
  if(bulkSteps.length === 0){ pipeMsg('No bulk steps selected','warn'); return; }
  if(bulkSteps.length !== steps.length){
    pipeMsg('Single-cell units removed from pipeline','warn');
  }
  validatePipeline(); // show current validation info
  
  // Get current state to determine starting step index for this run
  try {
    const stateRes = await fetch(`/session/${SID}/state`);
    const state = await stateRes.json();
    // Set the starting step index to the next step (or 0 if no steps yet)
    CURRENT_RUN_START_STEP = (state.steps && state.steps.length > 0) 
      ? Math.max(...state.steps.map(s => s.step_index)) + 1 
      : 0;
  } catch(e) {
    CURRENT_RUN_START_STEP = 0;
  }
  
  // Clear read statistics at the start of a new pipeline run
  await updateReadStats(true);
  
  // Reset stop flag and set running state
  PIPELINE_STOP_REQUESTED = false;
  PIPELINE_RUNNING = true;
  
  // Update UI: show stop button, disable run button
  $('#pipe-run').style.display = 'none';
  $('#pipe-stop').style.display = '';
  $('#pipe-validate').disabled = true;
  $('#pipe-clear').disabled = true;
  
  setRunStatus('Starting…'); setProgress(0, bulkSteps.length);

  for(let i=0;i<bulkSteps.length;i++){
    // Check if stop was requested
    if(PIPELINE_STOP_REQUESTED){
      setRunStatus(`Stopped at step ${i}/${bulkSteps.length}`);
      pipeMsg('Pipeline stopped by user','warn');
      break;
    }
    
    const s = bulkSteps[i];
    setRunStatus(`Running <b>${esc(s.label)}</b> (${i+1}/${bulkSteps.length})`);
    const ok = await runUnit(s.card, s.unit);
    setProgress(i+1, bulkSteps.length);
    
    if(!ok){ 
      setRunStatus(`Failed at <b>${esc(s.label)}</b> (${i+1}/${bulkSteps.length})`); 
      pipeMsg('Pipeline failed','err'); 
      break;
    }
  }
  
  // Check if stopped before resetting flag
  const wasStopped = PIPELINE_STOP_REQUESTED;
  
  // Reset running state
  PIPELINE_RUNNING = false;
  PIPELINE_STOP_REQUESTED = false;
  
  // Update UI: hide stop button, enable run button
  $('#pipe-run').style.display = '';
  $('#pipe-stop').style.display = 'none';
  $('#pipe-validate').disabled = false;
  $('#pipe-clear').disabled = false;
  
  if(!wasStopped){
    setRunStatus('Finished ✅'); 
    pipeMsg('Pipeline finished','ok');
  }
  await updateReadStats(); // Final update of statistics
}

function stopPipeline(){
  if(!PIPELINE_RUNNING) return;
  PIPELINE_STOP_REQUESTED = true;
  setRunStatus('Stopping pipeline…');
  pipeMsg('Stopping pipeline…','warn');
}

/* ===== Wire up ===== */
document.addEventListener('DOMContentLoaded', () => {
  startSession();
  $('#upload')?.addEventListener('click', uploadReads);
  $('#upload-aux')?.addEventListener('click', uploadAux);
  $('#pipe-validate')?.addEventListener('click', validatePipeline);
  $('#pipe-run')?.addEventListener('click', runPipeline);
  $('#pipe-stop')?.addEventListener('click', stopPipeline);
  $('#pipe-clear')?.addEventListener('click', ()=>{
    if(PIPELINE_RUNNING){
      if(!confirm('Pipeline is running. Stop and clear?')) return;
      stopPipeline();
    }
    $$('.pipe-add').forEach(c=>c.checked=false);
    PIPELINE = [];
    drawFlow(); $('#validation').textContent='—'; pipeMsg('Pipeline cleared');
  });
});
