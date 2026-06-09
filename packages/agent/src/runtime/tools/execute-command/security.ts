/**
 * Pure security helpers for the execute_command tool.
 *
 * These functions carry no I/O: dangerous-command detection, working-directory
 * allow-listing (reading config), and output truncation. The impure command
 * execution lives in `execute-command.tool.ts`.
 */

import { config } from '../../../config/index.js';

/**
 * Error type definition for `child_process.exec` execution. Surfaced by the
 * tool's inner try/catch to format the "Execution Error:" block.
 */
export interface ExecError extends Error {
  code?: number;
  signal?: string;
  stdout?: string;
  stderr?: string;
}

/**
 * Blocklist of dangerous commands.
 */
export const DANGEROUS_COMMANDS = [
  // System destructive commands
  'rm -rf /',
  'mkfs',
  'dd if=',
  'fdisk',

  // System operation commands
  'shutdown',
  'reboot',
  'halt',
  'init 0',
  'init 6',

  // EC2 Instance Metadata Service (IMDS) endpoints
  // Blocking direct HTTP access to IMDS prevents credential theft from the
  // execution role even if the child process environment is compromised.
  '169.254.169.254', // EC2 IMDS IPv4
  'fd00:ec2::254', // EC2 IMDS IPv6 (IMDSv2)
  '169.254.170.2', // ECS Task metadata credential endpoint
];

/**
 * Check if a command matches the dangerous-command blocklist.
 *
 * Matching is case-insensitive and substring-based so that variants like
 * `RM -RF /` or commands embedding an IMDS endpoint are caught.
 */
export function isDangerousCommand(command: string): boolean {
  const lowerCommand = command.toLowerCase().trim();

  return DANGEROUS_COMMANDS.some((dangerous) => lowerCommand.includes(dangerous.toLowerCase()));
}

/**
 * Check if a working directory is allowed.
 *
 * The root directory is always forbidden. When `config.ALLOWED_WORKING_DIRS`
 * is configured, the directory must start with one of those prefixes;
 * otherwise the built-in defaults (`/home/`, `/tmp/`, `/var/tmp/`, `/Users/`)
 * apply.
 */
export function isAllowedWorkingDirectory(dir: string): boolean {
  // Root directory is forbidden
  if (dir === '/') {
    return false;
  }

  // Check if allowed directories are specified in environment variable
  const allowedDirs = config.ALLOWED_WORKING_DIRS;
  if (allowedDirs.length > 0) {
    return allowedDirs.some((allowed) => dir.startsWith(allowed));
  }

  // By default, /home, /tmp, /var/tmp, /Users are allowed
  const defaultAllowed = ['/home/', '/tmp/', '/var/tmp/', '/Users/'];
  return defaultAllowed.some((allowed) => dir.startsWith(allowed));
}

/**
 * Truncate output to a safe size, appending a notice when truncation occurs.
 */
export function truncateOutput(output: string, maxLength: number = 4000): string {
  if (output.length <= maxLength) {
    return output;
  }

  const truncated = output.substring(0, maxLength);
  return `${truncated}\n\n... (Output truncated due to length. Original length: ${output.length} characters)`;
}
