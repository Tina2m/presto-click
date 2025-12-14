// Single-Cell page with grouped accordions, search, and compact cards
let SID = null;
let UNITS_META = [];
let FLOW = []; // [{unitId,label,params}]
let running = false;
let CURRENT_RUN_START_STEP = null; // Track starting step index for current pipeline run
let STOP_REQUESTED = false; // Flag to stop pipeline execution
let LOG_EXPANDED = false;
let RUN_HISTORY = [];
let SELECTED_RUN_ID = null;
let CURRENT_RUN_ID = null;

const $  = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const esc = s => (s??'').toString().replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const FLOW_LABELS = {
  sc_merge_samples: 'Merge Samples',
  sc_filter_productive: 'Keep Productive Seqs',
  sc_remove_multi_heavy: 'Remove cells with Multiple IgH',
  sc_remove_no_heavy: 'Remove cells winth No IgH',
};
function cleanLabel(label=''){
  return label.replace(/^SC:\s*/i,'').trim();
}
function flowLabel(unitId, fallback){
  return FLOW_LABELS[unitId] || fallback;
}

// ----- Session (auto) -----
async function ensureSession(){
  if(SID) return SID;
  const r = await fetch('/session/start',{method:'POST'});
  const j = await r.json();
  SID = j.session_id;
  window.__SID__ = SID;      // keep accessible, not visible
  await refreshState();
  return SID;
}

// ----- Upload -----
async function uploadSCFiles(){
  await ensureSession();
  const files = $('#sc-files').files;
  if(!files || !files.length){ alert('Choose at least one file'); return; }
  $('#upload-msg').textContent = `Uploading ${files.length} file(s)…`;
  let ok = 0;
  for(const f of files){
    const fd = new FormData();
    fd.append('file', f);
    fd.append('name', f.name);
    const r = await fetch(`/session/${SID}/upload-aux`, {method:'POST', body:fd});
    if(r.ok) ok++;
  }
  $('#upload-msg').textContent = `Uploaded ${ok}/${files.length} files.`;
  listUploaded(files);
  await refreshState();
}
function listUploaded(fileList){
  const names = Array.from(fileList).map(f => esc(f.name));
  $('#uploaded-list').innerHTML = names.length ? 'Uploaded: ' + names.join(', ') : '';
}

// ----- Units rendering (grouped) -----
const GROUPS = [
  { id:'merge',    title:'I/O & Merge',       match:u => (u.id||'').includes('merge') },
  { id:'qc',       title:'QC & Filtering',    match:u => /(filter|remove)/.test(u.id||'') },
  { id:'other',    title:'Other',             match:u => true }
];
function groupOf(u){
  for(const g of GROUPS){ if(g.match(u)) return g.id; }
  return 'other';
}
function renderGroups(units){
  const wrap = $('#groups'); wrap.innerHTML = '';
  const buckets = Object.fromEntries(GROUPS.map(g=>[g.id, []]));
  units.forEach(u => buckets[groupOf(u)].push(u));

  for(const g of GROUPS){
    if(buckets[g.id].length === 0) continue;
    const container = document.createElement('div');
    container.className = 'unit-group open';
    container.dataset.group = g.id;
    container.innerHTML = `
      <div class="group-head" role="button" tabindex="0">
        <h3>${esc(g.title)}</h3>
        <span class="count">${buckets[g.id].length}</span>
      </div>
      <div class="group-body"></div>`;
    const body = container.querySelector('.group-body');
    buckets[g.id].forEach(u => body.appendChild(buildUnitCard(u)));
    // toggle
    const head = container.querySelector('.group-head');
    const toggle = () => container.classList.toggle('open');
    head.addEventListener('click', toggle);
    head.addEventListener('keypress', e => { if(e.key==='Enter' || e.key===' ') { e.preventDefault(); toggle(); }});
    wrap.appendChild(container);
  }
}

function buildUnitCard(u){
  const card = document.createElement('div');
  card.className = 'unit-card';
  card.dataset.unit = u.id;
  const displayLabel = cleanLabel(u.label || u.id);

  const requires = (u.requires||[]).map(x=>`<span class="pill">${esc(x)}</span>`).join(' ') || '<span class="muted">none</span>';
  let paramsHTML = '';
  for (const [k,v] of Object.entries(u.params_schema||{})) {
    const help = v.help ? ` <span class="muted">— ${esc(v.help)}</span>` : '';
    const label = `<label>${esc(k)}${help}</label>`;
    if (v.type === 'select') {
      const opts = (v.options||[]).map(o => `<option value="${esc(o)}" ${o===v.default?'selected':''}>${esc(o)}</option>`).join('');
      paramsHTML += `${label}<select name="${esc(k)}">${opts}</select>`;
    } else {
      const val = v.default ?? ''; const ph = v.placeholder ?? '';
      const t = (v.type === 'int' || v.type === 'number') ? 'number' : 'text';
      paramsHTML += `${label}<input type="${t}" name="${esc(k)}" value="${esc(val)}" placeholder="${esc(ph)}">`;
    }
  }

  card.innerHTML = `
    <div class="uc-head">
      <div class="uc-title">${esc(displayLabel)}</div>
      <div class="req">requires: ${requires}</div>
      <button class="params-toggle" title="Show/Hide parameters">Parameters</button>
    </div>
    <div class="params">
      <div class="params-wrap">${paramsHTML || '<div class="muted">No parameters</div>'}</div>
      <div class="row mt8">
        <button class="run">Run</button>
        <button class="secondary addflow">Add to pipeline</button>
      </div>
    </div>`;

  // Behavior
  const pwrap = card.querySelector('.params-wrap');
  card.querySelector('.params-toggle').addEventListener('click', ()=>{
    pwrap.classList.toggle('open');
  });
  card.querySelector('.run').addEventListener('click', ()=>runSingle(card, u.id, displayLabel));
  card.querySelector('.addflow').addEventListener('click', ()=>addToFlow(card, u.id, displayLabel));

  return card;
}

function collectParams(card){
  const params = {};
  card.querySelectorAll('input,select,textarea').forEach(el => {
    if(!el.name) return;
    if(el.type === 'file') return;
    params[el.name] = (el.type === 'checkbox') ? (el.checked ? 'true' : 'false') : el.value;
  });
  return params;
}

async function renderUnits(){
  await ensureSession();
  let all = [];
  try {
    const res = await fetch(`/session/${SID}/units?group=sc`);
    all = await res.json();
  } catch (e) {
    try {
      const res2 = await fetch(`/session/${SID}/units`);
      all = await res2.json();
    } catch (e2) { all = []; }
  }
  // filter SC
  UNITS_META = (all || []).filter(u => (u.group && u.group==='sc') || (u.id||'').startsWith('sc_') || (u.label||'').toLowerCase().startsWith('sc:'));
  renderGroups(UNITS_META);
}

// Search
function applySearch(){
  const q = ($('#unit-search').value || '').trim().toLowerCase();
  const cards = Array.from($$('.unit-card'));
  const groups = Array.from($$('.unit-group'));
  // per-card show/hide
  cards.forEach(c => {
    const unitId = (c.dataset.unit||'').toLowerCase();
    const title = (c.querySelector('.uc-title')?.textContent||'').toLowerCase();
    const req = (c.querySelector('.req')?.textContent||'').toLowerCase();
    const hay = [unitId,title,req].join(' ');
    const hit = !q || hay.includes(q);
    c.style.display = hit ? '' : 'none';
  });
  // hide empty groups
  groups.forEach(g => {
    const hasAny = Array.from(g.querySelectorAll('.unit-card')).some(c => c.style.display !== 'none');
    g.style.display = hasAny ? '' : 'none';
    // auto open groups when searching
    if(q && hasAny) g.classList.add('open');
  });
}

// Expand / Collapse all
function expandAll(){ $$('.unit-group').forEach(g=>g.classList.add('open')); }
function collapseAll(){ $$('.unit-group').forEach(g=>g.classList.remove('open')); }

// ----- Flow builder -----
function addToFlow(card, unitId, label){
  const params = collectParams(card);
  const flowTitle = flowLabel(unitId, label);
  FLOW.push({unitId, label, flowTitle, params});
  renderFlow();
}
function removeFromFlow(idx){
  FLOW.splice(idx,1);
  renderFlow();
}
async function runSingle(card, unitId, label){
  const params = collectParams(card);
  const btn = card.querySelector('.run');
  if(btn) btn.disabled = true;
  if(btn){
    btn.dataset.originalText = btn.textContent;
    btn.textContent = 'Running…';
  }
  try{
    await updateReadStats(true);
    const ok = await runUnit({unitId, label, params}, null);
    if(ok){
      $('#pstate').textContent = `Ran ${label}`;
    }
  }finally{
    if(btn) btn.disabled = false;
    if(btn && btn.dataset.originalText){
      btn.textContent = btn.dataset.originalText;
      delete btn.dataset.originalText;
    }
  }
}
function setLogExpanded(expanded){
  LOG_EXPANDED = expanded;
  const log = $('#log');
  const btn = $('#log-toggle');
  if(log){
    if(expanded) log.classList.remove('collapsed');
    else log.classList.add('collapsed');
  }
  if(btn){
    btn.textContent = expanded ? 'Collapse' : 'Expand';
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}
function toggleLog(){
  setLogExpanded(!LOG_EXPANDED);
}
function renderFlow(){
  const ul = $('#flow'); ul.innerHTML = '';
  if(FLOW.length === 0){
    ul.innerHTML = '<li class="muted">No steps yet. Use “Add to pipeline”.</li>';
  } else {
    FLOW.forEach((s,i)=>{
      const li = document.createElement('li');
      li.className = 'flow-item';
      const labelText = s.flowTitle || s.label;
      li.innerHTML = `<div class="flow-step">${i+1}</div>
                      <div class="flow-label" title="${esc(s.label)}">${esc(labelText)}</div>
                      <button class="flow-remove" title="Remove">✕</button>`;
      li.querySelector('.flow-remove').addEventListener('click', ()=>removeFromFlow(i));
      ul.appendChild(li);
    });
  }
  $('#validation').innerHTML = '-';
}

function serializeFlow(){
  return FLOW.map(step => ({
    unitId: step.unitId,
    label: step.label,
    flowTitle: step.flowTitle,
    params: JSON.parse(JSON.stringify(step.params || {})),
  }));
}

function hydrateFlowFromPipeline(pipeline){
  const cloned = (pipeline || []).map(step => {
    const unitId = step.unitId || step.unit || '';
    const baseLabel = step.label || step.flowTitle || unitId;
    return {
      unitId,
      label: baseLabel,
      flowTitle: step.flowTitle || baseLabel,
      params: JSON.parse(JSON.stringify(step.params || {})),
    };
  });
  FLOW = cloned;
  renderFlow();
}

// ----- Validation & run -----
function validateFlow(){
  if(FLOW.length === 0){
    $('#validation').innerHTML = `<span class="pill err">Empty flow</span> Add steps with “Add to pipeline”.`;
    return {ok:false, msgs:['Empty flow']};
  }
  const msgs = [];
  let ok = true;

  const idxMerge = FLOW.findIndex(s=>s.unitId==='sc_merge_samples');
  if(idxMerge > 0){
    msgs.push('Suggestion: Place “Merge samples” first for efficiency (optional).');
  }

  const idxMH = FLOW.findIndex(s=>s.unitId==='sc_remove_multi_heavy');
  const idxNH = FLOW.findIndex(s=>s.unitId==='sc_remove_no_heavy');
  if(idxMH !== -1 && idxNH !== -1 && idxMH > idxNH){
    msgs.push('Suggestion: Run “Remove multi heavy” before “Remove no heavy” (optional).');
  }

  const nonSC = FLOW.filter(s=>!s.unitId.startsWith('sc_'));
  if(nonSC.length){
    ok = false;
    msgs.push('Invalid step detected (non single-cell unit). Please remove it.');
  }

  const head = ok ? '<span class="pill ok">Looks good</span>' : '<span class="pill err">Problems found</span>';
  $('#validation').innerHTML = head + (msgs.length? ('<div class="mt8">'+msgs.map(esc).join('<br>')+'</div>') : '');
  return {ok, msgs};
}

async function runFlow(){
  if(running) return;
  const v = validateFlow();
  if(!v.ok){
    alert('Please fix flow issues and try again.');
    return;
  }

  const runId = (crypto?.randomUUID ? crypto.randomUUID() : `run-${Date.now()}`);
  const runLabel = `Run ${new Date().toLocaleString()}`;
  CURRENT_RUN_ID = runId;
  const pipelineSnapshot = serializeFlow();
  try{
    await fetch(`/session/${SID}/run/start`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({run_id: runId, label: runLabel, reset_sc_table: true, pipeline: pipelineSnapshot})
    });
  }catch(e){
    console.warn('Failed to register run', e);
  }

  try {
    const stateRes = await fetch(`/session/${SID}/state`);
    const state = await stateRes.json();
    CURRENT_RUN_START_STEP = (state.steps && state.steps.length > 0) 
      ? Math.max(...state.steps.map(s => s.step_index)) + 1 
      : 0;
  } catch(e) {
    CURRENT_RUN_START_STEP = 0;
  }
  
  await updateReadStats(true);
  STOP_REQUESTED = false;
  running = true;
  
  $('#runflow').style.display = 'none';
  $('#stopflow').style.display = '';
  $('#validate').disabled = true;
  $('#clearflow').disabled = true;
  
  $('#pstate').textContent = `starting (${FLOW.length} steps)…`;
  for(let i=0;i<FLOW.length;i++){
    if(STOP_REQUESTED){
      $('#pstate').textContent = `stopped at step ${i}/${FLOW.length}`;
      break;
    }
    
    const s = FLOW[i];
    $('#pstate').textContent = `running step ${i+1}/${FLOW.length}: ${s.label}`;
    const ok = await runUnit(s, runId);
    if(!ok){
      $('#pstate').textContent = `failed at step ${i+1}: ${s.label}`;
      break;
    }
  }
  
  const wasStopped = STOP_REQUESTED;
  running = false;
  STOP_REQUESTED = false;
  
  $('#runflow').style.display = '';
  $('#stopflow').style.display = 'none';
  $('#validate').disabled = false;
  $('#clearflow').disabled = false;
  
  if(!wasStopped){
    $('#pstate').textContent = 'finished ✓';
  }
  await updateReadStats(); // Final update of statistics
  CURRENT_RUN_ID = null;
}

function stopFlow(){
  if(!running) return;
  STOP_REQUESTED = true;
  $('#pstate').textContent = 'stopping…';
}

async function runUnit(step, runId = null){
  await ensureSession();
  try{
    const r = await fetch(`/session/${SID}/run`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ unit_id: step.unitId, params: step.params, run_id: runId })
    });
    const j = await r.json();
    if(!r.ok){
      const detail = (j.detail && (j.detail.error || j.detail)) || r.statusText;
      alert(`Error: ${detail}`);
      const logEl = $('#log');
      if(logEl) {
        const errorLog = (j.detail && j.detail.log_tail) ? j.detail.log_tail : '';
        logEl.innerHTML = (logEl.innerHTML || '') + 
          `<div style="border-top:2px solid var(--err);padding-top:8px;margin-top:8px;color:var(--err);font-weight:600">❌ Error in step: ${esc(step.label)}</div>` +
          `<pre style="background:#fef2f2;border-color:#fecaca">${esc(errorLog)}</pre>`;
        logEl.scrollTop = logEl.scrollHeight;
      setLogExpanded(true);
      }
      return false;
    }
    await refreshState();
    await updateReadStats(); // Update statistics after each step
    const stepIdx = j.step.step_index;
    const lr = await fetch(`/session/${SID}/log/${stepIdx}`);
    const logText = await lr.text();
    const logEl = $('#log');
    if(logEl) {
      // Append new log with separator
      const separator = logEl.innerHTML ? '<div style="border-top:2px solid var(--border);padding-top:8px;margin-top:12px"></div>' : '';
      logEl.innerHTML = (logEl.innerHTML || '') + 
        separator +
        `<div style="color:var(--accent);font-weight:600;margin-bottom:4px">Step ${stepIdx}: ${esc(step.label)}</div>` +
        `<pre>${esc(logText)}</pre>`;
      // Auto-scroll to bottom
      logEl.scrollTop = logEl.scrollHeight;
      setLogExpanded(true);
    }
    return true;
  }catch(e){
    alert('Network error running step: '+e);
    return false;
  }
}

// ----- State / artifacts -----
async function refreshState(){
  if(!SID) return;
  const r = await fetch(`/session/${SID}/state`);
  const s = await r.json();
  const chips = Object.entries(s.current||{}).map(([k,v]) => `<span class="pill">${esc(k)}: ${esc(v)}</span>`).join(' ');
  $('#statebox').innerHTML = chips || '<span class="muted">no state</span>';
  await updateReadStats(); // Update statistics visualization
}

/* ===== Read Statistics Visualization ===== */
  function formatNumber(num){
    if(num === null || num === undefined || Number.isNaN(num)) return '--';
    if(num >= 1000000) return (num/1000000).toFixed(3).replace(/\.?0+$/, '') + 'M';
    if(num >= 1000) return (num/1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return num.toString();
  }
  function formatRunTimestamp(ts){
    if(!ts) return '';
    const d = new Date(ts * 1000);
    if(Number.isNaN(d.getTime())) return '';
    return d.toLocaleString();
  }
  
  async function updateReadStats(clearFirst = false){
    const statsContainer = $('#read-stats');
    const historyContainer = $('#run-history');
    const pipelineContainer = $('#run-pipeline');
    const artifactContainer = $('#run-artifacts');
    if(!statsContainer){
      console.warn('read-stats container not found');
      return;
    }
  
    if(clearFirst){
      statsContainer.innerHTML = '<span class=\"muted\">Running pipeline...</span>';
      if(pipelineContainer){
        pipelineContainer.innerHTML = '<span class=\"muted\">Pipeline pending...</span>';
      }
      if(artifactContainer){
        artifactContainer.innerHTML = '<span class=\"muted\">Results pending...</span>';
      }
      return;
    }
  
    if(!SID){
      statsContainer.innerHTML = '<span class=\"muted\">No statistics available yet. Run pipeline steps to see read counts.</span>';
      if(historyContainer) historyContainer.innerHTML = '<span class=\"muted\">No runs yet.</span>';
      if(pipelineContainer) pipelineContainer.innerHTML = '<span class=\"muted\">No pipeline captured yet.</span>';
      if(artifactContainer) artifactContainer.innerHTML = '<span class=\"muted\">No results captured yet.</span>';
      return;
    }
  
    try{
      const r = await fetch(`/session/${SID}/stats`);
      if(!r.ok) throw new Error('Unable to fetch stats');
      const data = await r.json();
      RUN_HISTORY = Array.isArray(data.runs) ? data.runs : [];
  
      if(!RUN_HISTORY.length){
        SELECTED_RUN_ID = null;
        statsContainer.innerHTML = '<span class=\"muted\">No statistics available yet. Run pipeline steps to see read counts.</span>';
        if(historyContainer) historyContainer.innerHTML = '<span class=\"muted\">No completed runs yet.</span>';
        if(pipelineContainer) pipelineContainer.innerHTML = '<span class=\"muted\">No pipeline captured yet.</span>';
        if(artifactContainer) artifactContainer.innerHTML = '<span class=\"muted\">No results captured yet.</span>';
        return;
      }
  
      const hasSelected = RUN_HISTORY.some(run => run.id === SELECTED_RUN_ID);
      if(CURRENT_RUN_ID && RUN_HISTORY.some(run => run.id === CURRENT_RUN_ID)){
        SELECTED_RUN_ID = CURRENT_RUN_ID;
      } else if(!hasSelected){
        SELECTED_RUN_ID = RUN_HISTORY[0].id;
      }
  
    renderRunHistory();
    renderSelectedRunStats();
    renderSelectedRunPipeline();
    renderSelectedRunArtifacts();
    }catch(e){
      const msg = e?.message || e.toString();
      statsContainer.innerHTML = '<span class=\"muted\">Statistics unavailable: ' + esc(msg) + '</span>';
      if(historyContainer) historyContainer.innerHTML = '<span class=\"muted\">History unavailable.</span>';
      if(pipelineContainer) pipelineContainer.innerHTML = '<span class=\"muted\">Pipeline unavailable.</span>';
      if(artifactContainer) artifactContainer.innerHTML = '<span class=\"muted\">Results unavailable.</span>';
    }
  }
  
  function renderRunHistory(){
    const wrap = $('#run-history');
    if(!wrap) return;
  
    if(!RUN_HISTORY.length){
      wrap.innerHTML = '<span class=\"muted\">No runs yet.</span>';
      return;
    }
  
    wrap.innerHTML = '';
    RUN_HISTORY.forEach(run => {
      const item = document.createElement('div');
      item.className = 'run-history-item' + (run.id === SELECTED_RUN_ID ? ' active' : '');
      item.tabIndex = 0;
      const label = esc(run.label || 'Run');
      const created = formatRunTimestamp(run.created);
      const steps = (run.steps || []).length;
      const hasInitial = run.initial_reads !== null && run.initial_reads !== undefined;
      const reads = hasInitial ? `${formatNumber(run.initial_reads)} initial reads` : 'Reads pending';
      const metaParts = [`${steps} step${steps === 1 ? '' : 's'}`];
      if(created) metaParts.push(created);
  
      item.innerHTML = `
        <div><strong>${label}</strong></div>
        <small>${esc(metaParts.join(' * '))}</small>
        <small>${esc(reads)}</small>
      `;
  
      item.addEventListener('click', () => {
        if(SELECTED_RUN_ID === run.id) return;
        SELECTED_RUN_ID = run.id;
        renderRunHistory();
        renderSelectedRunStats();
        renderSelectedRunPipeline();
        renderSelectedRunArtifacts();
      });
      item.addEventListener('keypress', e => {
        if(e.key === 'Enter' || e.key === ' '){
          e.preventDefault();
          item.click();
        }
      });
      wrap.appendChild(item);
    });
  }
  
function renderSelectedRunStats(){
  const container = $('#read-stats');
  if(!container) return;
    if(!RUN_HISTORY.length){
      container.innerHTML = '<span class=\"muted\">No statistics available.</span>';
      return;
    }
  
    const run = RUN_HISTORY.find(r => r.id === SELECTED_RUN_ID) || RUN_HISTORY[0];
    const runPipeline = resolvePipeline(run);
    const pipelineMap = new Map();
    runPipeline.forEach((step, idx) => {
      if(step.unitId){ pipelineMap.set(step.unitId, step.flowTitle || step.label || `Step ${idx+1}`); }
    });
    if(!run || !run.steps || run.steps.length === 0){
      container.innerHTML = '<span class=\"muted\">No statistics recorded yet for this run.</span>';
      return;
    }
  
    let initialReads = run.initial_reads;
    if((initialReads === null || initialReads === undefined) && run.steps[0]){
      const first = run.steps[0];
      if(first.input !== null && first.input !== undefined){
        initialReads = first.input;
      }else if(first.pass !== null && first.pass !== undefined){
        initialReads = first.pass;
      }
    }
    if(initialReads === null || initialReads === undefined){
      container.innerHTML = '<span class=\"muted\">Waiting for initial read count...</span>';
      return;
    }
    const positiveInitial = initialReads > 0;
  
    const chart = document.createElement('div');
    chart.className = 'funnel-chart';
  
    const firstBar = document.createElement('div');
    firstBar.className = 'funnel-bar initial';
    firstBar.style.width = '100%';
    firstBar.innerHTML = `
      <div class=\"funnel-bar-label\">Total reads</div>
      <div class=\"funnel-bar-value\">${formatNumber(initialReads)}</div>
      <div class=\"funnel-bar-percentage\">${positiveInitial ? '100%' : '0%'}</div>
    `;
    chart.appendChild(firstBar);
  
    if(run.steps.length){
      const sep = document.createElement('div');
      sep.className = 'funnel-separator';
      chart.appendChild(sep);
    }
  
    run.steps.forEach((step, idx) => {
      const passCount = (step.pass !== null && step.pass !== undefined) ? step.pass : null;
      if(passCount === null || passCount === undefined) return;
  
      const bar = document.createElement('div');
      bar.className = 'funnel-bar filter';
      const percentage = positiveInitial ? Math.round((passCount / initialReads) * 100) : (passCount > 0 ? 100 : 0);
      const widthPercent = positiveInitial ? Math.max(15, (passCount / initialReads) * 100) : 15;
      bar.style.width = widthPercent + '%';
  
    let label = cleanLabel(step.label || step.unit);
    const pipelineLabel = pipelineMap.get(step.unit);
    if(pipelineLabel){
      label = cleanLabel(pipelineLabel);
    } else if(idx < runPipeline.length){
      label = cleanLabel(runPipeline[idx].flowTitle || runPipeline[idx].label || label);
    }
    if(label.length > 30) label = label.slice(0, 27) + '...';

      bar.innerHTML = `
        <div class=\"funnel-bar-label\">${esc(label)}</div>
        <div class=\"funnel-bar-value\">passed ${formatNumber(passCount)}</div>
        <div class=\"funnel-bar-percentage\">${percentage}%</div>
      `;
      chart.appendChild(bar);
  
      if(idx < run.steps.length - 1){
        const sep = document.createElement('div');
        sep.className = 'funnel-separator';
        chart.appendChild(sep);
      }
    });
  
    const meta = document.createElement('div');
    meta.className = 'run-stats-meta';
    const created = formatRunTimestamp(run.created);
    const metaParts = [`${(run.steps || []).length} step${run.steps.length === 1 ? '' : 's'}`];
    if(created) metaParts.push(created);
    meta.innerHTML = `
      <strong>${esc(run.label || 'Run')}</strong>
      <span>${esc(metaParts.join(' * '))}</span>
    `;
  
  container.innerHTML = '';
  container.appendChild(meta);
  container.appendChild(chart);
}

function resolvePipeline(run){
  if(!run) return [];
  if(Array.isArray(run.pipeline) && run.pipeline.length){
    return run.pipeline;
  }
  const steps = run.steps || [];
  return steps.map((step, idx) => ({
    unitId: step.unit,
    label: cleanLabel(step.label || step.unit || `Step ${idx+1}`),
    flowTitle: cleanLabel(step.label || step.unit || `Step ${idx+1}`),
    params: {},
  }));
}

function renderSelectedRunPipeline(){
  if(!RUN_HISTORY.length){
    hydrateFlowFromPipeline([]);
    const container = $('#run-pipeline');
    if(container){
      container.innerHTML = '<span class="muted">No runs yet.</span>';
    }
    return;
  }
  const run = RUN_HISTORY.find(r => r.id === SELECTED_RUN_ID) || RUN_HISTORY[0];
  const pipeline = resolvePipeline(run);
  hydrateFlowFromPipeline(pipeline);
  const container = $('#run-pipeline');
  if(!container){
    return;
  }
  if(!pipeline.length){
    container.innerHTML = '<span class="muted">Pipeline not captured for this run.</span>';
    return;
  }
  container.innerHTML = '';
  pipeline.forEach((step, idx) => {
    const item = document.createElement('div');
    item.className = 'pipeline-step';
    const label = step.flowTitle || step.label || step.unitId || `Step ${idx+1}`;
    const unitId = step.unitId || '';
    item.innerHTML = `
      <span class="pipeline-index">${idx+1}</span>
      <div class="pipeline-info">
        <div class="pipeline-label">${esc(label)}</div>
        <div class="pipeline-unit">${esc(unitId)}</div>
      </div>
    `;
    container.appendChild(item);
  });
}

function renderSelectedRunArtifacts(){
  const container = $('#run-artifacts');
  if(!container){
    return;
  }
  if(!RUN_HISTORY.length){
    container.innerHTML = '<span class="muted">No runs yet.</span>';
    return;
  }
  const run = RUN_HISTORY.find(r => r.id === SELECTED_RUN_ID) || RUN_HISTORY[0];
  const artifacts = Array.isArray(run?.artifacts) ? run.artifacts : [];
  if(!artifacts.length){
    container.innerHTML = '<span class="muted">No results captured for this run.</span>';
    return;
  }
  container.innerHTML = '';
  artifacts.forEach(art => {
    const item = document.createElement('div');
    item.className = 'artifact-item';
    const label = cleanLabel(art.label || art.name);
    const url = `/session/${SID}/download/${encodeURIComponent(art.name)}`;
    item.innerHTML = `
      <div class="artifact-info">
        <div class="artifact-label">${esc(label)}</div>
        <div class="artifact-meta">${esc(art.kind || '')}</div>
      </div>
      <a href="${url}" target="_blank" rel="noopener">download</a>
    `;
    container.appendChild(item);
  });
}
// ----- Init -----
document.addEventListener('DOMContentLoaded', async () => {
  // wire buttons
  $('#upload-sc').addEventListener('click', uploadSCFiles);
  $('#validate').addEventListener('click', validateFlow);
  $('#runflow').addEventListener('click', runFlow);
  $('#stopflow').addEventListener('click', stopFlow);
  $('#clearflow').addEventListener('click', ()=>{ 
    if(running){
      if(!confirm('Pipeline is running. Stop and clear?')) return;
      stopFlow();
    }
    FLOW=[]; 
    renderFlow(); 
    $('#validation').textContent='—'; 
    $('#pstate').textContent='idle';
    // Clear accumulated logs
    const logEl = $('#log');
    if(logEl) logEl.innerHTML = '';
    // Reset run start step
    CURRENT_RUN_START_STEP = null;
    // Clear statistics
    updateReadStats(true);
  });
  $('#unit-search').addEventListener('input', applySearch);
  $('#expAll').addEventListener('click', expandAll);
  $('#colAll').addEventListener('click', collapseAll);
  const logToggle = $('#log-toggle');
  if(logToggle) logToggle.addEventListener('click', toggleLog);
  setLogExpanded(false);

  await ensureSession();
  await renderUnits();
  applySearch(); // initialize
  await updateReadStats(); // Initialize read statistics display
});



