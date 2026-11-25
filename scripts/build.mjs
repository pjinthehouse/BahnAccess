import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';

const text = path => readFile(path, 'utf8');
const routes = {
  '/': ['text/html; charset=utf-8', 'web/index.html'],
  '/styles.css': ['text/css; charset=utf-8', 'web/styles.css'],
  '/app.js': ['text/javascript; charset=utf-8', 'web/app.js'],
  '/evaluation-results.json': ['application/json; charset=utf-8', 'evaluation/results.json'],
  '/evaluation-regressions.json': ['application/json; charset=utf-8', 'evaluation/missing-evidence-regressions.json'],
  '/evaluation.json': ['application/json; charset=utf-8', 'evaluation/questions.json'],
};
const assets = Object.fromEntries(await Promise.all(Object.entries(routes).map(async ([path, [type, file]]) => [
  path, [type, await text(file)],
])));
const [netex, timetable, vectors, catalog, evidence, question, worker] = await Promise.all([
  text('data/stations.json'), text('data/timetable.json'), text('data/vectors.json'), text('config/stations.json'),
  text('worker/evidence.mjs'), text('worker/question.mjs'), text('worker/index.mjs'),
]);
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
try {
  await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await rm('dist/.openai', { recursive: true, force: true });
}
const source = [
  'const assets = ' + JSON.stringify(assets) + ';',
  'const netex = ' + netex.trim() + ';',
  'const timetable = ' + timetable.trim() + ';',
  'const vectors = ' + vectors.trim() + ';',
  'const stationCatalog = ' + catalog.trim() + ';',
  evidence.replace('export { makePassages, words };', ''), question, worker,
].join('\n');
await writeFile('dist/server/index.js', source);
