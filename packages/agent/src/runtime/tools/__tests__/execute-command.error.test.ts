/**
 * A failure before the child process runs (e.g. user-scoped credentials
 * cannot be re-minted) must tell the model why, not print an empty
 * "Execution Error" it cannot act on.
 */

import { describe, it, expect, jest } from '@jest/globals';

jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { formatExecutionError } = await import('../execute-command.js');

describe('formatExecutionError', () => {
  it('includes the reason for a non-process error', () => {
    const error = Object.assign(
      new Error('User-scoped credentials expired and no unexpired ID token is available'),
      {
        name: 'UserCredentialsExpiredError',
      }
    );

    const output = formatExecutionError(error, {
      command: 'ls',
      workingDirectory: '/tmp/ws',
      timeout: 1000,
    });

    expect(output).toContain('UserCredentialsExpiredError');
    expect(output).toContain('no unexpired ID token');
  });

  it('keeps exit code and stderr for a failed process without duplicating its message', () => {
    const error = Object.assign(new Error('Command failed: false'), { code: 1, stderr: 'boom' });

    const output = formatExecutionError(error, {
      command: 'false',
      workingDirectory: '/tmp/ws',
      timeout: 1000,
    });

    expect(output).toContain('Exit Code: 1');
    expect(output).toContain('boom');
    expect(output).not.toContain('Reason:');
  });
});
