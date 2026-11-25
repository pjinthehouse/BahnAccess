import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

await import('./build.mjs');
const { default: app } = await import('../dist/server/index.js');
const { values } = parseArgs({
  options: { host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '4173' }, strictPort: { type: 'boolean' } },
});
createServer(async (request, response) => {
  try {
    const { method, headers } = request;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const result = await app.fetch(new Request('http://' + headers.host + request.url, { method, headers, body }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  } catch {
    response.writeHead(500).end('Preview request failed.');
  }
}).listen(Number(values.port), values.host);
