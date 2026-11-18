import type { InstanceDto, ReconciliationReportDto } from '@copy-trade/contracts';
import { useEffect, useState } from 'react';
import { api } from './api';

const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#4d7c0f'];

function colorFor(id: string): string {
  const digits = /(\d+)$/.exec(id)?.[1];
  let n = digits === undefined ? 0 : Number(digits);
  if (digits === undefined) for (let i = 0; i < id.length; i++) n += id.charCodeAt(i);
  return PALETTE[n % PALETTE.length] ?? '#475569';
}

export function InstanceBadge(props: { id: string | null | undefined }) {
  if (props.id === null || props.id === undefined) return <span className="muted">—</span>;
  return (
    <span
      className="instance"
      style={{ borderColor: colorFor(props.id), color: colorFor(props.id) }}
    >
      {props.id}
    </span>
  );
}

export function ReconciliationLine(props: { report: ReconciliationReportDto; testId: string }) {
  const { report } = props;
  return (
    <p data-testid={props.testId} className={report.consistent ? 'ok' : 'bad'}>
      Reconciliation {report.consistent ? 'consistent' : 'DRIFT DETECTED'}:{' '}
      {report.summary.followersChecked} followers checked, {report.summary.driftedFollowers}{' '}
      drifted, {report.stuckPending} stuck pending
    </p>
  );
}

const ago = (iso: string): string =>
  `${String(Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)))}s ago`;

/** Live API replicas and workers (heartbeats in Postgres), with each worker's partitions. */
export function InstancesPanel() {
  const [items, setItems] = useState<InstanceDto[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.instances().then(
        (list) => {
          if (!cancelled) setItems(list);
        },
        () => undefined,
      );
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <section className="card" aria-labelledby="instances-title">
      <h2 id="instances-title">Instances</h2>
      <table className="table" data-testid="instances-table">
        <thead>
          <tr>
            <th>Instance</th>
            <th>Kind</th>
            <th>State</th>
            <th>Partitions</th>
            <th>Last heartbeat</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr
              key={i.id}
              data-testid="instance-row"
              data-kind={i.kind}
              data-alive={String(i.alive)}
            >
              <td>
                <InstanceBadge id={i.id} />
              </td>
              <td>{i.kind}</td>
              <td>
                <span
                  className={`badge ${i.alive ? 'executed' : i.stoppedAt === null ? 'failed' : 'pending'}`}
                >
                  {i.alive ? 'alive' : i.stoppedAt === null ? 'lost' : 'stopped'}
                </span>
              </td>
              <td className="mono">{i.kind === 'worker' ? i.partitions.join(', ') || '—' : ''}</td>
              <td>{ago(i.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
