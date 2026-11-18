import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SCREENSHOT_PATH = process.env['SCREENSHOT_PATH'] ?? 'test-results/copy-trade-ui.png';

async function runScenario(page: Page, id: string) {
  await page.getByTestId(`scenario-${id}`).click();
  const row = page.getByTestId('scenario-run').first();
  await expect(row).toBeVisible();
  await expect(page.getByTestId(`scenario-${id}`)).toBeEnabled();
  return row;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Copy Trade Console' })).toBeVisible();
});

test.describe('assessment scenarios through the UI', () => {
  test('1. normal: 10,000 / 2,000 follower copies a 700 trade', async ({ page }) => {
    const row = await runScenario(page, 'normal');

    await expect(row.getByTestId('scenario-summary')).toHaveText('1× copied');
    await expect(row.getByTestId('scenario-balance')).toHaveText('9,300');
    await expect(row.getByTestId('scenario-allocation')).toHaveText('1,300');
    await expect(page.getByTestId('follower-balance')).toHaveText('9,300');
    await expect(page.getByTestId('trade-row')).toHaveCount(1);
    // The outbox relay settles the entry asynchronously.
    await expect(page.getByTestId('trade-row').first()).toContainText('executed', {
      timeout: 10_000,
    });
  });

  test('2a. same trade twice, sequential: one copy, one duplicate', async ({ page }) => {
    const row = await runScenario(page, 'duplicate-sequential');

    await expect(row.getByTestId('scenario-summary')).toHaveText('1× copied, 1× duplicate');
    await expect(row).toContainText('201 / 200');
    await expect(row.getByTestId('scenario-balance')).toHaveText('9,300');
    await expect(page.getByTestId('trade-row')).toHaveCount(1);
  });

  test('2b. same trade twice, concurrent: one copy, one duplicate', async ({ page }) => {
    const row = await runScenario(page, 'duplicate-concurrent');

    await expect(row.getByTestId('scenario-summary')).toHaveText('1× copied, 1× duplicate');
    await expect(row.getByTestId('scenario-balance')).toHaveText('9,300');
    await expect(row.getByTestId('scenario-allocation')).toHaveText('1,300');
    await expect(page.getByTestId('trade-row')).toHaveCount(1);
  });

  test('3. two concurrent 700 trades on 1,000 / 1,000: exactly one succeeds', async ({ page }) => {
    const row = await runScenario(page, 'concurrent-700');

    await expect(row.getByTestId('scenario-summary')).toHaveText(
      '1× copied, 1× rejected:INSUFFICIENT_BALANCE',
    );
    await expect(row.getByTestId('scenario-balance')).toHaveText('300');
    await expect(row.getByTestId('scenario-allocation')).toHaveText('300');
    await expect(page.getByTestId('follower-balance')).toHaveText('300');
    await expect(page.getByTestId('trade-row')).toHaveCount(1);
    await expect(page.getByTestId('trade-row').first()).toContainText('executed', {
      timeout: 10_000,
    });

    await page.getByTestId('run-reconciliation').click();
    await expect(page.getByTestId('reconciliation-result')).toContainText('Consistent');

    mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  });
});

test.describe('rejections through the UI', () => {
  async function createFollower(page: Page, balance: number, allocation: number, enabled = true) {
    const form = page.getByRole('form', { name: 'Create follower' });
    await form.getByLabel('Balance').fill(String(balance));
    await form.getByLabel('Allocation').fill(String(allocation));
    const toggle = form.getByLabel('Copying enabled');
    if ((await toggle.isChecked()) !== enabled) await toggle.click();
    await form.getByRole('button', { name: 'Create follower' }).click();
    await expect(page.getByTestId('follower-balance')).toHaveText(balance.toLocaleString('en-US'));
    return (await page.getByTestId('follower-id').textContent()) ?? '';
  }

  async function submitTrade(page: Page, trade: { traderId?: string; amount: number }) {
    const form = page.getByRole('form', { name: 'Submit trade' });
    await form.getByRole('button', { name: 'New trade id' }).click();
    if (trade.traderId !== undefined) await form.getByLabel('Trader id').fill(trade.traderId);
    await form.getByLabel('Amount').fill(String(trade.amount));
    await form.getByRole('button', { name: 'Submit trade' }).click();
    return page.getByTestId('last-response');
  }

  test('copying disabled', async ({ page }) => {
    await createFollower(page, 10_000, 2_000, false);
    await expect(await submitTrade(page, { amount: 700 })).toContainText('COPYING_DISABLED');
    await expect(page.getByTestId('last-response')).toContainText('HTTP 422');
  });

  test('copying re-enabled via the toggle then succeeds', async ({ page }) => {
    await createFollower(page, 10_000, 2_000, false);
    await page
      .getByRole('region', { name: 'Selected follower' })
      .getByLabel('Copying enabled')
      .click();
    await expect(await submitTrade(page, { amount: 700 })).toContainText('"outcome": "copied"');
  });

  test('insufficient balance', async ({ page }) => {
    await createFollower(page, 500, 2_000);
    await expect(await submitTrade(page, { amount: 700 })).toContainText('INSUFFICIENT_BALANCE');
  });

  test('insufficient allocation', async ({ page }) => {
    await createFollower(page, 10_000, 500);
    await expect(await submitTrade(page, { amount: 700 })).toContainText('INSUFFICIENT_ALLOCATION');
  });

  test('invalid amount', async ({ page }) => {
    await createFollower(page, 10_000, 2_000);
    await expect(await submitTrade(page, { amount: 0 })).toContainText('INVALID_AMOUNT');
  });

  test('self-copy', async ({ page }) => {
    const followerId = await createFollower(page, 10_000, 2_000);
    await expect(await submitTrade(page, { traderId: followerId, amount: 700 })).toContainText(
      'SELF_COPY',
    );
    await expect(page.getByTestId('follower-balance')).toHaveText('10,000');
    await expect(page.getByTestId('trade-row')).toHaveCount(0);
  });
});
