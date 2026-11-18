import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase, migrateToLatest } from '@copy-trade/db';

export const API_DIR = fileURLToPath(new URL('../..', import.meta.url));

export async function startMigratedPostgres(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withCommand(['postgres', '-c', 'max_connections=300'])
    .start();
  const db = createDatabase({
    connectionString: container.getConnectionUri(),
    poolMax: 1,
    applicationName: 'migrate',
    statementTimeoutMs: 30_000,
  });
  await migrateToLatest(db);
  await db.destroy();
  return container;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

export function baseEnv(databaseUrl: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    DATABASE_URL: databaseUrl,
    LOG_LEVEL: 'warn',
    DB_POOL_MAX: '40',
    OUTBOX_POLL_INTERVAL_MS: '200',
    RECONCILIATION_INTERVAL_MS: '0',
  };
}

export interface RunningApi {
  readonly url: string;
  readonly process: ChildProcess;
  readonly output: string[];
  stop(): Promise<void>;
}

/** Starts `src/main.ts` as a separate OS process (its own pool, event loop and relay). */
export async function spawnApi(env: Record<string, string>): Promise<RunningApi> {
  const port = await freePort();
  const output: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: API_DIR,
    env: { ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d: Buffer) => output.push(d.toString()));
  child.stderr.on('data', (d: Buffer) => output.push(d.toString()));
  const url = `http://127.0.0.1:${String(port)}`;

  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`API exited early:\n${output.join('')}`);
    const ready = await fetch(`${url}/health/ready`).then(
      (r) => r.ok,
      () => false,
    );
    if (ready) {
      return {
        url,
        process: child,
        output,
        stop: () =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) {
              resolve();
              return;
            }
            child.once('exit', () => {
              resolve();
            });
            child.kill('SIGTERM');
          }),
      };
    }
    await delay(200);
  }
  child.kill('SIGKILL');
  throw new Error(`API did not become ready:\n${output.join('')}`);
}

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function createFollower(apiUrl: string, balance: number, allocation: number) {
  const res = await postJson(`${apiUrl}/v1/followers`, { balance, allocation });
  if (res.status !== 201) throw new Error(`create follower failed: ${JSON.stringify(res.body)}`);
  return res.body['id'] as string;
}

export const countBy = (values: readonly (string | number)[]) =>
  values.reduce<Record<string, number>>((acc, v) => {
    acc[String(v)] = (acc[String(v)] ?? 0) + 1;
    return acc;
  }, {});
