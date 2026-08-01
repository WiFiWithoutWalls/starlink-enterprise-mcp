/**
 * Structured JSON logger.
 *
 * Outputs one JSON object per line to stderr (stdout is reserved for MCP stdio transport).
 * Log level is controlled by the LOG_LEVEL environment variable (default: "info").
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * MCP's `logging/setLevel` uses the eight syslog severities (RFC 5424); this
 * logger has four. Anything at or above `error` collapses onto error, since
 * we have nothing more severe to escalate to.
 */
const MCP_LEVEL_MAP: Record<string, LogLevel> = {
  debug: 'debug',
  info: 'info',
  notice: 'info',
  warning: 'warn',
  error: 'error',
  critical: 'error',
  alert: 'error',
  emergency: 'error',
};

class Logger {
  private level: number;

  constructor() {
    const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
    this.level = LEVEL_VALUES[envLevel as LogLevel] ?? LEVEL_VALUES.info;
  }

  /** Sets the minimum level to emit, accepting either our names or MCP's. */
  setLevel(level: string): void {
    const mapped = MCP_LEVEL_MAP[level.toLowerCase()] ?? (level.toLowerCase() as LogLevel);
    const value = LEVEL_VALUES[mapped];
    if (value === undefined) return;
    this.level = value;
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_VALUES[level] < this.level) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    };
    process.stderr.write(JSON.stringify(entry) + '\n');
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }
}

export const logger = new Logger();
