const byId = id => document.getElementById(id);
const form = byId('journey-form');
const questionForm = byId('question-form');
const question = byId('question');
const askButton = byId('ask-question');
const origin = byId('origin');
const destination = byId('destination');
const date = byId('date');
const after = byId('after');
const resultContent = byId('result-content');
const sourceList = byId('source-list');
const submit = byId('submit');
const status = byId('status');
const queryError = byId('query-error');
let metadata;
let currentRequest;

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function appendLink(parent, url, label) {
  const link = node('a', 'original', label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  parent.append(link);
}

function citationLink(id) {
  const link = node('a', 'cite', String(id));
  link.href = '#evidence-' + id;
  link.setAttribute('aria-label', 'Open source citation ' + id);
  link.addEventListener('click', event => {
    const details = byId('evidence-' + id);
    if (!details) return;
    event.preventDefault();
    details.open = true;
    details.querySelector('summary').focus({ preventScroll: true });
    details.scrollIntoView({ block: 'nearest' });
  });
  return link;
}

function displayDate(value) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(value + 'T00:00:00Z'));
}

function displayTime(minutes) {
  const value = minutes % 1440;
  return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
}

function stationStop(endpoint, side) {
  const block = node('div', side);
  const time = node('strong', 'clock', displayTime(endpoint.time));
  if (endpoint.time >= 1440) time.append(node('small', 'next-day', '+1 day'));
  block.append(time, node('span', 'stop-name', metadata.stations[endpoint.station]),
    node('span', 'stop-track', endpoint.track ? 'Track ' + endpoint.track : endpoint.area
      ? 'Tracks ' + endpoint.area + ' area' : 'Track unspecified'));
  return block;
}

function renderSources(citations) {
  sourceList.replaceChildren();
  for (const citation of citations) {
    const details = node('details', 'source');
    details.id = 'evidence-' + citation.id;
    details.append(node('summary', '', '[' + citation.id + '] ' + citation.title));
    details.append(node('p', 'source-publisher', citation.publisher + ' · ' + displayDate(citation.snapshot)));
    details.append(node('p', 'source-id', [citation.scope, citation.locator].filter(Boolean).join(' · ')));
    details.append(node('pre', 'excerpt', citation.excerpt));
    appendLink(details, citation.url, citation.stationPage ? 'Open source dataset' : 'Open original feed');
    if (citation.stationPage) appendLink(details, citation.stationPage, 'Check station on bahnhof.de');
    sourceList.append(details);
  }
}

function renderResult(result, query) {
  renderSources(result.citations);
  const subtitle = byId('result-subtitle');
  if (!result.journey && !result.station) {
    subtitle.textContent = 'Outside the available evidence';
    const empty = node('div', 'empty result-empty');
    empty.append(node('h3', '', 'Unable to verify this request'), node('p', '', result.answer));
    appendLink(empty, result.links.db, 'Check Deutsche Bahn');
    resultContent.replaceChildren(empty);
    status.textContent = 'Unable to verify. ' + result.answer;
    return;
  }

  const journey = result.journey;
  resultContent.replaceChildren();
  subtitle.textContent = journey ? displayDate(journey.date) + ' · Scheduled times in Germany' : result.station + ' · Station inventory';
  if (result.status === 'refused') resultContent.append(node('p', 'note', 'The timetable identifies the train. The requested accessibility detail could not be verified.'));
  if (journey) {
    const route = node('div', 'route-box');
    const header = node('p', 'route-meta');
    header.append(node('span', 'train-pill', journey.line),
      node('span', '', 'Direct · ' + (journey.duration >= 60 ? Math.floor(journey.duration / 60) + ' h ' : '') + journey.duration % 60 + ' min'),
      citationLink(journey.citation));
    const timeline = node('div', 'route-timeline');
    const line = node('div', 'route-line');
    line.setAttribute('aria-hidden', 'true');
    timeline.append(stationStop(journey.from, 'departure'), line, stationStop(journey.to, 'arrival'));
    route.append(header, timeline);
    resultContent.append(route);
  }

  if (result.options.length > 1) {
    const options = node('details', 'options');
    options.append(node('summary', '', 'Compare other departures'));
    const list = node('div', 'options-list');
    for (const option of result.options) {
      const button = node('button', 'option-button', option.line + ' · ' + option.from + ' to ' + option.to);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(option.trip === journey.option));
      button.addEventListener('click', () => ask({ ...query, trip: option.trip }, true));
      list.append(button);
    }
    options.append(list);
    resultContent.append(options);
  }

  if (result.claims.length) {
    const evidence = node('section', 'evidence');
    evidence.append(node('h3', '', 'Accessibility evidence'));
    const list = node('ul', 'evidence-list');
    for (const claim of result.claims) {
      const item = node('li', 'evidence-item');
      const text = node('p', '', claim.text + ' ');
      for (const citation of claim.citations) text.append(citationLink(citation));
      item.append(node('h4', '', claim.station + ' · ' + claim.label),
        node('span', 'state ' + claim.status, claim.status === 'verify' ? 'Verify before travel' : 'Inventory record'),
        text);
      list.append(item);
    }
    evidence.append(list);
    resultContent.append(evidence);
  }
  if (result.unsupportedMessage) resultContent.append(node('p', 'note', result.unsupportedMessage));
  const note = node('p', 'note', 'Static data can change. Check your actual platform, lift status or boarding arrangements before travel. ');
  appendLink(note, result.links.assistance, 'DB accessibility information');
  resultContent.append(note);
  status.textContent = (journey ? journey.line + ' departs at ' + displayTime(journey.from.time) : result.station)
    + (result.status === 'answered' ? '. Results loaded.' : '. Some accessibility details could not be verified.');
}

function queryFromForm() {
  return {
    origin: origin.value, destination: destination.value, date: date.value, after: after.value,
    needs: new FormData(form).getAll('needs'),
  };
}

async function ask(query, moveFocus = false) {
  currentRequest?.abort();
  const controller = new AbortController();
  currentRequest = controller;
  submit.disabled = true;
  askButton.disabled = true;
  queryError.hidden = true;
  resultContent.setAttribute('aria-busy', 'true');
  status.textContent = 'Checking journey…';
  try {
    const response = await fetch('/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query), signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (currentRequest !== controller) return;
    renderResult(result, query);
    if (moveFocus) byId('results-title').focus();
  } catch (error) {
    if (currentRequest !== controller || controller.signal.aborted) return;
    queryError.textContent = error.message || 'The journey could not be checked. Please try again.';
    queryError.hidden = false;
    status.textContent = queryError.textContent;
  } finally {
    if (currentRequest === controller) {
      submit.disabled = false;
      askButton.disabled = false;
      resultContent.setAttribute('aria-busy', 'false');
    }
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  ask(queryFromForm(), true);
});

byId('swap').addEventListener('click', () => {
  [origin.value, destination.value] = [destination.value, origin.value];
});

questionForm.addEventListener('submit', event => {
  event.preventDefault();
  if (question.value.trim()) ask({ question: question.value.trim() }, true);
});

byId('example').addEventListener('click', () => {
  question.value = 'Is the exact departure platform step-free on the 09:39 ICE 41 from Wurzbrg to Nurnbrg on ' + metadata.timetable.first + '?';
  questionForm.requestSubmit();
});

function drawMap() {
  const canvas = byId('network-canvas');
  const context = canvas.getContext('2d');
  const { stations, stationMap, directPairs } = metadata;
  byId('network').setAttribute('aria-label',
    'Schematic direct train coverage for ' + Object.values(stations).join(', '));
  if (!context) return;
  const points = Object.fromEntries(Object.entries(stationMap).map(([id, [x, y]]) =>
    [id, [x / 100 * canvas.width, y / 100 * canvas.height]]));
  const pairs = new Set(directPairs.map(pair => pair.split('-').sort().join('-')));
  context.lineWidth = 2.4;
  context.strokeStyle = '#76a999';
  for (const pair of pairs) {
    const [start, end] = pair.split('-');
    context.beginPath();
    context.moveTo(...points[start]);
    context.lineTo(...points[end]);
    context.stroke();
  }
  context.font = '700 17px system-ui';
  context.textAlign = 'center';
  for (const [id, [x, y]] of Object.entries(points)) {
    context.fillStyle = '#f5fcf8';
    context.strokeStyle = '#276f60';
    context.lineWidth = 3;
    context.beginPath();
    context.arc(x, y, 6, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    const label = stations[id].replace(/ Hbf$/, '');
    const width = context.measureText(label).width + 16;
    context.fillStyle = '#f5fcf8';
    context.beginPath();
    context.roundRect(x - width / 2, y - 36, width, 23, 5);
    context.fill();
    context.fillStyle = '#173e36';
    context.fillText(label, x, y - 19);
  }
}

async function initialize() {
  try {
    const response = await fetch('/meta');
    if (!response.ok) throw new Error('Metadata unavailable.');
    metadata = await response.json();
    drawMap();
    for (const [id, name] of Object.entries(metadata.stations)) {
      origin.add(new Option(name, id));
      destination.add(new Option(name, id));
    }
    origin.value = 'wue';
    destination.value = 'nue';
    date.min = metadata.timetable.first;
    date.max = metadata.timetable.last;
    const berlinToday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
    date.value = berlinToday >= date.min && berlinToday <= date.max ? berlinToday : date.min;
    byId('snapshot').textContent = 'Timetable coverage · ' + displayDate(date.min) + ' to ' + displayDate(date.max);
    byId('example').disabled = false;
    await ask(queryFromForm());
  } catch {
    byId('snapshot').textContent = 'Timetable unavailable. Reload the page to try again.';
    resultContent.replaceChildren(node('p', 'empty', 'Could not load the timetable snapshot.'));
    resultContent.setAttribute('aria-busy', 'false');
  }
}

initialize();
