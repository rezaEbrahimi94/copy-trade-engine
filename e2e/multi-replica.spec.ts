import { expect, test } from '@playwright/test';

test('duplicate ×6 and 700/700 ×3 spread across all API replicas: one effect each, clean reconciliation', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('run-multi-replica').click();
  const result = page.getByTestId('multi-replica-result');
  await expect(result).toBeVisible({ timeout: 30_000 });

  await expect(page.getByTestId('replica-summary')).toHaveText(
    /Replicas used: 3\/3 \(api-1, api-2, api-3\)/,
  );

  const requests = page.getByTestId('replica-request');
  await expect(requests).toHaveCount(12);
  await expect(page.locator('[data-testid="replica-request"][data-outcome="copied"]')).toHaveCount(
    4,
  );
  await expect(
    page.locator('[data-testid="replica-request"][data-outcome="duplicate"]'),
  ).toHaveCount(5);
  await expect(
    page.locator('[data-testid="replica-request"][data-outcome="rejected"]'),
  ).toHaveCount(3);
  await expect(requests.filter({ hasText: 'rejected: INSUFFICIENT_BALANCE' })).toHaveCount(3);

  const followers = page.getByTestId('replica-follower');
  await expect(followers).toHaveCount(4);
  await expect(followers.nth(0).getByTestId('replica-balance')).toHaveText('9,300');
  await expect(followers.nth(0).getByTestId('replica-allocation')).toHaveText('1,300');
  for (const i of [1, 2, 3]) {
    await expect(followers.nth(i).getByTestId('replica-balance')).toHaveText('300');
    await expect(followers.nth(i).getByTestId('replica-allocation')).toHaveText('300');
  }
  for (const i of [0, 1, 2, 3])
    await expect(followers.nth(i).getByTestId('replica-copies')).toHaveText('1');

  const trades = page.getByTestId('replica-trade');
  await expect(trades).toHaveCount(4);
  await expect(trades.filter({ hasText: /api-[123]/ })).toHaveCount(4);
  await expect(page.getByTestId('replica-reconciliation')).toHaveText(
    /consistent: \d+ followers checked, 0 drifted/,
  );
  await expect(page.getByTestId('served-by')).toContainText(/api-[123]/);

  await page
    .getByTestId('multi-replica-result')
    .screenshot({ path: 'test-results/multi-replica.png' });
});
