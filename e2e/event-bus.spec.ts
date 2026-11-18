import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('event bus: trades fan out through Redpanda to the worker group; duplicates, 700/700, redelivery', async ({
  page,
}) => {
  await expect(page.getByTestId('run-event-bus')).toBeEnabled();
  await page.getByTestId('run-event-bus').click();
  await expect(page.getByTestId('event-bus-result')).toBeVisible({ timeout: 60_000 });

  const opens = page.getByTestId('bus-open-call');
  await expect(opens).toHaveCount(7);
  await expect(opens.nth(0)).toContainText('202');
  await expect(opens.nth(0)).toContainText('accepted (4 followers)');
  await expect(page.locator('[data-testid="bus-open-call"][data-outcome="duplicate"]')).toHaveCount(
    3,
  );
  await expect(
    page.locator('[data-testid="bus-open-call"][data-outcome="trade_conflict"]'),
  ).toHaveCount(1);
  await expect(opens.last()).toContainText('409');

  // 4 subscribed followers with copying on × 3 trades; nobody else got an event.
  const requests = page.getByTestId('bus-request');
  await expect(requests).toHaveCount(12);
  await expect(page.locator('[data-testid="bus-request"][data-outcome="copied"]')).toHaveCount(9);
  await expect(page.locator('[data-testid="bus-request"][data-outcome="rejected"]')).toHaveCount(3);
  await expect(requests.filter({ hasText: 'INSUFFICIENT_BALANCE' })).toHaveCount(3);
  await expect(requests.filter({ hasText: /worker-\d/ })).toHaveCount(12);

  const followers = page.getByTestId('bus-follower');
  await expect(followers).toHaveCount(6);
  const row = (role: string) => page.locator(`[data-testid="bus-follower"][data-role="${role}"]`);
  await expect(row('10,000 / 2,000').getByTestId('bus-balance')).toHaveText('8,400');
  await expect(row('10,000 / 2,000').getByTestId('bus-allocation')).toHaveText('400');
  await expect(row('10,000 / 2,000').getByTestId('bus-copies')).toHaveAttribute('data-count', '3');
  for (const tight of await row('1,000 / 1,000').all()) {
    await expect(tight.getByTestId('bus-balance')).toHaveText('100');
    await expect(tight.getByTestId('bus-copies')).toHaveAttribute('data-count', '2');
  }
  await expect(row('copying off').getByTestId('bus-copies')).toHaveAttribute('data-count', '0');
  await expect(row('not subscribed').getByTestId('bus-copies')).toHaveAttribute('data-count', '0');

  await expect(page.getByTestId('bus-summary')).toContainText(
    'republished 4 events, ledger rows 9 → 9',
  );
  await expect(page.getByTestId('bus-reconciliation')).toHaveText(
    /consistent: \d+ followers checked, 0 drifted/,
  );
  await page.getByTestId('event-bus-result').screenshot({ path: 'test-results/event-bus.png' });
});

test('Redpanda Console links and live workers with their partitions', async ({ page }) => {
  const links = page.getByTestId('console-links');
  await expect(
    links.getByRole('link', { name: 'copy-trade.requested', exact: true }),
  ).toHaveAttribute('href', /\/topics\/copy-trade\.requested$/);
  await expect(
    links.getByRole('link', { name: /Consumer group copy-trade-workers/ }),
  ).toHaveAttribute('href', /\/groups\/copy-trade-workers$/);
  await expect(links.getByRole('link', { name: /DLQ/ })).toBeVisible();

  const workers = page.locator(
    '[data-testid="instance-row"][data-kind="worker"][data-alive="true"]',
  );
  await expect(workers).toHaveCount(3, { timeout: 15_000 });
  await expect(
    page.locator('[data-testid="instance-row"][data-kind="api"][data-alive="true"]'),
  ).toHaveCount(3);
});
