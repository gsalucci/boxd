/* boxd dashboard: the part that touches the page. Routing, events, polling, theme, focus and scroll.
   The state and every view come from boxd-views.mjs (pure, tested in node); this file only asks the service for the document
   (/api/fleet.json, again every 15 seconds), puts the views on the page and keeps what the person is doing (route, sorting,
   filters, focus, scroll position, the open log) while the data under it is replaced. The page only reads. */
import { newState, applyDoc, route, renderView, chrome, fmtCd } from './boxd-views.mjs';

const POLL_MS = 15000;      /* the document; the box process table and the open log are asked on the same beat */
const RETRY_MS = 5000;      /* until the first document arrives */
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const main = $('main');
const view = $('view');
let S = null;               /* the state, once the first document has arrived */
let lastText = '';          /* the last document as text: an unchanged one is not drawn again */
let notice = '';            /* a short message in the status bar until the next change of data, for example "copied" */

/* ------------------------------------------------------------------ storage that may be blocked: every use is guarded */
function store(key, value) { try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch (e) { /* storage blocked */ } return null; }
function loadAcked() { try { const o = JSON.parse(store('boxd-acked') || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }

/* ------------------------------------------------------------------ dimensions: widths and offsets are data attributes in the views, set here, so the page needs no inline style */
function applyDims(scope) {
  scope.querySelectorAll('[data-w]').forEach((el) => { el.style.width = el.dataset.w + '%'; });
  scope.querySelectorAll('[data-left]').forEach((el) => { el.style.left = el.dataset.left + '%'; });
}

/* ------------------------------------------------------------------ render, without stealing focus or losing the place */
/* An element is found again after a redraw by its id, else by its place among the controls of the view and what it does. */
const CONTROLS = 'button, a[href], input, select, textarea, [tabindex]';
const sig = (el) => (el.dataset.act || '') + '|' + (el.dataset.arg || '') + '|' + (el.dataset.input || '');
function focusMark() {
  const ae = document.activeElement;
  if (!ae || !view.contains(ae)) return null;
  if (ae.id) return { id: ae.id, sel: ae.tagName === 'INPUT' && ae.type === 'search' ? [ae.selectionStart, ae.selectionEnd] : null };
  const i = Array.prototype.indexOf.call(view.querySelectorAll(CONTROLS), ae);
  return i < 0 ? null : { idx: i, sig: sig(ae), sel: null };
}
function refocus(mark) {
  let target = null;
  if (mark.id) target = $(mark.id);
  else { const el = view.querySelectorAll(CONTROLS)[mark.idx]; if (el && sig(el) === mark.sig) target = el; }
  if (!target) return;
  target.focus({ preventScroll: true });
  if (mark.sel && target.setSelectionRange) { try { target.setSelectionRange(mark.sel[0], mark.sel[1]); } catch (e) { /* not a text input */ } }
}

function renderChrome() {
  const c = chrome(S, Date.now());
  document.querySelectorAll('.nav').forEach((n) => {
    if (n.dataset.arg === c.nav) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-count]').forEach((el) => { const t = String(c.counts[el.dataset.count]); if (el.textContent !== t) el.textContent = t; });
  setText($('crumb'), c.crumb, true);
  setText($('fleet'), c.fleet);
  setText($('theme-label'), 'theme: ' + S.theme);
  setText($('status-msg'), notice || c.status);   /* only when it changed, so a screen reader is not told the same thing again */
  document.title = c.title;
}
function setText(el, text, html) {
  if (html) { if (el.innerHTML !== text) el.innerHTML = text; } else if (el.textContent !== text) el.textContent = text;
}

/* opts.focus: an element id to move focus to (a navigation); otherwise focus, text selection and scroll positions stay where they were */
function render(opts) {
  opts = opts || {};
  if (!S) return;
  const mark = opts.focus ? null : focusMark();
  const oldTop = main.scrollTop;
  const oldLog = $('log-body');
  const logTop = oldLog ? oldLog.scrollTop : null;
  view.innerHTML = renderView(S, Date.now());
  applyDims(view);
  renderChrome();
  const logEl = $('log-body');
  if (logEl) {
    if (S.log.follow && !opts.keepLogScroll) logEl.scrollTop = logEl.scrollHeight;
    else if (logTop != null) logEl.scrollTop = logTop;
  }
  if (opts.focus) { const t = $(opts.focus) || $('view-title'); if (t) t.focus({ preventScroll: false }); } else { main.scrollTop = oldTop; if (mark) refocus(mark); }
}

/* The view is also the address (#hosts, #box:<name>): a reload or a shared link opens the same view, and the browser's
   back button works. Only a known view name is taken from the address; ids are looked up, never trusted. */
const VIEW_NAMES = ['overview', 'hosts', 'host', 'boxes', 'box', 'calls', 'images', 'services', 'alerts', 'reset'];
function fromAddress() { let a = location.hash.slice(1); try { a = decodeURIComponent(a); } catch (e) { return null; } return VIEW_NAMES.includes(a.split(':')[0]) ? a : null; }
window.addEventListener('popstate', () => { const a = fromAddress(); if (S && a) go(a, { address: true, back: true }); });

function go(arg, opts) {
  opts = opts || {};
  if (!opts.address && location.hash.slice(1) !== String(arg)) history.pushState(null, '', '#' + arg);
  S.scroll[S.route.view + ':' + (S.route.id || '')] = main.scrollTop;
  route(S, arg);
  closeNav(false);
  render({ focus: opts.focus || 'view-title' });
  main.scrollTop = opts.back ? (S.scroll[S.route.view + ':' + (S.route.id || '')] || 0) : 0;
  onDemand();
}

/* ------------------------------------------------------------------ the service */
async function getJson(url) {
  const r = await fetch(url, { cache: 'no-cache', headers: { accept: 'application/json' } });
  let body = null;
  try { body = await r.json(); } catch (e) { /* not json */ }
  return { ok: r.ok, status: r.status, body: body };
}

/* a selection the person is making (to copy a command, say) is not destroyed by a redraw: the poll waits for the next beat */
const selecting = () => { const s = window.getSelection(); return !!(s && !s.isCollapsed && view.contains(s.anchorNode)); };

async function loadFleet() {
  let res;
  try { res = await fetch('/api/fleet.json', { cache: 'no-cache', headers: { accept: 'application/json' } }); } catch (e) { return fleetFailed('the service did not answer'); }
  if (res.status === 503) return fleetFailed('the service has no data yet: its first poll has not finished');
  if (!res.ok) return fleetFailed('the service answered ' + res.status);
  const text = await res.text();
  if (text === lastText && S) {
    if (S.fetchError) { S.fetchError = null; renderChrome(); }
    return;
  }
  if (S && selecting()) return;
  let doc;
  try { doc = JSON.parse(text); } catch (e) { return fleetFailed('the service sent something that is not a document'); }
  if (doc.schema !== 1) return fleetFailed('the service speaks document schema ' + doc.schema + ', this page reads 1');
  lastText = text;
  notice = '';
  if (!S) { S = newState(doc); S.acked = loadAcked(); applyDoc(S, doc); { const a = fromAddress(); if (a) route(S, a); } applyTheme(store('boxd-theme')); render({ focus: 'view-title' }); }
  else { applyDoc(S, doc); render(); }
}
function fleetFailed(why) {
  if (S) { S.fetchError = why; renderChrome(); return; }
  view.innerHTML = '<div class="bx-panel"><div class="bx-empty"><span class="bx-empty__title">no data yet</span><span></span></div></div>';
  view.querySelector('.bx-empty span:last-child').textContent = why + '. trying again every few seconds.';
}

/* the box process table and a run's log: asked only while a box page is open and its host is awake (the service answers 409 otherwise) */
async function onDemand() {
  if (!S || S.route.view !== 'box') return;
  const b = S.boxes.find((x) => x.name === S.route.id);
  const h = b && S.hosts.find((x) => x.id === b.host);
  if (!h || h.state !== 'awake') return;
  const q = (o) => Object.keys(o).filter((k) => o[k] != null).map((k) => k + '=' + encodeURIComponent(o[k])).join('&');
  const here = () => S.route.view === 'box' && S.route.id === b.name;
  const psKey = b.host + '|' + b.name;
  const psJob = getJson('/api/ps?' + q({ host: b.host, box: b.name })).then((r) => {
    S.ps[psKey] = r.ok && r.body && Array.isArray(r.body.ps) ? { at: r.body.at, ps: r.body.ps } : { error: (r.body && r.body.error) || 'the service did not answer' };
  }, () => { S.ps[psKey] = { error: 'the service did not answer' }; });
  const run = S.log.run && b.runs.find((r) => r.id === S.log.run);
  let logJob = Promise.resolve();
  if (run) {
    const L = S.logs[run.id];
    if (!L || L.error || (L.state !== 'ended' && S.log.follow)) {
      const from = L && !L.error && L.next != null ? L.next : null;
      logJob = getJson('/api/log?' + q({ host: b.host, box: b.name, run: run.id, from: from })).then((r) => {
        const a = r.body;
        if (!r.ok || !a || typeof a.text !== 'string') { S.logs[run.id] = { error: (a && a.error) || 'the service did not answer' }; return; }
        const keep = from != null && L && !L.error && a.from === from && a.size >= from;
        S.logs[run.id] = { text: (keep ? L.text : '') + a.text, size: a.size, from: keep ? L.from : a.from, next: a.next, state: a.state, exit: a.exit, error: null };
      }, () => { S.logs[run.id] = { error: 'the service did not answer' }; });
    }
  }
  const before = JSON.stringify([S.ps[psKey], S.logs[run && run.id]]);
  await Promise.all([psJob, logJob]);
  if (here() && JSON.stringify([S.ps[psKey], S.logs[run && run.id]]) !== before && !selecting()) render({ keepLogScroll: !S.log.follow });
}

async function tick() {
  if (!document.hidden) { await loadFleet(); await onDemand(); }
  setTimeout(tick, S ? POLL_MS : RETRY_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S) { loadFleet().then(onDemand); } });

/* ------------------------------------------------------------------ theme */
function applyTheme(t) {
  S.theme = t === 'light' || t === 'dark' ? t : 'auto';
  if (S.theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', S.theme);
}

/* ------------------------------------------------------------------ narrow-width navigation */
function openNav() {
  $('app').classList.add('is-nav-open');
  $('scrim').hidden = false;
  $('menu-btn').setAttribute('aria-expanded', 'true');
  const first = document.querySelector('.nav[aria-current="page"]') || document.querySelector('.nav');
  if (first) first.focus();
}
function closeNav(refocus) {
  if (!$('app').classList.contains('is-nav-open')) return;
  $('app').classList.remove('is-nav-open');
  $('scrim').hidden = true;
  $('menu-btn').setAttribute('aria-expanded', 'false');
  if (refocus) $('menu-btn').focus();
}

/* ------------------------------------------------------------------ events: delegated from the document, so rebuilt controls stay bound */
const ACT = {
  go: (arg) => go(arg),
  back: (arg) => go(arg, { back: true, focus: 'view-title' }),
  menu: () => (document.getElementById('app').classList.contains('is-nav-open') ? closeNav(true) : openNav()),
  navclose: () => closeNav(true),
  theme: () => {
    const order = ['auto', 'light', 'dark'];
    applyTheme(order[(order.indexOf(S.theme) + 1) % 3]);
    store('boxd-theme', S.theme);
    renderChrome();
  },
  sort: (arg) => {
    const p = arg.split(':'), s = S.sort[p[0]];
    if (s.key === p[1]) s.dir = s.dir === 'asc' ? 'desc' : 'asc'; else S.sort[p[0]] = { key: p[1], dir: p[1] === 'name' || p[1] === 'host' || p[1] === 'engine' ? 'asc' : 'desc' };
    render({ keepLogScroll: true });
    const t = $('sort-' + p[0] + '-' + p[1]); if (t) t.focus({ preventScroll: true });
  },
  boxview: (arg) => { S.boxView = arg; render({ keepLogScroll: true }); const t = $('boxview-' + arg); if (t) t.focus({ preventScroll: true }); },
  tab: (arg) => { S.log.run = arg; S.log.follow = true; render({ focus: 'tab-' + arg }); onDemand(); },
  logfollow: () => { S.log.follow = !S.log.follow; render({ keepLogScroll: !S.log.follow }); if (S.log.follow) onDemand(); },
  logwrap: () => { S.log.wrap = !S.log.wrap; render({ keepLogScroll: true }); },
  logline: (arg) => { S.log.sel = S.log.sel === +arg ? null : +arg; render({ keepLogScroll: true }); },
  callclear: () => { S.callFilter = { host: 'all', outcome: 'all', q: '' }; render({ focus: 'call-q' }); },
  /* acknowledging touches no host: it is kept in this browser, keyed by the alert's last occurrence */
  ack: (arg) => { const a = S.alerts.find((x) => x.id === arg); if (!a) return; S.acked[arg] = a.lastAt; a.acked = true; store('boxd-acked', JSON.stringify(S.acked)); render({ focus: 'view-title' }); },
  unack: (arg) => { const a = S.alerts.find((x) => x.id === arg); delete S.acked[arg]; if (a) a.acked = false; store('boxd-acked', JSON.stringify(S.acked)); render({ focus: 'view-title' }); },
  copy: (arg, el) => {
    const code = el.parentNode.querySelector('code');
    const said = () => { notice = 'copied: ' + arg; renderChrome(); };
    const select = () => { const r = document.createRange(); r.selectNodeContents(code); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); notice = 'select and copy: ' + arg; renderChrome(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(arg).then(said, select); else select();
  }
};
document.addEventListener('click', function (e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled || !S) return;
  const fn = ACT[el.dataset.act];
  if (fn) fn(el.dataset.arg, el);
});

const INPUTS = {
  callq: (el) => { S.callFilter.q = el.value; },
  callhost: (el) => { S.callFilter.host = el.value; },
  calloutcome: (el) => { S.callFilter.outcome = el.value; },
  logq: (el) => { S.log.q = el.value; if (el.value) S.log.follow = false; }
};
function onInput(e) {
  const el = e.target.closest('[data-input]');
  if (!el || !S) return;
  const isText = el.tagName === 'INPUT' && el.type === 'search';
  if (isText !== (e.type === 'input')) return;
  INPUTS[el.dataset.input](el);
  render({ keepLogScroll: true });
}
document.addEventListener('input', onInput);
document.addEventListener('change', onInput);

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && $('app').classList.contains('is-nav-open')) { closeNav(true); e.preventDefault(); return; }
  const tab = e.target.closest && e.target.closest('[role="tab"]');
  if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End')) {
    const tabs = Array.prototype.slice.call(tab.parentNode.querySelectorAll('[role="tab"]'));
    let i = tabs.indexOf(tab);
    if (e.key === 'ArrowRight') i = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') i = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') i = 0;
    else i = tabs.length - 1;
    e.preventDefault();
    ACT.tab(tabs[i].dataset.arg);
  }
});

/* 1 s: live values ("ago", "up for", "time left") are rewritten in place; nothing is redrawn, so nothing loses focus */
setInterval(function () {
  const t = Date.now();
  document.querySelectorAll('[data-cd]').forEach((el) => {
    const text = fmtCd(el.dataset.cdMode, +el.dataset.cd, t);
    if (el.textContent !== text) el.textContent = text;
  });
}, 1000);

/* ------------------------------------------------------------------ start */
tick();
