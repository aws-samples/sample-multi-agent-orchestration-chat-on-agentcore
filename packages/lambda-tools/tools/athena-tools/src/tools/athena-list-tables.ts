/**
 * Athena List Tables tool implementation
 *
 * Lists tables and their schemas from the Glue Data Catalog,
 * filtered by the configured access allow list.
 */

import { GlueClient, GetTablesCommand } from '@aws-sdk/client-glue';
import {
  ToolInput,
  ToolResult,
  Tool,
  ToolValidationError,
  AccessDeniedError,
  logger,
} from '@moca/lambda-tools-shared';
import { loadConfig, isDatabaseAllowed, isTableAllowed } from '../config.js';

const TOOL_NAME = 'athena-list-tables';

/**
 * List Tables tool input type
 */
interface ListTablesInput extends ToolInput {
  database?: string;
  tableNameFilter?: string;
}

/**
 * Column information
 */
interface ColumnInfo {
  name: string;
  type: string;
  comment?: string;
}

/**
 * Table summary in list results
 */
interface TableSummary {
  tableName: string;
  description?: string;
  columns: ColumnInfo[];
  partitionKeys: ColumnInfo[];
  dataFormat?: string;
  location?: string;
  createTime?: string;
}

/**
 * List Tables tool output type
 */
interface ListTablesResult extends ToolResult {
  tables: TableSummary[];
  tableCount: number;
  database: string;
}

/**
 * Create a Glue client instance
 */
function createGlueClient(region: string): GlueClient {
  return new GlueClient({ region });
}

/**
 * Main handler for the athena-list-tables tool
 */
async function handleListTables(input: ToolInput): Promise<ListTablesResult> {
  const listInput = input as ListTablesInput;

  // Validate required parameters
  if (!listInput.database) {
    throw new ToolValidationError("The 'database' parameter is required", TOOL_NAME, 'database');
  }

  const database = listInput.database;
  const tableNameFilter = listInput.tableNameFilter;

  // Load configuration and check access
  const config = loadConfig();

  if (!isDatabaseAllowed(database, config)) {
    throw new AccessDeniedError(
      `Access to database '${database}' is not allowed. Allowed databases: ${config.allowedDatabases.join(', ')}`,
      TOOL_NAME,
      database
    );
  }

  logger.info('LIST_TABLES_START', {
    database,
    tableNameFilter,
  });

  const client = createGlueClient(config.region);

  try {
    // Fetch tables from Glue Data Catalog
    const response = await client.send(
      new GetTablesCommand({
        DatabaseName: database,
        Expression: tableNameFilter ? `${tableNameFilter}*` : undefined,
      })
    );

    const glueTables = response.TableList || [];

    // Filter by allow list and map to summary format
    const tables: TableSummary[] = glueTables
      .filter((t) => {
        const tableName = t.Name || '';
        return isTableAllowed(database, tableName, config);
      })
      .map((t) => {
        const columns: ColumnInfo[] = (t.StorageDescriptor?.Columns || []).map((col) => ({
          name: col.Name || '',
          type: col.Type || 'unknown',
          comment: col.Comment || undefined,
        }));

        const partitionKeys: ColumnInfo[] = (t.PartitionKeys || []).map((pk) => ({
          name: pk.Name || '',
          type: pk.Type || 'unknown',
          comment: pk.Comment || undefined,
        }));

        // Determine data format from SerDe or InputFormat
        const serDeLib = t.StorageDescriptor?.SerdeInfo?.SerializationLibrary || '';
        const dataFormat = inferDataFormat(serDeLib, t.StorageDescriptor?.InputFormat || '');

        return {
          tableName: t.Name || '',
          description: t.Description || undefined,
          columns,
          partitionKeys,
          dataFormat,
          location: t.StorageDescriptor?.Location || undefined,
          createTime: t.CreateTime ? t.CreateTime.toISOString() : undefined,
        };
      });

    const result: ListTablesResult = {
      tables,
      tableCount: tables.length,
      database,
    };

    logger.info('LIST_TABLES_SUCCESS', {
      database,
      tableCount: result.tableCount,
      tableNames: tables.map((t) => t.tableName),
    });

    return result;
  } catch (error) {
    logger.error('LIST_TABLES_ERROR', {
      database,
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : 'Unknown',
    });
    throw error;
  }
}

/**
 * Infer the data format from the SerDe library or input format string
 */
function inferDataFormat(serDeLib: string, inputFormat: string): string {
  const lower = (serDeLib + ' ' + inputFormat).toLowerCase();

  if (lower.includes('parquet')) return 'Parquet';
  if (lower.includes('orc')) return 'ORC';
  if (lower.includes('json') || lower.includes('hive.serde2.JsonSerDe')) return 'JSON';
  if (lower.includes('csv') || lower.includes('opencsv')) return 'CSV';
  if (lower.includes('lazy') && lower.includes('simple')) return 'TSV/CSV';
  if (lower.includes('avro')) return 'Avro';
  if (lower.includes('regex')) return 'Regex';
  if (lower.includes('grok')) return 'Grok';
  if (lower.includes('cloudtrail')) return 'CloudTrail';

  return 'Unknown';
}

/**
 * Athena List Tables tool definition
 */
export const athenaListTablesTool: Tool = {
  name: TOOL_NAME,
  handler: handleListTables,
  description:
    'List tables and their schemas from the Glue Data Catalog for a specified database. ' +
    'Returns column names, types, partition keys, and data format.',
  version: '1.0.0',
  tags: ['athena', 'glue', 'schema', 'metadata'],
};

export default athenaListTablesTool;
