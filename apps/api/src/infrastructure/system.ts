import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Clock, IdGenerator, Sleep } from '@copy-trade/application';

export const systemClock: Clock = { now: () => new Date() };
export const uuidGenerator: IdGenerator = { next: () => randomUUID() };
export const realSleep: Sleep = (ms) => delay(ms).then(() => undefined);
