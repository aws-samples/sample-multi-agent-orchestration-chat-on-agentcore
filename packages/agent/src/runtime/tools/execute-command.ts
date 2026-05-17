/**
 * Command execution tool - Execute shell commands safely
 */

import { tool } from '@strands-agents/sdk';
import { executeCommandDefinition } from '@moca/tool-definitions';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config, WORKSPACE_DIRECTORY } from '../../config/index.js';
import { logger } from '../../libs/logger/index.js';
import { getCurrentContext } from '../../libs/context/request-context.js';
import { getUserScopedEnvVars } from '../../libs/utils/scoped-credentials.js';

const execAsync = promisify(exec);

/**
 * Error type definition for exec execution
 */
interface ExecError extends Error {
  code?: number;
  signal?: string;
  stdout?: string;
  stderr?: string;
}

/**
 * Blacklist of dangerous commands
 */
const DANGEROUS_COMMANDS = [
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
 * Check if working directory is allowed
 */
function isAllowedWorkingDirectory(dir: string): boolean {
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
 * Check if command is dangerous
 */
function isDangerousCommand(command: string): boolean {
  const lowerCommand = command.toLowerCase().trim();

  return DANGEROUS_COMMANDS.some((dangerous) => lowerCommand.includes(dangerous.toLowerCase()));
}

/**
 * Truncate output to safe size
 */
function truncateOutput(output: string, maxLength: number = 4000): string {
  if (output.length <= maxLength) {
    return output;
  }

  const truncated = output.substring(0, maxLength);
  return `${truncated}\n\n... (Output truncated due to length. Original length: ${output.length} characters)`;
}

/**
 * Command execution tool
 */
export const executeCommandTool = tool({
  name: executeCommandDefinition.name,
  description: executeCommandDefinition.description,
  inputSchema: executeCommandDefinition.zodSchema,
  callback: async (input) => {
    const { command, workingDirectory, timeout, maxOutputLength } = input;

    logger.info(`Command execution started: ${command}`);

    // Resolve active working directory (outside try/catch for error handler access)
    const context = getCurrentContext();
    const activeDir = context?.workspaceSync?.getActiveWorkingDirectory() || WORKSPACE_DIRECTORY;

    try {
      // Wait for workspace sync to complete
      if (context?.workspaceSync) {
        await context.workspaceSync.waitForInitialSync();
      }

      // Set default working directory (use active workspace subdirectory if available)
      const effectiveWorkingDirectory = workingDirectory || activeDir;

      // 1. Security check: Detect dangerous commands
      if (isDangerousCommand(command)) {
        const errorMsg = `⚠️ Security Error: Dangerous command detected\nCommand: ${command}`;
        logger.warn(errorMsg);
        return errorMsg;
      }

      // 2. Working directory check
      if (!isAllowedWorkingDirectory(effectiveWorkingDirectory)) {
        const errorMsg = `⚠️ Security Error: Working directory not allowed\nDirectory: ${effectiveWorkingDirectory}`;
        logger.warn(errorMsg);
        return errorMsg;
      }

      // 3. Build scoped environment variables for the child process
      // When USER_SCOPED_ROLE_ARN is configured, assume a role with a session
      // policy that restricts S3 and DynamoDB access to the authenticated user only.
      let scopedEnv: Record<string, string> | undefined;
      if (config.IDENTITY_POOL_ID && context?.userId) {
        scopedEnv = await getUserScopedEnvVars(context.userId);
        logger.debug(`[EXEC] Using Identity Pool scoped credentials for user=${context.userId}`);
      }

      // 4. Execute command
      const execOptions = {
        timeout,
        maxBuffer: 1024 * 1024 * 10, // 10MB
        cwd: effectiveWorkingDirectory,
        encoding: 'utf8' as const,
        // Override AWS credentials in the child process environment so that
        // `aws s3` and other SDK-based commands can only access the user's prefix.
        // Credential-chain bypass vectors are explicitly removed (undefined deletes the key).
        //
        // IMDS is disabled for child processes to prevent credential theft via
        // direct HTTP access to the EC2 Instance Metadata Service endpoint.
        // The user-scoped credentials in scopedEnv are sufficient for all AWS
        // operations that the agent is permitted to perform.
        env: {
          ...process.env,
          // Disable EC2 Instance Metadata Service (IMDS) access in child processes.
          // This prevents `aws` CLI and SDK-based tools from falling back to the
          // execution role via IMDS, which would bypass per-user credential scoping.
          AWS_EC2_METADATA_DISABLED: 'true',
          AWS_METADATA_SERVICE_TIMEOUT: '0',
          AWS_METADATA_SERVICE_NUM_ATTEMPTS: '0',
          // Remove container credential relay endpoints (ECS/CodeBuild/etc.)
          AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
          AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
          // Remove credential file / profile overrides
          AWS_PROFILE: undefined,
          AWS_DEFAULT_PROFILE: undefined,
          AWS_SHARED_CREDENTIALS_FILE: undefined,
          AWS_CONFIG_FILE: undefined,
          ...scopedEnv,
        } as NodeJS.ProcessEnv,
      };

      const startTime = Date.now();
      const result = await execAsync(command, execOptions);
      const duration = Date.now() - startTime;

      // 5. Format result
      const stdout = truncateOutput(result.stdout || '', maxOutputLength);
      const stderr = truncateOutput(result.stderr || '', maxOutputLength);

      const output = `Execution Result:
Command: ${command}
Working Directory: ${effectiveWorkingDirectory}
Execution Time: ${duration}ms
Exit Code: 0

Standard Output:
${stdout || '(no output)'}

${stderr ? `Standard Error:\n${stderr}` : ''}`.trim();

      logger.info(`Command execution succeeded: ${command} (${duration}ms)`);
      return output;
    } catch (error: unknown) {
      // Error handling
      const execError = error as ExecError;
      const effectiveWorkingDirectory = workingDirectory || activeDir;

      let errorOutput = `Execution Error:
Command: ${command}
Working Directory: ${effectiveWorkingDirectory}
`;

      if (execError.code !== undefined) {
        errorOutput += `Exit Code: ${execError.code}\n`;
      }

      if (execError.signal) {
        errorOutput += `Signal: ${execError.signal}\n`;
      }

      if (execError.stdout) {
        errorOutput += `\nStandard Output:\n${truncateOutput(execError.stdout, maxOutputLength)}`;
      }

      if (execError.stderr) {
        errorOutput += `\nStandard Error:\n${truncateOutput(execError.stderr, maxOutputLength)}`;
      }

      // Special handling for timeout errors
      const isTimeout =
        execError.signal === 'SIGTERM' ||
        execError.message?.includes('timeout') ||
        execError.message?.includes('ETIMEDOUT');
      if (isTimeout) {
        errorOutput += `\n⏰ Timeout: Execution interrupted after ${timeout}ms`;
      }

      logger.error(
        { command, errMessage: execError.message || 'Unknown error' },
        'Command execution error'
      );
      return errorOutput;
    }
  },
});
