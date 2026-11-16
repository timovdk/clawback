import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildFormUrl, buildLines, buildSubject, findIssue, groupStops, issuesFor, linesToHtml, logToCsv,
  nearestGroups, nearestStops, searchStops, slimStop, stopLabel,
} from '../js/lib.js';
import { ISSUES } from '../js/config.js';
import * as MSG from '../js/messages.js';

const data = JSON.parse(readFileSync(new URL('../data/uov.json', import.meta.url), 'utf8'));
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
