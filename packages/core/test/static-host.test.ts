import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryServeStatic } from '../src/server/static-host.js';

function listen(dir: string): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (
      !tryServeStatic({
        webDistDir: dir,
        method: req.method ?? 'GET',
        pathname: url.pathname,
        parts,
        acceptEncoding: String(req.headers['accept-encoding'] ?? ''),
        res,
      })
    ) {
      res.writeHead(404);
      res.end('miss');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

function get(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<{
  status: number;
  encoding: string | undefined;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          encoding: res.headers['content-encoding'],
          body: Buffer.concat(chunks).toString(),
        }),
      );
    }).on('error', reject);
  });
}

describe('tryServeStatic', () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it('回预压缩 .gz、SPA fallback；/api 不托管', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-static-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>spa</html>');
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'app.js.gz'), 'gzip-bytes');
    const { server, port } = await listen(dir);
    servers.push(server);

    const gz = await get(port, '/app.js', { 'accept-encoding': 'gzip' });
    expect(gz.status).toBe(200);
    expect(gz.encoding).toBe('gzip');
    expect(gz.body).toBe('gzip-bytes');

    const spa = await get(port, '/unknown/route');
    expect(spa.status).toBe(200);
    expect(spa.body).toContain('spa');

    const api = await get(port, '/api/projects');
    expect(api.status).toBe(404);
    expect(api.body).toBe('miss');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
