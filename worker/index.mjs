const { stations } = netex;
const passages = makePassages(netex);
const bm25 = makeBM25(passages);
const hybrid = makeHybrid(vectors, bm25);
const stationNames = Object.fromEntries(Object.entries(stationCatalog).map(([id, station]) => [id, station.name]));
const unsupported = {
  live_lifts: 'live lift status',
  onboard_toilet: 'onboard toilet accessibility',
  assistance_booking: 'an assistance booking',
  access_path: 'the exact path between an entrance or exit and this platform',
  live_train_status: 'real-time train status',
  fare: 'ticket fares or availability',
  bicycle: 'bicycle carriage',
  weather: 'weather',
  meals: 'onboard food service',
};
const links = {
  gtfs: 'https://www.gtfs.de/en/feeds/de_full/',
  netex: 'https://github.com/dbinfrago/openstation-docs',
  netexDownload: 'https://bahnhof.de/daten/netex',
  db: 'https://int.bahn.de/en',
  assistance: 'https://int.bahn.de/en/booking-information/accessible-travel',
};

const metadata = {
  stations: stationNames,
  stationMap: Object.fromEntries(Object.entries(stationCatalog).map(([id, station]) => [id, station.map])),
  directPairs: [...new Set(Object.values(timetable.dates).flatMap(day => Object.keys(day)))],
  timetable: { first: timetable.first, last: timetable.last, snapshot: timetable.snapshot, url: links.gtfs },
  infrastructure: { snapshot: netex.timestamp, url: links.netex },
  links,
};

function timeLabel(minutes) {
  const time = minutes % 1440;
  return String(Math.floor(time / 60)).padStart(2, '0') + ':' + String(time % 60).padStart(2, '0');
}

function timetableCitation(trip) {
  const { from, to } = trip;
  return {
    id: 1,
    title: 'Scheduled rail service',
    publisher: 'GTFS.de / DELFI e.V.',
    url: links.gtfs,
    snapshot: timetable.snapshot,
    locator: 'trip_id=' + trip.trip + ' · service_id=' + trip.service,
    tripId: trip.trip,
    scope: 'GTFS trip',
    excerpt: [
      'route_short_name: ' + trip.line,
      'stop_times.txt · ' + stations[from.station].name + ' · stop_id=' + from.stop + ' · stop_sequence=' + from.sequence + ' · departure_time=' + from.rawTime,
      'stop_times.txt · ' + stations[to.station].name + ' · stop_id=' + to.stop + ' · stop_sequence=' + to.sequence + ' · arrival_time=' + to.rawTime,
      trip.calendar + ' · service_date=' + trip.serviceDate,
      'stops.txt · platform_code (departure): ' + (from.track ?? 'blank') + ' · platform_code (arrival): ' + (to.track ?? 'blank'),
      ...(from.area ? ['Scheduled departure track group in stop_name: ' + from.area] : []),
      ...(to.area ? ['Scheduled arrival track group in stop_name: ' + to.area] : []),
    ].join('\n'),
  };
}

function evidenceCitation(chunk, id) {
  return {
    id, title: chunk.title + ' · ' + (chunk.need === 'wheelchair' ? 'Wheelchair access' : intents[chunk.need].label), publisher: 'DB InfraGO · OpenStation NeTEx',
    snapshot: netex.timestamp.slice(0, 10), url: links.netexDownload, stationPage: chunk.url,
    scope: chunk.numbers.length ? 'Quay' : 'StopPlace',
    locator: chunk.entity, field: chunk.field, excerpt: chunk.excerpt,
  };
}

const textualValue = {
  true: 'listed as available', false: 'listed as unavailable',
  partial: 'listed as partially available', unknown: 'marked unknown',
};

function summaryFor(chunk) {
  if (chunk.need === 'lifts') {
    if (chunk.value === 0) return 'This station record contains no lift entries. Other station areas may have separate records.';
    return chunk.value + ' lift ' + (chunk.value === 1 ? 'entry is' : 'entries are') + ' listed in this station inventory. Check operating status with DB.';
  }
  const label = chunk.need === 'wheelchair' ? 'Wheelchair access' : intents[chunk.need].label;
  return label + ' is ' + (textualValue[chunk.value] ?? 'missing from this record')
    + (chunk.numbers.length ? ' for tracks ' + chunk.numbers.join('/') + '.' : ' at station level.');
}

function evidenceFor(endpoint, need, context) {
  const station = stations[endpoint.station];
  const type = need === 'vehicle_boarding' ? 'wheelchair' : need;
  const intent = intents[type];
  const track = Number(endpoint.track);
  const pool = passages.flatMap((item, index) => item.station === endpoint.station
    && (!item.numbers.length || (track && item.numbers.includes(track))) ? [index] : []);
  const query = context.question ? context.question + ' ' + intent.label : intent.label;
  const ranked = context.retrieve(query, pool).map(index => passages[index]);
  context.recordRetrieval(station.name, need, ranked);
  const usable = chunk => chunk && (type === 'lifts' || Object.hasOwn(textualValue, chunk.value) && chunk.value !== 'unknown');
  const matching = ranked.filter(item => item.need === type);
  const platformRecords = matching.filter(item => item.numbers.length);
  const platform = new Set(platformRecords.map(item => item.value)).size === 1 ? platformRecords[0] : null;
  const stationRecord = matching.find(item => !item.numbers.length);
  const primary = usable(platform) ? platform : usable(stationRecord) ? stationRecord : null;
  const chunks = primary ? [primary] : [];
  const messages = primary ? [summaryFor(primary)] : [];
  const exact = Boolean(primary?.numbers.length);
  let support = primary ? 'supported' : 'unresolved';
  const boarding = type === 'wheelchair' && Boolean(endpoint.tripBound);

  if (endpoint.area && !endpoint.track && type !== 'lifts') {
    const [first, last] = endpoint.area.split('-').map(Number);
    const groups = passages.filter(item => item.station === endpoint.station && item.need === type
      && item.numbers.length && item.numbers.every(number => number >= first && number <= last));
    const tracks = new Set(groups.flatMap(item => item.numbers));
    if (tracks.size === last - first + 1 && groups.every(item => item.value === 'true')) {
      chunks.push(...groups);
      messages.push('OpenStation lists this feature for all tracks in the scheduled ' + endpoint.area + ' group.');
      support = 'context';
    }
  }

  if (boarding) {
    messages.push('The records do not establish vehicle boarding, ramp needs or assistance for this train.');
    support = chunks.length ? 'context' : 'unresolved';
  } else if (endpoint.tripBound && !exact && type !== 'lifts') {
    messages.push(endpoint.track
      ? 'The matching platform record does not establish this feature. The exact platform’s accessibility cannot be verified.'
      : 'GTFS does not identify the exact platform, so its accessibility cannot be verified.');
    support = chunks.length ? 'context' : 'unresolved';
  }
  if (primary?.value === 'partial' && support === 'supported') support = 'context';
  if (!messages.length) messages.push('The station records do not establish this accessibility feature.');
  return {
    station: station.name,
    label: need === 'vehicle_boarding' ? 'Vehicle boarding and assistance'
      : type === 'wheelchair' && !endpoint.tripBound ? 'Wheelchair access' : intent.label,
    status: support === 'supported' ? 'recorded' : 'verify',
    support, text: messages.join(' '), citations: chunks.map(context.addCitation),
  };
}

function refused(reason, answer, claims = []) {
  return { status: 'refused', reason, answer, claims, citations: [], journey: null, options: [], links };
}

function resultFor(input, retrieve) {
  const origin = stationId(input.origin);
  const destination = stationId(input.destination);
  const stationOnly = Boolean(input.stationIds?.length);
  if (!stationOnly && (!origin || !destination)) {
    return refused('station_out_of_scope', 'This snapshot covers ' + stationChoices + '.');
  }
  if (!stationOnly && origin === destination) return refused('same_station', 'Choose two different stations for a direct journey.');
  const day = timetable.dates[input.date];
  if (!stationOnly && !day) {
    return refused('date_out_of_scope', 'The timetable snapshot covers ' + timetable.first + ' through ' + timetable.last + '.');
  }
  const recognized = input.needs.filter(need => Object.hasOwn(intents, need)
    || (!stationOnly && ['platform', 'vehicle_boarding'].includes(need)));
  const missing = input.needs.filter(need => !recognized.includes(need));
  const unsupportedMessage = missing.length ? 'The static sources cannot verify '
    + missing.map(need => Object.hasOwn(unsupported, need) ? unsupported[need] : 'the requested feature').join(', ') + '.' : '';
  if (missing.length && !recognized.length && (stationOnly || !input.wantsSchedule)) return refused('unsupported_need', unsupportedMessage);

  let trips = [];
  let trip;
  if (!stationOnly) {
    const [hours, minutes] = input.after.split(':').map(Number);
    const threshold = hours * 60 + minutes;
    const timeMatches = {
      exact: (actual, target) => actual === target,
      atLeast: (actual, target) => actual >= target,
      atMost: (actual, target) => actual <= target,
      lessThan: (actual, target) => actual < target,
    };
    const times = input.times ?? [];
    trips = (day[origin + '-' + destination] ?? []).filter(option => option.from.time >= threshold
      && times.every(({ side, operation, time }) => timeMatches[operation](option[side].time, time))
      && (!input.line || option.line.replace(/\s/g, '').toUpperCase() === input.line));
    if (!trips.length) {
      const timing = times.length ? ' for the requested times' : ' at or after ' + input.after;
      return refused('no_direct_trip', 'No matching direct departure was found' + timing + ' on ' + input.date + ' in this timetable snapshot.');
    }
    trip = input.trip ? trips.find(option => option.trip === input.trip) : trips[0];
    if (!trip) return refused('trip_out_of_scope', 'That departure is unavailable for this route, date and time.');
  }

  const citations = trip ? [timetableCitation(trip)] : [];
  const rankedEvidence = [];
  const cited = new Map();
  const context = {
    question: input.question, retrieve,
    addCitation(chunk) {
      const key = chunk.entity + '|' + chunk.field;
      if (!cited.has(key)) {
        const id = citations.length + 1;
        cited.set(key, id);
        citations.push(evidenceCitation(chunk, id));
      }
      return cited.get(key);
    },
    recordRetrieval(station, need, ranked) {
      if (!input.includeRetrieval) return;
      rankedEvidence.push({ station, need, hits: ranked.slice(0, 10).map(chunk => ({
        locator: chunk.entity, field: chunk.field,
      })) });
    },
  };
  const endpoints = stationOnly ? input.stationIds.map(station => ({ station }))
    : (input.side ? [trip[input.side]] : [trip.from, trip.to]).map(endpoint => ({ ...endpoint, tripBound: true }));
  const claims = endpoints.flatMap(endpoint => recognized.map(need => {
    if (need !== 'platform') return evidenceFor(endpoint, need, context);
    const text = endpoint.track ? 'GTFS records track ' + endpoint.track + '.'
      : (endpoint.area ? 'GTFS gives tracks ' + endpoint.area + ' as the station area. ' : '') + 'The exact track cannot be determined from this snapshot.';
    return { station: stations[endpoint.station].name, label: 'Exact platform', text,
      support: endpoint.track ? 'supported' : endpoint.area ? 'context' : 'unresolved',
      status: endpoint.track ? 'recorded' : 'verify', citations: [1] };
  }));
  const scheduleText = trip ? 'Scheduled ' + trip.line + ' from ' + stations[origin].name + ' at ' + timeLabel(trip.from.time)
    + ' to ' + stations[destination].name + ' at ' + timeLabel(trip.to.time) + (trip.to.time >= 1440 ? ' the next day' : '') + ' [1].' : '';
  const journey = trip ? { ...trip, date: input.date, citation: 1, duration: trip.to.time - trip.from.time, option: trip.trip } : null;
  const hasSupport = claims.some(claim => claim.support !== 'unresolved') || Boolean(trip && (input.wantsSchedule || !recognized.length));
  if (!hasSupport) {
    const answer = [scheduleText, ...claims.map(claim => claim.station + ': ' + claim.text), unsupportedMessage]
      .filter(Boolean).join('\n');
    return { ...refused('no_supported_evidence', answer, claims), journey,
      citations, ...(input.includeRetrieval ? { rankedEvidence } : {}) };
  }
  const status = unsupportedMessage || claims.some(claim => claim.support !== 'supported') ? 'partial' : 'answered';
  return {
    status,
    answer: [scheduleText, ...claims.map(claim => claim.station + ': ' + claim.text
      + (claim.citations.length ? ' [' + claim.citations.join(', ') + ']' : '')), unsupportedMessage].filter(Boolean).join('\n'),
    unsupportedMessage,
    journey,
    station: stationOnly ? input.stationIds.map(id => stations[id].name).join(' and ') : null,
    options: trips.slice(0, 4).map(option => ({ trip: option.trip, line: option.line, from: timeLabel(option.from.time), to: timeLabel(option.to.time) })),
    claims, citations, links, ...(input.includeRetrieval ? { rankedEvidence } : {}),
  };
}

function validInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const question = typeof body.question === 'string' && body.question.trim().length > 0 && body.question.length <= 600;
  const validStation = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 80;
  return (body.question === undefined || question)
    && ['origin', 'destination'].every(key => body[key] === undefined ? question : validStation(body[key]))
    && (body.date === undefined ? question : typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date))
    && (body.after === undefined || typeof body.after === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.after))
    && (body.trip === undefined || typeof body.trip === 'string' && /^[a-z0-9_-]{1,32}$/i.test(body.trip))
    && (body.includeRetrieval === undefined || typeof body.includeRetrieval === 'boolean')
    && (body.needs === undefined || Array.isArray(body.needs) && body.needs.length <= 8
      && body.needs.every(need => typeof need === 'string' && need.length <= 60));
}

const sharedHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { ...sharedHeaders, ...headers } });

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/ask') {
      if (request.method !== 'POST') return json({ error: 'Use POST /ask.' }, 405, { allow: 'POST' });
      let body;
      try {
        const text = await request.text();
        if (text.length > 4096) return json({ error: 'The request is too large.' }, 413);
        body = JSON.parse(text);
      } catch {
        return json({ error: 'Send a JSON object.' }, 400);
      }
      if (!validInput(body)) return json({ error: 'Enter a journey question or valid station and date fields.' }, 400);
      if (body.retrieval !== undefined && !['bm25', 'hybrid'].includes(body.retrieval)) return json({ error: 'Choose bm25 or hybrid retrieval.' }, 400);
      const retrieval = body.retrieval ?? 'hybrid';
      const { origin, destination, date, after, question, trip, includeRetrieval } = body;
      const needs = [...new Set(body.needs ?? [])];
      const requestData = { origin, destination, date, after, question, trip, includeRetrieval, needs };
      const input = question ? interpretQuestion(requestData) : { ...requestData, after: after ?? '00:00' };
      const result = input.reason ? refused(input.reason, input.message) : resultFor(input, retrieval === 'bm25' ? bm25 : hybrid);
      return json({ ...result, retrieval });
    }
    if (request.method !== 'GET') return json({ error: 'Use GET for this resource.' }, 405, { allow: 'GET' });
    if (path === '/health') return json({ ok: true, project: 'Germany Accessible Transit' });
    if (path === '/meta') return json(metadata);
    if (Object.hasOwn(assets, path)) {
      const [contentType, body] = assets[path];
      return new Response(body, { headers: { ...sharedHeaders, 'content-type': contentType,
        'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'" } });
    }
    return json({ error: 'Page not found.' }, 404);
  },
};
