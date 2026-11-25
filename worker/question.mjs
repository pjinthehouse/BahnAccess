// Resolve a small rail vocabulary locally. Unclear routes are returned for clarification.
const stationAliases = Object.entries(stationCatalog).flatMap(([id, station]) =>
  [id, ...station.aliases].map(alias => ({ id, word: words(alias).join(' ') })),
);
const stationChoices = Object.values(stationCatalog).map(station => station.name).join(', ');

function withinTypoLimit(a, b) {
  if (a === b) return true;
  const limit = b.length >= 8 ? 2 : b.length >= 5 ? 1 : 0;
  if (!limit || Math.abs(a.length - b.length) > limit) return false;
  const distance = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  distance[0] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const substitution = distance[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]);
      const transpose = i > 1 && j > 1 && a[i - 2] === b[j - 1] && a[i - 1] === b[j - 2]
        ? distance[i - 2][j - 2] + 1 : Infinity;
      distance[i][j] = Math.min(substitution, transpose, distance[i - 1][j] + 1, distance[i][j - 1] + 1);
    }
  }
  return distance[a.length][b.length] <= limit;
}

function stationId(value, fuzzy = false) {
  const key = words(value ?? '').join(' ').replace(/ (hbf|hauptbahnhof|central station)$/, '');
  const exact = stationAliases.find(alias => alias.word === key);
  if (exact || !fuzzy || key.includes(' ')) return exact?.id;
  const ids = [...new Set(stationAliases.filter(alias => withinTypoLimit(key, alias.word)).map(alias => alias.id))];
  if (ids.length === 1) return ids[0];
}

function parseQuestionDate(question, fallback) {
  const iso = question.match(/\b\d{4}-\d{2}-\d{2}\b/);
  const numeric = question.match(/\b(\d{1,2})([./])(\d{1,2})\2(\d{4})\b/);
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december'];
  const named = question.toLowerCase().match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + months.join('|') + ')(?:\\s+(\\d{4}))?\\b'));
  const berlinToday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
  const twoDigits = value => String(value).padStart(2, '0');
  const date = iso?.[0] ?? (numeric ? numeric[4] + '-' + twoDigits(numeric[3]) + '-' + twoDigits(numeric[1]) : null)
    ?? (named ? (named[3] ?? (fallback ?? timetable.first).slice(0, 4)) + '-'
      + twoDigits(months.indexOf(named[2]) + 1) + '-' + twoDigits(named[1]) : null);
  if (date) {
    const calendarDate = new Date(date + 'T00:00:00Z');
    return !Number.isNaN(calendarDate.valueOf()) && calendarDate.toISOString().slice(0, 10) === date ? date : null;
  }
  if (/\b(?:\d{1,2}[./]\d{1,2}[./]\d{1,3}|\d{4}-\d{1,2}-\d{1,2})\b/.test(question)) return null;
  if (/\b(today|tomorrow)\b/i.test(question)) {
    const day = new Date(berlinToday + 'T00:00:00Z');
    if (/\btomorrow\b/i.test(question)) day.setUTCDate(day.getUTCDate() + 1);
    return day.toISOString().slice(0, 10);
  }
  return fallback ?? (Object.hasOwn(timetable.dates, berlinToday) ? berlinToday : timetable.first);
}

function parseQuestionTimes(question) {
  question = question.replace(/\b([ap])\.m\.?(?=\W|$)/gi, '$1m');
  const clock = /\b(\d{1,2})(?::(\d+)(?:\s*(am|pm)\b)?|\s*(am|pm)\b)\b/gi;
  const hourOnly = /\b(after|at|from|before|by)\s+(\d{1,2})\b(?![:./-]|\s*(?:am|pm)\b)/gi;
  const matches = [
    ...[...question.matchAll(clock)].map(match => ({ match, hour: match[1], minutes: match[2], meridiem: match[3] ?? match[4] })),
    ...[...question.matchAll(hourOnly)].map(match => ({ match, hour: match[2], qualifier: match[1] })),
  ].sort((a, b) => a.match.index - b.match.index);
  const constraints = [];
  for (const { match, hour, minutes, meridiem, qualifier } of matches) {
    const hours = Number(hour);
    const marker = meridiem?.toLowerCase();
    if (hours > 23 || (minutes && (minutes.length !== 2 || Number(minutes) > 59))
      || (marker && (hours < 1 || hours > 12))) return null;
    const before = question.slice(0, match.index);
    const after = question.slice(match.index + match[0].length);
    const preposition = qualifier?.toLowerCase() ?? before.match(/\b(at|by|before|after|from)\s*$/i)?.[1]?.toLowerCase();
    const localClause = before.split(/[,;?.]|\b(?:and|but)\b/i).at(-1);
    const direction = [...localClause.matchAll(/\b(?:arriv(?:e|es|ed|ing|al)|get in|depart(?:s|ed|ing|ure)?|leav(?:e|es|ing))\b/gi)].at(-1);
    const followsRoute = direction && /\b(?:from|von)\b.*\b(?:to|nach)\b/i.test(localClause.slice(direction.index));
    const arrival = direction ? /^(?:arriv|get in)/i.test(direction[0]) && !followsRoute
      : /^\s+(?:i\s+)?arriv(?:e|es)\b/i.test(after);
    const trainTime = /^\s*(?:ICE|IC|EC|ECE|RJX|RJ|RE|RB)\s?\d/i.test(after);
    const operation = preposition === 'by' ? 'atMost' : preposition === 'before' ? 'lessThan'
      : preposition === 'at' || (!preposition && trainTime) ? 'exact' : 'atLeast';
    const localHour = marker ? hours % 12 + (marker === 'pm' ? 12 : 0) : hours;
    constraints.push({ side: arrival ? 'to' : 'from', operation, time: localHour * 60 + Number(minutes ?? 0) });
  }
  return constraints;
}

const liveLiftPattern = /\b(?:live|real time|working|operational|out of service|broken|right now|running now)\b/;
const unsupportedQuestionTopics = {
  live_train_status: /\b(?:delays?|delayed|cancell?ed|cancellation|on time|real time|live (?:train|departure|arrival|status))\b/,
  fare: /\b(?:fares?|tickets?|prices?|costs?)\b/,
  bicycle: /\b(?:bikes?|bicycles?|cycling|fahrrad)\b/,
  weather: /\b(?:weather|temperature|forecast)\b/,
  meals: /\b(?:meals?|food|dining|restaurant)\b/,
};

function requestsSchedule(clause) {
  if (Object.values(unsupportedQuestionTopics).some(pattern => pattern.test(clause))) return false;
  if (/\b(?:what time|when (?:does|do|is|will) .*\b(?:depart|leave|arrive)|train times?|timetable|train schedule|scheduled (?:departure|arrival) times?|departures|next train|direct trains|connections?)\b/.test(clause)) return true;
  return /\b(?:show|find|list|take|catch|get|go|travel)\b.*\b(?:trains?|direct|from|arrive)\b/.test(clause)
    && !/\b(?:platform|track|lift|elevator|stairs|steps|step free|wheelchair|tactile)\b/.test(clause);
}

function interpretQuestion(input) {
  const question = input.question.trim();
  const terms = words(question);
  const text = terms.join(' ');
  const hasTerms = (tokens, aliases) => aliases.some(alias => tokens.some(term => withinTypoLimit(term, alias)));
  const includes = (...aliases) => hasTerms(terms, aliases);
  const clauses = question.split(/[?;!]+|\b(?:and|but|also)\s+(?=(?:are|is|do|does|can|could|how|what|when|which|will)\b)/i)
    .map(clause => words(clause).join(' ')).filter(Boolean);
  const live = liveLiftPattern.test(text);
  const liftTerms = ['lift', 'lifts', 'elevator', 'elevators', 'aufzug'];
  const lift = includes(...liftTerms);
  const boarding = includes('wheelchair', 'rollstuhl', 'boarding', 'ramp', 'ramps');
  const step = /\b(step free|without steps|without a step|no steps|barrier free)\b/.test(text)
    || includes('stairs', 'stairless', 'stepfree', 'stufenfrei', 'barrierefrei');
  const tactile = includes('tactile', 'braille', 'blindenleitsystem') || /\b(guide strips|guidance strips)\b/.test(text);
  const accessPath = (lift && /\b(which|what)\b/.test(text) && /\b(platform|track|entrance)\b/.test(text))
    || (step && /\b(exit|entrance)\b/.test(text));
  const whichTrack = /\b(which|what|exact)\b/.test(text) && /\b(track|gleis)\b/.test(text)
    || !step && !tactile && !boarding && !lift && /\b(which|what)\b/.test(text) && includes('platform');
  const needs = new Set(input.needs ?? []);
  if (step) needs.add('step');
  if (tactile) needs.add('tactile');
  if (boarding) needs.add(/\bwithout\b|\b(is .* booked|can .* board)\b/.test(text) ? 'vehicle_boarding' : 'wheelchair');
  if (lift && live) needs.add('live_lifts');
  if (lift && !accessPath && (!live || clauses.some(clause => !liveLiftPattern.test(clause)
    && hasTerms(words(clause), liftTerms)))) needs.add('lifts');
  if (accessPath) needs.add('access_path');
  if (whichTrack) needs.add('platform');
  if (includes('toilet', 'toilets', 'restroom')) needs.add('onboard_toilet');
  if (/\b(book|booking|booked|reserve)\b/.test(text) && /\bassistance\b/.test(text)) needs.add('assistance_booking');
  for (const [need, pattern] of Object.entries(unsupportedQuestionTopics)) {
    if (pattern.test(text) && !(need === 'live_train_status' && lift && /\b(?:live|real time)\b/.test(text)
      && !/\b(?:delays?|delayed|cancell?ed|cancellation|on time|train status)\b/.test(text))) needs.add(need);
  }
  const wantsSchedule = clauses.some(requestsSchedule);
  const departure = /\b(departure|boarding|departing|depart at|leave at)\b/.test(text);
  const arrival = /\b(arrival|arriv(?:e|es|ed|ing)\s+(?:on|at|by|before|after)|alighting|station exit)\b/.test(text);
  const side = departure === arrival ? null : departure ? 'from' : 'to';

  const mentions = terms.map(term => stationId(term, true)).filter(Boolean);
  const distinct = [...new Set(mentions)];
  const betweenToken = '(?:\\s+(?:hbf|hauptbahnhof|central station))?';
  const arrowRoute = question.match(/([\p{L}]+)(?:\s+(?:hbf|hauptbahnhof))?\s*(?:->|→)\s*([\p{L}]+)/iu);
  const fullRoute = text.match(new RegExp('\\b(?:from|von) ([a-z]+)' + betweenToken + ' (?:to|nach) ([a-z]+)\\b'));
  const shortRoute = text.match(new RegExp('\\b([a-z]+)' + betweenToken + ' (?:to|nach) ([a-z]+)\\b'));
  const route = fullRoute && (distinct.length !== 1 || fullRoute.slice(1).some(name => stationId(name, true))) ? fullRoute : null;
  const namedRoute = arrowRoute ?? route ?? (shortRoute && (stationId(shortRoute[1], true) || stationId(shortRoute[2], true)) ? shortRoute : null);
  const line = question.match(/\b(ICE|IC|EC|ECE|RJX|RJ|RE|RB)\s?(\d{1,4})\b/i);
  const stationList = !namedRoute && !line && !wantsSchedule && !(input.origin && input.destination)
    && distinct.length && needs.size
    && (distinct.length === 1 || /\b(?:and|both)\b/.test(text))
    && !/\b(?:from|to)\s+[a-z]+\s+(?:hbf|hauptbahnhof)\b/.test(text);
  if (stationList) return { ...input, stationIds: distinct, needs: [...needs] };

  const [from, to] = namedRoute ? namedRoute.slice(1).map(station => stationId(station, true)) : distinct;
  if ((namedRoute && (!from || !to)) || distinct.length > 2) {
    return { reason: 'station_out_of_scope', message: 'I could not match the route to a station pair. Covered stations: ' + stationChoices + '.' };
  }
  const origin = from ?? stationId(input.origin, true);
  const destination = to ?? stationId(input.destination, true);
  if (origin && destination) {
    const date = parseQuestionDate(question, input.date);
    if (!date) return { reason: 'invalid_date', message: 'Enter a valid date, for example 2026-12-01 or 01.12.2026.' };
    const times = parseQuestionTimes(question);
    if (!times) return { reason: 'invalid_time', message: 'Enter a valid time, for example 09:39.' };
    const routeOnly = /^(?:(?:from|von)\s+)?[a-z]+(?:\s+(?:hbf|hauptbahnhof|central station))?\s+(?:to|nach)\s+[a-z]+(?:\s+(?:hbf|hauptbahnhof|central station))?$/.test(text)
      || (arrowRoute && question.trim().replace(/[?!.]$/, '') === arrowRoute[0].trim());
    if (!needs.size && !wantsSchedule && !routeOnly) {
      return { reason: 'unsupported_need', message: 'Ask for a timetable or a recorded accessibility feature, such as step-free access.' };
    }
    const after = input.after ?? (times.length || line ? '00:00' : '09:00');
    const endpoint = side ?? (times.length && times.every(time => time.side === 'to') ? 'to' : null);
    return { ...input, origin, destination, date, after, times, needs: [...needs], side: endpoint,
      line: line ? line[1].toUpperCase() + line[2] : null, wantsSchedule: wantsSchedule || Boolean(routeOnly) };
  }
  return { reason: 'station_out_of_scope', message: 'Name a covered station for an accessibility check or enter two stations for a journey. Covered stations: ' + stationChoices + '.' };
}
