/**
 * Structured logging utility
 *
 * Outputs single-line JSON logs with automatic request ID injection
 * and log level filtering.
 */

interface LogContext {
  [key: string]: unknown;
}

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

class Logger {
  private reqId?: string;
  private logLevel: LogLevel = 'INFO';

  /**
   * Set the request ID (auto-injected into all subsequent logs)
   */
  setRequestId(reqId: string): void {
    this.reqId = reqId;
  }

  /**
   * Set the minimum log level threshold
   */
  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  /**
   * Convert log level to numeric value for comparison
   */
  private getLogLevelValue(level: LogLevel): number {
    const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    return levels[level];
  }

  /**
   * Core log output handler
   */
  private log(level: LogLevel, tag: string, data: LogContext): void {
    if (this.getLogLevelValue(level) < this.getLogLevelValue(this.logLevel)) {
      return;
    }

    // Auto-inject request ID
    const logData = this.reqId ? { reqId: this.reqId, ...data } : data;

    // Serialize Error objects for JSON output
    const processedData = this.processErrorObjects(logData);

    const logMessage = `[${tag}] ${JSON.stringify(processedData)}`;

    switch (level) {
      case 'ERROR':
        console.error(logMessage);
        break;
      case 'WARN':
        console.warn(logMessage);
        break;
      case 'DEBUG':
      case 'INFO':
      default:
        console.log(logMessage);
        break;
    }
  }

  /**
   * Recursively convert Error objects into JSON-serializable format
   */
  private processErrorObjects(obj: unknown): unknown {
    if (obj instanceof Error) {
      return {
        message: obj.message,
        name: obj.name,
        stack: obj.stack,
      };
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.processErrorObjects(item));
    }

    if (typeof obj === 'object' && obj !== null) {
      const processed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        processed[key] = this.processErrorObjects(value);
      }
      return processed;
    }

    return obj;
  }

  /** DEBUG level log */
  debug(tag: string, data: LogContext = {}): void {
    this.log('DEBUG', tag, data);
  }

  /** INFO level log */
  info(tag: string, data: LogContext = {}): void {
    this.log('INFO', tag, data);
  }

  /** WARN level log */
  warn(tag: string, data: LogContext = {}): void {
    this.log('WARN', tag, data);
  }

  /** ERROR level log */
  error(tag: string, data: LogContext = {}): void {
    this.log('ERROR', tag, data);
  }

  /**
   * Create a context object with request ID auto-injected
   */
  createContext(data: LogContext = {}): LogContext {
    return this.reqId ? { reqId: this.reqId, ...data } : data;
  }

  /**
   * Create a context object with request ID and timestamp
   */
  createTimestampedContext(data: LogContext = {}): LogContext {
    return {
      timestamp: new Date().toISOString(),
      ...this.createContext(data),
    };
  }

  /**
   * Measure synchronous function execution time and log the result
   */
  measureExecution<T>(tag: string, fn: () => T): T {
    const start = process.hrtime.bigint();
    try {
      const result = fn();
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;

      this.debug(`${tag}_PERF`, { durationMs });
      return result;
    } catch (error) {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;

      this.error(`${tag}_PERF_ERROR`, {
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

/**
 * Singleton logger instance
 */
export const logger = new Logger();

// Configure log level from environment variable
const envLogLevel = process.env.LOG_LEVEL?.toUpperCase() as LogLevel;
if (envLogLevel && ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(envLogLevel)) {
  logger.setLogLevel(envLogLevel);
}
