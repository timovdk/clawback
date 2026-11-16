// Pure helpers (no DOM), so they can be tested with node: `node --test test/`.
import { FORM, ISSUES } from './config.js';

/** Issues that apply to a vehicle type ('bus' | 'tram'); unknown mode → all of them. */
export function issuesFor(mode) {
  return ISSUES.filter((i) => !mode || !i.modes || i.modes.includes(mode));
}

/** The chosen issue (or sub-issue), or null if not complete or not valid for this vehicle. */
export function findIssue(issueId, subId, mode) {
  const issue = issuesFor(mode).find((i) => i.id === issueId);
  if (!issue) return null;
  if (!issue.sub) return issue;
  return issue.sub.find((s) => s.id === subId) || null;
}

// --- dates -------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DDTHH:MM' in local time (value for <input type=datetime-local>). */
export function toLocalInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 'YYYY-MM-DDTHH:MM' -> 'ma 16 nov 2026, 14:05' */
export function formatWhen(local) {
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return local;
  const date = d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return `${date}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- stops -------------------------------------------------------------------

/** Distance in metres (equirectangular; accurate enough at city scale). */
export function distance(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.sqrt(x * x + y * y) * 6371000;
}

export function nearestStops(stops, lat, lon, { limit = 8, maxMetres = 1500 } = {}) {
  return stops
    .map((s) => ({ stop: s, metres: distance(lat, lon, s.lat, s.lon) }))
    .filter((x) => x.metres <= maxMetres)
    .sort((a, b) => a.metres - b.metres)
    .slice(0, limit);
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function searchStops(stops, query, limit = 20) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return stops
    .filter((s) => {
      const hay = norm(`${s.town} ${s.name}`);
      return words.every((w) => hay.includes(w));
    })
    .slice(0, limit);
}

// --- stop groups: all platforms with the same town + name ----------------------

const lineOrder = (a, b) => a.line.length - b.line.length || a.line.localeCompare(b.line, 'nl');

/**
 * Merge platforms (A/B/C, opposite sides of the road ...) into one entry per stop name.
 * Group: { key, town, name, platform: '', lat, lon, platforms: [stop],
 *          lines: [{ routeId, line, headsigns: [{ headsign, stop }] }] }
 */
export function groupStops(data) {
  const groups = new Map();
  for (const s of data.stops) {
    const key = `${s.town}|${s.name}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, town: s.town, name: s.name, platform: '', lat: s.lat, lon: s.lon, platforms: [], byRoute: new Map() };
      groups.set(key, g);
    }
    g.platforms.push(s);
    for (const [routeId, headsign] of s.lines) {
      if (!g.byRoute.has(routeId)) g.byRoute.set(routeId, new Map());
      const hs = g.byRoute.get(routeId);
      if (!hs.has(headsign)) hs.set(headsign, s);
    }
  }
  const out = [];
  for (const g of groups.values()) {
    g.lines = [...g.byRoute]
      .map(([routeId, hs]) => ({
        routeId,
        line: (data.routes[routeId] || {}).line || '?',
        headsigns: [...hs].map(([headsign, stop]) => ({ headsign, stop })).sort((a, b) => a.headsign.localeCompare(b.headsign, 'nl')),
      }))
      .sort(lineOrder);
    delete g.byRoute;
    out.push(g);
  }
  return out;
}

export function nearestGroups(groups, lat, lon, { limit = 6, maxMetres = 1500 } = {}) {
  return groups
    .map((g) => ({ group: g, metres: Math.min(...g.platforms.map((s) => distance(lat, lon, s.lat, s.lon))) }))
    .filter((x) => x.metres <= maxMetres)
    .sort((a, b) => a.metres - b.metres)
    .slice(0, limit);
}

/** What gets stored in the log and written in the complaint. */
export function slimStop(stopOrGroup) {
  if (!stopOrGroup) return null;
  const { town, name, platform = '' } = stopOrGroup;
  return { key: `${town}|${name}`, id: stopOrGroup.platforms ? null : stopOrGroup.id, town, name, platform };
}

export function stopLabel(stop) {
  const name = stop.town ? `${stop.town}, ${stop.name}` : stop.name;
  return stop.platform ? `${name} (perron ${stop.platform})` : name;
}

// --- the complaint -----------------------------------------------------------

/**
 * report: { when, line, headsign, stop, vehicle, issueId, subId, subject, text, reply, email }
 *   line/headsign: strings; stop: stop object or null.
 */
export function buildSubject(report) {
  const parts = [report.subject];
  if (report.line) parts.push(`lijn ${report.line}`);
  if (report.vehicle) parts.push(`${report.mode === 'tram' ? 'tram' : 'bus'} ${report.vehicle}`);
  return parts.filter(Boolean).join(' – ');
}

export function buildLines(report) {
  const lines = [`Datum en tijd: ${formatWhen(report.when)}`];
  if (report.line) lines.push(`Lijn: ${report.line}${report.headsign ? ` richting ${report.headsign}` : ''}`);
  if (report.stop) lines.push(`Halte: ${stopLabel(report.stop)}`);
  if (report.vehicle) lines.push(`Voertuignummer: ${report.vehicle}`);
  lines.push('');
  lines.push(...(report.text || '').split('\n'));
  const issue = findIssue(report.issueId, report.subId, report.mode);
  if (issue && issue.detail && report.detail && report.detail.trim()) {
    lines.push('', issue.detail.heading, ...report.detail.trim().split('\n'));
  }
  // trim trailing empty lines
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The form's editor collapses plain newlines, so every line becomes its own <p>. */
export function linesToHtml(lines) {
  return lines.map((l) => (l.trim() ? `<p>${escapeHtml(l)}</p>` : '<p>&nbsp;</p>')).join('');
}

export function buildFormUrl(report) {
  const issue = findIssue(report.issueId, report.subId, report.mode);
  const f = FORM.fields;
  const p = new URLSearchParams();
  p.set('ticket_form_id', FORM.ticketFormId);
  if (report.email) p.set(`tf_${f.email}`, report.email);
  p.set(`tf_${f.subject}`, buildSubject(report));
  p.set(`tf_${f.description}`, linesToHtml(buildLines(report)));
  if (issue) p.set(`tf_${f.subcategory}`, issue.subcategory);
  if (report.when) p.set(`tf_${f.date}`, report.when.slice(0, 10));
  p.set(`tf_${f.type}`, FORM.typeValue);
  p.set(`tf_${f.reply}`, report.reply ? 'ja' : 'nee');
  return `${FORM.url}?${p.toString()}`;
}

// --- log export --------------------------------------------------------------

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function logToCsv(entries) {
  const head = ['datum', 'tijd', 'lijn', 'richting', 'halte', 'voertuig', 'probleem', 'onderwerp', 'tekst', 'aangemaakt', 'status'];
  const rows = entries.map((e) => [
    e.when.slice(0, 10),
    e.when.slice(11, 16),
    e.line,
    e.headsign,
    e.stop ? stopLabel(e.stop) : '',
    e.vehicle,
    e.issueLabel,
    e.fullSubject,
    e.text,
    e.created,
    e.status === 'draft' ? 'nog versturen' : 'formulier geopend',
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
