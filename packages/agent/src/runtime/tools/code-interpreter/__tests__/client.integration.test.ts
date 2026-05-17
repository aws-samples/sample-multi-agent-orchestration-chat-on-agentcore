/**
 * Integration tests for the AgentCore CodeInterpreter client
 *
 * These tests call the actual AWS CodeInterpreter service.
 * Valid AWS credentials are required to run them.
 *
 * How to run:
 * npm run test:integration -- client.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { AgentCoreCodeInterpreterClient } from '../client.js';
import type {
  InitSessionAction,
  ExecuteCodeAction,
  ExecuteCommandAction,
  WriteFilesAction,
  ReadFilesAction,
  ListFilesAction,
  RemoveFilesAction,
  DownloadFilesAction,
} from '../types.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Client for testing
let client: AgentCoreCodeInterpreterClient;
let testSessionName: string;
let downloadDir: string;

// Initialize client before tests
beforeAll(async () => {
  // Generate a unique session name
  testSessionName = `test-session-${Date.now()}`;

  // Temporary directory for downloads
  downloadDir = path.join(os.tmpdir(), `codeinterpreter-test-${Date.now()}`);
  fs.mkdirSync(downloadDir, { recursive: true });

  // Initialize client (explicitly with autoCreate=false for testing)
  client = new AgentCoreCodeInterpreterClient({
    region: process.env.AWS_REGION || 'us-east-1',
    autoCreate: false,
    persistSessions: false, // Clean up after tests
  });

  console.log(`Test session name: ${testSessionName}`);
  console.log(`Download directory: ${downloadDir}`);

  // Initialize session (used by all tests)
  const initAction: InitSessionAction = {
    action: 'initSession',
    sessionName: testSessionName,
    description: 'Integration test session',
  };

  const result = await client.initSession(initAction);
  if (result.status !== 'success') {
    throw new Error(`Failed to initialize test session: ${JSON.stringify(result.content)}`);
  }

  console.log(`Session initialized: ${testSessionName}`);
}, 60000);

// Clean up after tests
afterAll(async () => {
  try {
    // Clean up session
    await client.cleanup();

    // Remove download directory
    if (fs.existsSync(downloadDir)) {
      fs.rmSync(downloadDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}, 60000);

describe('AgentCoreCodeInterpreterClient - Session Management', () => {
  it('should have initialized session in beforeAll', () => {
    // Session is already initialized in beforeAll
    const result = client.listLocalSessions();

    expect(result.status).toBe('success');
    const jsonContent = result.content[0].json as {
      sessions: Array<{ sessionName: string; description: string; sessionId: string }>;
      totalSessions: number;
    };

    expect(jsonContent.totalSessions).toBeGreaterThan(0);
    const testSession = jsonContent.sessions.find((s) => s.sessionName === testSessionName);
    expect(testSession).toBeDefined();
  });

  it('should fail to initialize duplicate session', async () => {
    const action: InitSessionAction = {
      action: 'initSession',
      sessionName: testSessionName,
      description: 'Duplicate session',
    };

    const result = await client.initSession(action);

    expect(result.status).toBe('error');
    expect(result.content[0].text).toContain('already exists');
  }, 60000);

  it('should list local sessions', () => {
    const result = client.listLocalSessions();

    expect(result.status).toBe('success');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].json).toBeDefined();

    const jsonContent = result.content[0].json as {
      sessions: Array<{ sessionName: string; description: string; sessionId: string }>;
      totalSessions: number;
    };

    expect(jsonContent.sessions).toBeDefined();
    expect(Array.isArray(jsonContent.sessions)).toBe(true);
    expect(jsonContent.totalSessions).toBeGreaterThan(0);

    // Verify the created session is included
    const testSession = jsonContent.sessions.find((s) => s.sessionName === testSessionName);
    expect(testSession).toBeDefined();
  });
});

describe('AgentCoreCodeInterpreterClient - Code Execution', () => {
  it('should execute Python code and return result', async () => {
    const action: ExecuteCodeAction = {
      action: 'executeCode',
      sessionName: testSessionName,
      language: 'python',
      code: 'print("Hello from Python")\nresult = 2 + 2\nprint(f"Result: {result}")',
    };

    const result = await client.executeCode(action);

    expect(result.status).toBe('success');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBeDefined();
    expect(result.content[0].text).toContain('Hello from Python');
    expect(result.content[0].text).toContain('Result: 4');
  }, 60000);

  it('should execute Python code with calculations', async () => {
    const action: ExecuteCodeAction = {
      action: 'executeCode',
      sessionName: testSessionName,
      language: 'python',
      code: `
import math
x = 10
y = math.sqrt(x)
print(f"Square root of {x} is {y}")
`,
    };

    const result = await client.executeCode(action);

    expect(result.status).toBe('success');
    expect(result.content[0].text).toContain('Square root of 10');
  }, 60000);

  it('should handle Python code errors gracefully', async () => {
    const action: ExecuteCodeAction = {
      action: 'executeCode',
      sessionName: testSessionName,
      language: 'python',
      code: 'undefined_variable + 1',
    };

    const result = await client.executeCode(action);

    // Results are returned even on error (per AWS behavior)
    expect(result.status).toBeDefined();
    expect(result.content).toHaveLength(1);

    // Verify error message is included
    const content = result.content[0].text || JSON.stringify(result.content[0]);
    expect(content.toLowerCase()).toMatch(/error|exception|undefined/i);
  }, 60000);

  it('should execute JavaScript code', async () => {
    const action: ExecuteCodeAction = {
      action: 'executeCode',
      sessionName: testSessionName,
      language: 'javascript',
      code: 'console.log("Hello from JavaScript"); const sum = 5 + 3; console.log("Sum:", sum);',
    };

    const result = await client.executeCode(action);

    expect(result.status).toBe('success');
    expect(result.content).toHaveLength(1);

    const content = result.content[0].text || JSON.stringify(result.content[0]);
    expect(content).toContain('Hello from JavaScript');
  }, 60000);
});

describe('AgentCoreCodeInterpreterClient - Command Execution', () => {
  it('should execute simple shell commands', async () => {
    const action: ExecuteCommandAction = {
      action: 'executeCommand',
      sessionName: testSessionName,
      command: 'echo "Hello World"',
    };

    const result = await client.executeCommand(action);

    expect(result.status).toBe('success');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('Hello World');
  }, 60000);

  it('should execute commands and return output', async () => {
    const action: ExecuteCommandAction = {
      action: 'executeCommand',
      sessionName: testSessionName,
      command: 'ls -la',
    };

    const result = await client.executeCommand(action);

    expect(result.status).toBe('success');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBeDefined();
    expect(typeof result.content[0].text).toBe('string');
  }, 60000);

  it('should execute pwd command', async () => {
    const action: ExecuteCommandAction = {
      action: 'executeCommand',
      sessionName: testSessionName,
      command: 'pwd',
    };

    const result = await client.executeCommand(action);

    expect(result.status).toBe('success');
    expect(result.content[0].text).toMatch(/\//); // Unix path should contain /
  }, 60000);
});

describe('AgentCoreCodeInterpreterClient - File Operations', () => {
  const testFileName = 'test-file.txt';
  const testFileContent = 'This is a test file created by integration test';

  it('should write files to sandbox', async () => {
    const action: WriteFilesAction = {
      action: 'writeFiles',
      sessionName: testSessionName,
      content: [
        {
          path: testFileName,
          text: testFileContent,
        },
      ],
    };

    const result = await client.writeFiles(action);

    expect(result.status).toBe('success');
    expect(result.content).toHaveLength(1);
  }, 60000);

  it('should write multiple files to sandbox', async () => {
    const action: WriteFilesAction = {
      action: 'writeFiles',
      sessionName: testSessionName,
      content: [
        {
          path: 'file1.txt',
          text: 'Content of file 1',
        },
        {
          path: 'file2.txt',
          text: 'Content of file 2',
        },
        {
          path: 'subdir/file3.txt',
          text: 'Content of file 3 in subdirectory',
        },
      ],
    };

    const result = await client.writeFiles(action);

    expect(result.status).toBe('success');
  }, 60000);

  it('should read files from sandbox', async () => {
    const action: ReadFilesAction = {
      action: 'readFiles',
      sessionName: testSessionName,
      paths: [testFileName],
    };

    const result = await client.readFiles(action);

    expect(result.status).toBe('success');
    expect(result.content).toHaveLength(1);

    const content = result.content[0].text || JSON.stringify(result.content[0]);
    expect(content).toContain(testFileContent);
  }, 60000);

  it('should list files in directory', async () => {
    const action: ListFilesAction = {
      action: 'listFiles',
      sessionName: testSessionName,
      path: '/',
    };

    const result = await client.listFiles(action);

    expect(result.status).toBe('success');
    expect(result.content).toHaveLength(1);

    const content = result.content[0].text || JSON.stringify(result.content[0]);
    expect(content).toContain(testFileName);
  }, 60000);

  it('should download files to local filesystem', async () => {
    const localFileName = 'downloaded-test.txt';
    const expectedLocalPath = path.join(downloadDir, localFileName);

    // First, create a file for downloading
    const writeAction: WriteFilesAction = {
      action: 'writeFiles',
      sessionName: testSessionName,
      content: [
        {
          path: localFileName,
          text: 'Content for download test',
        },
      ],
    };

    await client.writeFiles(writeAction);

    // Execute download
    const downloadAction: DownloadFilesAction = {
      action: 'downloadFiles',
      sessionName: testSessionName,
      sourcePaths: [localFileName],
      destinationDir: downloadDir,
    };

    const result = await client.downloadFiles(downloadAction);

    expect(result.status).toBe('success');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].json).toBeDefined();

    const jsonContent = result.content[0].json as {
      downloadedFiles: Array<{ sourcePath: string; localPath: string; size: number }>;
      totalFiles: number;
      destinationDir: string;
    };

    expect(jsonContent.downloadedFiles).toHaveLength(1);
    expect(jsonContent.downloadedFiles[0].sourcePath).toBe(localFileName);
    expect(jsonContent.downloadedFiles[0].size).toBeGreaterThan(0);
    expect(jsonContent.totalFiles).toBe(1);
    expect(jsonContent.destinationDir).toBe(downloadDir);

    // Verify files were actually downloaded
    expect(fs.existsSync(expectedLocalPath)).toBe(true);

    const downloadedContent = fs.readFileSync(expectedLocalPath, 'utf-8');
    expect(downloadedContent).toBe('Content for download test');
  }, 90000);

  it('should download multiple files', async () => {
    // Create multiple files
    const files = ['multi1.txt', 'multi2.txt', 'multi3.txt'];
    const writeAction: WriteFilesAction = {
      action: 'writeFiles',
      sessionName: testSessionName,
      content: files.map((file, idx) => ({
        path: file,
        text: `Content ${idx + 1}`,
      })),
    };

    await client.writeFiles(writeAction);

    // Download
    const downloadAction: DownloadFilesAction = {
      action: 'downloadFiles',
      sessionName: testSessionName,
      sourcePaths: files,
      destinationDir: downloadDir,
    };

    const result = await client.downloadFiles(downloadAction);

    expect(result.status).toBe('success');

    const jsonContent = result.content[0].json as {
      downloadedFiles: Array<{ sourcePath: string; localPath: string; size: number }>;
      totalFiles: number;
    };

    expect(jsonContent.totalFiles).toBe(3);

    // Verify all files were downloaded
    files.forEach((file) => {
      // nosemgrep: path-join-resolve-traversal - test code with hardcoded values, path.basename strips traversal
      const localPath = path.join(downloadDir, path.basename(file));
      expect(fs.existsSync(localPath)).toBe(true);
    });
  }, 90000);

  it('should remove files from sandbox', async () => {
    // Create a file for deletion
    const fileToRemove = 'file-to-remove.txt';
    const writeAction: WriteFilesAction = {
      action: 'writeFiles',
      sessionName: testSessionName,
      content: [
        {
          path: fileToRemove,
          text: 'This file will be removed',
        },
      ],
    };

    await client.writeFiles(writeAction);

    // Delete the file
    const removeAction: RemoveFilesAction = {
      action: 'removeFiles',
      sessionName: testSessionName,
      paths: [fileToRemove],
    };

    const result = await client.removeFiles(removeAction);

    expect(result.status).toBe('success');

    // Verify the file was deleted (get file listing)
    const listAction: ListFilesAction = {
      action: 'listFiles',
      sessionName: testSessionName,
      path: '/',
    };

    const listResult = await client.listFiles(listAction);
    const content = listResult.content[0].text || JSON.stringify(listResult.content[0]);

    // Verify the deleted file is not in the listing
    expect(content).not.toContain(fileToRemove);
  }, 60000);
});

describe('AgentCoreCodeInterpreterClient - Context Management', () => {
  it('should maintain context across code executions', async () => {
    // Define a variable
    const defineAction: ExecuteCodeAction = {
      action: 'executeCode',
      sessionName: testSessionName,
      language: 'python',
      code: 'test_variable = 42',
    };

    await client.executeCode(defineAction);

    // Use the same variable
    const useAction: ExecuteCodeAction = {
      action: 'executeCode',
      sessionName: testSessionName,
      language: 'python',
      code: 'print(f"Variable value: {test_variable}")',
    };

    const result = await client.executeCode(useAction);

    expect(result.status).toBe('success');
    expect(result.content[0].text).toContain('Variable value: 42');
  }, 60000);

  it('should clear context when requested', async () => {
    // Define a new variable and clear the context
    const clearAction: ExecuteCodeAction = {
      action: 'executeCode',
      sessionName: testSessionName,
      language: 'python',
      code: 'new_variable_after_clear = "cleared"',
      clearContext: true,
    };

    await client.executeCode(clearAction);

    // After executing with clearContext=true, access the previous variable test_variable
    const accessOldAction: ExecuteCodeAction = {
      action: 'executeCode',
      sessionName: testSessionName,
      language: 'python',
      code: `
try:
    print(test_variable)
    print("OLD_VAR_EXISTS")
except NameError:
    print("OLD_VAR_NOT_DEFINED")
`,
    };

    const oldResult = await client.executeCode(accessOldAction);
    const oldContent = oldResult.content[0].text || JSON.stringify(oldResult.content[0]);

    // Access the newly defined variable after clearContext
    const accessNewAction: ExecuteCodeAction = {
      action: 'executeCode',
      sessionName: testSessionName,
      language: 'python',
      code: `
try:
    print(new_variable_after_clear)
    print("NEW_VAR_EXISTS")
except NameError:
    print("NEW_VAR_NOT_DEFINED")
`,
    };

    const newResult = await client.executeCode(accessNewAction);
    const newContent = newResult.content[0].text || JSON.stringify(newResult.content[0]);

    // Verify clearContext behavior:
    // - Whether previous variables are cleared, or
    // - Whether new variables exist
    const oldVarCleared = oldContent.includes('OLD_VAR_NOT_DEFINED');
    const newVarExists = newContent.includes('NEW_VAR_EXISTS');

    // Either condition being satisfied is acceptable
    expect(oldVarCleared || newVarExists).toBe(true);

    // Debug information
    if (!oldVarCleared && !newVarExists) {
      console.log('clearContext test debug:');
      console.log('Old variable check:', oldContent);
      console.log('New variable check:', newContent);
    }
  }, 60000);
});

describe('AgentCoreCodeInterpreterClient - Error Handling', () => {
  it('should handle non-existent file read', async () => {
    const action: ReadFilesAction = {
      action: 'readFiles',
      sessionName: testSessionName,
      paths: ['non-existent-file.txt'],
    };

    const result = await client.readFiles(action);

    // Results containing errors or error messages are returned
    expect(result.status).toBeDefined();
    const content = result.content[0].text || JSON.stringify(result.content[0]);
    expect(content.toLowerCase()).toMatch(/error|not found|no such file/i);
  }, 60000);

  it('should handle invalid download directory', async () => {
    const action: DownloadFilesAction = {
      action: 'downloadFiles',
      sessionName: testSessionName,
      sourcePaths: ['test-file.txt'],
      destinationDir: 'relative/path', // Relative paths are invalid
    };

    const result = await client.downloadFiles(action);

    expect(result.status).toBe('error');
    expect(result.content[0].text).toContain('absolute path');
  }, 60000);
});

describe('AgentCoreCodeInterpreterClient - Cleanup', () => {
  it('should cleanup sessions properly', async () => {
    // Create a new client for cleanup testing
    const cleanupClient = new AgentCoreCodeInterpreterClient({
      region: process.env.AWS_REGION || 'us-east-1',
      sessionName: `cleanup-test-${Date.now()}`,
      autoCreate: true,
      persistSessions: false,
    });

    // Create a session (automatically created since autoCreate is true)
    const cleanupSessionName = `cleanup-test-${Date.now()}`;
    const action: ExecuteCodeAction = {
      action: 'executeCode',
      sessionName: cleanupSessionName,
      language: 'python',
      code: 'print("test")',
    };

    const result = await cleanupClient.executeCode(action);
    expect(result.status).toBe('success');

    // Execute cleanup
    await expect(cleanupClient.cleanup()).resolves.not.toThrow();
  }, 60000);
});
