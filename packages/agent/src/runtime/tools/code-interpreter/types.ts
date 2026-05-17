/**
 * Type definitions for the CodeInterpreter tool
 */

export type LanguageType = 'python' | 'javascript' | 'typescript';

/**
 * Tool execution result
 */
export interface ToolResult {
  status: 'success' | 'error';
  content: Array<{ text?: string; json?: unknown }>;
}

/**
 * Session initialization action
 */
export interface InitSessionAction {
  action: 'initSession';
  sessionName: string;
  description: string;
}

/**
 * Code execution action
 */
export interface ExecuteCodeAction {
  action: 'executeCode';
  sessionName: string;
  language: LanguageType;
  code: string;
  clearContext?: boolean;
}

/**
 * Command execution action
 */
export interface ExecuteCommandAction {
  action: 'executeCommand';
  sessionName: string;
  command: string;
}

/**
 * File read action
 */
export interface ReadFilesAction {
  action: 'readFiles';
  sessionName: string;
  paths: string[];
}

/**
 * File listing action
 */
export interface ListFilesAction {
  action: 'listFiles';
  sessionName: string;
  path: string;
}

/**
 * File removal action
 */
export interface RemoveFilesAction {
  action: 'removeFiles';
  sessionName: string;
  paths: string[];
}

/**
 * Content for file writing
 */
export interface FileContent {
  path: string;
  text: string;
}

/**
 * File write action
 */
export interface WriteFilesAction {
  action: 'writeFiles';
  sessionName: string;
  content: FileContent[];
}

/**
 * File download action
 */
export interface DownloadFilesAction {
  action: 'downloadFiles';
  sessionName: string;
  sourcePaths: string[];
  destinationDir: string;
}

/**
 * List local sessions action
 */
export interface ListLocalSessionsAction {
  action: 'listLocalSessions';
}

/**
 * All actions for CodeInterpreter
 */
export type CodeInterpreterAction =
  | InitSessionAction
  | ExecuteCodeAction
  | ExecuteCommandAction
  | ReadFilesAction
  | ListFilesAction
  | RemoveFilesAction
  | WriteFilesAction
  | DownloadFilesAction
  | ListLocalSessionsAction;

/**
 * Session information
 */
export interface SessionInfo {
  sessionId: string;
  description: string;
  awsSessionId: string;
}

/**
 * Options for CodeInterpreter client
 */
export interface CodeInterpreterOptions {
  region?: string;
  identifier?: string;
  sessionName?: string;
  autoCreate?: boolean;
  persistSessions?: boolean;
  storagePath?: string; // User's storage path for generating correct file references
}

/**
 * File download result
 */
export interface DownloadedFile {
  sourcePath: string;
  localPath: string;
  userPath: string; // User-facing path for references (e.g., /storage/filename.png)
  size: number;
}

/**
 * Download result
 */
export interface DownloadResult {
  downloadedFiles: DownloadedFile[];
  totalFiles: number;
  destinationDir: string;
  storagePath?: string; // Storage path prefix for instruction
  instruction?: string; // Instruction for using userPath
  errors?: string[];
}
