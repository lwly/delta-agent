/**
 * Vue 构建产物静态托管（SPA fallback + F-53 预压缩 .gz，AC-53-5）。
 * 命中则写出响应并返回 true；未命中（无 webDistDir / 非 GET·HEAD / /api）返回 false。
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function tryServeStatic(input: {
  webDistDir?: string;
  method: string;
  pathname: string;
  parts: string[];
  acceptEncoding: string;
  res: http.ServerResponse;
}): boolean {
  const { webDistDir, method, pathname, parts, acceptEncoding, res } = input;
  if (!webDistDir || (method !== 'GET' && method !== 'HEAD') || parts[0]?.startsWith('api')) return false;

  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(webDistDir, rel);
  if (file.startsWith(path.resolve(webDistDir)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    const gzFile = `${file}.gz`;
    if (acceptEncoding.includes('gzip') && fs.existsSync(gzFile) && fs.statSync(gzFile).isFile()) {
      res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
      fs.createReadStream(gzFile).pipe(res);
      return true;
    }
    res.writeHead(200, { 'content-type': type, vary: 'Accept-Encoding' });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  const index = path.join(webDistDir, 'index.html');
  if (fs.existsSync(index)) {
    const indexGz = `${index}.gz`;
    if (acceptEncoding.includes('gzip') && fs.existsSync(indexGz)) {
      res.writeHead(200, { 'content-type': MIME['.html']!, 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
      fs.createReadStream(indexGz).pipe(res);
      return true;
    }
    res.writeHead(200, { 'content-type': MIME['.html']! });
    fs.createReadStream(index).pipe(res);
    return true;
  }
  return false;
}
