/**
 * SQL query validator
 *
 * Ensures only SELECT statements are allowed and extracts
 * referenced table names for access control checks.
 */

import { logger } from '@moca/lambda-tools-shared';

/**
 * SQL validation result
 */
export interface SqlValidationResult {
  /** Whether the SQL is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** Extracted table references (best-effort parsing) */
  tableReferences: { database?: string; table: string }[];
}

/**
 * SQL keywords that indicate data modification or DDL operations.
 * These are forbidden in queries executed by this tool.
 */
const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'REPLACE',
  'MERGE',
  'GRANT',
  'REVOKE',
  'CALL',
  'EXEC',
  'EXECUTE',
  'MSCK',
] as const;

/**
 * Validate an SQL query string.
 *
 * Rules:
 * 1. Must not be empty
 * 2. Must start with SELECT, WITH, SHOW, DESCRIBE, or EXPLAIN
 * 3. Must not contain DDL/DML keywords at statement boundaries
 * 4. Must not contain multiple statements (semicolon-separated)
 *
 * @param sql - The SQL query string to validate
 * @returns Validation result with extracted table references
 */
export function validateSql(sql: string): SqlValidationResult {
  if (!sql || sql.trim().length === 0) {
    return {
      valid: false,
      error: 'SQL query must not be empty',
      tableReferences: [],
    };
  }

  const trimmedSql = sql.trim();

  // Remove comments before analysis
  const cleanedSql = removeComments(trimmedSql);

  // Check for multiple statements (prevent semicolon injection)
  const statements = cleanedSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (statements.length > 1) {
    return {
      valid: false,
      error: 'Multiple SQL statements are not allowed. Please provide a single query.',
      tableReferences: [],
    };
  }

  const statement = statements[0];

  // Check that the statement starts with an allowed keyword
  const firstWord = statement.split(/\s+/)[0].toUpperCase();
  const allowedStartKeywords = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'EXPLAIN'];

  if (!allowedStartKeywords.includes(firstWord)) {
    return {
      valid: false,
      error: `Only SELECT queries are allowed. Statement starts with '${firstWord}' which is not permitted.`,
      tableReferences: [],
    };
  }

  // Scan for forbidden keywords at word boundaries
  const forbiddenFound = findForbiddenKeywords(statement);
  if (forbiddenFound.length > 0) {
    return {
      valid: false,
      error: `Forbidden SQL keywords detected: ${forbiddenFound.join(', ')}. Only read-only queries (SELECT) are allowed.`,
      tableReferences: [],
    };
  }

  // Extract table references for access control
  const tableReferences = extractTableReferences(statement);

  logger.debug('SQL_VALIDATION', {
    valid: true,
    sqlLength: sql.length,
    firstKeyword: firstWord,
    tableReferences,
  });

  return {
    valid: true,
    tableReferences,
  };
}

/**
 * Remove SQL comments (both line comments and block comments)
 */
function removeComments(sql: string): string {
  // Remove block comments /* ... */
  let result = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Remove line comments -- ...
  result = result.replace(/--.*/g, ' ');
  // Collapse multiple spaces
  result = result.replace(/\s+/g, ' ').trim();
  return result;
}

/**
 * Find forbidden keywords that appear as whole words in the SQL.
 * Ignores occurrences inside string literals (single-quoted).
 */
function findForbiddenKeywords(sql: string): string[] {
  // Remove string literals to avoid false positives
  const withoutStrings = sql.replace(/'[^']*'/g, "''");
  const upperSql = withoutStrings.toUpperCase();
  const found: string[] = [];

  for (const keyword of FORBIDDEN_KEYWORDS) {
    // Match keyword at word boundaries
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(upperSql)) {
      found.push(keyword);
    }
  }

  return found;
}

/**
 * Best-effort extraction of table references from a SQL SELECT statement.
 *
 * Handles common patterns:
 * - FROM table_name
 * - FROM database.table_name
 * - JOIN table_name
 * - FROM database.table_name AS alias
 *
 * This is not a full SQL parser but covers typical Athena query patterns.
 */
function extractTableReferences(sql: string): { database?: string; table: string }[] {
  // Remove string literals
  const withoutStrings = sql.replace(/'[^']*'/g, "''");
  // Remove parenthesized subqueries (simple nesting only)
  const cleaned = withoutStrings;

  const references: { database?: string; table: string }[] = [];
  const seen = new Set<string>();

  // Pattern: FROM/JOIN followed by an optional database.table or just table
  // Handles: FROM db.table, FROM table, JOIN db.table AS alias, etc.
  const tablePattern = /\b(?:FROM|JOIN)\s+(?:`?(\w+)`?\.)?`?(\w+)`?(?:\s+(?:AS\s+)?(\w+))?\b/gi;

  let match: RegExpExecArray | null;
  while ((match = tablePattern.exec(cleaned)) !== null) {
    const database = match[1];
    const table = match[2];

    // Skip subquery keywords and common non-table tokens
    if (['SELECT', 'LATERAL', 'UNNEST', 'VALUES'].includes(table.toUpperCase())) {
      continue;
    }

    const key = database ? `${database}.${table}` : table;
    if (!seen.has(key.toLowerCase())) {
      seen.add(key.toLowerCase());
      references.push(database ? { database, table } : { table });
    }
  }

  return references;
}
