/**
 * Development-only logger utility.
 *
 * All log methods are no-ops in production builds, preventing
 * unnecessary console output and potential information leakage.
 */

const isDev = import.meta.env.DEV;

export const logger = {
  log: isDev ? console.log.bind(console) : () => {},
  warn: isDev ? console.warn.bind(console) : () => {},
  error: isDev ? console.error.bind(console) : () => {},
  info: isDev ? console.info.bind(console) : () => {},
  debug: isDev ? console.debug.bind(console) : () => {},
} as const;
