import { createServiceLogger } from '@copy-trade/platform';
import type { Logger } from 'pino';
import type { AppConfig } from '../config';

export function createLogger(config: AppConfig, fd: 1 | 2 = 1): Logger {
  return createServiceLogger(
    {
      level: config.log.level,
      pretty: config.log.pretty,
      service: config.otel.serviceName,
      instanceId: config.instanceId,
    },
    fd,
  );
}
