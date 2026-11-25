const intents = {
  step: { label: 'Step-free platform access', field: 'StepFreeAccess', terms: 'step free stair stairs stairs-free ramps accessible barrier stufenfrei treppe barrierefrei' },
  wheelchair: { label: 'Wheelchair boarding', field: 'WheelchairAccess', terms: 'wheelchair mobility impaired boarding platform access rollstuhl einstieg' },
  tactile: { label: 'Tactile guidance', field: 'TactileGuidanceAvailable', terms: 'tactile guidance paving blind visual orientation braille blindenleitsystem taktil' },
  lifts: { label: 'Lift infrastructure', field: 'LiftEquipment', terms: 'lift elevator equipment inventory aufzug fahrstuhl' },
};

function words(text) {
  return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').match(/[a-z0-9]+/g) ?? [];
}

function makePassages(netex) {
  const passages = [];
  for (const [station, record] of Object.entries(netex.stations)) {
    const scopes = [{ id: record.id, title: record.name, numbers: [], ...record.access }, ...record.tracks.map(track => ({
      ...track, title: track.name,
    }))];
    for (const scope of scopes) {
      for (const [need, intent] of Object.entries(intents)) {
        if (need === 'lifts' && scope.numbers.length) continue;
        const value = need === 'lifts' ? record.lifts.length : scope[need];
        const ids = need === 'lifts' ? record.lifts : [];
        const excerpt = need === 'lifts' ? 'LiftEquipment records under this StopPlace: ' + value
          + (ids.length ? '\n' + ids.join('\n') : '') : intent.field + ': ' + (value ?? 'field absent');
        passages.push({
          station, need, value, ids, excerpt, entity: scope.id, numbers: scope.numbers,
          terms: intent.terms,
          passage: record.name + ' ' + scope.title + ' ' + intent.label + '\n' + excerpt,
          title: record.name + (scope.numbers.length ? ' · ' + scope.title : ''),
          field: intent.field, url: record.url,
        });
      }
    }
  }
  return passages;
}

function makeBM25(passages) {
  const documents = passages.map(ch => words(ch.passage + ' ' + ch.terms));
  const counters = documents.map(terms => {
    const counts = new Map();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    return counts;
  });
  const documentFrequency = new Map();
  for (const counts of counters) {
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const averageLength = documents.reduce((sum, terms) => sum + terms.length, 0) / documents.length;
  return (query, pool) => {
    const terms = [...new Set(words(query))];
    return pool.map(index => {
      let score = 0;
      for (const term of terms) {
        const tf = counters[index].get(term) ?? 0;
        const df = documentFrequency.get(term) ?? 0;
        const lengthWeight = 0.25 + 0.75 * documents[index].length / averageLength;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        score += idf * (tf * 2.2) / (tf + 1.2 * lengthWeight);
      }
      return [index, score];
    }).filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([index]) => index);
  };
}

function makeHybrid(vectors, bm25) {
  const vocabulary = new Map(vectors.vocab.map((term, index) => [term, index]));
  return (query, pool) => {
    const queryVector = Array(vectors.width).fill(0);
    for (const term of new Set(words(query))) {
      const termIndex = vocabulary.get(term);
      if (termIndex === undefined) continue;
      vectors.basis[termIndex].forEach((coefficient, index) => {
        queryVector[index] += coefficient * vectors.idf[termIndex];
      });
    }
    const norm = Math.hypot(...queryVector);
    const lexical = bm25(query, pool);
    if (!norm) return lexical;
    const dense = pool.map(index => [index, vectors.rows[index].reduce(
      (sum, value, column) => sum + value * queryVector[column] / norm, 0,
    )]).filter(([, score]) => score > 0.12)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([index]) => index);
    const fused = new Map();
    for (const ranking of [lexical, dense]) {
      ranking.forEach((index, rank) => fused.set(index, (fused.get(index) ?? 0) + 1 / (60 + rank + 1)));
    }
    return [...fused].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([index]) => index);
  };
}

export { makePassages, words };
