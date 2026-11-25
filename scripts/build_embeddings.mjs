import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { makePassages, words } from '../worker/evidence.mjs';

const stations = JSON.parse(readFileSync('data/stations.json', 'utf8'));
const documents = makePassages(stations).map(chunk => words(chunk.passage + ' ' + chunk.terms));
const result = spawnSync(process.env.CODEX_PRIMARY_RUNTIME_PYTHON ?? 'python3', ['scripts/lsa.py'], {
  input: JSON.stringify(documents), encoding: 'utf8', maxBuffer: 2_000_000,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr);
writeFileSync('data/vectors.json', result.stdout);
