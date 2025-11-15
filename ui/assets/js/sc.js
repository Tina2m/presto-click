// Single-Cell page with grouped accordions, search, and compact cards
let SID = null;
let UNITS_META = [];
let FLOW = []; // [{unitId,label,params}]
let running = false;
let CURRENT_RUN_START_STEP = null; // Track starting step index for current pipeline run
let STOP_REQUESTED = false; // Flag to stop pipeline execution

const $  = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const esc = s => (s??'').toString().replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

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
      <div class="uc-title">${esc(u.label)}</div>
      <div class="req">requires: ${requires}</div>
      <button class="params-toggle" title="Show/Hide parameters">Parameters</button>
    </div>
    <div class="params">
      <div class="params-wrap">${paramsHTML || '<div class="muted">No parameters</div>'}</div>
      <div class="row mt8">
        <button class="run">Run</button>
        <button class="secondary addflow">Add to flow</button>
      </div>
    </div>`;

  // Behavior
  const pwrap = card.querySelector('.params-wrap');
  card.querySelector('.params-toggle').addEventListener('click', ()=>{
    pwrap.classList.toggle('open');
  });
  card.querySelector('.run').addEventListener('click', ()=>runSingle(card, u.id, u.label));
  card.querySelector('.addflow').addEventListener('click', ()=>addToFlow(card, u.id, u.label));

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
  FLOW.push({unitId, label, params});
  renderFlow();
}
function removeFromFlow(idx){
  FLOW.splice(idx,1);
  renderFlow();
}
function renderFlow(){
  const ul = $('#flow'); ul.innerHTML = '';
  if(FLOW.length === 0){
    ul.innerHTML = '<li class="muted">No steps yet. Use “Add to flow”.</li>';
  } else {
    FLOW.forEach((s,i)=>{
      const li = document.createElement('li');
      li.className = 'flow-item';
      li.innerHTML = `<div class="flow-step">${i+1}</div>
                      <div class="flow-label">${esc(s.label)} <span class="muted">(${esc(s.unitId)})</span></div>
                      <button class="flow-remove" title="Remove">✕</button>`;
      li.querySelector('.flow-remove').addEventListener('click', ()=>removeFromFlow(i));
      ul.appendChild(li);
    });
  }
  $('#validation').innerHTML = '—';
}

// ----- Validation & run -----
function validateFlow(){
  if(FLOW.length === 0){
    $('#validation').innerHTML = `<span class="pill err">Empty flow</span> Add steps with “Add to flow”.`;
    return {ok:false, msgs:['Empty flow']};
  }
  const msgs = [];
  let ok = true;

  const idxMerge = FLOW.findIndex(s=>s.unitId==='sc_merge_samples');
  if(idxMerge > 0){
    msgs.push('Suggestion: Place “SC: Merge samples” first for efficiency (optional).');
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
  STOP_REQUESTED = false;
  running = true;
  
  // Update UI: show stop button, disable run button
  $('#runflow').style.display = 'none';
  $('#stopflow').style.display = '';
  $('#validate').disabled = true;
  $('#clearflow').disabled = true;
  
  $('#pstate').textContent = `starting (${FLOW.length} steps)…`;
  for(let i=0;i<FLOW.length;i++){
    // Check if stop was requested
    if(STOP_REQUESTED){
      $('#pstate').textContent = `stopped at step ${i}/${FLOW.length}`;
      break;
    }
    
    const s = FLOW[i];
    $('#pstate').textContent = `running step ${i+1}/${FLOW.length}: ${s.label}`;
    const ok = await runUnit(s);
    if(!ok){
      $('#pstate').textContent = `failed at step ${i+1}: ${s.label}`;
      break;
    }
  }
  
  // Check if stopped before resetting flag
  const wasStopped = STOP_REQUESTED;
  
  // Reset running state
  running = false;
  STOP_REQUESTED = false;
  
  // Update UI: hide stop button, enable run button
  $('#runflow').style.display = '';
  $('#stopflow').style.display = 'none';
  $('#validate').disabled = false;
  $('#clearflow').disabled = false;
  
  if(!wasStopped){
    $('#pstate').textContent = 'finished ✓';
  }
  await updateReadStats(); // Final update of statistics
}

function stopFlow(){
  if(!running) return;
  STOP_REQUESTED = true;
  $('#pstate').textContent = 'stopping…';
}

async function runUnit(step){
  await ensureSession();
  try{
    const r = await fetch(`/session/${SID}/run`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ unit_id: step.unitId, params: step.params })
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
  const arts = Object.values(s.artifacts||{}).map(a =>
    `<div>${esc(a.name)} — <a href="/session/${SID}/download/${encodeURIComponent(a.name)}">download</a></div>`
  ).join('');
  $('#arts').innerHTML = arts || '<span class="muted">none</span>';
  await updateReadStats(); // Update statistics visualization
}

/* ===== Read Statistics Visualization ===== */
function formatNumber(num){
  if(!num && num !== 0) return '—';
  if(num >= 1000000) return (num/1000000).toFixed(3).replace(/\.?0+$/, '') + 'M';
  if(num >= 1000) return (num/1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return num.toString();
}

async function updateReadStats(clearFirst = false){
  if(!SID) {
    // If no session yet, show placeholder
    const container = $('#read-stats');
    if(container) {
      container.innerHTML = '<span class="muted">No statistics available yet. Run pipeline steps to see read counts.</span>';
    }
    return;
  }
  const container = $('#read-stats');
  if(!container) {
    console.warn('read-stats container not found');
    return;
  }
  
  // Clear container if requested (e.g., at start of new pipeline run)
  if(clearFirst) {
    container.innerHTML = '<span class="muted">Running pipeline...</span>';
    return;
  }
  
  try{
    const r = await fetch(`/session/${SID}/stats`);
    if(!r.ok) {
      console.error('Failed to fetch stats:', r.status, r.statusText);
      container.innerHTML = '<span class="muted">Failed to load statistics</span>';
      return;
    }
    const data = await r.json();
    console.log('Stats data received:', data);
    
    if(!data.steps || data.steps.length === 0){
      container.innerHTML = '<span class="muted">No statistics available yet. Run pipeline steps to see read counts.</span>';
      return;
    }
    
    // Filter to only show steps from the current pipeline run
    let filteredSteps = data.steps;
    if(CURRENT_RUN_START_STEP !== null) {
      filteredSteps = data.steps.filter(step => step.step_index >= CURRENT_RUN_START_STEP);
      console.log('Filtered steps:', filteredSteps, 'from start step:', CURRENT_RUN_START_STEP);
    }
    
    if(filteredSteps.length === 0){
      container.innerHTML = '<span class="muted">No statistics available yet. Run pipeline steps to see read counts.</span>';
      return;
    }
    
    // Get initial reads from the first step of current run
    const firstStep = filteredSteps[0];
    // For SC units, try to get initial from first step's pass count if no input
    let initialReads = firstStep?.input || firstStep?.total || data.initial_reads;
    // If still no initial reads, use the first step's pass count as baseline
    if(!initialReads && firstStep?.pass) {
      initialReads = firstStep.pass;
    }
    console.log('Initial reads:', initialReads, 'from first step:', firstStep);
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
    console.log('Statistics chart rendered successfully');
  }catch(e){
    console.error('Failed to update read stats:', e);
    container.innerHTML = '<span class="muted">Statistics unavailable: ' + esc(e.message) + '</span>';
  }
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

  await ensureSession();
  await renderUnits();
  applySearch(); // initialize
  await updateReadStats(); // Initialize read statistics display
});
