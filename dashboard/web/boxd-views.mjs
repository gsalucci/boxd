/* boxd dashboard: the pure part of the page. State from the document the service serves (/api/fleet.json) and every view as a
   function that returns a string. Nothing here touches `document`, `window`, the network or the clock: the clock is an argument,
   so node can build the state from tests/fixtures/dashboard/fleet.json and render every view (tests/dashboard-web.test.mjs).
   The part that touches the page (routing, events, polling, theme) is boxd.mjs. The page only reads: no view draws a button
   that changes a host; where the prototype had one, a view shows the command to run as copyable text.
   Everything that comes from a host (box names, commands, log lines, refusal reasons, image names, details) goes through esc()
   before it is put into a string. Widths and offsets are written as data-w, data-left and data-gap and applied by boxd.mjs, so
   the page needs no inline style and its content security policy needs no exception. */

/* ------------------------------------------------------------------ state */
export function newState(doc) {
  const S = {
    route: { view: 'overview', id: null },
    boxView: 'table',
    sort: { boxes: { key: 'lastUsed', dir: 'desc' }, calls: { key: 'time', dir: 'desc' } },
    callFilter: { host: 'all', outcome: 'all', q: '' },
    log: { run: null, follow: true, wrap: false, q: '', sel: null },
    acked: {},      /* alert id -> time of its last occurrence when it was acknowledged (kept in the browser by boxd.mjs) */
    ps: {},         /* "host|box" -> { at, ps } or { error }: the box ps table, asked while a box page is open */
    logs: {},       /* run id -> { text, size, next, state, exit, error }: the log of a detached run, asked while it is open */
    fetchError: null,
    scroll: {},
    theme: 'auto'
  };
  return applyDoc(S, doc);
}

/* a poll replaces the data and nothing else: route, sorting, filters, view mode, log choices and acknowledgements stay */
export function applyDoc(S, doc) {
  S.generatedAt = doc.generatedAt;
  S.version = doc.version;
  S.hosts = doc.hosts;
  S.boxes = doc.boxes;
  S.calls = doc.calls.map((c, i) => Object.assign({ n: i }, c));
  S.callsCut = !!doc.callsCut;
  S.images = doc.images;
  S.services = doc.services;
  /* an acknowledged alert that happens again (a later last occurrence) comes back */
  S.alerts = doc.alerts.map((a) => Object.assign({}, a, { acked: (S.acked[a.id] === undefined ? -1 : S.acked[a.id]) >= a.lastAt }));
  S.fetchError = null;
  return S;
}

/* a link or a nav button names its target as view[:id[:run]] */
export function route(S, arg) {
  const parts = String(arg).split(':');
  S.route = { view: parts[0], id: parts[1] || null };
  if (parts[0] === 'box') S.log = { run: parts[2] || null, follow: true, wrap: S.log.wrap, q: '', sel: null };
}

/* ------------------------------------------------------------------ static helpers */
export const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const sum = (list, fn) => list.reduce((t, x) => t + fn(x), 0);
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : (word === 'box' ? 'es' : 's'));
const num = (n, digits) => (n == null ? '-' : n.toFixed(digits));
const gib = (n) => (n == null ? '-' : n.toFixed(1) + ' GiB');
const DASH = '<span class="ter">-</span>';

function fmtSpan(sec) {
  let s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d > 0) return d + ' d ' + pad(h) + ' h';
  if (h > 0) return h + ' h ' + pad(m) + ' min';
  return m + ':' + pad(s);
}
function fmtDur(ms) {
  if (ms == null) return '';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 10000) return (ms / 1000).toFixed(2) + ' s';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  return Math.floor(ms / 60000) + ' min ' + pad(Math.floor((ms % 60000) / 1000)) + ' s';
}
export function clock(t) { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
export function fmtAgo(t, now) {
  const s = Math.floor((now - t) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return s + ' s ago';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}
/* the text of a live value; boxd.mjs rewrites it every second from data-cd and data-cd-mode */
export function fmtCd(mode, t, now) {
  if (mode === 'ago') return fmtAgo(t, now);
  if (mode === 'up') return fmtSpan((now - t) / 1000);
  return fmtSpan((t - now) / 1000);
}

const ICONS = {
  overview: 'M2.75 2.75h4.5v4.5h-4.5zM8.75 2.75h4.5v4.5h-4.5zM2.75 8.75h4.5v4.5h-4.5zM8.75 8.75h4.5v4.5h-4.5z',
  host: 'M2.75 3.75h10.5v8.5H2.75zM2.75 8h10.5M5 6h1.5M5 10.25h1.5',
  box: 'M2.75 2.75h10.5v10.5H2.75zM2.75 6h10.5M6.5 8.75h3',
  vm: 'M2.75 2.75h10.5v10.5H2.75zM5.75 5.75h4.5v4.5h-4.5z',
  container: 'M2.75 4.75h10.5v6.5H2.75zM5.5 4.75v6.5M8 4.75v6.5M10.5 4.75v6.5',
  image: 'M2.75 3h10.5v3H2.75zM3.75 6v7.25h8.5V6M6.5 8.75h3',
  service: 'M5.75 5.75h4.5v4.5h-4.5zM8 2v3.75M8 10.25V14M2 8h3.75M10.25 8H14',
  power: 'M8 2v6M4.75 4.75a4.6 4.6 0 1 0 6.5 0',
  clock: 'M8 2.75a5.25 5.25 0 1 0 0 10.5a5.25 5.25 0 0 0 0-10.5zM8 5v3.25l2 1.25',
  refusal: 'M8 2.75a5.25 5.25 0 1 0 0 10.5a5.25 5.25 0 0 0 0-10.5zM4.3 4.3l7.4 7.4',
  reset: 'M3.25 8a4.75 4.75 0 1 0 1.6-3.55M3.25 2.5v3.25H6.5',
  remove: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  check: 'M3 8.5l3.25 3.25L13 4.75',
  warning: 'M8 2.5l6 10.75H2zM8 6.5v3M8 11v.5',
  sortAsc: 'M8 12.5v-9M4.5 7L8 3.5 11.5 7',
  sortDesc: 'M8 3.5v9M4.5 9L8 12.5 11.5 9',
  back: 'M9.5 3.5L5 8l4.5 4.5',
  table: 'M2.75 3.25h10.5v9.5H2.75zM2.75 6.5h10.5M2.75 9.5h10.5M6.5 6.5v6.25',
  wrap: 'M2.5 4h11M2.5 8h8.75a2 2 0 0 1 0 4H9M10.5 10.5L9 12l1.5 1.5M2.5 12H6',
  follow: 'M8 2.5v8.5M4.5 7.5L8 11l3.5-3.5M3 13.25h10',
  copy: 'M5.75 5.75h7v7.5h-7zM3.25 10.25v-7.5h7'
};
const icon = (name) => '<svg class="od-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false"><path d="' + ICONS[name] + '"/></svg>';

/* state glyphs: a separate 12 px set, so state never rests on colour alone (each state has its own shape) */
const GLYPHS = {
  awake: '<circle cx="6" cy="6" r="4" fill="currentColor"/>',
  asleep: '<circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  unreachable: '<circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 8.5l5-5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  running: '<path d="M3 2l7 4-7 4z" fill="currentColor"/>',
  detached: '<path d="M6 1.5L10.5 6 6 10.5 1.5 6z" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  ok: '<path d="M2 6.5L4.5 9 10 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/>',
  warning: '<path d="M6 2v5M6 9.25v.75" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square"/>',
  danger: '<path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/>'
};
const glyph = (state) => '<svg class="od-icon od-icon--glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">' + GLYPHS[state] + '</svg>';

function pill(state, word, o) {
  o = o || {};
  return '<span class="bx-pill' + (o.plain ? ' bx-pill--plain' : '') + (o.busy ? ' bx-pill--busy' : '') + '" data-state="' + esc(state) + '">' +
    '<span class="bx-pill__glyph">' + glyph(state) + '</span>' + esc(word || state) + '</span>';
}

function btn(o) {
  const cls = ['bx-btn'];
  if (o.kind) cls.push('bx-btn--' + o.kind);
  if (o.small) cls.push('bx-btn--s');
  return '<button type="button" class="' + cls.join(' ') + '"' +
    (o.id ? ' id="' + esc(o.id) + '"' : '') +
    ' data-act="' + o.act + '"' +
    (o.arg != null ? ' data-arg="' + esc(o.arg) + '"' : '') +
    (o.disabled ? ' disabled' : '') +
    (o.pressed != null ? ' aria-pressed="' + o.pressed + '"' : '') +
    (o.title ? ' title="' + esc(o.title) + '"' : '') +
    (o.aria ? ' aria-label="' + esc(o.aria) + '"' : '') + '>' +
    (o.icon ? icon(o.icon) : '') + '<span>' + esc(o.label) + '</span></button>';
}
const link = (text, arg, aria) => '<button type="button" class="bx-link" data-act="go" data-arg="' + esc(arg) + '"' + (aria ? ' aria-label="' + esc(aria) + '"' : '') + '>' + esc(text) + '</button>';
const hostLink = (id) => link(id, 'host:' + id, 'host ' + id);

/* a command the owner can run: selectable text and a copy button; the page never runs it */
const cmdText = (text) => '<span class="bx-cmd"><code>' + esc(text) + '</code>' +
  '<button type="button" class="bx-btn bx-btn--quiet bx-btn--s" data-act="copy" data-arg="' + esc(text) + '" aria-label="Copy command: ' + esc(text) + '">' + icon('copy') + '<span>Copy</span></button></span>';

function meter(o) {
  const pct = o.max > 0 ? Math.min(100, o.value / o.max * 100) : 0;
  const level = pct >= 95 ? 'full' : pct >= 80 ? 'high' : '';
  return '<div class="bx-meter' + (o.mark != null ? ' bx-meter--mark' : '') + '"' + (level ? ' data-level="' + level + '"' : '') +
    ' role="meter" aria-label="' + esc(o.label) + '" aria-valuemin="0" aria-valuemax="' + +o.max.toFixed(2) + '" aria-valuenow="' + (+o.value.toFixed(2)) + '" aria-valuetext="' + esc(o.text + (level ? ', ' + level : '')) + '">' +
    '<div class="bx-meter__head"><span class="bx-meter__label">' + esc(o.label) + '</span>' +
    '<span class="bx-meter__value">' + (level ? '<span class="bx-meter__flag">' + glyph(level === 'full' ? 'danger' : 'warning') + ' ' + level + '</span> ' : '') + esc(o.text) + '</span></div>' +
    '<div class="bx-meter__track"><span class="bx-meter__fill" data-w="' + pct.toFixed(1) + '"></span>' +
    (o.mark != null ? '<span class="bx-meter__mark" data-left="' + o.mark + '"></span>' : '') + '</div>' +
    (o.note ? '<div class="bx-meter__note">' + o.note + '</div>' : '') +
    '</div>';
}
/* a figure the host did not report: the meter is not drawn, the reason is said */
const unknown = (label, why) => '<div class="bx-meter"><div class="bx-meter__head"><span class="bx-meter__label">' + esc(label) + '</span><span class="bx-meter__value ter">' + esc(why || 'not reported') + '</span></div></div>';

function sparkLine(values, lastText) {
  if (!values || values.length < 2) return '<span class="bx-spark"><span>' + esc(lastText) + '</span></span>';
  const max = Math.max.apply(null, values.concat([1]));
  const pts = values.map((v, i) => [(1 + i * 94 / (values.length - 1)), 18.5 - v / max * 17]);
  const l = pts[pts.length - 1];
  return '<span class="bx-spark"><svg viewBox="0 0 96 20" width="96" height="20" role="img" aria-label="trend, last value ' + esc(lastText) + '">' +
    '<polyline fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter" points="' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"/>' +
    '<rect class="bx-spark__last" x="' + (l[0] - 2).toFixed(1) + '" y="' + (l[1] - 2).toFixed(1) + '" width="4" height="4"/></svg><span>' + esc(lastText) + '</span></span>';
}
function sparkBars(values, lastText) {
  const max = Math.max.apply(null, values.concat([1]));
  const w = 96 / values.length;
  let bars = '';
  values.forEach((v, i) => {
    const hgt = v === 0 ? 1 : Math.max(2, v / max * 19);
    bars += '<rect x="' + (i * w + 1).toFixed(1) + '" y="' + (20 - hgt).toFixed(1) + '" width="' + (w - 2).toFixed(1) + '" height="' + hgt.toFixed(1) + '"' + (i === values.length - 1 ? ' class="bx-spark__last"' : ' fill="currentColor"') + '/>';
  });
  return '<span class="bx-spark"><svg viewBox="0 0 96 20" width="96" height="20" role="img" aria-label="calls per 5 min, last value ' + esc(lastText) + '">' + bars + '</svg><span>' + esc(lastText) + '</span></span>';
}

const kv = (pairs) => '<dl class="bx-kv">' + pairs.filter(Boolean).map((p) => '<dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd>').join('') + '</dl>';
const stat = (label, value, note) =>
  '<div class="bx-stat"><span class="overline">' + esc(label) + '</span><span class="bx-stat__value">' + value + '</span><span class="bx-stat__note">' + note + '</span></div>';
const empty = (title, text) => '<div class="bx-panel"><div class="bx-empty"><span class="bx-empty__title">' + title + '</span><span>' + text + '</span></div></div>';
const section = (title, note, body, extra) =>
  '<section class="section"><div class="section__head"><h2 class="section__title">' + esc(title) + '</h2>' +
  (note ? '<span class="section__note">' + note + '</span>' : '') + (extra || '') + '</div>' + body + '</section>';
const panel = (title, body, headExtra) =>
  '<section class="bx-panel"><div class="bx-panel__head"><h3 class="bx-panel__title">' + esc(title) + '</h3>' + (headExtra || '') + '</div>' +
  '<div class="bx-panel__body">' + body + '</div></section>';
const pageHead = (title, lede, actions, back) =>
  (back ? '<div class="back">' + btn({ act: 'back', arg: back.arg, label: back.label, icon: 'back', kind: 'quiet', small: true, id: 'back-btn' }) + '</div>' : '') +
  '<header class="page-head"><div class="page-head__text"><h1 class="page-title" id="view-title" tabindex="-1">' + title + '</h1>' +
  (lede ? '<p class="page-lede">' + lede + '</p>' : '') + '</div>' +
  (actions ? '<div class="page-head__actions">' + actions + '</div>' : '') + '</header>';

const NAV_OF = { host: 'hosts', box: 'boxes' };
const TITLES = { overview: 'overview', hosts: 'hosts', host: 'hosts', boxes: 'boxes', box: 'boxes', calls: 'calls', images: 'images', services: 'services', alerts: 'alerts', reset: 'reset' };
const BUSY = {
  ssh: 'an ssh connection that counts as work',
  load: 'the load is above the idle limit',
  keepawake: 'someone holds the keepawake lock',
  'no-wake-card': 'no network card is registered to wake it again'
};

/* ------------------------------------------------------------------ views, built for one state and one clock */
function build(S, now) {
  const ago = (t) => fmtAgo(t, now);
  /* a live value: boxd.mjs rewrites its text every second without redrawing the view */
  const cd = (t, mode) => '<span class="od-nowrap" data-cd="' + t + '" data-cd-mode="' + mode + '">' + fmtCd(mode, t, now) + '</span>';
  const host = (id) => S.hosts.find((h) => h.id === id);
  const box = (name) => S.boxes.find((b) => b.name === name);
  const hostBoxes = (h) => S.boxes.filter((b) => b.host === h.id);
  const activeRuns = (b) => b.runs.filter((r) => r.state === 'detached');
  const openAlerts = () => S.alerts.filter((a) => !a.acked);
  const isAwake = (h) => h.state === 'awake';
  const boxLink = (name) => (box(name) ? link(name, 'box:' + name, 'box ' + name) : '<span class="ter">' + esc(name) + '</span>');
  const findRun = (id) => { for (const b of S.boxes) { const r = b.runs.find((x) => x.id === id); if (r) return { box: b, run: r }; } return null; };

  const hostPill = (h, plain) => pill(h.state, h.state, { plain: plain });
  function boxState(b) {
    if (activeRuns(b).length || b.busy) return { state: 'running', word: 'running', busy: true };
    if (b.state === 'stopped') return { state: 'asleep', word: 'stopped' };
    if (b.lastExit) return { state: 'danger', word: 'failed' };
    return { state: 'ok', word: 'ok' };
  }
  const boxPill = (b, plain) => { const s = boxState(b); return pill(s.state, s.word, { plain: plain, busy: s.busy }); };
  function runPill(r, plain) {
    if (r.state === 'detached') return pill('detached', 'detached', { plain: plain });
    return r.exit === 0 ? pill('ok', 'exit 0', { plain: plain }) : r.exit == null ? pill('asleep', 'ended', { plain: plain }) : pill('danger', 'exit ' + r.exit, { plain: plain });
  }
  function callOutcome(c) {
    if (c.reason) return 'refused';
    if (c.exit === null) return 'detached';
    return c.exit === 0 ? 'ok' : 'failed';
  }
  function outcomePill(c) {
    const o = callOutcome(c);
    if (o === 'ok') return pill('ok', 'ok', { plain: true });
    if (o === 'detached') return pill('detached', 'detached', { plain: true });
    return pill('danger', o, { plain: true });
  }

  /* what the host measured; nothing is summed from boxes any more */
  function usage(h) {
    const d = h.disk;
    const thrGiB = d && d.totalGiB != null && d.thresholdPct != null ? d.totalGiB * d.thresholdPct / 100 : null;
    const vmUsed = h.vmUsed != null ? h.vmUsed : S.boxes.filter((b) => b.host === h.id && b.engine === 'vm' && b.state === 'running').length;
    return {
      boxes: hostBoxes(h).length, vmUsed: vmUsed,
      slotsFree: h.slotsMax != null ? Math.max(0, h.slotsMax - vmUsed) : null,
      memUsed: h.buildMemUsedGiB, memMax: h.buildMemMaxGiB, memFree: h.buildMemFreeGiB,
      diskPct: d ? d.pct : null, diskUsed: d ? d.usedGiB : null, diskTotal: d ? d.totalGiB : null,
      diskFree: thrGiB != null && d.usedGiB != null ? Math.max(0, thrGiB - d.usedGiB) : null
    };
  }
  /* a host that does not count its machines (no ceiling) says whether another fits, by its measured memory */
  const roomWord = (h) => (h.vmRoom === true ? 'yes' : h.vmRoom === false ? 'no' : 'not reported');
  function placement(h) {
    const u = usage(h);
    const engines = !h.vmInstalled ? 'containers only: virtual machine engine not installed'
      : h.slotsMax != null ? (u.slotsFree > 0 ? 'containers and virtual machines' : 'containers only: machine slots full')
        : h.vmRoom === false ? 'containers only: no room for another virtual machine' : 'containers and virtual machines';
    if (h.state === 'awake') {
      const okAll = h.vmInstalled && (h.slotsMax != null ? u.slotsFree > 0 : h.vmRoom !== false) && (u.diskFree == null || u.diskFree > 0);
      return { level: okAll ? 'ok' : 'warning', word: okAll ? 'eligible' : 'limited', text: engines };
    }
    if (h.state === 'unreachable') return { level: 'danger', word: 'unreachable', text: 'does not answer: ' + h.detail };
    return { level: 'warning', word: 'limited', text: engines + '. ' + (h.powerModule === false ? 'asleep, does not wake on call: power module off' : 'asleep, wakes on the next call') };
  }

  /* table: uppercase mono headers, 28 px rows, sortable headers; stacks into labelled rows when narrow */
  function table(o) {
    const sort = o.id && S.sort[o.id];
    const head = o.cols.map((c) => {
      const active = sort && c.sort && sort.key === c.sort;
      const aria = c.sort ? ' aria-sort="' + (active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') + '"' : '';
      const inner = c.sort
        ? '<button type="button" class="bx-table__sort" id="sort-' + o.id + '-' + c.sort + '" data-act="sort" data-arg="' + o.id + ':' + c.sort + '">' + esc(c.label) + (active ? icon(sort.dir === 'asc' ? 'sortAsc' : 'sortDesc') : '') + '</button>'
        : (c.hide ? '<span class="vh">' + esc(c.label) + '</span>' : esc(c.label));
      return '<th scope="col" class="' + (c.num ? 'is-num' : '') + '"' + aria + '>' + inner + '</th>';
    }).join('');
    const body = o.rows.map((r) => '<tr class="' + (r.cls || '') + '">' + r.cells.map((cell, i) => {
      const c = o.cols[i];
      return '<td data-label="' + (c.hide ? '' : esc(c.label)) + '" class="' + (c.num ? 'is-num ' : '') + (c.cls || '') + '">' + cell + '</td>';
    }).join('') + '</tr>').join('');
    return '<div class="bx-table-wrap"><table class="bx-table bx-table--stack">' +
      (o.caption ? '<caption class="vh">' + esc(o.caption) + '</caption>' : '') +
      '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }
  function sorted(list, id, getters) {
    const s = S.sort[id];
    const get = getters[s.key];
    if (!get) return list.slice();
    const dir = s.dir === 'asc' ? 1 : -1;
    return list.slice().sort((a, b) => {
      const x = get(a), y = get(b);
      if (x === y) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  }

  /* ---------------------------------------------------------------- host pieces */
  function lastKnown(h) {
    if (isAwake(h)) return h.report ? '' : '<p class="caption">' + icon('clock') + ' ' + esc(h.detail) + '. figures a server of this age does not give are shown as -.</p>';
    const seen = h.seenAt ? 'data from ' + clock(h.seenAt) + ' (' + ago(h.seenAt) + ')' : 'never seen by the dashboard';
    if (h.state === 'asleep') return '<p class="caption">' + icon('clock') + ' asleep for ' + cd(h.sinceAt, 'up') + '. values below are last known: ' + esc(seen) + '. It wakes on the next call; the dashboard never wakes it.</p>';
    return '<p class="caption">' + icon('clock') + ' ' + esc(h.detail || 'no answer') + ' for ' + cd(h.sinceAt, 'up') + '. values below are last known: ' + esc(seen) + '.</p>';
  }
  function loadMeter(h) {
    if (!h.load || h.threads == null) return unknown('load, 1 min, against threads', h.load ? 'threads not reported' : 'no load figure yet');
    const l = h.load[0];
    return meter({ label: 'load, 1 min, against threads', value: l, max: h.threads, text: l.toFixed(2) + ' / ' + h.threads + ' threads' + (isAwake(h) ? '' : ', last known') });
  }
  function memMeter(h, u) {
    if (u.memUsed == null || u.memMax == null) return unknown('build-group memory', h.report ? 'not reported' : 'needs server 0.3.0');
    return meter({ label: 'build-group memory', value: u.memUsed, max: u.memMax, text: gib(u.memUsed) + ' of ' + u.memMax + ' GiB' });
  }
  function diskMeter(h, u) {
    const d = h.disk;
    if (!d) return unknown('work area disk', 'no figure yet');
    const thr = d.thresholdPct;
    const over = thr != null && d.pct >= thr;
    const note = thr == null ? ''
      : over ? '<span class="st-danger">' + glyph('danger') + ' at or over the ' + thr + ' % reset threshold: boxd resets the build area</span>'
        : 'tick marks the ' + thr + ' % reset threshold' + (u.diskFree != null ? ' · ' + gib(u.diskFree) + ' to go' : '');
    const text = d.pct + ' %' + (d.usedGiB != null && d.totalGiB != null ? ' · ' + gib(d.usedGiB) + ' of ' + d.totalGiB + ' GiB' : '');
    return meter({ label: 'work area disk', value: d.pct, max: 100, text: text, mark: thr, note: note });
  }
  function slots(h, u) {
    if (!h.vmInstalled) {
      return '<div class="bx-slots"><span class="bx-slots__label">virtual machines</span>' + icon('refusal') + '<span class="bx-slots__note">virtual machine engine not installed. containers only.</span></div>';
    }
    if (h.slotsMax == null) {
      /* since server 0.2.0 machines are admitted by measured memory, not by a count */
      return '<div class="bx-slots"><span class="bx-slots__label">virtual machines</span><span>' + (u.vmUsed == null ? '-' : u.vmUsed) + ' running</span>' +
        '<span class="bx-slots__note">room for another: ' + roomWord(h) + ' · no count ceiling, measured memory decides</span></div>';
    }
    let cells = '';
    for (let i = 0; i < h.slotsMax; i++) cells += '<span class="bx-slots__cell' + (i < u.vmUsed ? ' is-used' : '') + '"></span>';
    return '<div class="bx-slots" role="meter" aria-label="virtual machine slots" aria-valuemin="0" aria-valuemax="' + h.slotsMax + '" aria-valuenow="' + u.vmUsed + '" aria-valuetext="' + u.vmUsed + ' of ' + h.slotsMax + ' used">' +
      '<span class="bx-slots__label">machine slots</span><span class="bx-slots__cells" aria-hidden="true">' + cells + '</span>' +
      '<span>' + u.vmUsed + '/' + h.slotsMax + '</span><span class="bx-slots__note">' + (u.slotsFree === 0 ? 'full' : u.slotsFree + ' free') + '</span></div>';
  }
  const loadText = (h) => (h.load ? h.load[0].toFixed(2) + (isAwake(h) ? ' now' : ' last known') : 'no data');
  function hostCard(h) {
    const u = usage(h);
    const meta = [h.addr, h.threads != null ? h.threads + ' threads' : null, h.ramGiB != null ? h.ramGiB + ' GiB' : null,
      h.powerModule == null ? null : 'power module ' + (h.powerModule ? 'on' : 'off')].filter(Boolean).map(esc).join(' · ');
    return '<article class="bx-card bx-card--host' + (h.stale ? ' bx-card--dim' : '') + '" aria-label="host ' + esc(h.id) + '">' +
      '<div class="bx-card__head"><h3 class="bx-card__name">' + icon('host') + hostLink(h.id) + '</h3>' + hostPill(h) + '</div>' +
      '<p class="bx-card__meta">' + (meta || 'nothing reported yet') + '</p>' +
      lastKnown(h) +
      '<div class="bx-card__cols">' +
      slots(h, u) +
      '<div class="od-stack">' + loadMeter(h) + sparkLine(h.loadHist, loadText(h)) + '</div>' +
      memMeter(h, u) +
      diskMeter(h, u) +
      '</div>' +
      '<div class="bx-card__actions">' + (h.powerModule === false ? '<span class="caption">' + icon('power') + ' always on: power module off</span>' : '') +
      btn({ act: 'go', arg: 'host:' + h.id, label: 'Details', kind: 'quiet', aria: 'Details for ' + h.id }) + '</div></article>';
  }
  function capacityTable() {
    const rows = S.hosts.map((h) => {
      const u = usage(h), p = placement(h);
      return { cls: h.stale ? 'is-dim' : '', cells: [
        hostLink(h.id), pill(h.state, h.state, { plain: true }), String(u.boxes),
        !h.vmInstalled ? 'none' : h.slotsMax != null ? u.slotsFree + ' of ' + h.slotsMax : roomWord(h),
        u.memFree != null ? gib(u.memFree) + (u.memMax != null ? ' of ' + u.memMax : '') : '-',
        gib(u.diskFree),
        pill(p.level, p.word, { plain: true }) + '<span class="bx-table__sub">' + esc(p.text) + '</span>'
      ] };
    });
    rows.push({ cells: [
      '<strong>fleet</strong>', S.hosts.filter(isAwake).length + '/' + S.hosts.length + ' awake', String(S.boxes.length),
      sum(S.hosts, (h) => usage(h).vmUsed || 0) + ' machines running', gib(sum(S.hosts, (h) => h.buildMemFreeGiB || 0)), '-',
      '<span class="ter">a new box lands on the first eligible host</span>'
    ] });
    return table({ caption: 'Free capacity per host', cols: [
      { label: 'host' }, { label: 'state' }, { label: 'boxes', num: true }, { label: 'room for a virtual machine', num: true },
      { label: 'free build memory, GiB', num: true }, { label: 'disk to threshold', num: true }, { label: 'placement', cls: 'is-wrap' }
    ], rows: rows });
  }
  function placementTable(list) {
    return table({ caption: 'Which host each box lives on', cols: [
      { label: 'box' }, { label: 'placed on' }, { label: 'engine' }, { label: 'state' }, { label: 'memory', num: true }, { label: 'size' }
    ], rows: list.map((b) => {
      const h = host(b.host);
      return { cells: [
        boxLink(b.name), hostLink(b.host) + ' ' + (h && h.stale ? pill(h.state, h.state, { plain: true }) : ''),
        icon(b.engine) + ' ' + esc(b.engine), boxPill(b, true),
        h && isAwake(h) && b.memGiB != null ? gib(b.memGiB) : '-', b.size ? esc(b.size) : '-'
      ] };
    }) });
  }

  /* ---------------------------------------------------------------- calls pieces */
  function callsTable(list, id) {
    return table({ id: id, caption: 'Calls', cols: [
      { label: 'time', sort: id ? 'time' : null }, { label: 'host' }, { label: 'box' }, { label: 'command', cls: 'is-wrap' },
      { label: 'outcome' }, { label: 'exit', num: true, sort: id ? 'exit' : null },
      { label: 'duration', num: true, sort: id ? 'dur' : null }, { label: 'lock wait', num: true, sort: id ? 'lock' : null }
    ], rows: list.map((c) => ({ cells: [
      clock(c.at) + ' <span class="ter">' + ago(c.at) + '</span>',
      hostLink(c.host), boxLink(c.box),
      (c.cmd == null ? '<span class="ter">no command recorded</span>' : esc(c.cmd)) +
        (c.reason ? '<span class="bx-table__sub st-danger">' + icon('refusal') + ' refused: ' + esc(c.reason) + '</span>' : '') +
        (c.run && findRun(c.run) ? '<span class="bx-table__sub">run ' + esc(c.run) + ' · ' + link('log', 'box:' + c.box + ':' + c.run, 'log of run ' + c.run) + '</span>' : ''),
      outcomePill(c),
      c.exit === null ? '<span class="ter">detached</span>' : (c.exit === 0 ? '0' : '<span class="st-danger">' + esc(c.exit) + '</span>'),
      fmtDur(c.dur),
      c.lock ? (c.lock >= 10000 ? '<span class="st-warning">' + glyph('warning') + ' ' + fmtDur(c.lock) + '</span>' : fmtDur(c.lock)) : '<span class="ter">0 ms</span>'
    ] })) });
  }
  function callStats() {
    const last60 = S.calls.filter((c) => now - c.at < 3600e3);
    const done = S.calls.filter((c) => c.exit !== null && !c.reason).map((c) => c.dur).sort((a, b) => a - b);
    const q = (p) => (done.length ? done[Math.min(done.length - 1, Math.floor(p * done.length))] : 0);
    const buckets = new Array(12).fill(0);
    last60.forEach((c) => { buckets[11 - Math.min(11, Math.floor((now - c.at) / 300e3))]++; });
    const edges = [100, 500, 2000, 10000, 60000, Infinity];
    const labels = ['< 100 ms', '100–500 ms', '0.5–2 s', '2–10 s', '10–60 s', '> 60 s'];
    const hist = edges.map(() => 0);
    done.forEach((d) => { hist[edges.findIndex((e) => d < e)]++; });
    const refused = S.calls.filter((c) => c.reason);
    return {
      last60: last60.length, rate: last60.length / 60, median: q(0.5), p95: q(0.95),
      maxLock: Math.max.apply(null, S.calls.map((c) => c.lock || 0).concat([0])),
      refused: refused, failed: S.calls.filter((c) => callOutcome(c) === 'failed').length,
      buckets: buckets, hist: hist, labels: labels, done: done.length
    };
  }

  /* ---------------------------------------------------------------- box pieces */
  /* --user is a flag, containers only; a vm row never shows it (the host refuses --user with --vm) */
  const userFlag = (b) => (b.engine === 'vm' ? '<span class="ter">n/a (vm)</span>' : b.userFlag == null ? DASH : b.userFlag ? 'unprivileged' : 'root');
  function ttl(b) {
    const h = host(b.host);
    if (activeRuns(b).length || b.busy) return '<span class="ter">kept by a run</span>';
    if (b.ttlAt == null || (h && !isAwake(h))) return DASH;
    const soon = b.ttlAt - now < 5 * 60e3;
    return (soon ? '<span class="st-warning">' + glyph('warning') + ' </span>' : '') + cd(b.ttlAt, 'down') + ' <span class="ter">min</span>' + (soon ? ' <span class="ter">soon</span>' : '');
  }
  function runList(b) {
    const act = activeRuns(b);
    if (!act.length) return '<span class="ter">none</span>';
    return '<div class="bx-runs">' + act.map((r) => '<span>' + runPill(r, true) + '<span>' + esc(r.id) + '</span>' + link('log', 'box:' + b.name + ':' + r.id, 'log of run ' + r.id) + '</span>').join('') + '</div>';
  }
  const lastUsed = (b) => (b.lastUsedAt == null ? DASH : cd(b.lastUsedAt, 'ago'));
  function boxMem(b, h) {
    if (!h || !isAwake(h) || b.memGiB == null || b.memLimitGiB == null) return unknown('memory', h && !isAwake(h) ? 'host not awake' : 'not reported');
    return meter({ label: 'memory', value: b.memGiB, max: b.memLimitGiB, text: gib(b.memGiB) + ' of ' + gib(b.memLimitGiB) });
  }
  function boxCard(b) {
    const s = boxState(b);
    const h = host(b.host);
    return '<article class="bx-card bx-card--box" data-state="' + s.state + '" aria-label="box ' + esc(b.name) + '">' +
      '<div class="bx-card__head"><h3 class="bx-card__name">' + icon(b.engine) + boxLink(b.name) + '</h3>' + boxPill(b) + '</div>' +
      kv([
        ['host', hostLink(b.host) + (h && h.stale ? ' ' + hostPill(h, true) : '')],
        ['engine', esc(b.engine)], ['image', esc(b.image)], ['user', userFlag(b)],
        ['last used', lastUsed(b)], ['time left', ttl(b)], ['runs', runList(b)]
      ]) +
      '<div class="od-stack">' + boxMem(b, h) + '</div></article>';
  }

  /* ---------------------------------------------------------------- views */
  const VIEWS = {};

  VIEWS.overview = function () {
    const cs = callStats();
    const open = openAlerts();
    const awake = S.hosts.filter(isAwake).length;
    const detached = sum(S.boxes, (b) => activeRuns(b).length);
    const vmUsed = sum(S.hosts, (h) => usage(h).vmUsed || 0);
    const room = S.hosts.filter((h) => isAwake(h) && h.vmInstalled && h.vmRoom === true).length;
    const withDisk = S.hosts.filter((h) => h.disk);
    const worst = withDisk.slice().sort((a, b) => b.disk.pct - a.disk.pct)[0];
    const quiet = S.hosts.filter((h) => !isAwake(h)).map((h) => h.id + ' ' + h.state).join(', ');
    const lastRef = cs.refused[0];

    const banner = open.length
      ? '<div class="bx-banner" role="status">' + pill('warning', plural(open.length, 'alert')) +
        '<span class="bx-banner__msg">' + esc(open[0].title) + ' · since ' + clock(open[0].sinceAt) + ', ' + ago(open[0].sinceAt) + '</span>' +
        btn({ act: 'go', arg: 'alerts', label: 'View alerts', id: 'banner-alerts' }) + '</div>'
      : '<div class="bx-panel"><div class="bx-panel__body"><span>' + pill('ok', 'no open alerts', { plain: true }) + ' <span class="sec">nothing unusual in the last 24 hours.</span></span></div></div>';

    return pageHead('Overview', 'Fleet state as of ' + clock(S.generatedAt) + ': ' + plural(S.hosts.length, 'host') + ', ' + plural(S.boxes.length, 'box') + '. A host that sleeps shows its last known values; the dashboard never wakes it.') +
      banner +
      '<div class="grid grid--stats">' +
      stat('hosts awake', awake + '<small>/' + S.hosts.length + '</small>', quiet ? esc(quiet) : 'all hosts accept calls') +
      stat('boxes', String(S.boxes.length), esc(S.hosts.map((h) => usage(h).boxes + ' on ' + h.id).join(', '))) +
      stat('detached runs', String(detached), 'long runs still going') +
      stat('virtual machines', String(vmUsed) + '<small> running</small>', room + ' of ' + awake + ' awake hosts have room for another') +
      stat('calls, last 60 min', String(cs.last60), cs.rate.toFixed(2) + ' per min · median ' + fmtDur(cs.median)) +
      stat('refusals, 24 h', String(cs.refused.length), lastRef ? 'last ' + ago(lastRef.at) + ' on ' + esc(lastRef.host) : 'none') +
      stat('work area', worst ? worst.disk.pct + '<small> %</small>' : '-', worst ? esc(worst.id) + (worst.disk.thresholdPct != null ? ' · reset threshold ' + worst.disk.thresholdPct + ' %' : '') : 'no figure yet') +
      '</div>' +
      section('Fleet', 'one card per host', '<div class="grid grid--2">' + S.hosts.map(hostCard).join('') + '</div>') +
      section('Free capacity', 'where the next box can be placed', capacityTable()) +
      section('Recent calls', 'newest first', callsTable(S.calls.slice(0, 8), null), link('All ' + S.calls.length + ' calls', 'calls'));
  };

  VIEWS.hosts = function () {
    const withIdle = S.hosts.find((h) => h.idle);
    return pageHead('Hosts', 'Machines that run boxes.' + (withIdle ? ' A host sleeps after ' + (withIdle.idle.timeoutSec / 60) + ' min idle if its power module is on, and wakes on the next call.' : '')) +
      '<div class="grid grid--2">' + S.hosts.map(hostCard).join('') + '</div>' +
      section('Capacity summary', 'room for machines, build memory and disk per host', capacityTable()) +
      section('Placement', 'which host each box lives on', placementTable(S.boxes));
  };

  VIEWS.host = function () {
    const h = host(S.route.id);
    const u = usage(h);
    const awake = isAwake(h);
    const known = awake ? '' : ' <span class="ter">last known</span>';
    const runs = [];
    hostBoxes(h).forEach((b) => activeRuns(b).forEach((r) => runs.push({ box: b.name, run: r })));

    let idle;
    if (h.state !== 'awake') idle = h.state === 'asleep' ? 'asleep. no timer.' : 'no answer. no timer.';
    else if (h.powerModule === false) idle = 'off. this host never sleeps: always on.';
    else if (!h.idle) idle = '<span class="ter">not reported</span>';
    else if (h.idle.busy) idle = pill('warning', 'busy', { plain: true }) + ' ' + esc(BUSY[h.idle.busy] || h.idle.busy) + '. the ' + (h.idle.timeoutSec / 60) + ' min quiet timer is at zero.';
    else idle = fmtSpan(h.idle.timeoutSec - h.idle.quietSec) + ' to sleep <span class="ter">(quiet for ' + fmtSpan(h.idle.quietSec) + ' of ' + (h.idle.timeoutSec / 60) + ' min, at the last poll)</span>';

    const runsBody = runs.length
      ? table({ caption: 'Detached runs on this host', cols: [{ label: 'run' }, { label: 'box' }, { label: 'command', cls: 'is-wrap' }, { label: 'since' }],
        rows: runs.map((x) => ({ cells: [esc(x.run.id) + ' · ' + link('log', 'box:' + x.box + ':' + x.run.id, 'log of run ' + x.run.id), boxLink(x.box),
          x.run.cmd == null ? '<span class="ter">not recorded</span>' : '<code>' + esc(x.run.cmd) + '</code>',
          x.run.startedAt == null ? '-' : clock(x.run.startedAt) + ' <span class="ter">' + ago(x.run.startedAt) + '</span>'] })) })
      : '<div class="bx-empty"><span class="bx-empty__title">no detached runs</span><span>' + (awake ? 'No long run holds this host awake.' : 'Runs are listed from the last answer of the host.') + '</span></div>';

    const power = panel('Power', kv([
      ['state', hostPill(h)],
      [awake ? 'awake for' : h.state === 'asleep' ? 'asleep for' : 'unreachable for', cd(h.sinceAt, 'up')],
      ['data from', h.seenAt ? clock(h.seenAt) + ' <span class="ter">' + ago(h.seenAt) + '</span>' : '<span class="ter">never</span>'],
      ['address', esc(h.addr)],
      ['power module', h.powerModule == null ? '<span class="ter">not reported</span>' : h.powerModule ? 'on: sleeps when idle, wakes on the next call' : 'off: never sleeps, does not wake on call'],
      ['idle countdown', idle],
      ['keepawake lock', h.keepawake == null ? DASH : h.keepawake ? 'held' : 'free'],
      ['change it', h.powerModule == null ? '' : 'edit <code>BOXD_POWER</code> in <code>/etc/boxd/boxd.conf</code> on the host, then ' + cmdText('boxctl reload')]
    ]) + '<div class="od-stack"><span class="overline">detached runs</span>' + runsBody + '</div>');

    const l = h.load || [null, null, null];
    const load = panel('Load', loadMeter(h) + kv([
      ['1 / 5 / 15 min', l.map((x) => num(x, 2)).join(' / ') + known],
      ['threads', h.threads == null ? '-' : String(h.threads)],
      ['trend, 2 h', sparkLine(h.loadHist, loadText(h))],
      ['headroom', h.load && h.threads != null ? Math.max(0, h.threads - l[0]).toFixed(2) + ' threads free' : '-']
    ]) + '<p class="caption">Load above the thread count means calls wait for a processor.</p>');

    const p = h.pressure;
    const memory = panel('Memory',
      memMeter(h, u) +
      (h.swap ? meter({ label: 'swap', value: h.swap.usedGiB, max: h.swap.totalGiB, text: gib(h.swap.usedGiB) + ' of ' + h.swap.totalGiB + ' GiB' }) : unknown('swap', 'not reported')) +
      kv([
        ['pressure, some', (p ? p.some10.toFixed(2) + ' % avg10 · ' + p.some60.toFixed(2) + ' % avg60' + known : '-')],
        ['pressure, full', (p ? p.full10.toFixed(2) + ' % avg10 · ' + p.full60.toFixed(2) + ' % avg60' + known : '-')],
        ['memory kills', h.memKills == null ? '-' : h.memKills ? '<span class="st-warning">' + glyph('warning') + ' ' + h.memKills + '</span> since boxd started' + (h.lastKillAt ? ' · last ' + ago(h.lastKillAt) : '') : '0 since boxd started'],
        ['installed memory', h.ramGiB == null ? '-' : h.ramGiB + ' GiB'],
        ['available memory', gib(h.memAvailGiB)],
        ['limit per box', h.boxMemGiB == null ? '-' : h.boxMemGiB + ' GiB'],
        ['size of a machine', h.vmMemGiB == null ? '-' : h.vmMemGiB + ' GiB']
      ]));

    const pl = placement(h);
    const capacity = panel('Capacity', slots(h, u) + diskMeter(h, u) + kv([
      ['boxes here', String(u.boxes)],
      ['free build memory', gib(u.memFree)],
      ['disk to threshold', gib(u.diskFree)],
      ['placement', pill(pl.level, pl.word, { plain: true }) + ' ' + esc(pl.text)]
    ]) + '<p class="caption">What a reset does and how to run it: ' + link('Reset', 'reset') + '.</p>');

    const hb = hostBoxes(h);
    return pageHead(icon('host') + ' ' + esc(h.id) + ' ' + hostPill(h),
      [h.threads != null ? h.threads + ' threads' : null, h.ramGiB != null ? h.ramGiB + ' GiB' : null, h.addr, h.version ? 'server ' + h.version : null].filter(Boolean).map(esc).join(' · '),
      btn({ act: 'go', arg: 'services', label: 'Services', icon: 'service', kind: 'quiet' }),
      { arg: 'hosts', label: 'Hosts' }) +
      (awake && h.report ? '' : '<div class="bx-panel"><div class="bx-panel__body">' + lastKnown(h) + '</div></div>') +
      '<div class="grid grid--2">' + power + load + memory + capacity + '</div>' +
      section('Boxes on ' + h.id, plural(hb.length, 'box') + ' placed here',
        hb.length ? placementTable(hb) : empty('no boxes on ' + esc(h.id), 'A box is created on the first call from a worktree.'));
  };

  VIEWS.boxes = function () {
    const list = sorted(S.boxes, 'boxes', {
      name: (b) => b.name, host: (b) => b.host, engine: (b) => b.engine, lastUsed: (b) => b.lastUsedAt, ttl: (b) => b.ttlAt
    });
    const running = S.boxes.filter((b) => activeRuns(b).length).length;
    const toggle = '<div class="bx-seg" role="group" aria-label="View">' +
      btn({ id: 'boxview-table', act: 'boxview', arg: 'table', label: 'Table', icon: 'table', pressed: S.boxView === 'table' }) +
      btn({ id: 'boxview-cards', act: 'boxview', arg: 'cards', label: 'Cards', icon: 'overview', pressed: S.boxView === 'cards' }) + '</div>';
    let body;
    if (!S.boxes.length) {
      body = empty('no boxes', 'A box is created on the first <code>box</code> call from a git worktree.');
    } else if (S.boxView === 'cards') {
      body = '<div class="grid grid--boxes">' + list.map(boxCard).join('') + '</div>';
    } else {
      body = table({ id: 'boxes', caption: 'Boxes', cols: [
        { label: 'name', sort: 'name' }, { label: 'host', sort: 'host' }, { label: 'engine', sort: 'engine' }, { label: 'image', cls: 'is-wrap-s' }, { label: 'user' },
        { label: 'last used', sort: 'lastUsed' }, { label: 'time left', sort: 'ttl', num: true }, { label: 'runs' }
      ], rows: list.map((b) => {
        const h = host(b.host);
        return { cells: [
          '<span>' + boxLink(b.name) + ' ' + boxPill(b, true) + '</span>',
          hostLink(b.host) + (h && h.stale ? ' ' + hostPill(h, true) : ''),
          icon(b.engine) + ' ' + esc(b.engine), esc(b.image).replace(/([/:])/g, '$1<wbr>'), userFlag(b),
          lastUsed(b), ttl(b), runList(b)
        ] };
      }) });
    }
    return pageHead('Boxes', 'One box per git worktree: a rootless container or a small virtual machine. ' + plural(S.boxes.length, 'box') + ', ' + running + ' with detached runs.', toggle) + body;
  };

  /* the log is plain text, shown as the host wrote it: no levels, no invented timestamps */
  function logLine(text, i, q) {
    let msg = esc(text);
    const idx = q ? text.toLowerCase().indexOf(q) : -1;
    if (idx >= 0) msg = esc(text.slice(0, idx)) + '<mark>' + esc(text.slice(idx, idx + q.length)) + '</mark>' + esc(text.slice(idx + q.length));
    return '<div class="bx-log__line' + (S.log.sel === i ? ' is-selected' : '') + '" data-act="logline" data-arg="' + i + '">' +
      '<span class="bx-log__n">' + (S.log.sel === i ? '&gt;' : '') + (i + 1) + '</span><span class="bx-log__msg">' + msg + '</span></div>';
  }
  const logLines = (L) => (L && L.text ? L.text.replace(/\n$/, '').split('\n') : []);
  function logViewer(b, r) {
    const L = S.logs[r.id];
    const active = r.state === 'detached' && !(L && L.state === 'ended');
    const q = S.log.q.trim().toLowerCase();
    const lines = logLines(L);
    const body = !L ? '<div class="bx-log__empty">asking the host for the log…</div>'
      : L.error ? '<div class="bx-log__empty">' + esc(L.error) + '</div>'
        : lines.length ? lines.map((t, i) => logLine(t, i, q)).join('') : '<div class="bx-log__empty">no output yet.</div>';
    let tail = '';
    if (L && !L.error) {
      if (active) tail = '<div class="bx-log__tail">' + (S.log.follow ? 'following' : 'paused. new lines are held until you follow again.') + (S.log.follow ? ' <span class="bx-cursor" aria-hidden="true"></span>' : '') + '</div>';
      else {
        const code = L.exit != null ? L.exit : r.exit;
        tail = '<div class="bx-log__exit" data-ok="' + (code === 0) + '">' + glyph(code === 0 ? 'ok' : 'danger') + ' EXIT ' + esc(code == null ? 'unknown' : code) + '</div>';
      }
    }
    const matches = q ? lines.filter((t) => t.toLowerCase().indexOf(q) >= 0).length : 0;
    const state = (active ? (S.log.follow ? 'following' : 'paused') : 'ended') + ' · ' + plural(lines.length, 'line') + (L && L.size != null && L.from > 0 ? ' · the start of a long log is left out' : '') + (q ? ' · ' + matches + (matches === 1 ? ' match' : ' matches') : '');
    return '<div class="bx-log' + (S.log.wrap ? ' bx-log--wrap' : '') + '">' +
      '<div class="bx-log__bar">' +
      '<div class="bx-field"><label for="log-q">Search this log</label><input class="bx-input" id="log-q" type="search" data-input="logq" value="' + esc(S.log.q) + '" placeholder="text, for example warning" autocomplete="off"></div>' +
      btn({ id: 'log-follow', act: 'logfollow', label: 'Follow', icon: 'follow', pressed: S.log.follow && active, disabled: !active, title: active ? '' : 'run has ended' }) +
      btn({ id: 'log-wrap', act: 'logwrap', label: 'Wrap', icon: 'wrap', pressed: S.log.wrap }) +
      '<span class="bx-log__state" id="log-state" role="status">' + esc(state) + '</span></div>' +
      '<div class="bx-log__body" id="log-body" tabindex="0" role="log" aria-label="Log of run ' + esc(r.id) + '">' + body + tail + '</div></div>';
  }

  /* box ps: pid, age, processor seconds, folder, command; an old process with 0 s processor time is flagged */
  function psSection(b, h) {
    const entry = S.ps[b.host + '|' + b.name];
    if (!entry) return '<p class="caption">' + icon('clock') + ' ' + (isAwake(h) ? 'asking the host for the process list…' : 'host ' + esc(h.id) + ' is ' + esc(h.state) + ': the process list is asked only from an awake host.') + '</p>';
    if (entry.error) return empty('no process list', esc(entry.error));
    if (!entry.ps.length) return empty('no processes', 'Nothing runs in this box right now.');
    return table({ caption: 'box ps', cols: [{ label: 'pid', num: true }, { label: 'age', num: true }, { label: 'cpu', num: true }, { label: 'folder' }, { label: 'command', cls: 'is-wrap' }],
      rows: entry.ps.map((p) => {
        const hung = p[1] >= 600 && p[2] === 0;
        return { cells: [String(p[0]), fmtSpan(p[1]), p[2] + ' s', '<code>' + esc(p[3]) + '</code>',
          '<code>' + esc(p[4]) + '</code>' + (hung ? ' <span class="st-warning">' + glyph('warning') + ' possibly hung</span> <span class="ter">' + fmtSpan(p[1]) + ' old, 0 s of cpu</span>' : '')] };
      }) }) + '<p class="caption">as of ' + clock(entry.at) + '</p>';
  }

  VIEWS.box = function () {
    const b = box(S.route.id);
    const h = host(b.host);
    let r = b.runs.find((x) => x.id === S.log.run);
    if (!r) { r = activeRuns(b)[0] || b.runs[b.runs.length - 1]; S.log.run = r ? r.id : null; }
    const tabs = '<div class="bx-tabs" role="tablist" aria-label="Runs in ' + esc(b.name) + '">' + b.runs.map((x) =>
      '<button type="button" class="bx-tab" role="tab" id="tab-' + esc(x.id) + '" aria-selected="' + (r && x.id === r.id) + '" aria-controls="run-panel" tabindex="' + (r && x.id === r.id ? 0 : -1) + '" data-act="tab" data-arg="' + esc(x.id) + '"><span class="mono">' + esc(x.id) + '</span>' + runPill(x, true) + '</button>').join('') + '</div>';
    return pageHead(icon(b.engine) + ' ' + esc(b.name) + ' ' + boxPill(b), 'The box of one worktree on ' + esc(b.host) + '. The page only reads: the commands below are yours to run.', '', { arg: 'boxes', label: 'Boxes' }) +
      '<div class="grid grid--2">' +
      panel('Box', kv([
        ['host', hostLink(b.host) + ' ' + hostPill(h, true)], ['engine', icon(b.engine) + ' ' + esc(b.engine)], ['image', esc(b.image)],
        ['size', b.size ? esc(b.size) : '-'], ['user', userFlag(b)],
        ['last used', lastUsed(b)], ['time left' + (h.ttlSec ? ' (' + h.ttlSec / 60 + ' min idle)' : ''), ttl(b)]
      ])) +
      panel('Usage',
        boxMem(b, h) +
        kv([['runs', runList(b)]]) +
        (isAwake(h) ? '' : '<p class="caption">' + icon('clock') + ' host ' + esc(h.id) + ' is ' + esc(h.state) + '. values are last known.</p>') +
        '<div class="od-stack"><span class="overline">to change this box, run yourself</span>' +
        kv([
          ['stop it, ending its runs (files stay)', cmdText('pod stop ' + b.name)],
          ['replace it with a fresh one (files stay)', cmdText('box --recreate <command>')]
        ]) + '<p class="caption">The first runs on the host as its build account, the second in the worktree. Removing only the box files has no command of its own: a reset removes all of them.</p></div>') +
      '</div>' +
      section('box ps', 'processes in this box, oldest first', psSection(b, h)) +
      section('Runs and log', plural(b.runs.length, 'detached run'), (b.runs.length ? tabs : '') + '<div id="run-panel" role="tabpanel" aria-labelledby="' + (r ? 'tab-' + esc(r.id) : '') + '">' +
        (r ? '<p class="data sec">$ ' + (r.cmd == null ? '<span class="ter">command not recorded</span>' : esc(r.cmd)) + (r.startedAt == null ? '' : ' · started ' + clock(r.startedAt) + ', ' + ago(r.startedAt)) + '</p>' + logViewer(b, r)
          : '<div class="bx-log"><div class="bx-log__empty">no detached runs. a log exists only for a run started with <code>--detach</code>.</div></div>') + '</div>');
  };

  VIEWS.calls = function () {
    const cs = callStats();
    const f = S.callFilter;
    const q = f.q.trim().toLowerCase();
    let list = S.calls.filter((c) =>
      (f.host === 'all' || c.host === f.host) &&
      (f.outcome === 'all' || callOutcome(c) === f.outcome) &&
      (!q || ((c.cmd || '') + ' ' + c.box + ' ' + c.host + ' ' + (c.reason || '') + ' exit ' + (c.exit === null ? '' : c.exit)).toLowerCase().indexOf(q) >= 0));
    list = sorted(list, 'calls', { time: (c) => c.at, exit: (c) => c.exit, dur: (c) => c.dur, lock: (c) => c.lock });
    const filtered = f.host !== 'all' || f.outcome !== 'all' || q;
    const opt = (v, label, cur) => '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(label) + '</option>';
    const hmax = Math.max.apply(null, cs.hist.concat([1]));
    const reasons = {};
    cs.refused.forEach((c) => { const k = c.reason + '\u0000' + c.exit; reasons[k] = (reasons[k] || 0) + 1; });

    return pageHead('Calls', 'Every <code>box</code> call the hosts logged in the last 24 hours: ' + S.calls.length + (S.callsCut ? ' shown, older ones left out' : ' in the log') + '. A refused call states its reason and its own exit code.') +
      '<div class="grid grid--stats">' +
      stat('calls, last 60 min', String(cs.last60), cs.rate.toFixed(2) + ' per min') +
      stat('median duration', fmtDur(cs.median), cs.done + ' finished calls') +
      stat('p95 duration', fmtDur(cs.p95), 'slowest 5 % take longer') +
      stat('longest lock wait', fmtDur(cs.maxLock), 'waiting for a worktree lock') +
      stat('refusals', String(cs.refused.length), 'in the last 24 h') +
      stat('failed', String(cs.failed), 'non-zero exit, not refused') +
      '</div>' +
      '<div class="grid grid--2">' +
      panel('Rate, last 60 min', kv([['calls per 5 min', sparkBars(cs.buckets, cs.buckets[11] + ' in the last 5 min')], ['busiest 5 min', Math.max.apply(null, cs.buckets) + ' calls'], ['average', cs.rate.toFixed(2) + ' per min']])) +
      panel('Duration distribution', '<div class="bx-hist" role="img" aria-label="Finished calls by duration: ' + cs.labels.map((l, i) => l + ' ' + cs.hist[i]).join(', ') + '">' +
        cs.labels.map((l, i) => '<div class="bx-hist__row"><span class="bx-hist__label">' + l + '</span><span class="bx-hist__track"><span class="bx-hist__bar" data-w="' + (cs.hist[i] / hmax * 100).toFixed(1) + '"></span></span><span class="bx-hist__n">' + cs.hist[i] + '</span></div>').join('') + '</div>') +
      '</div>' +
      section('Refusal reasons', plural(cs.refused.length, 'refusal'),
        table({ caption: 'Refusal reasons', cols: [{ label: 'reason', cls: 'is-wrap' }, { label: 'count', num: true }, { label: 'exit', num: true }],
          rows: Object.keys(reasons).map((k) => { const p = k.split('\u0000'); return { cells: ['<span class="st-danger">' + icon('refusal') + '</span> ' + esc(p[0]), String(reasons[k]), 'exit ' + esc(p[1])] }; }) })) +
      section('Call log', list.length + ' of ' + S.calls.length + ' shown',
        '<div class="bx-filters">' +
        '<div class="bx-field"><label for="call-host">Host</label><select class="bx-select" id="call-host" data-input="callhost">' + opt('all', 'all hosts', f.host) + S.hosts.map((h) => opt(h.id, h.id, f.host)).join('') + '</select></div>' +
        '<div class="bx-field"><label for="call-outcome">Outcome</label><select class="bx-select" id="call-outcome" data-input="calloutcome">' +
        opt('all', 'all outcomes', f.outcome) + opt('ok', 'ok', f.outcome) + opt('failed', 'failed', f.outcome) + opt('refused', 'refused', f.outcome) + opt('detached', 'detached', f.outcome) + '</select></div>' +
        '<div class="bx-field"><label for="call-q">Search command, box, reason or exit</label><input class="bx-input" id="call-q" type="search" data-input="callq" value="' + esc(f.q) + '" placeholder="for example exit 75" autocomplete="off"></div>' +
        '<div class="bx-field">' + btn({ id: 'call-clear', act: 'callclear', label: 'Clear filters', kind: 'quiet', disabled: !filtered }) + '</div>' +
        '</div>' +
        (list.length ? callsTable(list, 'calls') : empty('no calls match', 'No call fits these filters. Clear them to see all ' + S.calls.length + ' calls.')));
  };

  VIEWS.images = function () {
    const total = sum(S.images, (i) => i.sizeGiB || 0);
    return pageHead('Images', 'Image archives every local box image is loaded from. Archives survive every reset.') +
      section('Archives', S.images.length + ' archives, ' + total.toFixed(2) + ' GiB',
        table({ caption: 'Image archives', cols: [
          { label: 'name' }, { label: 'host' }, { label: 'tag' }, { label: 'archive', cls: 'is-wrap' }, { label: 'size', num: true }, { label: 'built' }, { label: 'used by', num: true }
        ], rows: S.images.map((im) => ({ cells: [
          icon('image') + ' ' + esc(im.name), hostLink(im.host), esc(im.tag), esc(im.archive),
          im.sizeGiB == null ? '-' : im.sizeGiB.toFixed(2) + ' GiB', im.builtAt == null ? '-' : clock(im.builtAt) + ' <span class="ter">' + ago(im.builtAt) + '</span>', plural(im.usedBy, 'box')
        ] })) }));
  };

  VIEWS.services = function () {
    const body = S.hosts.map((h) => {
      const rows = S.services.filter((s) => s.host === h.id).map((s) => {
        const status = s.status === 'unknown' ? pill('asleep', 'unknown', { plain: true }) + '<span class="bx-table__sub">' + (isAwake(h) ? 'the host does not say' : 'host ' + esc(h.state)) + '</span>'
          : s.status === 'active' ? pill('ok', 'active', { plain: true }) : pill('asleep', 'inactive', { plain: true });
        const old = s.version && S.version && s.version !== S.version;
        return { cls: h.stale ? 'is-dim' : '', cells: [
          icon('service') + ' <strong>' + esc(s.name) + '</strong><span class="bx-table__sub">' + esc(SERVICE_ROLE[s.name] || '') + '</span>',
          status, s.version ? esc(s.version) + (old ? '<span class="bx-table__sub st-warning">' + glyph('warning') + ' ' + esc(S.version) + ' is the newest in the fleet</span>' : '') : DASH
        ] };
      });
      return section(h.id, '', table({ caption: 'Services on ' + h.id, cols: [{ label: 'service', cls: 'is-wrap' }, { label: 'status' }, { label: 'version' }], rows: rows }), hostPill(h, true));
    }).join('');
    return pageHead('Services', 'The three units behind each host. Status is derived from what the host answers; the page cannot start or stop them.') +
      '<div class="bx-panel"><div class="bx-panel__body"><span class="sec">On a host, as root: </span> ' + cmdText('boxctl status') + ' ' + cmdText('boxctl reload') + ' <span class="sec">; <code>boxctl start</code> and <code>boxctl stop</code> change a service.</span></div></div>' + body;
  };
  const SERVICE_ROLE = { boxd: 'accepts calls, owns boxes', 'boxd-sshd': 'call transport over ssh', 'boxd-power': 'idle sleep and wake on call' };

  VIEWS.alerts = function () {
    const open = openAlerts();
    const acked = S.alerts.filter((a) => a.acked);
    const card = (a) => '<article class="bx-card" aria-label="alert ' + esc(a.id) + '">' +
      '<div class="bx-card__head"><h3 class="bx-card__name">' + esc(a.title) + '</h3>' + pill(a.severity, a.severity) + '</div>' +
      '<div class="alert-card__grid">' +
      kv([['kind', esc(a.kind)], ['severity', pill(a.severity, a.severity, { plain: true })], ['since', clock(a.sinceAt) + ' <span class="ter">' + ago(a.sinceAt) + '</span>'],
        ['last', clock(a.lastAt) + ' <span class="ter">' + ago(a.lastAt) + '</span>'], ['occurrences', String(a.count)], ['host', hostLink(a.host)]]) +
      '<div class="od-stack"><span class="overline">observed</span><p class="prose">' + esc(a.detail) + '</p></div>' +
      '<div class="od-stack"><span class="overline">suggested action</span><p class="prose"><strong>' + esc(a.action) + '</strong></p></div>' +
      '</div>' +
      '<div class="bx-card__actions">' +
      (a.box && box(a.box) ? btn({ act: 'go', arg: 'box:' + a.box, label: 'Open box ' + a.box, icon: 'box' }) : '') +
      (a.kind === 'disk' ? btn({ act: 'go', arg: 'reset', label: 'About reset', icon: 'reset' }) : '') +
      btn({ id: 'ack-' + a.id, act: 'ack', arg: a.id, label: 'Acknowledge', icon: 'check', kind: 'primary' }) +
      '</div></article>';
    return pageHead('Alerts', 'Anomalies the dashboard computes from the hosts\' own figures over the last 24 hours. ' + plural(open.length, 'open alert') + '. Acknowledging is kept in this browser only, and an alert that happens again comes back.') +
      (open.length ? '<div class="od-stack od-stack--wide">' + open.map(card).join('') + '</div>'
        : empty(glyph('ok') + ' no open alerts', 'Nothing unusual in the last 24 hours. New anomalies appear here and on Overview.')) +
      (acked.length ? section('Acknowledged', plural(acked.length, 'alert'), table({ caption: 'Acknowledged alerts', cols: [
        { label: 'id' }, { label: 'severity' }, { label: 'alert', cls: 'is-wrap' }, { label: 'host' }, { label: 'last' }, { label: 'actions', cls: 'is-actions', hide: true }
      ], rows: acked.map((a) => ({ cells: [esc(a.id), pill(a.severity, a.severity, { plain: true }), esc(a.title), hostLink(a.host), clock(a.lastAt) + ' <span class="ter">' + ago(a.lastAt) + '</span>',
        '<div class="od-cluster">' + btn({ id: 'unack-' + a.id, act: 'unack', arg: a.id, label: 'Reopen', small: true }) + '</div>'] })) })) : '');
  };

  VIEWS.reset = function () {
    const li = (ok, text) => '<li><span class="' + (ok ? 'st-ok' : 'st-danger') + '">' + icon(ok ? 'check' : 'remove') + '</span><span>' + text + '</span></li>';
    const kinds = (title, command, pillWord, lost, stays) => panel(title, '<p>' + cmdText(command) + '</p>' +
      '<span class="overline">lost</span><ul>' + lost.map((t) => li(false, esc(t))).join('') + '</ul><span class="overline">stays</span><ul>' + stays.map((t) => li(true, esc(t))).join('') + '</ul>', pill('danger', pillWord, { plain: true }));
    const common = ['Image archives. A reset never touches them.', 'Worktrees and git history. boxd does not write to them.', 'The service settings.'];
    const base = ['The build area: build outputs, target directories, temporary files.', 'Every box, on both engines, with its box files. Boxes are created again on the next call.', 'Running and detached runs. They are killed with the rest of the build account\'s processes.'];
    const rows = S.hosts.map((h) => {
      const bs = hostBoxes(h);
      const runs = sum(bs, (b) => activeRuns(b).length);
      return { cls: h.stale ? 'is-dim' : '', cells: [hostLink(h.id), pill(h.state, h.state, { plain: true }), String(bs.length), String(runs), h.disk ? h.disk.pct + ' %' : '-'] };
    });
    return pageHead('Reset', 'A reset gives the build area back clean in seconds. This page only informs: run the command yourself, as root, on the host. It tells you first what is lost and what stays.') +
      '<div class="lost-stays">' +
      kinds('boxd-reset work', 'boxd-reset work', 'default', base, ['Caches: cargo, npm, pnpm, go, podman images, microsandbox. The next build starts warm.'].concat(common)) +
      kinds('boxd-reset all', 'boxd-reset all', 'caches too', base.concat(['Caches too: the next build downloads and compiles everything again.']), common) +
      '</div>' +
      panel('Before you run it', '<ul>' + [
        'It refuses while the build account has an ssh session or someone holds the keepawake lock. The dashboard\'s own poll is a short ssh session: if it refuses for that reason, run it again.',
        '<code>--force</code> ignores both refusals and goes on: <code>boxd-reset work --force</code>.'
      ].map((t) => '<li><span>' + t + '</span></li>').join('') + '</ul>') +
      section('Where it would act', 'the hosts as of the last answer', table({ caption: 'Hosts and what a reset would remove', cols: [
        { label: 'host' }, { label: 'state' }, { label: 'boxes', num: true }, { label: 'detached runs', num: true }, { label: 'work area', num: true }
      ], rows: rows }));
  };

  /* ---------------------------------------------------------------- the frame around a view */
  function chromeOf() {
    const awake = S.hosts.filter(isAwake).length;
    const running = S.boxes.filter((b) => activeRuns(b).length).length;
    const title = 'boxd · ' + TITLES[S.route.view] + (S.route.id ? ' · ' + S.route.id : '');
    const when = clock(S.generatedAt);
    const status = S.fetchError
      ? S.fetchError + '; showing data from ' + when + ' (' + ago(S.generatedAt) + '), read only'
      : 'boxd ' + (S.version || '(no host has answered yet)') + ', data from ' + when + ', read only';
    return {
      nav: NAV_OF[S.route.view] || S.route.view,
      counts: { hosts: S.hosts.length, boxes: S.boxes.length, calls: S.calls.length, images: S.images.length, alerts: openAlerts().length },
      crumb: 'boxd / <b>' + esc(TITLES[S.route.view]) + '</b>' + (S.route.id ? ' / <b>' + esc(S.route.id) + '</b>' : ''),
      fleet: awake + '/' + S.hosts.length + ' hosts awake · ' + plural(S.boxes.length, 'box') + ' · ' + running + ' with runs',
      status: status, title: title
    };
  }
  return { VIEWS: VIEWS, chrome: chromeOf, host: host, box: box };
}

/* the view of the current route; a route to a host or box that is gone falls back to the list, a view that throws says so */
export function renderView(S, now) {
  const b = build(S, now);
  if (S.route.view === 'host' && !b.host(S.route.id)) S.route = { view: 'hosts', id: null };
  if (S.route.view === 'box' && !b.box(S.route.id)) S.route = { view: 'boxes', id: null };
  try {
    return b.VIEWS[S.route.view]();
  } catch (err) {
    return '<div class="bx-panel"><div class="bx-empty"><span class="bx-empty__title">this view failed to render</span><span>' + esc(err && err.message ? err.message : err) + '</span></div></div>';
  }
}
export const chrome = (S, now) => build(S, now).chrome();
