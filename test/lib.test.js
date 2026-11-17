import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  buildFormUrl, buildLines, buildSubject, dayDepartures, departureKeys, departuresAround, findIssue,
  groupStops, issuesFor, labelledKeys, MAX_ESTIMATE_DAYS, linesToHtml, logToCsv,
  nearestGroups, nearestStops, searchStops, slimStop, stopLabel,
} from '../js/lib.js';
import { ISSUES } from '../js/config.js';
import * as MSG from '../js/messages.js';

// The data under test: data/ by default; the NAS refresh points CLAWBACK_DATA_DIR at a fresh
// build to check it before uploading (nas/clawback_data.py).
const dataDir = process.env.CLAWBACK_DATA_DIR
  ? pathToFileURL(`${process.env.CLAWBACK_DATA_DIR.replace(/\/$/, '')}/`)
  : new URL('../data/', import.meta.url);
const data = JSON.parse(readFileSync(new URL('uov.json', dataDir), 'utf8'));
const times = JSON.parse(readFileSync(new URL('times.json', dataDir), 'utf8'));
const vaartscheC = data.stops.find((s) => s.name === 'Station Vaartsche Rijn' && s.platform === 'C');

const report = {
  when: '2026-11-16T14:05',
  line: '28',
  headsign: 'Science Park',
  stop: vaartscheC,
  vehicle: '4123',
  issueId: 'seatbelt',
  subject: 'Gordel rolstoelplek defect',
  text: 'Regel een\n\nRegel <twee> & "drie"',
  reply: true,
  email: 'iemand@example.com',
};

test('every issue resolves to a valid subcategory', () => {
  const allowed = new Set(['instappen_en_haltes', 'gebrek_aan_hulp_bij_instappen',
    'onveilig_of_niet_prettig_gevoel_tijdens_de_reis_', 'overig']);
  for (const i of ISSUES) {
    for (const leaf of i.sub || [i]) {
      assert.ok(allowed.has(leaf.subcategory), `${leaf.id}: ${leaf.subcategory}`);
      assert.ok(leaf.subject);
    }
  }
  assert.equal(findIssue('driver', null), null, 'driver needs a sub-choice');
  assert.equal(findIssue('driver', 'ableist').id, 'ableist');
  assert.equal(findIssue('driver', 'rude'), null, 'rude was removed');
});

test('subject includes line and vehicle', () => {
  assert.equal(buildSubject(report), 'Gordel rolstoelplek defect – lijn 28 – bus 4123');
  assert.equal(buildSubject({ ...report, line: '', vehicle: '' }), 'Gordel rolstoelplek defect');
});

test('description lines and HTML', () => {
  const lines = buildLines(report);
  assert.match(lines[0], /^Datum en tijd: .*16.*nov.*2026, 14:05$/);
  assert.deepEqual(lines.slice(1), [
    'Lijn: 28 richting Science Park',
    'Halte: Utrecht, Station Vaartsche Rijn (perron C)',
    'Voertuignummer: 4123',
    '',
    'Regel een',
    '',
    'Regel <twee> & "drie"',
  ]);
  assert.equal(
    linesToHtml(['a', '', '<b>']),
    '<p>a</p><p>&nbsp;</p><p>&lt;b&gt;</p>',
  );
});

test('form URL matches the verified prefill format', () => {
  const url = new URL(buildFormUrl(report));
  const q = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://klantenservice.u-ov.nl/hc/nl/requests/new');
  assert.equal(q.get('ticket_form_id'), '31913821575069');
  assert.equal(q.get('tf_anonymous_requester_email'), 'iemand@example.com');
  assert.equal(q.get('tf_31970454147613'), 'onveilig_of_niet_prettig_gevoel_tijdens_de_reis_');
  assert.equal(q.get('tf_31967369101853'), '2026-11-16');
  assert.equal(q.get('tf_31914234696349'), 'klacht');
  assert.equal(q.get('tf_31915063055389'), 'ja');
  assert.ok(q.get('tf_description').startsWith('<p>Datum en tijd:'));
  assert.ok(q.get('tf_description').includes('<p>&nbsp;</p>'));
  assert.equal(new URL(buildFormUrl({ ...report, reply: false })).searchParams.get('tf_31915063055389'), 'nee');
  assert.ok(url.href.length < 2000, `URL is ${url.href.length} chars`);
});

test('stops: data, nearest and search', () => {
  assert.ok(vaartscheC, 'Vaartsche Rijn C exists');
  assert.equal(stopLabel(vaartscheC), 'Utrecht, Station Vaartsche Rijn (perron C)');
  const lines = vaartscheC.lines.map(([rid]) => data.routes[rid].line);
  assert.ok(lines.includes('8') && lines.includes('29'));

  const near = nearestStops(data.stops, vaartscheC.lat, vaartscheC.lon);
  assert.equal(near[0].stop.id, vaartscheC.id);
  assert.ok(near[0].metres < 1);

  const found = searchStops(data.stops, 'vaartsche rijn');
  assert.ok(found.some((s) => s.id === vaartscheC.id));
  assert.ok(searchStops(data.stops, 'utrecht  vaartsche').length > 0);
});

test('tram and line 28 colors come through', () => {
  const byLine = (l) => Object.values(data.routes).find((r) => r.line === l && r.op === 'CXX');
  assert.equal(byLine('20').color, 'ff0010');
  assert.equal(byLine('20').mode, 'tram');
  assert.equal(byLine('28').color, '4cac48');
});

test('CSV export escapes properly', () => {
  const csv = logToCsv([{ ...report, issueLabel: 'Gordel', fullSubject: buildSubject(report), created: 'x' }]);
  const [head, row] = csv.split('\r\n');
  assert.ok(head.startsWith('datum,tijd,lijn'));
  assert.ok(row.startsWith('2026-11-16,14:05,28,Science Park,'));
  assert.ok(row.includes('"Regel een\n\nRegel <twee> & ""drie"""'));
});

test('stop groups merge platforms and give line -> directions', () => {
  const groups = groupStops(data);
  assert.ok(groups.length < data.stops.length);
  const g = groups.find((x) => x.town === 'Utrecht' && x.name === 'Station Vaartsche Rijn');
  assert.equal(g.platforms.length, 4);
  assert.equal(stopLabel(g), 'Utrecht, Station Vaartsche Rijn');
  assert.deepEqual(g.lines.map((l) => l.line).slice(0, 7), ['8', '9', '20', '21', '22', '29', '47']);
  const l8 = g.lines.find((l) => l.line === '8');
  assert.deepEqual(l8.headsigns.map((h) => h.headsign), ['Lunetten', 'Wilhelminapark']);
  const lunetten = l8.headsigns.find((h) => h.headsign === 'Lunetten');
  assert.equal(lunetten.stop.platform, 'D', 'direction tells us the platform');
  assert.equal(stopLabel(slimStop(lunetten.stop)), 'Utrecht, Station Vaartsche Rijn (perron D)');

  // opposite sides of the road with the same name become one stop
  const bonaire = groups.filter((x) => x.town === 'Amersfoort' && x.name === 'Bonairelaan');
  assert.equal(bonaire.length, 1);
  assert.equal(bonaire[0].platforms.length, 2);

  const near = nearestGroups(groups, g.lat, g.lon);
  assert.equal(near[0].group.key, g.key);
  assert.ok(searchStops(groups, 'vaartsche').some((x) => x.key === g.key));
});

test('slimStop of a group has no platform', () => {
  const g = groupStops(data).find((x) => x.name === 'Station Vaartsche Rijn');
  assert.deepEqual(slimStop(g), { key: 'Utrecht|Station Vaartsche Rijn', id: null, town: 'Utrecht', name: 'Station Vaartsche Rijn', platform: '' });
  assert.equal(slimStop(null), null);
});

test('trams only get "Anders"; buses get everything', () => {
  assert.deepEqual(issuesFor('tram').map((i) => i.id), ['other']);
  assert.deepEqual(issuesFor('bus').map((i) => i.id), ['seatbelt', 'ramp', 'driver', 'other']);
  assert.equal(issuesFor(null).length, 4, 'unknown vehicle: show all');
  assert.equal(findIssue('seatbelt', undefined, 'tram'), null);
  assert.equal(findIssue('other', undefined, 'tram').id, 'other');
  assert.equal(buildSubject({ subject: 'X', line: '20', vehicle: '5001', mode: 'tram' }), 'X – lijn 20 – tram 5001');
});

test('driver detail is added as its own block', () => {
  const r = { ...report, issueId: 'driver', subId: 'inappropriate', mode: 'bus', text: 'De chauffeur maakte een ongepaste opmerking.', detail: 'Zei: "jij hoort hier niet"\nen lachte' };
  const lines = buildLines(r);
  assert.deepEqual(lines.slice(-5), ['De chauffeur maakte een ongepaste opmerking.', '', 'Wat de chauffeur zei of deed:', 'Zei: "jij hoort hier niet"', 'en lachte']);
  // no detail block for issues without one, even if text was left in state
  assert.ok(!buildLines({ ...r, subId: 'driving' }).includes('Wat de chauffeur zei of deed:'));
  assert.ok(!buildLines({ ...r, detail: '  ' }).includes('Wat de chauffeur zei of deed:'));
});

test('mascot lines in the top bar fit on two lines (≤ 60 characters)', () => {
  const headerLines = [
    ...MSG.START, ...Object.values(MSG.ISSUE).flat(), ...MSG.RESUME,
    ...MSG.LOG, ...MSG.LOG_EMPTY, ...MSG.LOG_DRAFTS,
    ...MSG.SETTINGS, ...MSG.SETTINGS_NO_EMAIL, ...MSG.DONE_HEADER,
  ];
  for (const line of headerLines) assert.ok(line.length <= 60, `${line.length} chars: ${line}`);
});

// Dates relative to the feed, so the tests keep working after the monthly data refresh.
const feedDate = (i) => { const s = times.dates[i]; return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)); };
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const midWeek = (() => { for (let i = 0; i < times.dates.length; i++) if (feedDate(i).getDay() === 3) return feedDate(i); return feedDate(0); })();
// The first date after the data with the same weekday as midWeek, plus `weeks` extra weeks.
const sameWeekdayAfterData = (weeks = 0) => {
  const last = feedDate(times.dates.length - 1);
  const d = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  while (d.getDay() !== midWeek.getDay()) d.setDate(d.getDate() + 1);
  d.setDate(d.getDate() + 7 * weeks);
  return d;
};

test('departures: two before and the next one, for line 8 to Lunetten', () => {
  const g = groupStops(data).find((x) => x.name === 'Station Vaartsche Rijn');
  const l8 = g.lines.find((l) => l.line === '8');
  const lunetten = l8.headsigns.find((h) => h.headsign === 'Lunetten');
  const keys = departureKeys(g, l8.routeId, lunetten.dir);
  assert.ok(keys.length >= 1);
  assert.ok(keys.every((k) => k.endsWith(`|${l8.routeId}|${lunetten.dir}`)));

  const at = `${localDay(midWeek)}T14:00`;
  const { list, estimated } = departuresAround(times, keys, at);
  assert.equal(estimated, false);
  assert.equal(list.length, 4);
  assert.ok(list[0].when < list[1].when && list[1].when <= at && list[2].when > at && list[3].when > list[2].when, JSON.stringify(list));
  assert.ok(list.every((d) => d.dayOffset === 0 && /^\d\d:\d\d$/.test(d.time)));
});

test('departures: dates outside the feed use the same weekday', () => {
  const key = Object.keys(times.k)[0];
  const inside = dayDepartures(times, key, midWeek);
  const later = sameWeekdayAfterData();
  const outside = dayDepartures(times, key, later);
  assert.equal(inside.estimated, false);
  assert.equal(outside.estimated, true);
  assert.equal(later.getDay(), midWeek.getDay());
  assert.ok(outside.minutes.length > 0);
});

test('departures: trips after midnight belong to the previous service day', () => {
  // a key with a departure after 24:00 on some date
  let found = null;
  for (const [key, entry] of Object.entries(times.k)) {
    for (let i = 1; i < times.dates.length - 1 && !found; i++) {
      const late = entry.p[entry.d[i]].find((t) => t >= 1440 && t < 1500);
      if (late) found = { key, i, late };
    }
    if (found) break;
  }
  assert.ok(found, 'some trip runs after midnight');
  const next = new Date(feedDate(found.i).getFullYear(), feedDate(found.i).getMonth(), feedDate(found.i).getDate() + 1);
  const mins = found.late - 1440;
  const hhmm = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  const { list } = departuresAround(times, [found.key], `${localDay(next)}T${hhmm}`, { before: 1, after: 0 });
  assert.equal(list.length, 1);
  assert.equal(list[0].when, `${localDay(next)}T${hhmm}`, 'shown on the calendar day it actually departs');
});

test('a picked departure is described as the scheduled departure of the ride', () => {
  const lines = buildLines({ ...report, departure: true });
  assert.match(lines[0], /^Datum: .*16.*nov.*2026$/);
  assert.equal(lines[1], 'Geplande vertrektijd van de rit: 14:05 (volgens de dienstregeling)');
  assert.equal(lines[2], 'Lijn: 28 richting Science Park');
  assert.equal(buildSubject({ ...report, departure: true }), 'Gordel rolstoelplek defect – lijn 28 – rit van 14:05 – bus 4123');
  // without a picked departure nothing changes
  assert.match(buildLines(report)[0], /^Datum en tijd: /);
  assert.doesNotMatch(buildLines(report).join(' '), /vertrektijd/);
  assert.doesNotMatch(buildSubject(report), /rit van/);
});

test('fallback uses the most common timetable for that weekday, not a one-off day', () => {
  const key = Object.keys(times.k).find((k) => {
    const e = times.k[k];
    return new Set(e.d).size > 2; // has some variation
  });
  const e = times.k[key];
  const weekday = midWeek.getDay();
  const counts = {};
  times.dates.forEach((s, j) => {
    if (new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getDay() === weekday) counts[e.d[j]] = (counts[e.d[j]] || 0) + 1;
  });
  const common = +Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const near = sameWeekdayAfterData(1);
  assert.deepEqual(dayDepartures(times, key, near).minutes, e.p[common]);
});

test('loop lines: both directions to the same destination are listed separately, with "via"', () => {
  const groups = groupStops(data);
  for (const g of groups) {
    for (const l of g.lines) {
      const labels = l.headsigns.map((h) => h.headsign);
      assert.equal(new Set(labels).size, labels.length, `${g.key} line ${l.line}: ${labels}`);
    }
  }
  const helium = groups.find((g) => g.name === 'Heliumweg').lines.find((l) => l.line === '1');
  assert.equal(helium.headsigns.length, 2);
  assert.ok(helium.headsigns.every((h) => /^Centraal Station \(via .+\)$/.test(h.headsign)));
  assert.notEqual(helium.headsigns[0].dir, helium.headsigns[1].dir);
});

test('platform codes are not part of stop names, so all platforms of a station form one stop', () => {
  for (const st of data.stops) {
    if (st.platform) assert.ok(!st.name.endsWith(`(${st.platform})`), `${st.town}, ${st.name}`);
  }
  const cs = groupStops(data).find((g) => g.key === 'Utrecht|CS Jaarbeurszijde');
  assert.ok(cs && cs.platforms.length >= 10, 'CS Jaarbeurszijde has its C and D platforms together');
});

test('other destinations in a direction: own choice, and labelled departures under the main one', () => {
  const groups = groupStops(data);
  let checked = 0;
  for (const g of groups) {
    for (const l of g.lines) {
      for (const h of l.headsigns) {
        for (const other of h.others) {
          assert.notEqual(other, h.headsign);
          const keys = departureKeys(g, l.routeId, h.dir);
          const only = departureKeys(g, l.routeId, h.dir, other);
          assert.ok(only.some((k) => times.k[k]), `${g.key} ${l.line} → ${other} has departures`);
          // every departure to `other` is also in the direction, and labelled there
          const all = labelledKeys(times, keys);
          assert.ok(all.some((k) => Array.isArray(k) && k[1] === other));
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 50, `only ${checked} directions with other destinations`);

  // One concrete ride: pick a direction with another destination and find a departure to it.
  const g = groups.find((x) => x.lines.some((l) => l.headsigns.some((h) => h.others.length)));
  const l = g.lines.find((x) => x.headsigns.some((h) => h.others.length));
  const h = l.headsigns.find((x) => x.others.length);
  const other = h.others[0];
  const only = departureKeys(g, l.routeId, h.dir, other);
  const [key] = only.filter((k) => times.k[k]);
  const e = times.k[key];
  const day = e.d.findIndex((p) => e.p[p].length);
  const minute = e.p[e.d[day]][0];
  const date = times.dates[day];
  const at = new Date(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), 0, minute);
  const local = `${localDay(at)}T${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const mixed = departuresAround(times, labelledKeys(times, departureKeys(g, l.routeId, h.dir)), local, { before: 1, after: 0 });
  assert.equal(mixed.list[0].when, local);
  assert.equal(mixed.list[0].headsign, other);
  const filtered = departuresAround(times, only, local, { before: 1, after: 0 });
  assert.equal(filtered.list[0].when, local);
});

test('uov.json and times.json come from the same build', () => {
  assert.ok(data.build, 'uov.json has a build id');
  assert.equal(times.build, data.build);
});

test('departure data that is too old gives no departures instead of guesses', () => {
  const key = Object.keys(times.k)[0];
  const tooFar = sameWeekdayAfterData(Math.ceil(MAX_ESTIMATE_DAYS / 7) + 1);
  assert.deepEqual(dayDepartures(times, key, tooFar), { minutes: [], estimated: false });
  const at = `${localDay(tooFar)}T14:00`;
  assert.deepEqual(departuresAround(times, [key], at).list, []);
});
