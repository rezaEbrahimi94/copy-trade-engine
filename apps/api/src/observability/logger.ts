import { pino, type Logger } from 'pino';
import type { AppConfig } from '../config';

/** `fd` 2 keeps stdout clean for jobs that print machine-readable output. */
export function createLogger(config: AppConfig, fd: 1 | 2 = 1): Logger {
  return pino(
    {
      level: config.log.level,
      base: { service: config.otel.serviceName, instanceId: config.instanceId },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], remove: true },
      ...(config.log.pretty
        ? { transport: { target: 'pino-pretty', options: { destination: fd } } }
        : {}),
    },
    config.log.pretty ? undefined : pino.destination(fd),
  );
}
