import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

// Only test-authored browser modules may be transformed and served.
const supportModules = new Set(['gpu', 'library', 'demo', 'shadows', 'materials', 'movement', 'effects']);
const mimeTypes: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
export async function startBrowserServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      if (pathname === '/gpu.html') {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>GPU contract tests</title>');
        return;
      }
      const support = /^\/support\/([a-z-]+)\.js$/.exec(pathname);
      if (support) {
        if (!supportModules.has(support[1])) { response.writeHead(404).end(); return; }
        const source = await readFile(resolve('tests/support/browser', `${support[1]}.ts`), 'utf8');
        const result = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext } });
        response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(result.outputText);
        return;
      }
      const library = pathname.startsWith('/lib/');
      const root = resolve(library ? 'dist' : 'demo-dist');
      const relative = library ? pathname.slice(5) : pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = resolve(root, relative);
      if (!file.startsWith(`${root}${sep}`)) { response.writeHead(403).end(); return; }
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser server failed to start');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())),
  };
}
