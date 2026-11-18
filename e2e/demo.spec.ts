import { expect, test, type Page } from '@playwright/test';

/** Recorded walkthrough (video on). Run: pnpm demo:record */

const PAUSE_MS = Number(process.env['DEMO_PAUSE_MS'] ?? 3_500);

async function caption(page: Page, text: string) {
  await page.evaluate((t) => {
    let el = document.getElementById('demo-caption');
    if (el === null) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      Object.assign(el.style, {
        position: 'fixed',
        left: '50%',
        top: '12px',
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

async function highlight(page: Page, testId: string) {
  await page
    .getByTestId(testId)
    .first()
    .evaluate((el) => {
      (el as HTMLElement).style.outline = '3px solid #f59e0b';
      (el as HTMLElement).style.outlineOffset = '2px';
    });
}

async function scenario(page: Page, id: string, intro: string, outcome: string) {
  await caption(page, intro);
  await page.waitForTimeout(PAUSE_MS / 2);
  await page.getByTestId(`scenario-${id}`).click();
  await expect(page.getByTestId(`scenario-${id}`)).toBeEnabled();
  await expect(page.getByTestId('trade-row').first()).toContainText('executed', {
    timeout: 10_000,
  });
  await highlight(page, 'scenario-run');
  await highlight(page, 'follower-state');
  await caption(page, outcome);
  await page.waitForTimeout(PAUSE_MS);
}

test('walkthrough of the three assessment scenarios', async ({ page }) => {
  await page.goto('/');
  await caption(page, 'Copy Trade Console: Fastify + Postgres (row lock + unique ledger key)');
  await page.waitForTimeout(PAUSE_MS);

  await scenario(
    page,
    'normal',
    'Scenario 1: balance 10,000, allocation 2,000, copy a 700 trade',
    'Result: copied (201). Balance 9,300, allocation 1,300, one ledger row, executed',
  );
  await scenario(
    page,
    'duplicate-sequential',
    'Scenario 2a: the same trade sent twice, one after the other',
    'Result: 201 copied + 200 duplicate (original record). Debited once: 9,300 / 1,300',
  );
  await scenario(
    page,
    'duplicate-concurrent',
    'Scenario 2b: the same trade sent twice at the same time',
    'Result: still exactly one effect: one copied, one duplicate, one ledger row',
  );
  await scenario(
    page,
    'concurrent-700',
    'Scenario 3: two different 700 trades at once against 1,000 / 1,000',
    'Result: exactly one succeeds, the other is rejected (INSUFFICIENT_BALANCE). 300 / 300, never negative',
  );

  await caption(page, 'Reconciliation: balance = opening - ledger, one row per key');
  await page.getByTestId('run-reconciliation').click();
  await expect(page.getByTestId('reconciliation-result')).toContainText('Consistent');
  await page.getByTestId('reconciliation-result').evaluate((el) => {
    el.scrollIntoView({ block: 'center' });
  });
  await highlight(page, 'reconciliation-result');
  await page.waitForTimeout(PAUSE_MS);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await caption(page, 'All three scenarios: correct, idempotent and concurrency-safe');
  await page.waitForTimeout(PAUSE_MS);
});
