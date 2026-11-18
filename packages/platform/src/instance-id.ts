import { lookup as dnsLookup } from 'node:dns/promises';
import { hostname, networkInterfaces } from 'node:os';

export interface ResolveInstanceIdOptions {
  /** Explicit id (e.g. `INSTANCE_ID`); wins when set. */
  readonly configured: string | undefined;
  /** Compose service name (`api`, `worker`). */
  readonly service: string;
  /** Compose project prefix of container names (`copy-trade-` -> `copy-trade-api-2`). */
  readonly projectPrefix?: string;
  readonly maxReplicas?: number;
  readonly lookup?: (name: string) => Promise<string[]>;
  readonly addresses?: () => readonly string[];
  readonly host?: () => string;
}

const ownIpv4Addresses = (): string[] =>
  Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);

const lookupAll = async (name: string): Promise<string[]> =>
  (await dnsLookup(name, { all: true, family: 4 })).map((a) => a.address);

/**
 * Human-readable identity for a replica. With `docker compose --scale`, every replica shares
 * one environment, so the id comes from Docker's embedded DNS: the container named
 * `<project>-<service>-<n>` that resolves to one of our own addresses is us. (Reverse lookups
 * are unusable from Node: c-ares drops PTR names containing `_`, as in `<project>_default`.)
 * Falls back to the hostname outside Docker.
 */
export async function resolveInstanceId(options: ResolveInstanceIdOptions): Promise<string> {
  if (options.configured !== undefined && options.configured !== '') return options.configured;
  const own = new Set((options.addresses ?? ownIpv4Addresses)());
  const lookup = options.lookup ?? lookupAll;
  const prefix = options.projectPrefix ?? 'copy-trade-';
  const candidates = Array.from(
    { length: options.maxReplicas ?? 32 },
    (_, i) => `${options.service}-${String(i + 1)}`,
  );
  const matches = await Promise.all(
    candidates.map((id) =>
      lookup(`${prefix}${id}`).then(
        (ips) => ips.some((ip) => own.has(ip)),
        () => false,
      ),
    ),
  );
  return candidates[matches.indexOf(true)] ?? (options.host ?? hostname)();
}
