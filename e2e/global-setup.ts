import { setTimeout as delay } from 'node:timers/promises';
import type { FullConfig } from '@playwright/test';

/** Fails fast with a helpful message when the composed stack is not running. */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:8080';
  for (let i = 0; i < 60; i++) {
    const ready = await fetch(`${baseURL}/api/health/ready`).then(
      (r) => r.ok,
      () => false,
    );
    if (ready) return;
    await delay(1_000);
  }
  throw new Error(`Stack not ready at ${baseURL}. Start it with: docker compose up --build --wait`);
}
