type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

function formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const metaString = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level}] ${message}${metaString}`;
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>): void => {
    console.log(formatMessage('INFO', message, meta));
  },
  warn: (message: string, meta?: Record<string, unknown>): void => {
    console.warn(formatMessage('WARN', message, meta));
  },
  error: (message: string, meta?: Record<string, unknown>): void => {
    console.error(formatMessage('ERROR', message, meta));
  },
  debug: (message: string, meta?: Record<string, unknown>): void => {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(formatMessage('DEBUG', message, meta));
    }
  },
};
