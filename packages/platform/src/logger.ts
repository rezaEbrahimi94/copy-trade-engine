import { pino, type Logger } from 'pino';

export interface LoggerOptions {
  readonly level: string;
  readonly pretty: boolean;
  readonly service: string;
  readonly instanceId: string;
}

/** Structured JSON logs; `fd` 2 keeps stdout clean for jobs that print machine-readable output. */
export function createServiceLogger(options: LoggerOptions, fd: 1 | 2 = 1): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service, instanceId: options.instanceId },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], remove: true },
      ...(options.pretty
        ? { transport: { target: 'pino-pretty', options: { destination: fd } } }
        : {}),
    },
    options.pretty ? undefined : pino.destination(fd),
  );
}
