/* global m */
import { ISSUES } from './config.js';
import * as MSG from './messages.js';
import { Mascot, randomCoat } from './mascot.js';
import { load, loadSync, requestPersistence, save } from './storage.js';
import {
  buildFormUrl, buildLines, buildSubject, departureKeys, departuresAround, findIssue, formatWhen, groupStops,
  issuesFor, logToCsv,
  nearestGroups, searchStops, slimStop, stopLabel, toLocalInput,
} from './lib.js';

// --- storage: IndexedDB with a localStorage mirror, see storage.js ----------------
// Keys keep their old names so existing logs and settings carry over.
const KEYS = { settings: 'uov.settings', log: 'uov.log' };
const dirty = { settings: false, log: false }; // changed since start-up (don't overwrite with older loaded data)

const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// --- state -------------------------------------------------------------------

const S = {
  data: null,
  groups: [],
  groupByKey: new Map(),
  loadError: '',
  cats: [],
  times: null, // data/times.json, loaded when first needed
  timesState: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
  tab: 'report',

  // finding the stop
  locating: false,
  locError: '',
  coords: null, // { lat, lon } of the last location fix
  nearby: null, // [{ group, metres }]
  nearbyNote: '',
  query: '',

  // the report being made
  editingId: null, // id of a draft being finished
  stop: null, // group
  savedStop: null, // stop from a resumed draft that is no longer in the timetable data
  pickedRoute: null, // routeId chosen, waiting for direction
  line: null, // { routeId?, line, headsign, platform? }
  manualLine: false,
  vehicle: '',
  when: toLocalInput(new Date()),
  whenTouched: false,
  departure: null, // { when, key }: a departure picked from the timetable
  anchor: null, // { when, key }: the time the departure choices are shown around
  issueId: null,
  subId: null,
  subject: '',
  text: '',
  textTouched: false,
  detail: '',
  mascot: MSG.pick(MSG.START),
  coat: randomCoat(),
  tabLine: { log: MSG.pick(MSG.LOG), settings: MSG.pick(MSG.SETTINGS) },
  online: navigator.onLine,

  updateReady: false, // a newer version is stored; show the reload banner
  done: null, // { status, entry, message, cat, showCat }
  settings: { email: '', reply: true, ...loadSync(KEYS.settings, {}) },
  log: loadSync(KEYS.log, []),
};

const saveSettings = () => { dirty.settings = true; return save(KEYS.settings, S.settings); };

function applyTheme() {
  const t = S.settings.theme || 'system';
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  // Browser/status bar colour: one per scheme, or forced to the chosen one.
  const colours = { light: '#c8a2c8', dark: '#c8a2c8' }; // same mauve in both; kept per scheme in case that changes
  document.querySelectorAll('meta[name="theme-color"]').forEach((el) => {
    const scheme = el.media.includes('dark') ? 'dark' : 'light';
    el.content = colours[t === 'system' ? scheme : t];
  });
}
const saveLog = () => { dirty.log = true; return save(KEYS.log, S.log); };
const drafts = () => S.log.filter((e) => e.status === 'draft');

function route(routeId) {
  return (S.data && routeId && S.data.routes[routeId]) || null;
}

function routeForLine(line) {
  // Best-effort colour for a hand-typed line number: prefer the Utrecht Binnen route.
  if (!S.data || !line) return null;
  const matches = Object.values(S.data.routes).filter((r) => r.line.toLowerCase() === String(line).toLowerCase());
  return matches.find((r) => r.op === 'CXX') || matches[0] || null;
}

function locate() {
  if (!('geolocation' in navigator)) {
    S.locError = 'Locatie wordt niet ondersteund door deze browser.';
    return;
  }
  S.locating = true;
  S.locError = '';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      S.locating = false;
      S.coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      S.nearby = nearestGroups(S.groups, S.coords.lat, S.coords.lon);
      S.nearbyNote = '';
      if (!S.nearby.length) S.locError = 'Geen U-OV-haltes binnen 1,5 km gevonden. Zoek de halte op naam.';
      m.redraw();
    },
    (err) => {
      S.locating = false;
      S.locError = err.code === err.PERMISSION_DENIED
        ? 'Geen toegang tot locatie. Zoek de halte op naam, of sta locatie toe in je browser.'
        : 'Locatie bepalen lukte niet. Probeer opnieuw of zoek op naam.';
      m.redraw();
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
  );
}

// --- choosing ---------------------------------------------------------------------

function chooseStop(group) {
  S.stop = group;
  S.savedStop = null;
  S.pickedRoute = null;
  S.line = null;
  S.manualLine = false;
  // Only one line at this stop: pick it (and its direction, if there's only one).
  if (group && group.lines.length === 1) chooseRoute(group.lines[0]);
}

function chooseRoute(lineEntry) {
  if (lineEntry.headsigns.length === 1) chooseDirection(lineEntry, lineEntry.headsigns[0]);
  else S.pickedRoute = lineEntry.routeId;
}

function chooseDirection(lineEntry, h) {
  S.pickedRoute = null;
  S.line = { routeId: lineEntry.routeId, line: lineEntry.line, headsign: h.headsign, dir: h.dir, platform: slimStop(h.stop) };
  // If only one issue applies to this vehicle (trams: "Anders"), pick it straight away.
  const options = issuesFor(vehicleMode());
  if (options.length === 1 && !findIssue(S.issueId, S.subId, vehicleMode())) pickIssue(options[0].id);
}

/** Identifies stop + line + direction; a picked departure only counts while this matches. */
function rideKey() {
  return S.stop && S.line && S.line.routeId && S.line.dir != null ? `${S.stop.key}|${S.line.routeId}|${S.line.dir}` : null;
}

function departurePicked() {
  return !!(S.departure && S.departure.key === rideKey() && S.departure.when === S.when);
}

function ensureTimes() {
  if (S.timesState !== 'idle') return;
  S.timesState = 'loading';
  fetch('data/times.json')
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((t) => { S.times = t; S.timesState = 'ready'; })
    .catch(() => { S.timesState = 'error'; })
    .finally(() => m.redraw());
}

function pickDeparture(d) {
  const key = rideKey();
  if (!S.anchor || S.anchor.key !== key) S.anchor = { when: S.when, key };
  S.when = d.when;
  S.whenTouched = true;
  S.departure = { when: d.when, key };
}

/** 'bus' | 'tram' | null (unknown), from the chosen or typed line. */
function vehicleMode() {
  if (!S.line) return null;
  const r = route(S.line.routeId) || (S.line.line && routeForLine(S.line.line.trim()));
  return r ? r.mode : null;
}

function pickIssue(issueId, subId = null) {
  if (S.issueId !== issueId) S.mascot = MSG.pick(MSG.ISSUE[issueId] || MSG.START);
  S.issueId = issueId;
  S.subId = subId;
  const issue = findIssue(issueId, subId);
  if (issue) {
    S.subject = issue.subject;
    if (!S.textTouched) S.text = issue.text;
  }
}

// --- the report -------------------------------------------------------------------

function currentReport() {
  const platform = S.line && S.line.platform;
  return {
    when: S.when,
    line: S.line ? S.line.line.trim() : '',
    headsign: S.line ? S.line.headsign.trim() : '',
    stop: platform || slimStop(S.stop) || S.savedStop,
    vehicle: S.vehicle.trim(),
    issueId: S.issueId,
    subId: S.subId,
    mode: vehicleMode(),
    subject: S.subject.trim(),
    text: S.text,
    detail: S.detail,
    departure: departurePicked(),
    reply: S.settings.reply,
    email: S.settings.email.trim(),
  };
}

/** Everything needed to pick a draft up again later. */
function snapshot() {
  return {
    stopKey: S.stop ? S.stop.key : (S.savedStop && S.savedStop.key) || null,
    line: S.line,
    manualLine: S.manualLine,
    vehicle: S.vehicle,
    when: S.when,
    issueId: S.issueId,
    subId: S.subId,
    subject: S.subject,
    text: S.text,
    detail: S.detail,
    departure: S.departure,
    coords: S.coords,
  };
}

function sendProblems(report) {
  const out = draftProblems(report);
  if (!report.email) out.push('Vul je e-mailadres in bij Instellingen, of bewaar de melding voor later.');
  if (!report.subject) out.push('Het onderwerp is leeg.');
  if (!report.text.trim()) out.push('Beschrijf kort wat er gebeurde.');
  return out;
}

function draftProblems(report) {
  return findIssue(report.issueId, report.subId, report.mode) ? [] : ['Kies wat er mis was.'];
}

function record(status) {
  const report = currentReport();
  const issue = ISSUES.find((i) => i.id === report.issueId);
  const sub = findIssue(report.issueId, report.subId, report.mode);
  const { email, ...rest } = report;
  const previous = S.editingId && S.log.find((e) => e.id === S.editingId);
  const entry = {
    ...rest,
    id: previous ? previous.id : `${Date.now()}`,
    created: previous ? previous.created : new Date().toISOString(),
    status,
    sentAt: status === 'sent' ? new Date().toISOString() : undefined,
    issueLabel: issue.sub ? `${issue.label}: ${sub.label}` : issue.label,
    fullSubject: buildSubject(report),
    routeId: S.line && S.line.routeId,
    state: snapshot(),
  };
  S.log = previous ? S.log.map((e) => (e.id === previous.id ? entry : e)) : [entry, ...S.log];
  saveLog();
  S.done = {
    status,
    entry,
    message: MSG.pick(status === 'sent' ? MSG.DONE_SENT : MSG.DONE_DRAFT),
    cat: S.cats.length ? S.cats[Math.floor(Math.random() * S.cats.length)] : null,
    showCat: !reducedMotion(),
  };
  S.editingId = null;
  window.scrollTo(0, 0);
}

function resetReport({ keepRide }) {
  S.issueId = null;
  S.subId = null;
  S.subject = '';
  S.text = '';
  S.textTouched = false;
  S.detail = '';
  S.done = null;
  S.editingId = null;
  S.mascot = MSG.pick(MSG.START);
  S.coat = randomCoat();
  if (!keepRide) {
    S.stop = null;
    S.savedStop = null;
    S.pickedRoute = null;
    S.line = null;
    S.manualLine = false;
    S.vehicle = '';
    S.when = toLocalInput(new Date());
    S.whenTouched = false;
    S.departure = null;
    S.anchor = null;
    S.query = '';
  }
  window.scrollTo(0, 0);
}

function resumeDraft(entry) {
  resetReport({ keepRide: false });
  const st = entry.state || {};
  S.editingId = entry.id;
  S.stop = (st.stopKey && S.groupByKey.get(st.stopKey)) || null;
  // The timetable data may have been updated since the draft was saved. What was saved is
  // plain text about the ride, so it stays valid: keep the stop even if it's no longer listed.
  if (!S.stop && st.stopKey && entry.stop) S.savedStop = entry.stop;
  S.line = st.line || null;
  S.manualLine = !!st.manualLine;
  S.vehicle = st.vehicle || '';
  S.when = st.when || entry.when;
  S.whenTouched = true;
  S.issueId = st.issueId || entry.issueId;
  S.subId = st.subId != null ? st.subId : entry.subId;
  S.subject = st.subject || entry.subject;
  S.text = st.text != null ? st.text : entry.text;
  S.textTouched = true;
  S.detail = st.detail || '';
  S.departure = st.departure || null;
  S.mascot = MSG.pick(MSG.RESUME);
  if (!S.stop && !S.savedStop && st.coords) {
    S.nearby = nearestGroups(S.groups, st.coords.lat, st.coords.lon);
    S.nearbyNote = 'Haltes in de buurt van waar je de melding bewaarde:';
  }
  openTab('report');
}

function deleteEntry(entry) {
  const what = entry.status === 'draft' ? 'Deze bewaarde melding verwijderen?' : 'Deze melding uit je logboek verwijderen?';
  if (!window.confirm(what)) return;
  S.log = S.log.filter((x) => x.id !== entry.id);
  saveLog();
  if (S.editingId === entry.id) resetReport({ keepRide: false });
}

function downloadCsv() {
  const blob = new Blob(['﻿' + logToCsv(S.log)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `u-ov-meldingen-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- small components ------------------------------------------------------------

function Badge(r, text) {
  const bg = r && r.color ? `#${r.color}` : 'var(--badge-default)';
  const fg = r && r.text ? `#${r.text}` : 'var(--badge-default-text)';
  return m('span.badge', { style: { background: bg, color: fg } }, text || (r && r.line) || '?');
}

function GroupRow(group, metres) {
  return m('button.row', { type: 'button', onclick: () => chooseStop(group) }, [
    m('span.row-main', [
      m('span.row-title', stopLabel(group)),
      m('span.badges', group.lines.map((l) => Badge(route(l.routeId), l.line))),
    ]),
    metres != null && m('span.row-meta', `${Math.round(metres)} m`),
  ]);
}

// --- report sections -------------------------------------------------------------

function DraftsBanner() {
  const list = drafts().filter((e) => e.id !== S.editingId);
  if (!list.length) return null;
  return m('section.card.drafts', [
    m('h2', list.length === 1 ? '1 melding om af te maken' : `${list.length} meldingen om af te maken`),
    m('div.list', list.map((e) => m('div.draft-row', [
      m('span.row-main', [
        m('span.row-title', [e.line && Badge(route(e.routeId) || routeForLine(e.line), e.line), ' ', e.issueLabel]),
        m('span.row-meta.wrap', formatWhen(e.when)),
      ]),
      m('button.secondary.small', { type: 'button', onclick: () => resumeDraft(e) }, 'Afmaken'),
    ]))),
  ]);
}

function EditingBanner() {
  if (!S.editingId) return null;
  return m('section.card.editing', [
    m('p', [m('strong', 'Je maakt een bewaarde melding af.'), ' Vul aan wat nog ontbreekt.']),
    m('button.link', { type: 'button', onclick: () => resetReport({ keepRide: false }) }, 'Stoppen (de melding blijft bewaard)'),
  ]);
}

function StopSection() {
  if (!S.stop && S.savedStop) {
    return m('section.card', [
      m('h2', 'Halte'),
      m('div.chosen', [
        m('span', stopLabel(S.savedStop)),
        m('button.link', { type: 'button', onclick: () => { S.savedStop = null; } }, 'Wijzig'),
      ]),
      m('p.hint', 'Deze halte staat niet meer in de dienstregeling, die is bijgewerkt sinds je de melding bewaarde. Je opgeslagen gegevens blijven gewoon staan.'),
    ]);
  }
  if (S.stop) {
    return m('section.card', [
      m('h2', 'Halte'),
      m('div.chosen', [
        m('span', stopLabel(S.stop)),
        m('button.link', { type: 'button', onclick: () => chooseStop(null) }, 'Wijzig'),
      ]),
    ]);
  }
  const results = S.query.trim() ? searchStops(S.groups, S.query) : null;
  return m('section.card', [
    m('h2', 'Halte'),
    m('p.hint', 'Waar je instapte of waar het gebeurde. Mag ook leeg blijven.'),
    m('button.primary', { type: 'button', onclick: locate, disabled: S.locating }, S.locating ? 'Locatie zoeken…' : 'Zoek haltes in de buurt'),
    S.locError && m('p.warn', S.locError),
    !results && S.nearby && S.nearby.length > 0 && [
      S.nearbyNote && m('p.hint', S.nearbyNote),
      m('div.list', S.nearby.map(({ group, metres }) => GroupRow(group, metres))),
    ],
    m('label.field', [
      m('span', 'Of zoek op naam'),
      m('input[type=search]', {
        value: S.query, placeholder: 'bijv. Vaartsche Rijn', autocomplete: 'off',
        oninput: (e) => { S.query = e.target.value; },
      }),
    ]),
    results && (results.length
      ? m('div.list', results.map((g) => GroupRow(g)))
      : m('p.hint', 'Geen haltes gevonden.')),
  ]);
}

function ManualLine() {
  const set = (field) => (e) => {
    S.line = { line: '', headsign: '', ...(S.line || {}), [field]: e.target.value, routeId: undefined, platform: undefined };
  };
  return m('div.grid2', [
    m('label.field', [
      m('span', 'Lijn'),
      m('input', { value: (S.line && S.line.line) || '', placeholder: '28', oninput: set('line') }),
    ]),
    m('label.field', [
      m('span', 'Richting'),
      m('input', { value: (S.line && S.line.headsign) || '', placeholder: 'Science Park', oninput: set('headsign') }),
    ]),
  ]);
}

function LineSection() {
  // No stop: type it in.
  if (!S.stop) {
    return m('section.card', [
      m('h2', 'Lijn en richting'),
      m('p.hint', 'Kies hierboven een halte om te tikken in plaats van te typen.'),
      ManualLine(),
    ]);
  }
  // Typing instead of picking.
  if (S.manualLine) {
    return m('section.card', [
      m('h2', 'Lijn en richting'),
      ManualLine(),
      m('button.link', { type: 'button', onclick: () => { S.manualLine = false; S.line = null; } }, 'Kies uit lijnen bij deze halte'),
    ]);
  }
  // Chosen.
  if (S.line) {
    return m('section.card', [
      m('h2', 'Lijn en richting'),
      m('div.chosen', [
        m('span.inline', [Badge(route(S.line.routeId), S.line.line), ` → ${S.line.headsign}`]),
        m('button.link', { type: 'button', onclick: () => { S.line = null; } }, 'Wijzig'),
      ]),
    ]);
  }
  // Step 2b: direction.
  const picked = S.pickedRoute && S.stop.lines.find((l) => l.routeId === S.pickedRoute);
  if (picked) {
    return m('section.card', [
      m('h2', ['Richting van ', Badge(route(picked.routeId), picked.line)]),
      m('div.list', picked.headsigns.map((h) => m('button.row', {
        type: 'button', onclick: () => chooseDirection(picked, h),
      }, m('span.row-title', `→ ${h.headsign}`)))),
      m('button.link', { type: 'button', onclick: () => { S.pickedRoute = null; } }, 'Andere lijn'),
    ]);
  }
  // Step 2a: line grid.
  return m('section.card', [
    m('h2', 'Lijn'),
    m('div.line-grid', S.stop.lines.map((l) => m('button.line-btn', {
      type: 'button', 'aria-label': `Lijn ${l.line}`, onclick: () => chooseRoute(l),
    }, Badge(route(l.routeId), l.line)))),
    m('button.link', { type: 'button', onclick: () => { S.manualLine = true; S.line = null; } }, 'Lijn staat er niet bij'),
  ]);
}

function RideSection() {
  return m('section.card', [
    m('h2', 'Rit'),
    m('div.grid2', [
      m('label.field', [
        m('span', 'Voertuignummer'),
        m('input', {
          inputmode: 'numeric', value: S.vehicle,
          placeholder: vehicleMode() === 'tram' ? 'nummer in de tram' : 'sticker in de bus',
          oninput: (e) => { S.vehicle = e.target.value; },
        }),
      ]),
      m('label.field', [
        m('span', 'Datum en tijd'),
        m('input[type=datetime-local]', {
          value: S.when,
          oninput: (e) => { S.when = e.target.value; S.whenTouched = true; S.anchor = null; },
        }),
      ]),
    ]),
    DepartureChoices(),
    vehicleMode() !== 'tram' && m('p.hint', 'Bij een defecte gordel of oprijplaat helpt het voertuignummer het meest.'),
  ]);
}

/** Two earlier departures and the next one, from the timetable, around the chosen time. */
function DepartureChoices() {
  const key = rideKey();
  if (!key) return null;
  ensureTimes();
  if (S.timesState === 'loading') return m('p.hint', 'Vertrektijden laden…');
  if (S.timesState !== 'ready') return null;
  const keys = departureKeys(S.stop, S.line.routeId, S.line.dir);
  const around = S.anchor && S.anchor.key === key ? S.anchor.when : S.when;
  const { list, estimated } = departuresAround(S.times, keys, around);
  if (!list.length) return null;
  const dayLabel = (o) => (o < 0 ? ' (dag ervoor)' : o > 0 ? ' (dag erna)' : '');
  return m('div.departures', [
    m('p.departures-label', 'Welke rit? Vertrektijd bij deze halte:'),
    m('div.chips', { role: 'group', 'aria-label': 'Vertrektijden' }, list.map((d) => {
      const on = departurePicked() && S.when === d.when;
      return m('button.chip', {
        type: 'button', class: on ? 'active' : '', 'aria-pressed': String(on),
        onclick: () => pickDeparture(d),
      }, `${d.time}${dayLabel(d.dayOffset)}`);
    })),
    estimated && m('p.hint', 'Geschat: deze datum valt buiten de dienstregeling, dus dit zijn de tijden van dezelfde weekdag.'),
  ]);
}

function IssueSection() {
  const mode = vehicleMode();
  const options = issuesFor(mode);
  const issue = options.find((i) => i.id === S.issueId);
  const leaf = findIssue(S.issueId, S.subId, mode);
  return m('section.card', [
    m('h2', 'Wat was er mis?'),
    // All issues stay visible; ones that don't apply to this vehicle are greyed out.
    m('div.issues', ISSUES.map((i) => {
      const enabled = options.includes(i);
      return m('button.issue', {
        type: 'button', class: issue === i ? 'active' : '', 'aria-pressed': String(issue === i),
        disabled: !enabled,
        onclick: () => pickIssue(i.id, i.sub ? null : undefined),
      }, [m('strong', i.label), m('small', enabled ? i.hint : `niet bij de ${mode}`)]);
    })),
    issue && issue.sub && m('div.subissues', issue.sub.map((s) => m('button.chip', {
      type: 'button', class: S.subId === s.id ? 'active' : '', 'aria-pressed': String(S.subId === s.id),
      onclick: () => pickIssue(issue.id, s.id),
    }, s.label))),
    leaf && [
      m('label.field', [
        m('span', 'Onderwerp'),
        m('input', { value: S.subject, oninput: (e) => { S.subject = e.target.value; } }),
      ]),
      m('label.field', [
        m('span', 'Beschrijving'),
        m('textarea', {
          rows: 4, value: S.text,
          oninput: (e) => { S.text = e.target.value; S.textTouched = true; },
        }),
      ]),
      leaf.detail && m('label.field', [
        m('span', leaf.detail.label),
        m('textarea', {
          rows: 3, value: S.detail, placeholder: leaf.detail.placeholder,
          oninput: (e) => { S.detail = e.target.value; },
        }),
      ]),
    ],
  ]);
}

function SendSection() {
  const report = currentReport();
  const blockSend = sendProblems(report);
  const blockDraft = draftProblems(report);
  return m('section.card', [
    m('h2', 'Versturen'),
    !blockDraft.length && m('div.preview', [
      m('p.preview-subject', buildSubject(report)),
      buildLines(report).map((l) => (l ? m('p', l) : m('p.blank', ' '))),
    ]),
    !S.online && m('p.offline', 'Je bent offline. Bewaar de melding en verstuur hem later, als je weer verbinding hebt.'),
    blockSend.length > 0 && m('ul.warn', blockSend.map((p) => m('li', p))),
    m('label.toggle', [
      m('input[type=checkbox]', {
        checked: S.settings.reply,
        onchange: (e) => { S.settings.reply = e.target.checked; saveSettings(); },
      }),
      m('span', 'Ik wil een reactie van U-OV'),
    ]),
    blockSend.length || !S.online
      ? m('button.primary.big', { type: 'button', disabled: true }, 'Nu versturen')
      : m('a.primary.big', {
        href: buildFormUrl(report), target: '_blank', rel: 'noopener',
        onclick: () => record('sent'),
      }, 'Nu versturen'),
    m('button.secondary.big', {
      type: 'button', disabled: blockDraft.length > 0, onclick: () => record('draft'),
    }, S.editingId ? 'Bewaar, later verder' : 'Bewaar, later versturen'),
    m('p.hint', '“Nu versturen” opent het formulier van U-OV met alles ingevuld. Controleer het, voeg eventueel een foto toe, en verstuur. U-OV stuurt je daarna een e-mail met een bevestigingslink.'),
  ]);
}

function DoneSection() {
  const d = S.done;
  const sent = d.status === 'sent';
  return m('section.card.done', [
    m('h2', sent ? 'Formulier geopend' : 'Bewaard voor later'),
    m('p.done-message', d.message),
    d.cat && (d.showCat
      ? m('figure.cat', [
        m('img.cat-gif', {
          src: `cats/${d.cat.file}`, alt: 'Een schattige kat',
          onerror: () => { d.cat = null; },
        }),
        d.cat.credit && m('figcaption', CatCredit(d.cat.credit)),
      ])
      : m('button.secondary', { type: 'button', onclick: () => { d.showCat = true; } }, 'Laat de kat zien')),
    !d.cat && Mascot('Miauw! Goed gedaan.', S.coat),
    sent
      ? m('p', ['Vergeet niet: verstuur het formulier en ', m('strong', 'klik op de link in de bevestigingsmail'), ' van U-OV.'])
      : m('p.hint', 'Je vindt hem bovenaan bij Melden en in je Logboek. Tik op “Afmaken” als je eraan toe bent.'),
    m('div.actions', [
      m('button.primary', { type: 'button', onclick: () => resetReport({ keepRide: true }) }, 'Nog een melding over deze rit'),
      m('button.secondary', { type: 'button', onclick: () => resetReport({ keepRide: false }) }, 'Klaar'),
      sent && m('a.link', { href: buildFormUrl({ ...d.entry, email: S.settings.email }), target: '_blank', rel: 'noopener' }, 'Formulier opnieuw openen'),
    ]),
  ]);
}

function ReportTab() {
  if (S.done) return DoneSection();
  return [
    DraftsBanner(),
    EditingBanner(),
    StopSection(),
    LineSection(),
    RideSection(),
    IssueSection(),
    SendSection(),
  ];
}

// --- log & settings -----------------------------------------------------------------

function LogTab() {
  if (!S.log.length) {
    return m('section.card', [m('h2', 'Logboek'), m('p', 'Nog geen meldingen. Elke melding die je via deze app verstuurt of bewaart, komt hier te staan.')]);
  }
  const counts = {};
  S.log.forEach((e) => { counts[e.issueLabel] = (counts[e.issueLabel] || 0) + 1; });
  const sentCount = S.log.filter((e) => e.status !== 'draft').length;
  return [
    m('section.card', [
      m('h2', `Logboek (${S.log.length})`),
      m('p', `${sentCount} verstuurd, ${S.log.length - sentCount} nog af te maken. Elke melding telt.`),
      m('ul.counts', Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => m('li', [m('strong', v), ` ${k}`]))),
      m('div.actions', [m('button.secondary', { type: 'button', onclick: downloadCsv }, 'Exporteer als CSV')]),
      m('p.hint', 'Het logboek staat alleen op dit apparaat. Exporteer het af en toe als back-up.'),
    ]),
    S.log.map((e) => m('section.card.entry', { key: e.id, class: e.status === 'draft' ? 'is-draft' : '' }, [
      m('div.entry-head', [
        e.line && Badge(route(e.routeId) || routeForLine(e.line), e.line),
        m('strong', e.issueLabel),
        e.status === 'draft' && m('span.tag', 'Nog versturen'),
        m('span.row-meta', formatWhen(e.when)),
      ]),
      m('p', e.fullSubject),
      e.stop && m('p.hint', stopLabel(e.stop)),
      m('div.actions', [
        e.status === 'draft'
          ? m('button.link', { type: 'button', onclick: () => resumeDraft(e) }, 'Afmaken')
          : m('a.link', { href: buildFormUrl({ ...e, email: S.settings.email }), target: '_blank', rel: 'noopener' }, 'Formulier opnieuw openen'),
        m('button.link.danger', { type: 'button', onclick: () => deleteEntry(e) }, 'Verwijderen'),
      ]),
    ])),
  ];
}

function SettingsTab() {
  const feed = S.data && S.data.feed;
  // The feed only covers ~4 weeks ahead, so it's refreshed weekly. Warn when that seems to have
  // stopped: data older than 3 weeks means departure times beyond the feed are estimates.
  const built = S.data && new Date(S.data.generated);
  const ageDays = built ? (Date.now() - built.getTime()) / 86400000 : 0;
  return [
    m('section.card', [
      m('h2', 'Instellingen'),
      m('label.field', [
        m('span', 'Je e-mailadres'),
        m('input[type=email]', {
          value: S.settings.email, autocomplete: 'email', placeholder: 'naam@voorbeeld.nl',
          oninput: (e) => { S.settings.email = e.target.value; saveSettings(); },
        }),
      ]),
      m('p.hint', 'Wordt alleen op dit apparaat bewaard en in het U-OV-formulier ingevuld. U-OV stuurt hier de bevestigingslink naartoe.'),
    ]),
    m('section.card', [
      m('h2#theme-label', 'Weergave'),
      m('div.segmented', { role: 'radiogroup', 'aria-labelledby': 'theme-label' },
        [['system', 'Systeem'], ['light', 'Licht'], ['dark', 'Donker']].map(([value, label]) => {
          const on = (S.settings.theme || 'system') === value;
          return m('button', {
            type: 'button', role: 'radio', 'aria-checked': String(on), class: on ? 'active' : '',
            onclick: () => { S.settings.theme = value; saveSettings(); applyTheme(); },
          }, label);
        })),
    ]),
    feed && m('section.card', [
      m('h2', 'Dienstregeling'),
      m('p', `${S.groups.length} haltes, ${Object.keys(S.data.routes).length} lijnen (${Object.values(S.data.operators).join(', ')}).`),
      m('p.hint', `Bijgewerkt op ${built.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })}. Wordt elke week automatisch ververst.`),
      ageDays > 21 && m('p.warn', 'De gegevens zijn al een tijd niet ververst. Vertrektijden kunnen geschat zijn, en nieuwe haltes of lijnen kunnen ontbreken.'),
    ]),
    AboutSection(),
  ];
}

function CatCredit(c) {
  return [c.author, ', ', c.url ? m('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.license) : c.license];
}

function AboutSection() {
  const credited = S.cats.filter((c) => c.credit);
  const ext = (href, text) => m('a', { href, target: '_blank', rel: 'noopener' }, text);
  return m('section.card.about', [
    m('h2', 'Over deze app'),
    m('p', [m('strong', 'Geen app van U-OV.'), ' Dit is een onafhankelijk hulpmiddel, niet van of namens U-OV, Transdev of Keolis. Je melding gaat via het officiële klantenserviceformulier van U-OV; de app vult dat alleen voor je in.']),
    m('h3', 'Privacy'),
    m('p', 'De app verstuurt zelf niets. Je e-mailadres, je logboek en je locatie blijven op dit apparaat. Pas als je op “Nu versturen” tikt, gaan je gegevens naar U-OV, via hun eigen formulier.'),
    m('h3', 'Haltes en lijnen'),
    m('p', ['Open data (CC0) van de Nederlandse vervoerders via NDOV Loket, omgezet door ', ext('https://gtfs.ovapi.nl/', 'OVapi'), '. Zonder garantie dat alles klopt.']),
    m('h3', 'Software'),
    m('p', ['Clawback is open source onder de ', ext('LICENSE', 'EUPL-1.2'), ': je mag de code gebruiken en aanpassen, zolang aangepaste versies ook open source blijven. Gemaakt met ', ext('https://mithril.js.org/', 'Mithril.js'), ' (© Leo Horie, ', ext('vendor/mithril.LICENSE', 'MIT-licentie'), ').']),
    credited.length > 0 && [
      m('h3', 'Katten'),
      m('ul.credits', credited.map((c) => m('li', [c.file, ': ', CatCredit(c.credit)]))),
    ],
  ]);
}

/** What the mascot says at the top of the current tab. */
function headerMessage() {
  if (S.tab === 'log') {
    if (!S.log.length) return MSG.LOG_EMPTY[0];
    if (drafts().length) return MSG.LOG_DRAFTS[0];
    return S.tabLine.log;
  }
  if (S.tab === 'settings') return S.settings.email.trim() ? S.tabLine.settings : MSG.SETTINGS_NO_EMAIL[0];
  if (S.done) return MSG.DONE_HEADER[0];
  return S.mascot;
}

function openTab(id) {
  if (id !== S.tab) S.tabLine = { log: MSG.pick(MSG.LOG), settings: MSG.pick(MSG.SETTINGS) };
  S.tab = id;
  window.scrollTo(0, 0);
}

/** Is there a complaint on screen that would be lost by reloading? */
function unsavedWork() {
  return !S.done && !!(S.issueId || S.stop || S.savedStop || S.line || S.vehicle.trim() || S.text.trim());
}

function UpdateBanner() {
  if (!S.updateReady) return null;
  return m('div.update-banner', { role: 'status' }, [
    m('p', [
      m('strong', 'Er is een nieuwe versie van Clawback.'),
      unsavedWork() && m('span', ' Verstuur of bewaar eerst je melding; herladen wist wat nog niet bewaard is.'),
    ]),
    m('div.update-actions', [
      m('button.primary.small', { type: 'button', onclick: () => window.location.reload() }, 'Herladen'),
      m('button.link', { type: 'button', onclick: () => { S.updateReady = false; } }, 'Later'),
    ]),
  ]);
}

const TABS = [['report', 'Melden'], ['log', 'Logboek'], ['settings', 'Instellingen']];

const App = {
  view() {
    let body;
    if (S.loadError) body = m('section.card', m('p.warn', S.loadError));
    else if (!S.data) body = m('section.card', m('p', 'Laden…'));
    else body = { report: ReportTab, log: LogTab, settings: SettingsTab }[S.tab]();
    const draftCount = drafts().length;
    return [
      m('header', [
        // On the report screen the mascot lives in the sticky header, so it stays in view.
        // The mascot lives in the sticky header on every tab, so it stays in view.
        S.data
          ? [m('h1.visually-hidden', 'Clawback'), m('div', { 'aria-live': 'polite' }, Mascot(headerMessage(), S.coat))]
          : m('h1', 'Clawback'),
        m('nav', { 'aria-label': 'Onderdelen' }, TABS.map(([id, label]) => {
          let extra = null;
          if (id === 'settings' && !S.settings.email.trim()) extra = m('span.dot', { 'aria-label': ' (e-mailadres ontbreekt)' });
          if (id === 'log' && draftCount) extra = m('span.count', { 'aria-label': ` (${draftCount} om af te maken)` }, draftCount);
          return m('button', {
            type: 'button', class: S.tab === id ? 'active' : '', 'aria-current': S.tab === id ? 'page' : null,
            onclick: () => openTab(id),
          }, [label, extra]);
        })),
      ]),
      m('main', body),
      UpdateBanner(),
    ];
  },
};

// Keep "now" fresh when the app comes back to the foreground, unless the user set a time.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !S.whenTouched && !S.done) {
    S.when = toLocalInput(new Date());
    m.redraw();
  }
});

for (const ev of ['online', 'offline']) {
  window.addEventListener(ev, () => { S.online = navigator.onLine; m.redraw(); });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Pick up newly added cats for offline use.
  navigator.serviceWorker.ready.then((reg) => reg.active && reg.active.postMessage('precache-cats')).catch(() => {});

  // Update banner: the service worker found newer files, or a new service worker took over.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'update-available') { S.updateReady = true; m.redraw(); }
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) { S.updateReady = true; m.redraw(); }
  });
  navigator.serviceWorker.startMessages();
}

applyTheme();
m.mount(document.getElementById('app'), App);

// The synchronous mirror is shown first; then switch to the durable copy (unless already edited).
requestPersistence();
Promise.all([load(KEYS.settings, null), load(KEYS.log, null)]).then(([settings, log]) => {
  if (settings && !dirty.settings) { S.settings = { email: '', reply: true, ...settings }; applyTheme(); }
  if (Array.isArray(log) && !dirty.log) S.log = log;
  m.redraw();
});

fetch('cats/cats.json')
  .then((r) => (r.ok ? r.json() : []))
  .then((list) => {
    // entries are { file, credit? }; plain file names are accepted too
    S.cats = (Array.isArray(list) ? list : []).map((c) => (typeof c === 'string' ? { file: c } : c)).filter((c) => c && c.file);
  })
  .catch(() => {});

fetch('data/uov.json')
  .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then((d) => {
    S.data = d;
    S.groups = groupStops(d);
    S.groupByKey = new Map(S.groups.map((g) => [g.key, g]));
    locate();
  })
  .catch(() => { S.loadError = 'Haltegegevens konden niet geladen worden. Controleer je verbinding en herlaad de pagina.'; })
  .finally(() => m.redraw());
