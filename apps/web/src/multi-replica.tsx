import type { FollowerDto, FollowerTradeDto, ReconciliationReportDto } from '@copy-trade/contracts';
import { useState } from 'react';
import { api, type CopyTradeCall } from './api';
import { InstanceBadge, ReconciliationLine } from './widgets';

const TRADER_ID = 'trader-lb';
const fmt = (n: number): string => n.toLocaleString('en-US');
const short = (id: string): string => id.slice(0, 8);

interface ReplicaRequest {
  readonly n: number;
  readonly scenario: string;
  readonly followerId: string;
  readonly tradeId: string;
  readonly call: CopyTradeCall;
}

export interface ReplicaRun {
  readonly requests: readonly ReplicaRequest[];
  readonly followers: readonly FollowerDto[];
  readonly trades: readonly FollowerTradeDto[];
  readonly replicasUsed: readonly string[];
  readonly apiReplicas: readonly string[];
  readonly report: ReconciliationReportDto;
}

const outcomeLabel = ({ body }: CopyTradeCall): string =>
  body.outcome === 'rejected' ? `rejected: ${body.reason}` : body.outcome;

/**
 * Fires both race scenarios at once through the load balancer: six identical requests for one
 * trade (one follower) and, for three followers on 1,000 / 1,000, two different 700 trades each.
 * Round-robin spreads the 12 requests over every API replica; only Postgres serialises them.
 */
async function runAcrossReplicas(newId: () => string): Promise<ReplicaRun> {
  const create = (balance: number, allocation: number) =>
    api.createFollower({ balance, allocation, copyingEnabled: true });
  const [dup, ...racers] = await Promise.all([
    create(10_000, 2_000),
    create(1_000, 1_000),
    create(1_000, 1_000),
    create(1_000, 1_000),
  ]);
  const tradeId = `dup-${short(newId())}`;
  const jobs = [
    ...Array.from({ length: 6 }, () => ({
      scenario: 'same trade ×6',
      followerId: dup.id,
      tradeId,
    })),
    ...racers.flatMap((f) =>
      [0, 1].map(() => ({
        scenario: '700 / 700',
        followerId: f.id,
        tradeId: `race-${short(newId())}`,
      })),
    ),
  ];
  const requests = await Promise.all(
    jobs.map(async (j, i) => ({
      ...j,
      n: i + 1,
      call: await api.copyTrade({
        trade: { id: j.tradeId, traderId: TRADER_ID, amount: 700 },
        followerId: j.followerId,
      }),
    })),
  );
  const ids = [dup.id, ...racers.map((f) => f.id)];
  const [followers, tradeLists, instances, report] = await Promise.all([
    Promise.all(ids.map((id) => api.getFollower(id))),
    Promise.all(ids.map((id) => api.listTrades(id))),
    api.instances(),
    api.reconcile(),
  ]);
  return {
    requests,
    followers,
    trades: tradeLists.flat(),
    replicasUsed: [...new Set(requests.map((r) => r.call.instanceId ?? '?'))].sort(),
    apiReplicas: instances
      .filter((i) => i.kind === 'api' && i.alive)
      .map((i) => i.id)
      .sort(),
    report,
  };
}

export function MultiReplicaPanel(props: {
  disabled: boolean;
  guard: (work: () => Promise<void>) => Promise<void>;
  newId: () => string;
}) {
  const [run, setRun] = useState<ReplicaRun | undefined>();

  return (
    <section className="card" aria-labelledby="replicas-title">
      <h2 id="replicas-title">Multiple API replicas behind the load balancer</h2>
      <p className="muted">
        12 concurrent requests through nginx round-robin: the same trade six times for one follower,
        and two different 700 trades for each of three followers on 1,000 / 1,000.
      </p>
      <button
        type="button"
        data-testid="run-multi-replica"
        disabled={props.disabled}
        onClick={() =>
          void props.guard(async () => {
            setRun(await runAcrossReplicas(props.newId));
          })
        }
      >
        Run duplicate + 700/700 across replicas
      </button>

      {run !== undefined && (
        <div data-testid="multi-replica-result">
          <p data-testid="replica-summary" className={run.replicasUsed.length > 1 ? 'ok' : 'bad'}>
            Replicas used: {run.replicasUsed.length}/{run.apiReplicas.length} (
            {run.replicasUsed.join(', ')})
          </p>
          <div className="columns">
            <table className="table" data-testid="replica-requests">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Scenario</th>
                  <th>Follower</th>
                  <th>Trade</th>
                  <th>Served by</th>
                  <th>HTTP</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {run.requests.map((r) => (
                  <tr key={r.n} data-testid="replica-request" data-outcome={r.call.body.outcome}>
                    <td>{r.n}</td>
                    <td>{r.scenario}</td>
                    <td className="mono">{short(r.followerId)}</td>
                    <td className="mono">{r.tradeId}</td>
                    <td>
                      <InstanceBadge id={r.call.instanceId} />
                    </td>
                    <td>{r.call.status}</td>
                    <td>{outcomeLabel(r.call)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <h3>Final state</h3>
              <table className="table" data-testid="replica-followers">
                <thead>
                  <tr>
                    <th>Follower</th>
                    <th>Opening</th>
                    <th>Balance</th>
                    <th>Allocation</th>
                    <th>Copies</th>
                  </tr>
                </thead>
                <tbody>
                  {run.followers.map((f) => (
                    <tr key={f.id} data-testid="replica-follower">
                      <td className="mono">{short(f.id)}</td>
                      <td>
                        {fmt(f.openingBalance)} / {fmt(f.openingAllocation)}
                      </td>
                      <td data-testid="replica-balance">{fmt(f.balance)}</td>
                      <td data-testid="replica-allocation">{fmt(f.remainingAllocation)}</td>
                      <td data-testid="replica-copies">
                        {run.trades.filter((t) => t.followerId === f.id).length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>Recorded trades</h3>
              <table className="table" data-testid="replica-trades">
                <thead>
                  <tr>
                    <th>Follower</th>
                    <th>Trade</th>
                    <th>Amount</th>
                    <th>Handled by</th>
                  </tr>
                </thead>
                <tbody>
                  {run.trades.map((t) => (
                    <tr key={t.id} data-testid="replica-trade">
                      <td className="mono">{short(t.followerId)}</td>
                      <td className="mono">{t.tradeId}</td>
                      <td>{fmt(t.amount)}</td>
                      <td>
                        <InstanceBadge id={t.handledBy} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ReconciliationLine report={run.report} testId="replica-reconciliation" />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
