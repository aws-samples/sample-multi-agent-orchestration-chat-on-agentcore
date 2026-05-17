/**
 * Ping tool implementation
 *
 * Returns connection status and system information for health checks.
 */

import { ToolInput, ToolResult, Tool, logger } from '@moca/lambda-tools-shared';

/**
 * Ping tool output type
 */
interface PingResult extends ToolResult {
  status: 'pong';
  timestamp: string;
  uptime: number;
  version: string;
  platform: string;
  arch: string;
  memory: NodeJS.MemoryUsage;
}

/**
 * Main handler for the ping tool
 *
 * @param input - Tool input data (unused by ping)
 * @returns System status information
 */
async function handlePing(input: ToolInput): Promise<PingResult> {
  const memory = process.memoryUsage();
  const timestamp = new Date().toISOString();

  logger.debug('PING_RESULT', {
    uptime: Math.round(process.uptime()),
    nodeVersion: process.version,
    platform: process.platform,
    memoryMB: Math.round(memory.heapUsed / 1024 / 1024),
    memoryTotalMB: Math.round(memory.heapTotal / 1024 / 1024),
    inputSize: input ? JSON.stringify(input).length : 0,
  });

  const result: PingResult = {
    status: 'pong',
    timestamp,
    uptime: process.uptime(),
    version: process.version,
    platform: process.platform,
    arch: process.arch,
    memory,
  };

  return result;
}

/**
 * Ping tool definition
 */
export const pingTool: Tool = {
  name: 'ping',
  handler: handlePing,
  description: 'Health check and system information tool',
  version: '1.0.0',
  tags: ['health-check', 'system-info', 'monitoring'],
};

export default pingTool;
