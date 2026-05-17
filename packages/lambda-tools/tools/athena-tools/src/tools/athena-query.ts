/**
 * Athena Query tool implementation
 *
 * Executes SQL SELECT queries against S3 data via Amazon Athena.
 * Includes SQL validation, access control, and result polling.
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';
import {
  ToolInput,
  ToolResult,
  Tool,
  ToolValidationError,
  AccessDeniedError,
  logger,
} from '@moca/lambda-tools-shared';
import { loadConfig, isDatabaseAllowed, isTableAllowed } from '../config.js';
import { validateSql } from '../validators/sql-validator.js';

const TOOL_NAME = 'athena-query';
const MAX_ROWS_LIMIT = 1000;
const DEFAULT_MAX_ROWS = 100;
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 150; // 150 * 1s = 2.5 minutes max

/**
 * Athena Query tool input type
 */
interface AthenaQueryInput extends ToolInput {
  query?: string;
  database?: string;
  maxRows?: number;
}

/**
 * Athena Query tool output type
 */
interface AthenaQueryResult extends ToolResult {
  rows: Record<string, string | null>[];
  rowCount: number;
  columnNames: string[];
  queryExecutionId: string;
  database: string;
  query: string;
  statistics?: {
    dataScannedInBytes?: number;
    engineExecutionTimeInMillis?: number;
  };
}

/**
 * Create an Athena client instance
 */
function createAthenaClient(region: string): AthenaClient {
  return new AthenaClient({ region });
}

/**
 * Wait for a query to complete by polling GetQueryExecution
 */
async function waitForQueryCompletion(
  client: AthenaClient,
  queryExecutionId: string
): Promise<QueryExecutionState> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const result = await client.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId })
    );

    const state = result.QueryExecution?.Status?.State;

    if (state === QueryExecutionState.SUCCEEDED) {
      return state;
    }

    if (state === QueryExecutionState.FAILED) {
      const reason = result.QueryExecution?.Status?.StateChangeReason || 'Unknown Athena error';
      throw new Error(`Athena query failed: ${reason}`);
    }

    if (state === QueryExecutionState.CANCELLED) {
      throw new Error('Athena query was cancelled');
    }

    // QUEUED or RUNNING — wait and retry
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Athena query timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000} seconds`
  );
}

/**
 * Main handler for the athena-query tool
 */
async function handleAthenaQuery(input: ToolInput): Promise<AthenaQueryResult> {
  const queryInput = input as AthenaQueryInput;

  // Validate required parameters
  if (!queryInput.query) {
    throw new ToolValidationError("The 'query' parameter is required", TOOL_NAME, 'query');
  }

  if (!queryInput.database) {
    throw new ToolValidationError("The 'database' parameter is required", TOOL_NAME, 'database');
  }

  const query = queryInput.query;
  const database = queryInput.database;
  const maxRows = Math.min(queryInput.maxRows || DEFAULT_MAX_ROWS, MAX_ROWS_LIMIT);

  // Load configuration
  const config = loadConfig();

  // Check database access
  if (!isDatabaseAllowed(database, config)) {
    throw new AccessDeniedError(
      `Access to database '${database}' is not allowed. Allowed databases: ${config.allowedDatabases.join(', ')}`,
      TOOL_NAME,
      database
    );
  }

  // Validate SQL (SELECT only, no DDL/DML)
  const sqlValidation = validateSql(query);
  if (!sqlValidation.valid) {
    throw new ToolValidationError(sqlValidation.error || 'Invalid SQL query', TOOL_NAME, 'query');
  }

  // Check table-level access for referenced tables
  for (const ref of sqlValidation.tableReferences) {
    const refDb = ref.database || database;
    if (!isDatabaseAllowed(refDb, config)) {
      throw new AccessDeniedError(`Access to database '${refDb}' is not allowed`, TOOL_NAME, refDb);
    }
    if (!isTableAllowed(refDb, ref.table, config)) {
      throw new AccessDeniedError(
        `Access to table '${refDb}.${ref.table}' is not allowed`,
        TOOL_NAME,
        `${refDb}.${ref.table}`
      );
    }
  }

  logger.info('ATHENA_QUERY_START', {
    database,
    queryLength: query.length,
    maxRows,
    tableReferences: sqlValidation.tableReferences,
    workgroup: config.workgroupName,
  });

  const client = createAthenaClient(config.region);

  try {
    // Start query execution
    const startResult = await client.send(
      new StartQueryExecutionCommand({
        QueryString: query,
        QueryExecutionContext: {
          Database: database,
        },
        WorkGroup: config.workgroupName,
        ResultConfiguration: {
          OutputLocation: `s3://${config.outputBucket}/athena-results/`,
        },
      })
    );

    const queryExecutionId = startResult.QueryExecutionId;
    if (!queryExecutionId) {
      throw new Error('Failed to start Athena query: no execution ID returned');
    }

    logger.info('ATHENA_QUERY_STARTED', { queryExecutionId });

    // Wait for completion
    await waitForQueryCompletion(client, queryExecutionId);

    // Get results
    const resultsResponse = await client.send(
      new GetQueryResultsCommand({
        QueryExecutionId: queryExecutionId,
        MaxResults: maxRows + 1, // +1 for header row
      })
    );

    // Parse column names from the first row (header)
    const resultSet = resultsResponse.ResultSet;
    const columnInfo = resultSet?.ResultSetMetadata?.ColumnInfo || [];
    const columnNames = columnInfo.map((col) => col.Name || 'unknown');

    // Parse data rows (skip header row)
    const allRows = resultSet?.Rows || [];
    const dataRows = allRows.slice(1); // First row is column headers

    const rows: Record<string, string | null>[] = dataRows.map((row) => {
      const record: Record<string, string | null> = {};
      const data = row.Data || [];
      columnNames.forEach((colName, index) => {
        record[colName] = data[index]?.VarCharValue ?? null;
      });
      return record;
    });

    // Get execution statistics
    const execResult = await client.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId })
    );
    const stats = execResult.QueryExecution?.Statistics;

    const result: AthenaQueryResult = {
      rows,
      rowCount: rows.length,
      columnNames,
      queryExecutionId,
      database,
      query,
      statistics: {
        dataScannedInBytes: stats?.DataScannedInBytes
          ? Number(stats.DataScannedInBytes)
          : undefined,
        engineExecutionTimeInMillis: stats?.EngineExecutionTimeInMillis
          ? Number(stats.EngineExecutionTimeInMillis)
          : undefined,
      },
    };

    logger.info('ATHENA_QUERY_SUCCESS', {
      queryExecutionId,
      rowCount: result.rowCount,
      columnCount: columnNames.length,
      dataScannedInBytes: result.statistics?.dataScannedInBytes,
      engineExecutionTimeInMillis: result.statistics?.engineExecutionTimeInMillis,
    });

    return result;
  } catch (error) {
    logger.error('ATHENA_QUERY_ERROR', {
      database,
      queryLength: query.length,
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : 'Unknown',
    });
    throw error;
  }
}

/**
 * Athena Query tool definition
 */
export const athenaQueryTool: Tool = {
  name: TOOL_NAME,
  handler: handleAthenaQuery,
  description:
    'Execute SQL SELECT queries against S3 data via Amazon Athena. ' +
    'Only read-only queries (SELECT) are allowed.',
  version: '1.0.0',
  tags: ['athena', 'query', 's3', 'sql', 'analytics'],
};

export default athenaQueryTool;
