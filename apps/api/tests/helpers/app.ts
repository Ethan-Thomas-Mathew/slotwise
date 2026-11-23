import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp, type AppDeps } from '../../src/app';
import { loadConfig } from '../../src/config';
import type { Database } from '../../src/db/database';
import { appDb } from './db';
import { RecordingJobs } from './recording-jobs';
import { TEST_PASSWORD } from './factory';

export interface TestApp {
  app: FastifyInstance;
  db: Database;
  jobs: RecordingJobs;
  deps: AppDeps;
  close(): Promise<void>;
}

export async function createTestApp(overrides: Partial<AppDeps> = {}): Promise<TestApp> {
  const db = appDb();
  const jobs = new RecordingJobs();
  const deps: AppDeps = { config: loadConfig(), db, redis: null, jobs, ...overrides } as AppDeps;
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    db,
    jobs,
    deps,
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A tiny browser stand-in: keeps the session cookie and sends the CSRF token
 * on writes, exactly like the real frontend does.
 */
export class Client {
  cookie: string | null = null;
  csrf: string | null = null;

  constructor(private readonly app: FastifyInstance) {}

  async request(
    method: Method,
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;
    const opts: InjectOptions = { method, url, headers };
    if (body !== undefined) opts.payload = body as InjectOptions['payload'];
    const res = await this.app.inject(opts);
    const setCookie = res.cookies.find((c) => c.name === 'sid');
    if (setCookie) this.cookie = setCookie.value ? `sid=${setCookie.value}` : null;
    if (res.statusCode < 300 && res.headers['content-type']?.includes('json')) {
      const json = res.json() as { csrfToken?: string };
      if (json && typeof json.csrfToken === 'string') this.csrf = json.csrfToken;
    }
    return res;
  }

  get(url: string) {
    return this.request('GET', url);
  }
  post(url: string, body?: unknown) {
    return this.request('POST', url, body ?? {});
  }
  patch(url: string, body?: unknown) {
    return this.request('PATCH', url, body ?? {});
  }
  put(url: string, body?: unknown) {
    return this.request('PUT', url, body ?? {});
  }
  delete(url: string) {
    return this.request('DELETE', url);
  }

  async login(email: string, password = TEST_PASSWORD, tenantSlug?: string) {
    const res = await this.post('/auth/login', { email, password, tenantSlug });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    return res.json();
  }
}

/** Logs in as a user and makes `slug` their active tenant. */
export async function loginAs(app: FastifyInstance, email: string, slug: string) {
  const c = new Client(app);
  await c.login(email, TEST_PASSWORD, slug);
  return c;
}
