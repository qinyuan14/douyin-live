import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';

export const LOCAL_TOKEN_HEADER = 'x-live-local-token';

export function projectRoot(): string {
  return process.env.LIVE_PROJECT_ROOT
    ? resolve(process.env.LIVE_PROJECT_ROOT)
    : resolve(import.meta.dirname, '..', '..', '..');
}

export function runtimeTokenPath(): string {
  return join(projectRoot(), '.data', 'live-system', 'runtime-token');
}

export function createRuntimeToken(): string {
  const token = randomBytes(32).toString('hex');
  const path = runtimeTokenPath();
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export function isPublicHealthRequest(method: string | undefined, url: string | undefined): boolean {
  return method === 'GET' && (url === '/api/health' || url?.startsWith('/api/health?') === true);
}

export function localRequestIsAuthorized(input: {
  method?: string;
  url?: string;
  tokenHeader?: string | string[];
  expectedToken: string;
}): boolean {
  return isPublicHealthRequest(input.method, input.url) || input.tokenHeader === input.expectedToken;
}

export function configureLocalAccess(app: INestApplication, token: string): void {
  app.enableCors({
    origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
      if (!origin || origin === 'null' || origin === 'http://127.0.0.1:5173') {
        callback(null, true);
        return;
      }
      callback(new Error('只允许本机桌面端访问'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH'],
    allowedHeaders: ['Content-Type', 'X-Live-Local-Token'],
  });
  app.use((request: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> }, response: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) => {
    if (!localRequestIsAuthorized({ method: request.method, url: request.url, tokenHeader: request.headers[LOCAL_TOKEN_HEADER], expectedToken: token })) {
      response.status(403).json({ code: 'LOCAL_CLIENT_REQUIRED', message: '只允许本次启动的桌面端读取或写入本地经营数据' });
      return;
    }
    next();
  });
}
