import type { FollowerDto, FollowerTradeDto, ReconciliationReportDto } from '@copy-trade/contracts';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CopyTradeCall } from './api';
import { CreateFollowerForm, TradeForm } from './forms';
import { SCENARIOS, summarize, type Scenario, type ScenarioRun } from './scenarios';

const fmt = (n: number): string => n.toLocaleString('en-US');
const newId = (): string => crypto.randomUUID();
const short = (id: string): string => id.slice(0, 8);

export function App() {
  const [followers, setFollowers] = useState<FollowerDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [trades, setTrades] = useState<FollowerTradeDto[]>([]);
  const [runs, setRuns] = useState<ScenarioRun[]>([]);
  const [lastCall, setLastCall] = useState<CopyTradeCall | undefined>();
  const [report, setReport] = useState<ReconciliationReportDto | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const selected = followers.find((f) => f.id === selectedId);

  const refresh = useCallback(async (followerId?: string) => {
    const list = await api.listFollowers();
    setFollowers(list);
    if (followerId !== undefined) setTrades(await api.listTrades(followerId));
  }, []);

  const guard = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.listFollowers().then(
      (list) => {
        if (!cancelled) setFollowers(list);
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedId === undefined) return;
    const timer = setInterval(() => void refresh(selectedId).catch(() => undefined), 1500);
    return () => {
      clearInterval(timer);
    };
  }, [selectedId, refresh]);

  const select = (id: string) =>
    guard(async () => {
      setSelectedId(id);
      await refresh(id);
    });

  const runScenario = (scenario: Scenario) =>
    guard(async () => {
      const follower = await api.createFollower({ ...scenario.opening, copyingEnabled: true });
      const calls = await scenario.run(follower, newId);
      const [after] = await Promise.all([api.listFollowers(), refresh(follower.id)]);
      const updated = after.find((f) => f.id === follower.id) ?? follower;
      setSelectedId(follower.id);
      setRuns((prev) => [
        { id: newId(), name: scenario.name, follower: updated, calls, summary: summarize(calls) },
        ...prev,
      ]);
    });

  return (
    <div className="layout">
      <header>
        <h1>Copy Trade Console</h1>
        <p className="muted">
          Amounts are integer minor units. Every copy is idempotent per (trade, follower) and
          serialized per follower with a row lock.
        </p>
      </header>

      {error !== undefined && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <section className="card" aria-labelledby="scenarios-title">
        <h2 id="scenarios-title">Scenarios</h2>
        <div className="scenario-grid">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="scenario"
              data-testid={`scenario-${s.id}`}
              disabled={busy}
              onClick={() => void runScenario(s)}
            >
              <strong>{s.name}</strong>
              <span>{s.description}</span>
            </button>
          ))}
        </div>
        {runs.length > 0 && (
          <table className="table" data-testid="scenario-results">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Follower</th>
                <th>Responses</th>
                <th>Result</th>
                <th>Balance after</th>
                <th>Allocation after</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} data-testid="scenario-run">
                  <td>{r.name}</td>
                  <td className="mono">{short(r.follower.id)}</td>
                  <td className="mono">{r.calls.map((c) => c.status).join(' / ')}</td>
                  <td data-testid="scenario-summary">{r.summary}</td>
                  <td data-testid="scenario-balance">{fmt(r.follower.balance)}</td>
                  <td data-testid="scenario-allocation">{fmt(r.follower.remainingAllocation)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="columns">
        <section className="card" aria-labelledby="followers-title">
          <h2 id="followers-title">Followers</h2>
          <CreateFollowerForm
            disabled={busy}
            onSubmit={(body) =>
              guard(async () => {
                const f = await api.createFollower(body);
                setSelectedId(f.id);
                await refresh(f.id);
              })
            }
          />
          <div className="scroll">
            <table className="table" data-testid="followers-table">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Balance</th>
                  <th>Allocation</th>
                  <th>Copying</th>
                </tr>
              </thead>
              <tbody>
                {followers.map((f) => (
                  <tr
                    key={f.id}
                    className={f.id === selectedId ? 'selected' : undefined}
                    onClick={() => void select(f.id)}
                  >
                    <td className="mono">{short(f.id)}</td>
                    <td>{fmt(f.balance)}</td>
                    <td>{fmt(f.remainingAllocation)}</td>
                    <td>{f.copyingEnabled ? 'on' : 'off'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-labelledby="selected-title">
          <h2 id="selected-title">Selected follower</h2>
          {selected === undefined ? (
            <p className="muted">Create or select a follower.</p>
          ) : (
            <>
              <dl className="stats" data-testid="follower-state">
                <div>
                  <dt>Id</dt>
                  <dd className="mono" data-testid="follower-id">
                    {selected.id}
                  </dd>
                </div>
                <div>
                  <dt>Balance</dt>
                  <dd data-testid="follower-balance">{fmt(selected.balance)}</dd>
                </div>
                <div>
                  <dt>Remaining allocation</dt>
                  <dd data-testid="follower-allocation">{fmt(selected.remainingAllocation)}</dd>
                </div>
                <div>
                  <dt>Opening</dt>
                  <dd>
                    {fmt(selected.openingBalance)} / {fmt(selected.openingAllocation)}
                  </dd>
                </div>
              </dl>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={selected.copyingEnabled}
                  disabled={busy}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    void guard(async () => {
                      await api.setCopying(selected.id, enabled);
                      await refresh(selected.id);
                    });
                  }}
                />
                Copying enabled
              </label>
              <TradeForm
                followerId={selected.id}
                disabled={busy}
                onSubmit={(body, key) =>
                  guard(async () => {
                    setLastCall(await api.copyTrade(body, key));
                    await refresh(selected.id);
                  })
                }
              />
              {lastCall !== undefined && (
                <pre className="response" data-testid="last-response">
                  HTTP {lastCall.status} {JSON.stringify(lastCall.body, null, 2)}
                </pre>
              )}
              <h3>Recorded trades</h3>
              <table className="table" data-testid="trades-table">
                <thead>
                  <tr>
                    <th>Trade</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} data-testid="trade-row">
                      <td className="mono">{t.tradeId}</td>
                      <td>{fmt(t.amount)}</td>
                      <td>
                        <span className={`badge ${t.status}`}>{t.status}</span>
                      </td>
                      <td>{new Date(t.createdAt).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="recon-title">
        <h2 id="recon-title">Reconciliation</h2>
        <button
          type="button"
          disabled={busy}
          data-testid="run-reconciliation"
          onClick={() =>
            void guard(async () => {
              setReport(await api.reconcile());
            })
          }
        >
          Run reconciliation
        </button>
        {report !== undefined && (
          <p data-testid="reconciliation-result" className={report.consistent ? 'ok' : 'bad'}>
            {report.consistent ? 'Consistent' : 'DRIFT DETECTED'}: {report.summary.followersChecked}{' '}
            followers checked, {report.summary.driftedFollowers} drifted, {report.stuckPending}{' '}
            stuck pending
          </p>
        )}
      </section>
    </div>
  );
}
