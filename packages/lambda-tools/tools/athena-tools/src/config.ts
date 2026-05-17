/**
 * Athena Tools configuration
 *
 * Reads environment variables and provides a typed configuration object
 * with optional access control lists for databases and tables.
 *
 * When ALLOWED_DATABASES or ALLOWED_TABLES is set to "*" (or left unset),
 * all databases/tables are permitted. When specific values are provided,
 * only those entries are allowed (allowlist mode).
 */

import { logger } from '@moca/lambda-tools-shared';

/** Wildcard value that permits all entries */
const WILDCARD = '*';

/**
 * Athena Tools configuration interface
 */
export interface AthenaToolsConfig {
  /** Allowed Glue database names. ["*"] means all databases are permitted. */
  allowedDatabases: string[];
  /** Allowed table names in "database.table" format. ["*"] means all tables are permitted. */
  allowedTables: string[];
  /** Athena workgroup name */
  workgroupName: string;
  /** S3 bucket name for Athena query results */
  outputBucket: string;
  /** AWS region */
  region: string;
}

/**
 * Parse a comma-separated environment variable into a trimmed string array.
 * Returns the provided default if the value is undefined or empty.
 */
function parseCommaSeparated(value: string | undefined, defaultValue: string[]): string[] {
  if (!value || value.trim() === '') {
    return defaultValue;
  }
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Check whether an allow list contains the wildcard entry.
 */
function isWildcard(allowList: string[]): boolean {
  return allowList.includes(WILDCARD);
}

/**
 * Load and validate configuration from environment variables.
 *
 * Environment variables:
 * - ALLOWED_DATABASES: Comma-separated list of allowed Glue database names (default: "*" = all)
 * - ALLOWED_TABLES: Comma-separated list of "database.table" patterns (default: "*" = all)
 * - ATHENA_WORKGROUP: Athena workgroup name (default: "primary")
 * - ATHENA_OUTPUT_BUCKET: S3 bucket name for query results (required)
 * - AWS_REGION: AWS region (defaults to "us-east-1")
 *
 * @returns Validated configuration object
 * @throws Error if required environment variables are missing
 */
export function loadConfig(): AthenaToolsConfig {
  const allowedDatabases = parseCommaSeparated(process.env.ALLOWED_DATABASES, [WILDCARD]);
  const allowedTables = parseCommaSeparated(process.env.ALLOWED_TABLES, [WILDCARD]);
  const workgroupName = process.env.ATHENA_WORKGROUP || 'primary';
  const outputBucket = process.env.ATHENA_OUTPUT_BUCKET || '';
  const region = process.env.AWS_REGION || 'us-east-1';

  // Validate required settings
  const missing: string[] = [];
  if (!outputBucket) missing.push('ATHENA_OUTPUT_BUCKET');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Ensure ATHENA_OUTPUT_BUCKET is set.'
    );
  }

  const config: AthenaToolsConfig = {
    allowedDatabases,
    allowedTables,
    workgroupName,
    outputBucket,
    region,
  };

  logger.info('CONFIG_LOADED', {
    allowedDatabases: config.allowedDatabases,
    allowedTables: config.allowedTables,
    workgroupName: config.workgroupName,
    outputBucket: config.outputBucket,
    region: config.region,
  });

  return config;
}

/**
 * Check whether a database is in the allow list.
 *
 * If allowedDatabases contains "*", all databases are permitted.
 *
 * @param database - Database name to check
 * @param config - Configuration object
 * @returns true if the database is allowed
 */
export function isDatabaseAllowed(database: string, config: AthenaToolsConfig): boolean {
  if (isWildcard(config.allowedDatabases)) {
    return true;
  }
  return config.allowedDatabases.includes(database.toLowerCase());
}

/**
 * Check whether a specific table is in the allow list.
 *
 * If allowedTables contains "*", all tables within allowed databases are permitted.
 * If specific entries are set, only explicitly listed "database.table" entries are permitted.
 *
 * @param database - Database name
 * @param table - Table name
 * @param config - Configuration object
 * @returns true if the table is allowed
 */
export function isTableAllowed(
  database: string,
  table: string,
  config: AthenaToolsConfig
): boolean {
  // Database must always be allowed
  if (!isDatabaseAllowed(database, config)) {
    return false;
  }

  // If wildcard or no table-level restrictions, all tables in allowed databases are permitted
  if (isWildcard(config.allowedTables) || config.allowedTables.length === 0) {
    return true;
  }

  const qualifiedName = `${database.toLowerCase()}.${table.toLowerCase()}`;
  return config.allowedTables.map((t) => t.toLowerCase()).includes(qualifiedName);
}

/**
 * Validate that all referenced tables in a list are allowed.
 *
 * @param tables - Array of { database, table } references
 * @param config - Configuration object
 * @returns Object with validation result and denied tables
 */
export function validateTableReferences(
  tables: { database: string; table: string }[],
  config: AthenaToolsConfig
): { allowed: boolean; denied: { database: string; table: string }[] } {
  const denied = tables.filter((ref) => !isTableAllowed(ref.database, ref.table, config));
  return {
    allowed: denied.length === 0,
    denied,
  };
}
