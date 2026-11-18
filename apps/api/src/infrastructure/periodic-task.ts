import type { Logger } from 'pino';

export interface PeriodicTask {
  stop(): Promise<void>;
}

/**
 * Runs `task` every `intervalMs` without overlap (next run is scheduled after the previous
 * finishes). Errors are logged, never thrown, so one failure cannot kill the loop.
 */
export function startPeriodicTask(
  name: string,
  intervalMs: number,
  task: () => Promise<void>,
  logger: Logger,
): PeriodicTask {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const tick = (): void => {
    running = task()
      .catch((error: unknown) => {
        logger.error({ err: error, task: name }, 'periodic task failed');
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  timer = setTimeout(tick, intervalMs);

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
