/**
 * Athena Describe Table tool implementation
 *
 * Retrieves detailed schema information for a specific table
 * from the Glue Data Catalog.
 */

import { GlueClient, GetTableCommand } from '@aws-sdk/client-glue';
import {
  ToolInput,
  ToolResult,
  Tool,
  ToolValidationError,
  AccessDeniedError,
  logger,
} from '@moca/lambda-tools-shared';
import { loadConfig, isDatabaseAllowed, isTableAllowed } from '../config.js';

const TOOL_NAME = 'athena-describe-table';

/**
 * Describe Table tool input type
 */
interface DescribeTableInput extends ToolInput {
  database?: string;
  tableName?: string;
}

/**
 * Detailed column information
 */
interface DetailedColumnInfo {
  name: string;
  type: string;
  comment?: string;
  isPartitionKey: boolean;
}

/**
 * SerDe (serialization/deserialization) information
 */
interface SerDeInfo {
  serializationLibrary?: string;
  parameters?: Record<string, string>;
}

/**
 * Describe Table tool output type
 */
interface DescribeTableResult extends ToolResult {
  database: string;
  tableName: string;
  description?: string;
  columns: DetailedColumnInfo[];
  partitionKeys: DetailedColumnInfo[];
  totalColumns: number;
  dataFormat: string;
  location?: string;
  serDeInfo?: SerDeInfo;
  tableParameters?: Record<string, string>;
  inputFormat?: string;
  outputFormat?: string;
  compressed: boolean;
  createTime?: string;
  updateTime?: string;
  tableType?: string;
}

/**
 * Create a Glue client instance
 */
function createGlueClient(region: string): GlueClient {
  return new GlueClient({ region });
}

/**
 * Main handler for the athena-describe-table tool
 */
async function handleDescribeTable(input: ToolInput): Promise<DescribeTableResult> {
  const descInput = input as DescribeTableInput;

  // Validate required parameters
  if (!descInput.database) {
    throw new ToolValidationError("The 'database' parameter is required", TOOL_NAME, 'database');
  }

  if (!descInput.tableName) {
    throw new ToolValidationError("The 'tableName' parameter is required", TOOL_NAME, 'tableName');
  }

  const database = descInput.database;
  const tableName = descInput.tableName;

  // Load configuration and check access
  const config = loadConfig();

  if (!isDatabaseAllowed(database, config)) {
    throw new AccessDeniedError(
      `Access to database '${database}' is not allowed. Allowed databases: ${config.allowedDatabases.join(', ')}`,
      TOOL_NAME,
      database
    );
  }

  if (!isTableAllowed(database, tableName, config)) {
    throw new AccessDeniedError(
      `Access to table '${database}.${tableName}' is not allowed`,
      TOOL_NAME,
      `${database}.${tableName}`
    );
  }

  logger.info('DESCRIBE_TABLE_START', { database, tableName });

  const client = createGlueClient(config.region);

  try {
    const response = await client.send(
      new GetTableCommand({
        DatabaseName: database,
        Name: tableName,
      })
    );

    const table = response.Table;
    if (!table) {
      throw new Error(`Table '${database}.${tableName}' not found`);
    }

    // Build detailed column list
    const columns: DetailedColumnInfo[] = (table.StorageDescriptor?.Columns || []).map((col) => ({
      name: col.Name || '',
      type: col.Type || 'unknown',
      comment: col.Comment || undefined,
      isPartitionKey: false,
    }));

    const partitionKeys: DetailedColumnInfo[] = (table.PartitionKeys || []).map((pk) => ({
      name: pk.Name || '',
      type: pk.Type || 'unknown',
      comment: pk.Comment || undefined,
      isPartitionKey: true,
    }));

    // Determine data format
    const serDeLib = table.StorageDescriptor?.SerdeInfo?.SerializationLibrary || '';
    const dataFormat = inferDataFormat(serDeLib, table.StorageDescriptor?.InputFormat || '');

    // Build SerDe info
    const serDeInfo: SerDeInfo | undefined = table.StorageDescriptor?.SerdeInfo
      ? {
          serializationLibrary: table.StorageDescriptor.SerdeInfo.SerializationLibrary || undefined,
          parameters: table.StorageDescriptor.SerdeInfo.Parameters as
            | Record<string, string>
            | undefined,
        }
      : undefined;

    // Build table parameters (filter out internal/sensitive ones)
    const rawParams = table.Parameters || {};
    const tableParameters: Record<string, string> = {};
    const safeParamKeys = [
      'classification',
      'compressionType',
      'typeOfData',
      'EXTERNAL',
      'numFiles',
      'numRows',
      'rawDataSize',
      'sizeKey',
      'totalSize',
      'averageRecordSize',
      'objectCount',
      'recordCount',
    ];
    for (const key of Object.keys(rawParams)) {
      if (safeParamKeys.includes(key) || key.startsWith('projection.')) {
        tableParameters[key] = rawParams[key];
      }
    }

    const result: DescribeTableResult = {
      database,
      tableName: table.Name || tableName,
      description: table.Description || undefined,
      columns,
      partitionKeys,
      totalColumns: columns.length + partitionKeys.length,
      dataFormat,
      location: table.StorageDescriptor?.Location || undefined,
      serDeInfo,
      tableParameters: Object.keys(tableParameters).length > 0 ? tableParameters : undefined,
      inputFormat: table.StorageDescriptor?.InputFormat || undefined,
      outputFormat: table.StorageDescriptor?.OutputFormat || undefined,
      compressed: table.StorageDescriptor?.Compressed ?? false,
      createTime: table.CreateTime ? table.CreateTime.toISOString() : undefined,
      updateTime: table.UpdateTime ? table.UpdateTime.toISOString() : undefined,
      tableType: table.TableType || undefined,
    };

    logger.info('DESCRIBE_TABLE_SUCCESS', {
      database,
      tableName,
      columnCount: columns.length,
      partitionKeyCount: partitionKeys.length,
      dataFormat,
    });

    return result;
  } catch (error) {
    logger.error('DESCRIBE_TABLE_ERROR', {
      database,
      tableName,
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
 * Athena Describe Table tool definition
 */
export const athenaDescribeTableTool: Tool = {
  name: TOOL_NAME,
  handler: handleDescribeTable,
  description:
    'Get detailed schema information for a specific table from the Glue Data Catalog. ' +
    'Returns column definitions, partition keys, data format, SerDe info, and table parameters.',
  version: '1.0.0',
  tags: ['athena', 'glue', 'schema', 'metadata', 'describe'],
};

export default athenaDescribeTableTool;
