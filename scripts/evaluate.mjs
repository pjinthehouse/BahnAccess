import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: { gold: { type: 'string' }, 'write-report': { type: 'boolean' } } });
await import('./build.mjs');
const { default: worker } = await import('../dist/server/index.js');
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const [original, regressions, netex, timetable, catalog] = await Promise.all([
  read('evaluation/questions.json'), read('evaluation/missing-evidence-regressions.json'),
  read('data/stations.json'), read('data/timetable.json'), read('config/stations.json'),
]);
const fields = { StepFreeAccess: 'step', WheelchairAccess: 'wheelchair', TactileGuidanceAvailable: 'tactile' };

async function request(path, options, app = worker) {
  return app.fetch(new Request('http://local' + path, options));
}

async function ask(body, app = worker) {
  const response = await request('/ask', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, app);
  assert.equal(response.status, 200);
  return response.json();
}

function verifyCitations(result) {
  const { citations, journey } = result;
  if (journey) {
    const fixture = timetable.dates[journey.date][journey.from.station + '-' + journey.to.station]
      .find(trip => trip.trip === journey.trip);
    const schedule = citations.find(citation => citation.id === journey.citation);
    assert.ok(fixture && schedule);
    assert.equal(schedule.tripId, fixture.trip);
    assert.ok(schedule.excerpt.includes('departure_time=' + fixture.from.rawTime));
    assert.ok(schedule.excerpt.includes('arrival_time=' + fixture.to.rawTime));
    assert.ok(schedule.excerpt.includes(fixture.calendar + ' · service_date=' + fixture.serviceDate));
  }

  const byId = new Map(citations.map(citation => [citation.id, citation]));
  assert.equal(byId.size, citations.length);
  for (const claim of result.claims) {
    if (claim.support !== 'unresolved') assert.ok(claim.citations.length, claim.text);
    for (const id of claim.citations) {
      const citation = byId.get(id);
      assert.ok(citation, 'Missing citation ' + id);
      if (citation.tripId) {
        assert.equal(citation.tripId, journey?.trip);
        continue;
      }
      const station = Object.values(netex.stations).find(record => record.name === claim.station);
      const record = citation.scope === 'StopPlace'
        ? { ...station.access, id: station.id } : station.tracks.find(track => track.id === citation.locator);
      assert.equal(citation.locator, record.id);
      if (citation.field === 'LiftEquipment') {
        assert.equal(citation.excerpt.split('\n')[0], 'LiftEquipment records under this StopPlace: ' + station.lifts.length);
        assert.deepEqual(citation.excerpt.split('\n').slice(1), station.lifts);
      } else {
        const value = record[fields[citation.field]];
        assert.ok(['true', 'false', 'partial'].includes(value), 'An unknown field must not support a claim');
        assert.equal(citation.excerpt, citation.field + ': ' + value);
      }
    }
  }
  for (const citation of citations) assert.equal(new URL(citation.url).protocol, 'https:');
  return citations.length;
}

function humanCases(dataset) {
  assert.ok(dataset.annotators?.some(name => typeof name === 'string' && name.trim()),
    'Enter the human annotator names or team IDs in annotators.');
  assert.ok(Array.isArray(dataset.cases) && dataset.cases.length, 'Add labeled cases.');
  const ids = new Set();
  for (const item of dataset.cases) {
    assert.ok(typeof item.id === 'string' && item.id.trim() && !ids.has(item.id), 'Use unique case IDs.');
    ids.add(item.id);
    assert.ok(item.input?.question?.trim(), item.id + ': enter a question.');
    assert.ok(['answered', 'partial', 'refused'].includes(item.expected), item.id + ': assign a human label.');
    assert.ok(item.rationale?.trim(), item.id + ': record your annotation rationale.');
    assert.ok(Array.isArray(item.evidence) && item.evidence.every(c => typeof c.locator === 'string' && typeof c.field === 'string'),
      item.id + ': evidence must contain locator/field pairs (or an empty array).');
  }
  const labels = new Set(dataset.cases.map(item => item.expected));
  assert.equal(labels.size, 3, 'Include fully answerable, partial and unanswerable cases.');
  return dataset.cases.map(item => ({ ...item, expect: { status: item.expected } }));
}

const cases = values.gold ? humanCases(await read(values.gold)) : [
  ...original.cases.map(item => ({ ...item, input: { ...original.defaults, ...item.input } })),
  ...regressions.cases,
];

function rate(numerator, denominator) {
  return { numerator, denominator, percent: denominator ? Math.round(10000 * numerator / denominator) / 100 : null };
}

const metrics = {};
for (const retrieval of ['bm25', 'hybrid']) {
  let refusedUnanswerable = 0;
  let falselyRefused = 0;
  let matchedLabels = 0;
  let citationsVerified = 0;
  let evidenceExpected = 0;
  let evidenceRetrieved = 0;
  const mismatches = [];
  const byLabel = { answered: 0, partial: 0, refused: 0 };
  for (const { id, input, expect, evidence } of cases) {
    const result = await ask({ ...input, retrieval, includeRetrieval: Boolean(evidence?.length) });
    assert.equal(result.retrieval, retrieval, id);
    citationsVerified += verifyCitations(result);
    byLabel[expect.status]++;
    if (result.status === expect.status) matchedLabels++;
    else mismatches.push({ id, expected: expect.status, actual: result.status });
    if (result.status === 'refused') {
      if (expect.status === 'refused') refusedUnanswerable++;
      else falselyRefused++;
    }

    if (evidence?.length) {
      const hits = (result.rankedEvidence ?? []).flatMap(group => group.hits.slice(0, 5));
      evidenceExpected += evidence.length;
      evidenceRetrieved += evidence.filter(target => hits.some(hit => hit.locator === target.locator && hit.field === target.field)).length;
    }
    if (values.gold) continue;

    assert.equal(result.status, expect.status, id);
    if (Object.hasOwn(expect, 'reason')) assert.equal(result.reason ?? null, expect.reason, id);
    if (expect.trip) assert.equal(result.journey?.trip, expect.trip, id);
    if (expect.date) assert.equal(result.journey?.date, expect.date, id);
    if (expect.claimStations) assert.deepEqual([...new Set(result.claims.map(claim => claim.station))], expect.claimStations, id);
    if (expect.answerIncludes) assert.ok(result.answer.includes(expect.answerIncludes), id + ': ' + result.answer);
    if (expect.status === 'refused' && !expect.trip) {
      assert.equal(result.journey, null, id);
      assert.deepEqual(result.citations, [], id);
    }
    if (expect.sourceFields) assert.deepEqual(
      [...new Set(result.citations.filter(c => c.field).map(c => c.field))].sort(), [...expect.sourceFields].sort(), id,
    );
    for (const stationId of expect.stationIds ?? []) assert.ok(result.citations.some(c => c.locator === stationId), id);
    if (id === 'A03') assert.equal(result.citations.filter(c => c.scope === 'Quay').length, 3);
    if (id === 'R01') {
      assert.match(result.answer, /exact platform, so its accessibility cannot be verified/);
      assert.ok(result.citations.some(c => c.scope === 'StopPlace' && c.field === 'StepFreeAccess'));
    }
    if (id === 'R02') assert.match(result.answer, /exact track cannot be determined/);
    if (id === 'R04') assert.equal(result.claims[0].station, 'Nürnberg Hbf');
    if (id === 'R09') {
      assert.equal(result.claims[0].support, 'unresolved');
      assert.equal(result.citations.length, 1);
    }
  }

  const timings = [];
  for (let repeat = 0; repeat < 15; repeat++) {
    for (const { input } of cases) {
      const start = performance.now();
      await ask({ ...input, retrieval });
      timings.push(performance.now() - start);
    }
  }
  timings.sort((a, b) => a - b);
  const percentile = p => Number(timings[Math.ceil(p * timings.length) - 1].toFixed(3));
  metrics[retrieval] = { cases: cases.length, byExpectedLabel: byLabel, matchedLabels, mismatches, citationsVerified,
    refusalRate: rate(refusedUnanswerable, byLabel.refused),
    falseRefusalRate: rate(falselyRefused, byLabel.answered + byLabel.partial),
    ...(evidenceExpected ? { accessibilityEvidenceRecallAt5PerQuery: rate(evidenceRetrieved, evidenceExpected) } : {}),
    warmLocalMs: { p50: percentile(.5), p95: percentile(.95), requests: timings.length }, modelApiCostEUR: 0 };
}

if (!values.gold) {
  const seededPairs = [['wue', 'nue'], ['muc', 'wue'], ['reg', 'nue'], ['nue', 'reg'], ['aug', 'muc'], ['muc', 'aug']];
  assert.deepEqual(Object.keys(catalog).sort(), Object.keys(netex.stations).sort());
  for (const [origin, destination] of seededPairs) {
    const result = await ask({ ...original.defaults, origin, destination });
    assert.equal(result.journey.from.station, origin);
    assert.equal(result.journey.to.station, destination);
    assert.ok(result.journey.from.sequence < result.journey.to.sequence);
    verifyCitations(result);
  }
  assert.ok(Object.values(timetable.dates).every(day => !day['reg-aug']));
  const alternative = await ask({ ...original.defaults, trip: (await ask(original.defaults)).options[1].trip, needs: ['step', 'live_lifts'] });
  assert.equal(alternative.status, 'partial');
  assert.match(alternative.unsupportedMessage, /live lift status/);
  verifyCitations(alternative);
  assert.equal((await request('/ask')).status, 405);
  assert.equal((await request('/ask', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await request('/ask', { method: 'POST', body: JSON.stringify({ ...original.defaults, after: '25:00' }) })).status, 400);
  for (const route of ['/', '/styles.css', '/app.js', '/meta', '/evaluation.json', '/evaluation-regressions.json', '/evaluation-results.json', '/health']) {
    assert.equal((await request(route)).status, 200, route);
  }

  // Exercise unavailable NeTEx fields independently of which values the real snapshot happens to contain.
  const incomplete = structuredClone(netex);
  incomplete.stations.wue.access.step = 'unknown';
  incomplete.stations.nue.access.step = null;
  const moduleFile = await readFile('dist/server/index.js', 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'bahnaccess-check-'));
  try {
    const path = join(directory, 'missing-fields.mjs');
    await writeFile(path, moduleFile.replace(/^const netex = .+;$/m, () => 'const netex = ' + JSON.stringify(incomplete) + ';'));
    const { default: app } = await import(pathToFileURL(path));
    const result = await ask(original.defaults, app);
    assert.equal(result.reason, 'no_supported_evidence');
    assert.ok(result.journey);
    assert.ok(result.claims.every(claim => claim.support === 'unresolved' && !claim.citations.length));
    assert.equal(result.citations.length, 1);
    const stationOnly = await ask({ question: 'Does Würzburg Hbf have step-free access?' }, app);
    assert.equal(stationOnly.status, 'refused');
    assert.deepEqual(stationOnly.citations, []);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const report = {
  provenance: values.gold ? 'Evaluation of user-supplied human labels.' : 'Engineering regression results. Independent human gold labels were not supplied.',
  latencyScope: 'Warm Worker handler in local Node, including JSON serialization and parsing. Network and cold starts excluded.',
  ...metrics,
};
if (values['write-report'] && !values.gold) await writeFile('evaluation/results.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
