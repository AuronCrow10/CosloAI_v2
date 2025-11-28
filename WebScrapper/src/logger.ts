type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const envLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

export const logger = {
  debug: (...args: unknown[]) => {
    if (levelOrder[envLevel] <= levelOrder.debug) console.debug('[DEBUG]', ...args);
  },
  info: (...args: unknown[]) => {
    if (levelOrder[envLevel] <= levelOrder.info) console.info('[INFO]', ...args);
  },
  warn: (...args: unknown[]) => {
    if (levelOrder[envLevel] <= levelOrder.warn) console.warn('[WARN]', ...args);
  },
  error: (...args: unknown[]) => {
    if (levelOrder[envLevel] <= levelOrder.error) console.error('[ERROR]', ...args);
  },
};
