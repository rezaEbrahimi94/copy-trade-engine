import { describe, expect, it } from 'vitest';
import { resolveInstanceId } from '../src';

const dns: Record<string, string[]> = {
  'copy-trade-worker-1': ['172.18.0.4'],
  'copy-trade-worker-2': ['172.18.0.5'],
};
const lookup = (name: string) =>
  name in dns ? Promise.resolve(dns[name] ?? []) : Promise.reject(new Error('ENOTFOUND'));

describe('resolveInstanceId', () => {
  it('prefers the configured id', async () => {
    expect(await resolveInstanceId({ configured: 'api-7', service: 'api' })).toBe('api-7');
  });

  it('finds the compose replica whose container name resolves to one of our addresses', async () => {
    const id = await resolveInstanceId({
      configured: '',
      service: 'worker',
      addresses: () => ['10.9.9.9', '172.18.0.5'],
      lookup,
    });
    expect(id).toBe('worker-2');
  });

  it('honours a custom project prefix and replica bound', async () => {
    const seen: string[] = [];
    const id = await resolveInstanceId({
      configured: undefined,
      service: 'api',
      projectPrefix: 'shop-',
      maxReplicas: 2,
      addresses: () => ['10.0.0.2'],
      lookup: (name) => {
        seen.push(name);
        return Promise.resolve(name === 'shop-api-2' ? ['10.0.0.2'] : ['10.0.0.1']);
      },
      host: () => 'unused',
    });
    expect(id).toBe('api-2');
    expect(seen).toEqual(['shop-api-1', 'shop-api-2']);
  });

  it('falls back to the hostname when no replica name matches', async () => {
    const id = await resolveInstanceId({
      configured: undefined,
      service: 'worker',
      addresses: () => ['192.168.1.1'],
      lookup,
      host: () => 'my-host',
    });
    expect(id).toBe('my-host');
  });

  it('uses real DNS and network interfaces by default', async () => {
    const id = await resolveInstanceId({ configured: undefined, service: 'nope', maxReplicas: 1 });
    expect(typeof id).toBe('string');
  });

  it('settles a full set of default lookups for missing replicas within a bounded time', async () => {
    const started = Date.now();
    const id = await resolveInstanceId({
      configured: undefined,
      service: 'no-such-service',
      host: () => 'fallback',
    });
    expect(id).toBe('fallback');
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15_000);
});
