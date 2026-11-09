import { createServer } from 'node:http';
import next from 'next';
import { loadEnv } from '../env';
import { createLogger, requestId } from './log';

async function main() {
  const dev = process.argv.includes('--dev');
  // Load .env using Next's own precedence before validation. Validation happens before
  // prepare/listen, never during next build, with no bypass switch.
  const { loadEnvConfig } = await import('@next/env');
  loadEnvConfig(process.cwd(), dev);
  const env = loadEnv({ ...process.env, NODE_ENV: dev ? 'development' : 'production' });
  const log = createLogger(env.LOG_LEVEL);
  const port = Number(process.env.PORT ?? 3000);
  const app = next({ dev, hostname: process.env.HOSTNAME ?? '0.0.0.0', port });
  const handle = app.getRequestHandler();
  await app.prepare();
  const server = createServer((req, res) => {
    const started = performance.now();
    const id = requestId(typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined);
    req.headers['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    // Never log query strings, request headers, or content bodies.
    const route = (req.url ?? '/').split('?')[0];
    res.once('finish', () => log('info', {
      request_id: id, route, status: res.statusCode,
      latency_ms: Math.round((performance.now() - started) * 100) / 100,
    }));
    void handle(req, res).catch(() => {
      log('error', { request_id: id, route, operation: 'request_failed' });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.listen(port, '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      server.close(() => { void app.close().finally(() => process.exit(0)); });
    });
  }
}

void main().catch((error: unknown) => {
  // loadEnv errors contain variable names only; other startup errors may include secrets.
  console.error(error instanceof Error && error.message.startsWith('Invalid server configuration:')
    ? error.message : 'Server startup failed');
  process.exit(1);
});
