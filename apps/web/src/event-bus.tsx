import type {
  FollowerDto,
  FollowerTradeDto,
  ReconciliationReportDto,
  SystemInfo,
  TradeViewDto,
} from '@copy-trade/contracts';
import { useEffect, useState } from 'react';
import { api, type OpenTradeCall } from './api';
import { InstanceBadge, ReconciliationLine } from './widgets';

const fmt = (n: number): string => n.toLocaleString('en-US');
const short = (id: string): string => id.slice(0, 8);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface OpenCall {
  readonly label: string;
  readonly tradeId: string;
  readonly call: OpenTradeCall;
}

interface Participant {
  readonly role: string;
  readonly follower: FollowerDto;
}

export interface BusRun {
  readonly traderId: string;
  readonly opens: readonly OpenCall[];
  readonly views: readonly TradeViewDto[];
  readonly participants: readonly Participant[];
  readonly trades: readonly FollowerTradeDto[];
  readonly republished: number;
  readonly ledgerBefore: number;
  readonly ledgerAfter: number;
  readonly report: ReconciliationReportDto;
}

async function waitProcessed(tradeId: string, timeoutMs = 30_000): Promise<TradeViewDto> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await api.getTrade(tradeId);
    if (view.requests.every((r) => r.processed !== null)) return view;
    if (Date.now() > deadline) throw new Error(`Workers did not process ${tradeId} in time`);
    await sleep(250);
  }
}

/**
 * The event-driven path end to end: POST /v1/trades writes the trade and one TradeOpened per
 * subscribed follower to the outbox; the relay publishes them to Redpanda keyed by follower;
 * the worker group copies them. Covers duplicate trade submissions (sequential and concurrent),
 * a 700/700 pair, a conflicting resubmission, and a forced redelivery of every event.
 */
async function runEventBus(newId: () => string): Promise<BusRun> {
  const traderId = `trader-${short(newId())}`;
  const create = (
    balance: number,
    allocation: number,
    copyingEnabled: boolean,
    subscribed: boolean,
  ) =>
    api.createFollower({
      balance,
      allocation,
      copyingEnabled,
      traderIds: subscribed ? [traderId] : [],
    });
  const [rich, a, b, c, paused, outsider] = await Promise.all([
    create(10_000, 2_000, true, true),
    create(1_000, 1_000, true, true),
    create(1_000, 1_000, true, true),
    create(1_000, 1_000, true, true),
    create(1_000, 1_000, false, true),
    create(1_000, 1_000, true, false),
  ]);

  const trade = (amount: number) => ({ id: `T-${short(newId())}`, traderId, amount });
  const t1 = trade(200);
  const opens: OpenCall[] = [];
  const open = async (label: string, body: { id: string; traderId: string; amount: number }) => {
    const call = await api.openTrade(body);
    opens.push({ label, tradeId: body.id, call });
  };

  await open('open trade (200)', t1);
  await open('same trade again (sequential)', t1);
  await Promise.all([
    open('same trade (concurrent #1)', t1),
    open('same trade (concurrent #2)', t1),
  ]);
  await waitProcessed(t1.id);

  const t2 = trade(700);
  const t3 = trade(700);
  await Promise.all([open('700 trade, concurrent', t2), open('700 trade, concurrent', t3)]);
  await open('same id, different amount', { ...t1, amount: 900 });
  await Promise.all([waitProcessed(t2.id), waitProcessed(t3.id)]);

  const ids = [rich, a, b, c, paused, outsider].map((f) => f.id);
  const countLedger = async () => (await Promise.all(ids.map((id) => api.listTrades(id)))).flat();
  const ledgerBefore = (await countLedger()).length;
  const republished = await api.republish(t1.id);
  await sleep(2_500);

  const [views, followers, trades, report] = await Promise.all([
    Promise.all([t1, t2, t3].map((t) => api.getTrade(t.id))),
    Promise.all(ids.map((id) => api.getFollower(id))),
    countLedger(),
    api.reconcile(),
  ]);
  const roles = [
    '10,000 / 2,000',
    '1,000 / 1,000',
    '1,000 / 1,000',
    '1,000 / 1,000',
    'copying off',
    'not subscribed',
  ];
  return {
    traderId,
    opens,
    views,
    participants: followers.map((follower, i) => ({ role: roles[i] ?? '', follower })),
    trades,
    republished,
    ledgerBefore,
    ledgerAfter: trades.length,
    report,
  };
}

export function ConsoleLinks(props: { system: SystemInfo | undefined }) {
  const { system } = props;
  if (system?.consoleUrl === null || system === undefined) {
    return <p className="muted">Event bus not configured on this API.</p>;
  }
  const url = system.consoleUrl;
  const links: [string, string][] = [
    ['Topics', `${url}/topics`],
    [system.topics.requested, `${url}/topics/${system.topics.requested}`],
    [system.topics.completed, `${url}/topics/${system.topics.completed}`],
    [system.topics.rejected, `${url}/topics/${system.topics.rejected}`],
    [`${system.topics.deadLetter} (DLQ)`, `${url}/topics/${system.topics.deadLetter}`],
    [`Consumer group ${system.consumerGroup} (lag)`, `${url}/groups/${system.consumerGroup}`],
  ];
  return (
    <nav className="links" aria-label="Redpanda Console" data-testid="console-links">
      <strong>Redpanda Console:</strong>
      {links.map(([label, href]) => (
        <a key={href} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>
      ))}
    </nav>
  );
}

export function EventBusPanel(props: {
  disabled: boolean;
  guard: (work: () => Promise<void>) => Promise<void>;
  newId: () => string;
}) {
  const [system, setSystem] = useState<SystemInfo | undefined>();
  const [run, setRun] = useState<BusRun | undefined>();

  useEffect(() => {
    api.system().then(setSystem, () => undefined);
  }, []);

  const rows =
    run?.views.flatMap((v) => v.requests.map((r) => ({ trade: v.trade, request: r }))) ?? [];
  const workers = [...new Set(rows.map((r) => r.request.processed?.handledBy ?? '?'))].sort();
  const partitions = [...new Set(rows.map((r) => r.request.processed?.partition ?? -1))].sort(
    (x, y) => x - y,
  );
  const roleOf = (id: string) => run?.participants.find((p) => p.follower.id === id)?.role ?? '';

  return (
    <section className="card" aria-labelledby="bus-title">
      <h2 id="bus-title">Event bus: outbox → Redpanda → worker group</h2>
      <ConsoleLinks system={system} />
      <p className="muted">
        Opens trades for a trader with five subscribers (one has copying off) and one
        non-subscriber. Each follower trade is processed by a worker in consumer group{' '}
        <span className="mono">{system?.consumerGroup ?? 'copy-trade-workers'}</span>; the row lock
        and the unique key in Postgres stay the source of truth.
      </p>
      <button
        type="button"
        data-testid="run-event-bus"
        disabled={props.disabled || system?.eventBus !== true}
        onClick={() =>
          void props.guard(async () => {
            setRun(await runEventBus(props.newId));
          })
        }
      >
        Run event-driven scenario
      </button>

      {run !== undefined && (
        <div data-testid="event-bus-result">
          <table className="table" data-testid="bus-open-calls">
            <thead>
              <tr>
                <th>POST /v1/trades</th>
                <th>Trade</th>
                <th>HTTP</th>
                <th>Outcome</th>
                <th>Served by</th>
              </tr>
            </thead>
            <tbody>
              {run.opens.map((o, i) => (
                <tr key={i} data-testid="bus-open-call" data-outcome={o.call.body.outcome}>
                  <td>{o.label}</td>
                  <td className="mono">{o.tradeId}</td>
                  <td>{o.call.status}</td>
                  <td>
                    {o.call.body.outcome}
                    {o.call.body.outcome === 'trade_conflict'
                      ? ''
                      : ` (${String(o.call.body.requestedFollowerIds.length)} followers)`}
                  </td>
                  <td>
                    <InstanceBadge id={o.call.instanceId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p data-testid="bus-summary" className="ok">
            Workers used: {workers.join(', ')} · partitions: {partitions.join(', ')} · redelivery:
            republished {run.republished} events, ledger rows {run.ledgerBefore} → {run.ledgerAfter}
          </p>

          <table className="table" data-testid="bus-requests">
            <thead>
              <tr>
                <th>Trade</th>
                <th>Amount</th>
                <th>Follower</th>
                <th>Outcome</th>
                <th>Handled by worker</th>
                <th>Partition @ offset</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ trade, request }) => (
                <tr
                  key={request.eventId}
                  data-testid="bus-request"
                  data-trade={trade.id}
                  data-follower={request.followerId}
                  data-outcome={request.processed?.outcome ?? 'pending'}
                >
                  <td className="mono">{trade.id}</td>
                  <td>{fmt(trade.amount)}</td>
                  <td>
                    <span className="mono">{short(request.followerId)}</span>{' '}
                    <span className="muted">{roleOf(request.followerId)}</span>
                  </td>
                  <td>
                    {request.processed?.outcome ?? 'pending'}
                    {request.processed?.reason ? `: ${request.processed.reason}` : ''}
                  </td>
                  <td>
                    <InstanceBadge id={request.processed?.handledBy} />
                  </td>
                  <td className="mono">
                    {request.processed?.partition ?? '—'} @ {request.processed?.offset ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Final state</h3>
          <table className="table" data-testid="bus-followers">
            <thead>
              <tr>
                <th>Follower</th>
                <th>Setup</th>
                <th>Balance</th>
                <th>Allocation</th>
                <th>Copies (worker)</th>
              </tr>
            </thead>
            <tbody>
              {run.participants.map(({ role, follower }) => {
                const mine = run.trades.filter((t) => t.followerId === follower.id);
                return (
                  <tr key={follower.id} data-testid="bus-follower" data-role={role}>
                    <td className="mono">{short(follower.id)}</td>
                    <td>{role}</td>
                    <td data-testid="bus-balance">{fmt(follower.balance)}</td>
                    <td data-testid="bus-allocation">{fmt(follower.remainingAllocation)}</td>
                    <td data-testid="bus-copies" data-count={mine.length}>
                      {mine.length}{' '}
                      {mine.map((t) => (
                        <InstanceBadge key={t.id} id={t.handledBy} />
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ReconciliationLine report={run.report} testId="bus-reconciliation" />
        </div>
      )}
    </section>
  );
}
