/**
 * AgentCore CodeInterpreter client implementation
 */

import {
  BedrockAgentCoreClient,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
  GetCodeInterpreterSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { config, WORKSPACE_DIRECTORY } from '../../../config/index.js';
import { logger } from '../../../libs/logger/index.js';
import { v7 as uuidv7 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ToolResult,
  SessionInfo,
  CodeInterpreterOptions,
  InitSessionAction,
  ExecuteCodeAction,
  ExecuteCommandAction,
  ReadFilesAction,
  ListFilesAction,
  RemoveFilesAction,
  WriteFilesAction,
  DownloadFilesAction,
  DownloadResult,
  DownloadedFile,
} from './types.js';

// Module-level session cache - persists across objects
const sessionMapping: Map<string, string> = new Map();

/**
 * AgentCore CodeInterpreter client
 */
export class AgentCoreCodeInterpreterClient {
  private region: string;
  private identifier: string;
  private sessions: Map<string, SessionInfo>;
  private autoCreate: boolean;
  private persistSessions: boolean;
  private defaultSession: string;
  private client: BedrockAgentCoreClient;
  private storagePath: string;

  constructor(options: CodeInterpreterOptions = {}) {
    this.region = options.region || config.AWS_REGION;
    this.identifier = options.identifier || 'aws.codeinterpreter.v1';
    this.autoCreate = options.autoCreate ?? true;
    this.persistSessions = options.persistSessions ?? true;
    this.storagePath = options.storagePath || '';

    if (options.sessionName) {
      this.defaultSession = options.sessionName;
    } else {
      this.defaultSession = `session-${uuidv7().replace(/-/g, '').slice(0, 12)}`;
    }

    this.sessions = new Map();
    this.client = new BedrockAgentCoreClient({ region: this.region });

    logger.info(
      `CodeInterpreter initialized: session='${this.defaultSession}', ` +
        `identifier='${this.identifier}', autoCreate=${this.autoCreate}, ` +
        `persistSessions=${this.persistSessions}, storagePath='${this.storagePath}'`
    );
  }

  /**
   * Initialize session
   */
  async initSession(action: InitSessionAction): Promise<ToolResult> {
    logger.info(`Initializing Bedrock AgentCore sandbox session: ${action.description}`);

    const sessionName = action.sessionName;

    // Check if already exists in instance cache
    if (this.sessions.has(sessionName)) {
      return {
        status: 'error',
        content: [{ text: `Session '${sessionName}' already exists` }],
      };
    }

    // Check if already in use by module-level cache
    if (sessionMapping.has(sessionName)) {
      const errorMsg =
        `Session '${sessionName}' is already in use by another instance. ` +
        `Use a unique session name or reconnect to the existing session ` +
        `via ensureSession() instead of calling initSession() directly.`;
      logger.error(errorMsg);
      return {
        status: 'error',
        content: [{ text: errorMsg }],
      };
    }

    try {
      // Start session
      const command = new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: this.identifier,
        name: sessionName,
        sessionTimeoutSeconds: 900, // 15 minutes
      });

      const response = await this.client.send(command);
      const awsSessionId = response.sessionId!;

      // Save to module-level cache
      sessionMapping.set(sessionName, awsSessionId);

      // Save local session information
      this.sessions.set(sessionName, {
        sessionId: sessionName,
        description: action.description,
        awsSessionId: awsSessionId,
      });

      logger.info(`Initialized session: ${sessionName} (AWS ID: ${awsSessionId})`);

      return {
        status: 'success',
        content: [
          {
            json: {
              sessionName: sessionName,
              description: action.description,
              sessionId: awsSessionId,
            },
          },
        ],
      };
    } catch (error) {
      const errorMsg = `Failed to initialize session '${sessionName}': ${error}`;
      logger.error(errorMsg);
      return {
        status: 'error',
        content: [{ text: errorMsg }],
      };
    }
  }

  /**
   * Get list of sessions
   */
  listLocalSessions(): ToolResult {
    const sessionsInfo = Array.from(this.sessions.values()).map((info) => ({
      sessionName: info.sessionId,
      description: info.description,
      sessionId: info.awsSessionId,
    }));

    return {
      status: 'success',
      content: [
        {
          json: {
            sessions: sessionsInfo,
            totalSessions: sessionsInfo.length,
          },
        },
      ],
    };
  }

  /**
   * Check session existence and create if needed
   */
  private async ensureSession(sessionName?: string): Promise<[string, ToolResult | null]> {
    const targetSession = sessionName || this.defaultSession;

    logger.debug(`Ensuring session: ${targetSession}`);

    // Check local cache
    if (this.sessions.has(targetSession)) {
      logger.debug(`Using cached session: ${targetSession}`);
      return [targetSession, null];
    }

    // Check module-level cache
    const awsSessionId = sessionMapping.get(targetSession);

    if (awsSessionId) {
      logger.debug(`Found session in module cache: ${targetSession} -> ${awsSessionId}`);

      try {
        // Check session status
        const command = new GetCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: this.identifier,
          sessionId: awsSessionId,
        });

        const sessionInfo = await this.client.send(command);

        if (sessionInfo.status === 'READY') {
          // Session is ready - reconnect
          this.sessions.set(targetSession, {
            sessionId: targetSession,
            description: 'Reconnected via module cache',
            awsSessionId: awsSessionId,
          });

          logger.info(`Reconnected to existing session: ${targetSession}`);
          return [targetSession, null];
        } else {
          // Session not ready - remove from cache
          logger.warn(`Session ${targetSession} not READY, removing from cache`);
          sessionMapping.delete(targetSession);
        }
      } catch (error) {
        // Session doesn't exist or error - remove from cache
        logger.debug(`Session reconnection failed: ${error}`);
        sessionMapping.delete(targetSession);
      }
    }

    // If session not found
    if (this.autoCreate) {
      logger.info(`Auto-creating session: ${targetSession}`);

      const initAction: InitSessionAction = {
        action: 'initSession',
        sessionName: targetSession,
        description: 'Auto-initialized session',
      };

      const result = await this.initSession(initAction);

      if (result.status !== 'success') {
        return [targetSession, result];
      }

      logger.info(`Successfully auto-created session: ${targetSession}`);
      return [targetSession, null];
    }

    // Session doesn't exist with autoCreate=false
    logger.debug(`Session '${targetSession}' not found (auto_create disabled)`);
    throw new Error(`Session '${targetSession}' not found. Create it first using initSession.`);
  }

  /**
   * Execute code
   */
  async executeCode(action: ExecuteCodeAction): Promise<ToolResult> {
    const [sessionName, error] = await this.ensureSession(action.sessionName);
    if (error) return error;

    logger.debug(`Executing ${action.language} code in session '${sessionName}'`);

    try {
      const sessionInfo = this.sessions.get(sessionName)!;

      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: sessionInfo.awsSessionId,
        name: 'executeCode',
        arguments: {
          code: action.code,
          language: action.language,
          clearContext: action.clearContext || false,
        },
      });

      const response = await this.client.send(command);
      return await this.createToolResult(response);
    } catch (error) {
      const errorMsg = `Failed to execute code: ${error}`;
      logger.error(errorMsg);
      return {
        status: 'error',
        content: [{ text: errorMsg }],
      };
    }
  }

  /**
   * Execute command
   */
  async executeCommand(action: ExecuteCommandAction): Promise<ToolResult> {
    const [sessionName, error] = await this.ensureSession(action.sessionName);
    if (error) return error;

    logger.debug(`Executing command in session '${sessionName}'`);

    try {
      const sessionInfo = this.sessions.get(sessionName)!;

      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: sessionInfo.awsSessionId,
        name: 'executeCommand',
        arguments: {
          command: action.command,
        },
      });

      const response = await this.client.send(command);
      return await this.createToolResult(response);
    } catch (error) {
      const errorMsg = `Failed to execute command: ${error}`;
      logger.error(errorMsg);
      return {
        status: 'error',
        content: [{ text: errorMsg }],
      };
    }
  }

  /**
   * Read files
   */
  async readFiles(action: ReadFilesAction): Promise<ToolResult> {
    const [sessionName, error] = await this.ensureSession(action.sessionName);
    if (error) return error;

    logger.debug(`Reading files from session '${sessionName}'`);

    try {
      const sessionInfo = this.sessions.get(sessionName)!;

      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: sessionInfo.awsSessionId,
        name: 'readFiles',
        arguments: {
          paths: action.paths,
        },
      });

      const response = await this.client.send(command);
      return await this.createToolResult(response);
    } catch (error) {
      const errorMsg = `Failed to read files: ${error}`;
      logger.error(errorMsg);
      return {
        status: 'error',
        content: [{ text: errorMsg }],
      };
    }
  }

  /**
   * List files
   */
  async listFiles(action: ListFilesAction): Promise<ToolResult> {
    const [sessionName, error] = await this.ensureSession(action.sessionName);
    if (error) return error;

    logger.debug(`Listing files in session '${sessionName}'`);

    try {
      const sessionInfo = this.sessions.get(sessionName)!;

      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: sessionInfo.awsSessionId,
        name: 'listFiles',
        arguments: {
          path: action.path,
        },
      });

      const response = await this.client.send(command);
      return await this.createToolResult(response);
    } catch (error) {
      const errorMsg = `Failed to list files: ${error}`;
      logger.error(errorMsg);
      return {
        status: 'error',
        content: [{ text: errorMsg }],
      };
    }
  }

  /**
   * Remove files
   */
  async removeFiles(action: RemoveFilesAction): Promise<ToolResult> {
    const [sessionName, error] = await this.ensureSession(action.sessionName);
    if (error) return error;

    logger.debug(`Removing files from session '${sessionName}'`);

    try {
      const sessionInfo = this.sessions.get(sessionName)!;

      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: sessionInfo.awsSessionId,
        name: 'removeFiles',
        arguments: {
          paths: action.paths,
        },
      });

      const response = await this.client.send(command);
      return await this.createToolResult(response);
    } catch (error) {
      const errorMsg = `Failed to remove files: ${error}`;
      logger.error(errorMsg);
      return {
        status: 'error',
        content: [{ text: errorMsg }],
      };
    }
  }

  /**
   * Write files
   */
  async writeFiles(action: WriteFilesAction): Promise<ToolResult> {
    const [sessionName, error] = await this.ensureSession(action.sessionName);
    if (error) return error;

    logger.debug(`Writing ${action.content.length} files to session '${sessionName}'`);

    try {
      const sessionInfo = this.sessions.get(sessionName)!;

      const contentDicts = action.content.map((fc) => ({
        path: fc.path,
        text: fc.text,
      }));

      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: sessionInfo.awsSessionId,
        name: 'writeFiles',
        arguments: {
          content: contentDicts,
        },
      });

      const response = await this.client.send(command);
      return await this.createToolResult(response);
    } catch (error) {
      const errorMsg = `Failed to write files: ${error}`;
      logger.error(errorMsg);
      return {
        status: 'error',
        content: [{ text: errorMsg }],
      };
    }
  }

  /**
   * Download files
   */
  async downloadFiles(action: DownloadFilesAction): Promise<ToolResult> {
    const [sessionName, error] = await this.ensureSession(action.sessionName);
    if (error) return error;

    logger.debug(`Downloading ${action.sourcePaths.length} files from session '${sessionName}'`);

    try {
      // Validate and create destination directory
      if (!path.isAbsolute(action.destinationDir)) {
        return {
          status: 'error',
          content: [
            { text: `Destination directory must be an absolute path: ${action.destinationDir}` },
          ],
        };
      }

      // Create destination directory (if it doesn't exist)
      fs.mkdirSync(action.destinationDir, { recursive: true });

      // Generate Python code to base64 encode files in sandbox
      const sourcePathsJson = JSON.stringify(action.sourcePaths);
      const encodeCode = `
import base64
import json
import os

results = {}
source_paths = ${sourcePathsJson}
cwd = os.getcwd()

for path in source_paths:
    try:
        # For relative paths, interpret as relative from working directory
        full_path = path if os.path.isabs(path) else os.path.join(cwd, path)
        
        if not os.path.exists(full_path):
            results[path] = {"error": f"File not found: {full_path}"}
            continue
            
        with open(full_path, 'rb') as f:
            file_data = f.read()
            results[path] = {
                "data": base64.b64encode(file_data).decode('utf-8'),
                "size": len(file_data)
            }
    except Exception as e:
        results[path] = {"error": str(e)}

# Save results to file (using cwd)
result_file = "__download_results__.json"
with open(result_file, 'w') as f:
    json.dump(results, f)

# Output only the file path
print(result_file)
`;

      // Execute encoding code in sandbox
      const sessionInfo = this.sessions.get(sessionName)!;

      const command = new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: this.identifier,
        sessionId: sessionInfo.awsSessionId,
        name: 'executeCode',
        arguments: {
          code: encodeCode,
          language: 'python',
          clearContext: false,
        },
      });

      const response = await this.client.send(command);
      const executionResult = await this.createToolResult(response);

      if (executionResult.status !== 'success') {
        return {
          status: 'error',
          content: [
            {
              text: `Failed to execute file encoding in sandbox: ${JSON.stringify(executionResult)}`,
            },
          ],
        };
      }

      // Get JSON file path from execution result
      const content = executionResult.content[0];
      let resultFilePath: string;

      if (content.text) {
        // If content.text is JSON array, parse and extract text field
        const outputText = content.text.trim();
        try {
          const parsed = JSON.parse(outputText);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].text) {
            resultFilePath = parsed[0].text.trim();
          } else {
            resultFilePath = outputText;
          }
        } catch {
          // Use as-is if not JSON
          resultFilePath = outputText;
        }
      } else {
        return {
          status: 'error',
          content: [{ text: `Unexpected response format: ${JSON.stringify(executionResult)}` }],
        };
      }

      logger.debug(`Result file path: ${resultFilePath}`);

      // Read JSON file using readFiles API
      const readAction: ReadFilesAction = {
        action: 'readFiles',
        sessionName: sessionName,
        paths: [resultFilePath],
      };

      const readResult = await this.readFiles(readAction);

      if (readResult.status !== 'success') {
        return {
          status: 'error',
          content: [
            {
              text: `Failed to read results file ${resultFilePath}: ${JSON.stringify(readResult)}`,
            },
          ],
        };
      }

      // Get JSON file content
      const fileContent = readResult.content[0];
      let resultsJson: string;

      if (fileContent.text) {
        // If text is JSON array string, parse and extract actual text
        try {
          const parsed = JSON.parse(fileContent.text);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const firstItem = parsed[0];
            // For resource type, get data from resource.text
            if (firstItem.type === 'resource' && firstItem.resource?.text) {
              resultsJson = firstItem.resource.text;
            } else if (firstItem.text) {
              resultsJson = firstItem.text;
            } else {
              resultsJson = fileContent.text;
            }
          } else {
            resultsJson = fileContent.text;
          }
        } catch {
          // Use as-is if JSON parse fails
          resultsJson = fileContent.text;
        }
      } else {
        return {
          status: 'error',
          content: [{ text: `Failed to extract JSON content: ${JSON.stringify(readResult)}` }],
        };
      }

      logger.debug(`Read JSON content (length: ${resultsJson.length})`);

      // Parse JSON
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let fileResults: Record<string, any>;
      try {
        fileResults = JSON.parse(resultsJson);
        logger.debug(`Parsed fileResults with ${Object.keys(fileResults).length} files`);
      } catch (jsonError) {
        return {
          status: 'error',
          content: [
            {
              text: `Failed to parse download results JSON: ${jsonError}. Content: ${resultsJson.substring(0, 500)}`,
            },
          ],
        };
      }

      // Remove temporary file
      try {
        await this.removeFiles({
          action: 'removeFiles',
          sessionName: sessionName,
          paths: [resultFilePath],
        });
        logger.debug(`Cleaned up temporary file: ${resultFilePath}`);
      } catch (cleanupError) {
        logger.warn(`Failed to cleanup temporary file ${resultFilePath}: ${cleanupError}`);
      }

      // Process each file result
      const downloadedFiles: DownloadedFile[] = [];
      const errors: string[] = [];

      for (const [sourcePath, result] of Object.entries(fileResults)) {
        if ('error' in result) {
          errors.push(`${sourcePath}: ${result.error}`);
          continue;
        }

        try {
          // Decode base64 data
          const fileData = Buffer.from(result.data, 'base64');

          // Determine local file path
          const sourceFilename = path.basename(sourcePath);
          // nosemgrep: path-join-resolve-traversal - destinationDir is validated, sourceFilename extracted via path.basename
          let localPath = path.join(action.destinationDir, sourceFilename);

          // Handle filename duplicates
          let counter = 1;
          const baseName = sourceFilename;
          while (fs.existsSync(localPath)) {
            if (baseName.includes('.')) {
              const nameExt = baseName.split('.');
              const ext = nameExt.pop();
              const name = nameExt.join('.');
              // nosemgrep: path-join-resolve-traversal - destinationDir is validated, filename is constructed safely
              localPath = path.join(action.destinationDir, `${name}_${counter}.${ext}`);
            } else {
              // nosemgrep: path-join-resolve-traversal - destinationDir is validated, filename is constructed safely
              localPath = path.join(action.destinationDir, `${baseName}_${counter}`);
            }
            counter++;
          }

          // Write file to local filesystem
          fs.writeFileSync(localPath, fileData);

          // Generate user-facing path by stripping WORKSPACE_DIRECTORY from local path.
          // Since workspace dir now mirrors S3 path hierarchy (e.g., /tmp/ws/dev2/file.png),
          // stripping /tmp/ws yields the correct display path (e.g., /dev2/file.png).
          const userPath = localPath.startsWith(WORKSPACE_DIRECTORY)
            ? localPath.slice(WORKSPACE_DIRECTORY.length) || `/${path.basename(localPath)}`
            : `/${path.basename(localPath)}`;

          downloadedFiles.push({
            sourcePath: sourcePath,
            localPath: localPath,
            userPath: userPath,
            size: result.size,
          });

          logger.info(`Downloaded file: ${sourcePath} -> ${localPath} (${result.size} bytes)`);
        } catch (decodeError) {
          errors.push(`${sourcePath}: Failed to decode/save file: ${decodeError}`);
        }
      }

      // Prepare response
      if (errors.length > 0 && downloadedFiles.length === 0) {
        return {
          status: 'error',
          content: [{ text: `All downloads failed: ${errors.join('; ')}` }],
        };
      }

      // Generate instruction for using userPath
      const exampleFile = downloadedFiles[0];
      const exampleExt = exampleFile ? path.extname(exampleFile.userPath).toLowerCase() : '';
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(exampleExt);
      const isVideo = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'].includes(exampleExt);

      let instruction = `✅ Files downloaded successfully. Use 'userPath' for references:\n`;

      if (isImage) {
        instruction += `Example: ![Image Description](${exampleFile.userPath})`;
      } else if (isVideo) {
        instruction += `Example: ![Video Description](${exampleFile.userPath}) or [Video](${exampleFile.userPath})`;
      } else {
        instruction += `Example: [File Name](${exampleFile.userPath})`;
      }

      const responseData: DownloadResult = {
        downloadedFiles: downloadedFiles,
        totalFiles: downloadedFiles.length,
        destinationDir: action.destinationDir,
        storagePath: this.storagePath,
        instruction: instruction,
      };

      if (errors.length > 0) {
        responseData.errors = errors;
      }

      return {
        status: 'success',
        content: [{ json: responseData }],
      };
    } catch (error) {
      const errorMsg = `Failed to download files from session '${sessionName}': ${error}`;
      logger.error(errorMsg);
      return {
        status: 'error',
        content: [{ text: errorMsg }],
      };
    }
  }

  /**
   * Create tool result from streaming response
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async createToolResult(response: any): Promise<ToolResult> {
    logger.debug(`Processing response: ${JSON.stringify(response, null, 2)}`);

    if (response.stream) {
      // Process streaming response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results: any[] = [];

      try {
        // Process AWS SDK v3 streaming response
        for await (const event of response.stream) {
          logger.debug(`Stream event: ${JSON.stringify(event)}`);

          if (event.result) {
            results.push(event.result);
          } else if (event.chunk) {
            // If chunk format
            results.push(event.chunk);
          } else {
            // Other event formats
            results.push(event);
          }
        }

        if (results.length > 0) {
          // Use last result
          const lastResult = results[results.length - 1];
          const isError = response.isError || false;

          // Format according to result content
          const content = lastResult.content || lastResult;
          if (typeof content === 'string') {
            return {
              status: isError ? 'error' : 'success',
              content: [{ text: content }],
            };
          } else if (Array.isArray(content)) {
            // CodeInterpreter returns content as array of {type, text} objects.
            // Extract text values to avoid wrapping the spec in the response envelope.
            const texts = content
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .filter((item: any) => item.type === 'text' && typeof item.text === 'string')
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((item: any) => item.text as string);
            if (texts.length > 0) {
              return {
                status: isError ? 'error' : 'success',
                content: [{ text: texts.join('\n') }],
              };
            }
            // Fallback: stringify the array if no text items found
            return {
              status: isError ? 'error' : 'success',
              content: [{ text: JSON.stringify(content) }],
            };
          } else {
            return {
              status: isError ? 'error' : 'success',
              content: [{ text: JSON.stringify(content) }],
            };
          }
        }

        return {
          status: 'error',
          content: [{ text: 'No results received from stream' }],
        };
      } catch (streamError) {
        logger.error(`Stream processing error: ${streamError}`);
        return {
          status: 'error',
          content: [{ text: `Stream processing failed: ${streamError}` }],
        };
      }
    }

    // Non-streaming response
    return response;
  }

  /**
   * Cleanup processing
   */
  async cleanup(): Promise<void> {
    if (!this.persistSessions) {
      logger.info('Cleaning up Bedrock Agent Core platform resources');

      for (const [sessionName, sessionInfo] of this.sessions.entries()) {
        try {
          const command = new StopCodeInterpreterSessionCommand({
            codeInterpreterIdentifier: this.identifier,
            sessionId: sessionInfo.awsSessionId,
          });

          await this.client.send(command);
          logger.debug(`Stopped session: ${sessionName}`);
        } catch (error) {
          logger.debug(`Session ${sessionName} cleanup skipped: ${error}`);
        }
      }

      this.sessions.clear();
      logger.info('Bedrock AgentCore platform cleanup completed');
    } else {
      logger.debug('Skipping cleanup - sessions persist (persistSessions=true)');
    }
  }
}
