// Meta Ads-style date picker with cross-page sync.
//
// Usage: `<script src="/js/date-picker.js"></script>` + a button element:
//   DatePicker.mount(document.getElementById('datePickerBtn'), {
//     syncInputs: true,  // also writes to #dateFrom / #dateTo hidden inputs
//     onChange: () => loadData(),
//   });
//
// State persists in localStorage under `ab_panel_date` so every page of the
// dashboard sees the same selection. Cross-tab sync via the `storage` event.
(function(){
const STYLE_ID = 'ab-date-picker-style';
const STORAGE_KEY = 'ab_panel_date';
const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const DOW_ES = ['L','M','X','J','V','S','D'];

function pad(n){return String(n).padStart(2,'0')}
function fmt(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
function parse(s){return new Date(s+'T00:00:00')}
function todayStr(){return fmt(new Date())}
function daysAgoStr(n){const d=new Date();d.setDate(d.getDate()-n);return fmt(d)}
function startOfWeek(){const d=new Date();const dow=d.getDay()||7;d.setDate(d.getDate()-(dow-1));return fmt(d)}
function lastWeekStart(){const d=parse(startOfWeek());d.setDate(d.getDate()-7);return fmt(d)}
function lastWeekEnd(){const d=parse(startOfWeek());d.setDate(d.getDate()-1);return fmt(d)}
function startOfMonth(){const d=new Date();d.setDate(1);return fmt(d)}
function lastMonthStart(){const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-1);return fmt(d)}
function lastMonthEnd(){const d=new Date();d.setDate(0);return fmt(d)}

const PRESETS = [
  { key:'today',     label:'Hoy',             from: todayStr,           to: todayStr },
  { key:'yesterday', label:'Ayer',            from: ()=>daysAgoStr(1),  to: ()=>daysAgoStr(1) },
  { key:'7d',        label:'Últimos 7 días',  from: ()=>daysAgoStr(6),  to: todayStr },
  { key:'14d',       label:'Últimos 14 días', from: ()=>daysAgoStr(13), to: todayStr },
  { key:'30d',       label:'Últimos 30 días', from: ()=>daysAgoStr(29), to: todayStr },
  { key:'week',      label:'Esta semana',     from: startOfWeek,        to: todayStr },
  { key:'lastweek',  label:'Semana pasada',   from: lastWeekStart,      to: lastWeekEnd },
  { key:'month',     label:'Este mes',        from: startOfMonth,       to: todayStr },
  { key:'lastmonth', label:'Mes pasado',      from: lastMonthStart,     to: lastMonthEnd },
  { key:'all',       label:'Máximo',          from: ()=>'2020-01-01',   to: todayStr },
];

function load(){
  try { const raw = localStorage.getItem(STORAGE_KEY); if(raw) return JSON.parse(raw); } catch {}
  return { preset:'7d' };
}
function save(s){ localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) }

function shortFmt(s){
  if(!s) return '';
  const d = parse(s);
  return d.getDate()+' '+MONTHS_ES[d.getMonth()].slice(0,3).toLowerCase();
}

function resolve(state){
  if(state && state.preset && state.preset !== 'custom'){
    const p = PRESETS.find(x => x.key === state.preset);
    if(p){ const from = p.from(), to = p.to();
      return { from, to, label: p.label + ' · ' + shortFmt(from) + ' — ' + shortFmt(to), preset: p.key };
    }
  }
  if(state && state.from && state.to){
    return { from: state.from, to: state.to, label: shortFmt(state.from) + ' — ' + shortFmt(state.to), preset: 'custom' };
  }
  return { from: daysAgoStr(6), to: todayStr(), label: 'Últimos 7 días · ' + shortFmt(daysAgoStr(6)) + ' — ' + shortFmt(todayStr()), preset: '7d' };
}

function injectStyles(){
  if(document.getElementById(STYLE_ID)) return;
  const css = `
  .adp-btn{padding:7px 14px;border-radius:8px;border:1px solid #2a2a3e;background:#111122;color:#e0e0e0;font-size:12px;font-weight:600;font-family:'Inter',system-ui,sans-serif;cursor:pointer;display:inline-flex;align-items:center;gap:10px;transition:all .15s}
  .adp-btn:hover{background:#1a1a2e;border-color:#3a3a5e}
  .adp-btn .adp-icon{opacity:0.6;font-size:14px}
  .adp-btn .adp-label{color:#fff;font-weight:700}
  .adp-btn .adp-caret{color:#666;font-size:9px;margin-left:2px}
  .adp-overlay{position:fixed;inset:0;z-index:99;background:transparent}
  .adp-pop{position:absolute;background:#0d0d1a;border:1px solid #2a2a3e;border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,0.7);padding:16px;z-index:100;font-family:'Inter',system-ui,sans-serif;color:#e0e0e0;min-width:540px}
  .adp-pop .adp-cols{display:grid;grid-template-columns:170px 1fr;gap:18px}
  .adp-presets{display:flex;flex-direction:column;gap:2px}
  .adp-preset{background:none;border:none;color:#aaa;font-size:12px;font-weight:600;font-family:inherit;padding:8px 12px;text-align:left;border-radius:6px;cursor:pointer;transition:all .1s}
  .adp-preset:hover{background:#1a1a2e;color:#fff}
  .adp-preset.active{background:#8b5cf6;color:#fff}
  .adp-cal{min-width:280px}
  .adp-cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  .adp-cal-head button{background:#1a1a2e;border:1px solid #2a2a3e;color:#aaa;width:28px;height:28px;border-radius:6px;font-size:12px;cursor:pointer;font-weight:700;font-family:inherit}
  .adp-cal-head button:hover{background:#2a2a3e;color:#fff}
  .adp-cal-head .adp-month{font-size:13px;font-weight:800;color:#fff;letter-spacing:0.3px}
  .adp-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
  .adp-dow{font-size:10px;font-weight:700;color:#555;text-align:center;padding:4px 0;letter-spacing:1px}
  .adp-day{font-size:12px;font-weight:600;color:#aaa;text-align:center;padding:7px 0;border-radius:5px;cursor:pointer;background:transparent;user-select:none}
  .adp-day:hover{background:#1a1a2e;color:#fff}
  .adp-day.out{color:#222;background:transparent;cursor:default}
  .adp-day.in-range{background:rgba(139,92,246,0.15);color:#fff}
  .adp-day.range-start,.adp-day.range-end{background:#8b5cf6;color:#fff;font-weight:800}
  .adp-day.today{outline:1px solid rgba(139,92,246,0.5)}
  .adp-footer{display:flex;align-items:center;gap:8px;padding-top:14px;margin-top:14px;border-top:1px solid #1a1a2e}
  .adp-footer input[type="date"]{background:#111122;border:1px solid #2a2a3e;color:#e0e0e0;padding:6px 10px;border-radius:6px;font-size:12px;font-family:inherit}
  .adp-footer input[type="date"]::-webkit-calendar-picker-indicator{filter:invert(0.7)}
  .adp-footer .sep{color:#555;font-size:12px}
  .adp-footer button{padding:7px 16px;border-radius:6px;border:none;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
  .adp-footer .adp-cancel{background:#1a1a2e;color:#aaa;border:1px solid #2a2a3e;margin-left:auto}
  .adp-footer .adp-cancel:hover{background:#2a2a3e;color:#fff}
  .adp-footer .adp-apply{background:#8b5cf6;color:#fff}
  .adp-footer .adp-apply:hover{background:#7c3aed}
  @media(max-width:720px){
    .adp-pop{min-width:0;width:calc(100vw - 24px);max-width:420px}
    .adp-pop .adp-cols{grid-template-columns:1fr}
    .adp-presets{flex-direction:row;flex-wrap:wrap;max-height:none}
    .adp-preset{flex:0 0 auto}
  }
  `;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = css;
  document.head.appendChild(s);
}

let activePopover = null;

function closePopover(){
  if(activePopover){
    activePopover.pop.remove();
    activePopover.overlay.remove();
    activePopover = null;
  }
}

function openPopover(button, cfg){
  closePopover();
  const initial = resolve(load());
  let tempFrom = initial.from, tempTo = initial.to;
  let selectedPreset = initial.preset;
  let calMonth = parse(tempTo); calMonth.setDate(1);

  const overlay = document.createElement('div');
  overlay.className = 'adp-overlay';
  overlay.onclick = closePopover;
  document.body.appendChild(overlay);

  const pop = document.createElement('div');
  pop.className = 'adp-pop';
  document.body.appendChild(pop);

  function renderCalHtml(){
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    const monthName = MONTHS_ES[m] + ' ' + y;
    const firstDow = (new Date(y,m,1).getDay() || 7) - 1;
    const nDays = new Date(y, m+1, 0).getDate();
    const today = todayStr();
    let cells = '';
    DOW_ES.forEach(d => cells += `<div class="adp-dow">${d}</div>`);
    for(let i = 0; i < firstDow; i++) cells += '<div class="adp-day out"></div>';
    for(let d = 1; d <= nDays; d++){
      const ds = y + '-' + pad(m+1) + '-' + pad(d);
      const cls = ['adp-day'];
      if(ds === today) cls.push('today');
      if(tempFrom && tempTo && ds >= tempFrom && ds <= tempTo) cls.push('in-range');
      if(ds === tempFrom) cls.push('range-start');
      if(ds === tempTo) cls.push('range-end');
      cells += `<div class="${cls.join(' ')}" data-date="${ds}">${d}</div>`;
    }
    return `
      <div class="adp-cal-head">
        <button data-nav="-1" title="Mes anterior">◀</button>
        <div class="adp-month">${monthName}</div>
        <button data-nav="1" title="Mes siguiente">▶</button>
      </div>
      <div class="adp-cal-grid">${cells}</div>
    `;
  }

  function render(){
    const presetsHtml = PRESETS.map(p =>
      `<button class="adp-preset ${p.key === selectedPreset ? 'active' : ''}" data-preset="${p.key}">${p.label}</button>`
    ).join('');
    pop.innerHTML = `
      <div class="adp-cols">
        <div class="adp-presets">${presetsHtml}</div>
        <div class="adp-cal">${renderCalHtml()}</div>
      </div>
      <div class="adp-footer">
        <input type="date" id="adp-from" value="${tempFrom || ''}">
        <span class="sep">→</span>
        <input type="date" id="adp-to" value="${tempTo || ''}">
        <button class="adp-cancel">Cancelar</button>
        <button class="adp-apply">Aplicar</button>
      </div>
    `;

    pop.querySelectorAll('.adp-preset').forEach(b => {
      b.onclick = () => {
        selectedPreset = b.dataset.preset;
        const p = PRESETS.find(x => x.key === selectedPreset);
        tempFrom = p.from(); tempTo = p.to();
        calMonth = parse(tempTo); calMonth.setDate(1);
        apply();
      };
    });
    pop.querySelectorAll('[data-nav]').forEach(b => {
      b.onclick = () => { calMonth.setMonth(calMonth.getMonth() + parseInt(b.dataset.nav)); render(); };
    });
    pop.querySelectorAll('.adp-day[data-date]').forEach(d => {
      d.onclick = () => {
        const ds = d.dataset.date;
        if(!tempFrom || (tempFrom === tempTo && ds >= tempFrom)){
          // Second click extends range
          if(tempFrom && ds >= tempFrom){ tempTo = ds; }
          else { tempFrom = ds; tempTo = ds; }
        } else if(ds < tempFrom){
          tempFrom = ds; tempTo = ds;
        } else {
          // Start a new range
          tempFrom = ds; tempTo = ds;
        }
        selectedPreset = 'custom';
        render();
      };
    });
    pop.querySelector('#adp-from').onchange = e => { tempFrom = e.target.value; if(tempTo < tempFrom) tempTo = tempFrom; selectedPreset = 'custom'; render(); };
    pop.querySelector('#adp-to').onchange = e => { tempTo = e.target.value; if(tempFrom > tempTo) tempFrom = tempTo; selectedPreset = 'custom'; render(); };
    pop.querySelector('.adp-cancel').onclick = closePopover;
    pop.querySelector('.adp-apply').onclick = apply;
  }

  function apply(){
    const newState = selectedPreset === 'custom'
      ? { preset: 'custom', from: tempFrom, to: tempTo }
      : { preset: selectedPreset };
    save(newState);
    closePopover();
    dispatchChange();
    if(cfg && cfg.onChange) cfg.onChange(resolve(newState));
  }

  render();

  // Position below button
  const rect = button.getBoundingClientRect();
  pop.style.top = (rect.bottom + window.scrollY + 8) + 'px';
  pop.style.left = Math.max(12, rect.left + window.scrollX) + 'px';
  requestAnimationFrame(() => {
    const pr = pop.getBoundingClientRect();
    if(pr.right > window.innerWidth - 12){
      pop.style.left = (window.innerWidth - pr.width - 12) + 'px';
    }
  });

  activePopover = { pop, overlay };
}

function dispatchChange(){
  window.dispatchEvent(new CustomEvent('abdatepicker:change', { detail: resolve(load()) }));
}

function mount(button, cfg){
  injectStyles();
  cfg = cfg || {};

  // Pick up shareable URL params on first mount.
  const qs = new URLSearchParams(location.search);
  const uFrom = qs.get('from'), uTo = qs.get('to');
  if(uFrom && uTo){
    save({ preset: 'custom', from: uFrom, to: uTo });
  }

  function paint(){
    const r = resolve(load());
    button.innerHTML = '<span class="adp-icon">📅</span><span class="adp-label">' + r.label + '</span><span class="adp-caret">▼</span>';
    button.classList.add('adp-btn');
  }
  paint();

  button.addEventListener('click', e => { e.stopPropagation(); openPopover(button, cfg); });

  // Cross-page sync: storage event fires in OTHER tabs when localStorage changes.
  window.addEventListener('storage', e => {
    if(e.key === STORAGE_KEY){
      paint();
      if(cfg.syncInputs) syncInputs();
      if(cfg.onChange) cfg.onChange(resolve(load()));
    }
  });
  // Same-tab sync (so multiple pickers on one page stay in lockstep).
  window.addEventListener('abdatepicker:change', () => {
    paint();
    if(cfg.syncInputs) syncInputs();
  });

  function syncInputs(){
    const r = resolve(load());
    const f = document.getElementById('dateFrom');
    const t = document.getElementById('dateTo');
    if(f) f.value = r.from;
    if(t) t.value = r.to;
  }
  if(cfg.syncInputs) syncInputs();
}

window.DatePicker = {
  mount,
  getRange: () => resolve(load()),
  setRange: (state) => { save(state); dispatchChange(); },
};
})();
