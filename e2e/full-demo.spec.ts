import { execFileSync } from 'node:child_process';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Recorded walkthrough of every scenario, one video per section (each test). Drives the real
 * compose stack, kills and restarts a worker with `docker`, and produces a poison message with
 * `rpk`. Run: pnpm demo:record --grep "full demo"
 */

const PAUSE_MS = Number(process.env['DEMO_PAUSE_MS'] ?? 3_000);
const CONSOLE_URL = process.env['CONSOLE_URL'] ?? 'http://localhost:8090';

test.describe.configure({ mode: 'serial' });

async function caption(page: Page, text: string) {
  await page.evaluate((t) => {
    let el = document.getElementById('demo-caption');
    if (el === null) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      Object.assign(el.style, {
        position: 'fixed',
        left: '50%',
        bottom: '18px',
        transform: 'translateX(-50%)',
        background: 'rgba(15, 23, 42, 0.92)',
        color: 'white',
        padding: '12px 20px',
        borderRadius: '10px',
        font: '600 18px system-ui, sans-serif',
        zIndex: '9999',
        maxWidth: '90vw',
        textAlign: 'center',
        boxShadow: '0 8px 24px rgba(0,0,0,.25)',
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

async function show(locator: Locator) {
  await locator.first().evaluate((el) => {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    (el as HTMLElement).style.outline = '3px solid #f59e0b';
    (el as HTMLElement).style.outlineOffset = '2px';
  });
}

const pause = (page: Page, factor = 1) => page.waitForTimeout(PAUSE_MS * factor);

async function openConsole(page: Page, path: string, ready: string | RegExp) {
  await page.goto(`${CONSOLE_URL}${path}`);
  await page.getByText(ready).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

async function scenario(page: Page, id: string, intro: string, outcome: string) {
  await show(page.getByTestId(`scenario-${id}`));
  await caption(page, intro);
  await pause(page, 0.6);
  await page.getByTestId(`scenario-${id}`).click();
  await expect(page.getByTestId(`scenario-${id}`)).toBeEnabled();
  await expect(page.getByTestId('trade-row').first()).toContainText('executed', {
    timeout: 10_000,
  });
  await show(page.getByTestId('scenario-run'));
  await caption(page, outcome);
  await pause(page);
}

async function rejection(
  page: Page,
  opening: [number, number, boolean],
  amount: number,
  label: string,
  traderIsSelf = false,
) {
  const form = page.getByRole('form', { name: 'Create follower' });
  await show(form);
  await caption(page, label);
  await form.getByLabel('Balance').fill(String(opening[0]));
  await form.getByLabel('Allocation').fill(String(opening[1]));
  const toggle = form.getByLabel('Copying enabled');
  if ((await toggle.isChecked()) !== opening[2]) await toggle.click();
  await form.getByRole('button', { name: 'Create follower' }).click();
  await expect(page.getByTestId('follower-balance')).toHaveText(opening[0].toLocaleString('en-US'));
  const trade = page.getByRole('form', { name: 'Submit trade' });
  await trade.getByRole('button', { name: 'New trade id' }).click();
  await trade
    .getByLabel('Trader id')
    .fill(
      traderIsSelf ? ((await page.getByTestId('follower-id').textContent()) ?? '') : 'trader-demo',
    );
  await trade.getByLabel('Amount').fill(String(amount));
  await trade.getByRole('button', { name: 'Submit trade' }).click();
  await expect(page.getByTestId('last-response')).toContainText('HTTP 4');
  await show(page.getByTestId('last-response'));
  await pause(page, 0.8);
}

test('full demo 1: UI scenarios and rejections', async ({ page }) => {
  await page.goto('/');
  await caption(
    page,
    'Copy Trade Console: UI → web nginx → load balancer → 3 API replicas → one PostgreSQL',
  );
  await show(page.getByTestId('served-by'));
  await pause(page);

  await scenario(
    page,
    'normal',
    'Normal: balance 10,000 / allocation 2,000, copy one 700 trade',
    'copied (201): 9,300 / 1,300, one ledger row, executed; "Served by" shows the replica',
  );
  await scenario(
    page,
    'duplicate-sequential',
    'Same trade twice, sequentially',
    '201 copied + 200 duplicate (original record): debited once, 9,300 / 1,300',
  );
  await scenario(
    page,
    'duplicate-concurrent',
    'Same trade twice, concurrently (possibly on two different replicas)',
    'Still exactly one effect: one copied, one duplicate, one ledger row',
  );
  await scenario(
    page,
    'concurrent-700',
    'Two different 700 trades at once against 1,000 / 1,000',
    'Exactly one succeeds, the other is 422 INSUFFICIENT_BALANCE: 300 / 300, never negative',
  );

  await rejection(
    page,
    [10_000, 2_000, false],
    700,
    'Rejection: copying disabled → 422 COPYING_DISABLED',
  );
  await rejection(
    page,
    [500, 2_000, true],
    700,
    'Rejection: balance 500 < 700 → 422 INSUFFICIENT_BALANCE',
  );
  await rejection(
    page,
    [10_000, 500, true],
    700,
    'Rejection: allocation 500 < 700 → 422 INSUFFICIENT_ALLOCATION',
  );
  await rejection(page, [10_000, 2_000, true], 0, 'Rejection: amount 0 → 422 INVALID_AMOUNT');
  await rejection(
    page,
    [10_000, 2_000, true],
    700,
    'Rejection: trader is the follower → 422 SELF_COPY',
    true,
  );
  await expect(page.getByTestId('trade-row')).toHaveCount(0);

  await caption(
    page,
    'Reconciliation: balance = opening − ledger for every follower, one row per key',
  );
  await page.getByTestId('run-reconciliation').click();
  await expect(page.getByTestId('reconciliation-result')).toContainText('Consistent');
  await show(page.getByTestId('reconciliation-result'));
  await pause(page);
});

test('full demo 2: duplicate and 700/700 spread across 3 API replicas', async ({ page }) => {
  await page.goto('/');
  await show(page.getByTestId('run-multi-replica'));
  await caption(
    page,
    '12 concurrent requests via nginx round-robin: same trade ×6, and 700/700 for three 1,000 / 1,000 followers',
  );
  await pause(page);
  await page.getByTestId('run-multi-replica').click();
  await expect(page.getByTestId('replica-summary')).toContainText('3/3');
  await show(page.getByTestId('replica-summary'));
  await caption(
    page,
    'Every request shows the replica that served it (x-instance-id): api-1, api-2 and api-3 all took part',
  );
  await pause(page, 1.3);
  await show(page.getByTestId('replica-requests'));
  await caption(
    page,
    'Same trade ×6: one 201 copied + five 200 duplicates. Each 700/700 pair: one 201, one 422',
  );
  await pause(page, 1.5);
  await show(page.getByTestId('replica-followers'));
  await caption(
    page,
    'Final state: 9,300 / 1,300 and 300 / 300, exactly one copy each; ledger rows record handled_by',
  );
  await pause(page, 1.3);
  await show(page.getByTestId('replica-reconciliation'));
  await caption(page, 'Reconciliation across everything the replicas wrote: consistent, 0 drifted');
  await pause(page);
});

test('full demo 3: event bus through Redpanda and the worker group, with Console views', async ({
  page,
}) => {
  await page.goto('/');
  await show(page.getByTestId('console-links'));
  await caption(
    page,
    'Event-driven path: POST /v1/trades → event_outbox (same tx) → relay → Redpanda → 3 workers in one consumer group',
  );
  await pause(page, 1.3);
  await page.getByTestId('run-event-bus').click();
  await expect(page.getByTestId('event-bus-result')).toBeVisible({ timeout: 60_000 });
  await show(page.getByTestId('bus-open-calls'));
  await caption(
    page,
    'Open trade 202; resubmitted sequentially and concurrently → 200 duplicate; same id, other amount → 409',
  );
  await pause(page, 1.5);
  await show(page.getByTestId('bus-requests'));
  await caption(
    page,
    'Per follower trade: outcome, the worker that handled it, partition @ offset (key = follower id)',
  );
  await pause(page, 1.5);
  await show(page.getByTestId('bus-summary'));
  await caption(
    page,
    'Forced redelivery of every event (same event ids): inbox says "seen", ledger rows unchanged',
  );
  await pause(page, 1.3);
  await show(page.getByTestId('bus-followers'));
  await caption(
    page,
    'Final state: 700/700 → one copy per 1,000 / 1,000 follower; copying off and non-subscriber untouched',
  );
  await pause(page, 1.3);
  await show(page.getByTestId('bus-reconciliation'));
  await pause(page, 0.7);

  await openConsole(page, '/topics', 'copy-trade.requested.dlq');
  await caption(page, 'Redpanda Console: topics (requested, completed, rejected, DLQ)');
  await pause(page);
  await openConsole(page, '/topics/copy-trade.requested', 'Estimated messages');
  await caption(page, 'copy-trade.requested: TradeOpened messages, key = follower id');
  await pause(page);
  await page.getByRole('tab', { name: 'Partitions' }).click();
  await caption(page, '6 partitions');
  await pause(page);
  await openConsole(page, '/topics/copy-trade.completed', 'Estimated messages');
  await caption(page, 'copy-trade.completed: results published by the workers after the DB commit');
  await pause(page);
  await openConsole(page, '/groups/copy-trade-workers', 'Assigned Partitions');
  await caption(page, 'Consumer group copy-trade-workers: 3 members, 2 partitions each, lag 0');
  await pause(page, 1.3);
});

test('full demo 4: kill a worker and restart it', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await show(page.getByTestId('instances-table'));
  await caption(page, 'Instances: 3 API replicas and 3 workers, each worker owns 2 partitions');
  await pause(page);

  execFileSync('docker', ['kill', 'copy-trade-worker-2']);
  await caption(
    page,
    'docker kill copy-trade-worker-2 (SIGKILL: no clean leave, no offset commit)',
  );
  await expect(
    page.locator('[data-testid="instance-row"][data-kind="worker"][data-alive="false"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  await show(page.getByTestId('instances-table'));
  await caption(
    page,
    'worker-2 stops heart-beating → "lost"; after the session timeout the group rebalances',
  );
  await page.waitForTimeout(8_000);
  await show(page.getByTestId('instances-table'));
  await caption(page, 'worker-1 and worker-3 now own all 6 partitions');
  await pause(page);

  await openConsole(page, '/groups/copy-trade-workers', 'Assigned Partitions');
  await caption(page, 'Console: the group has 2 members now, each with 3 partitions');
  await pause(page, 1.3);

  await page.goto('/');
  await show(page.getByTestId('run-event-bus'));
  await caption(page, 'Run the event-driven scenario with only two workers');
  await page.getByTestId('run-event-bus').click();
  await expect(page.getByTestId('event-bus-result')).toBeVisible({ timeout: 60_000 });
  await show(page.getByTestId('bus-requests'));
  await caption(page, 'Every follower trade processed by worker-1 or worker-3, nothing lost');
  await pause(page, 1.3);
  await show(page.getByTestId('bus-reconciliation'));
  await caption(page, 'Reconciliation consistent');
  await pause(page, 0.7);

  await caption(page, 'docker compose up -d worker: worker-2 restarts and rejoins the group');
  execFileSync('docker', ['compose', 'up', '-d', '--wait', 'worker'], { stdio: 'ignore' });
  await show(page.getByTestId('instances-table'));
  await expect(
    page.locator('[data-testid="instance-row"][data-kind="worker"][data-alive="true"]'),
  ).toHaveCount(3, { timeout: 30_000 });
  await page.waitForTimeout(3_000);
  await caption(page, 'worker-2 alive again with its partitions back');
  await pause(page);
  await openConsole(page, '/groups/copy-trade-workers', 'Assigned Partitions');
  await caption(page, 'Console: 3 members again, lag 0');
  await pause(page, 1.3);
});

test('full demo 5: poison message goes to the DLQ', async ({ page }) => {
  await openConsole(page, '/topics/copy-trade.requested.dlq', 'Estimated messages');
  await caption(page, 'DLQ topic copy-trade.requested.dlq before');
  await pause(page);
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'copy-trade-redpanda-1',
      'rpk',
      'topic',
      'produce',
      'copy-trade.requested',
      '-k',
      'demo-poison',
    ],
    { input: 'this is not a TradeOpened event\n' },
  );
  await caption(page, 'rpk topic produce copy-trade.requested: a malformed message');
  await page.waitForTimeout(2_500);
  await page.reload();
  await page.getByText('demo-poison').first().waitFor({ timeout: 20_000 });
  await caption(
    page,
    'The worker rejects it by schema and dead-letters it (offset committed, partition not blocked)',
  );
  await pause(page);
  const expand = page.getByRole('button', { name: /expand|collapse/i }).first();
  if (await expand.isVisible().catch(() => false)) await expand.click();
  else await page.locator('table tbody tr').first().click();
  await page
    .getByText(/^Headers \(\d+\)$/)
    .first()
    .click();
  await caption(
    page,
    'Headers: dlq-reason=invalid_payload, dlq-error, dlq-attempts, dlq-source=topic/partition@offset',
  );
  await pause(page, 1.7);
});
