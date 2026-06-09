import { describe, it, expect } from '@jest/globals';
import {
  isAllowedWorkingDirectory,
  isDangerousCommand,
  truncateOutput,
} from '../security.js';

/**
 * Unit tests for the pure security helpers of the execute_command tool.
 *
 * `isAllowedWorkingDirectory` reads `config.ALLOWED_WORKING_DIRS`. The test
 * environment does not set that variable, so it resolves to an empty list and
 * the built-in default allow-list (`/home/`, `/tmp/`, `/var/tmp/`, `/Users/`)
 * applies.
 */
describe('isDangerousCommand', () => {
  it('flags filesystem-destructive commands', () => {
    expect(isDangerousCommand('rm -rf /')).toBe(true);
    expect(isDangerousCommand('mkfs.ext4 /dev/sda')).toBe(true);
    expect(isDangerousCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);
  });

  it('flags access to the EC2 instance metadata endpoint', () => {
    expect(isDangerousCommand('curl http://169.254.169.254/latest/meta-data/')).toBe(true);
    expect(isDangerousCommand('curl http://169.254.170.2/')).toBe(true);
  });

  it('flags system-state commands', () => {
    expect(isDangerousCommand('shutdown now')).toBe(true);
    expect(isDangerousCommand('reboot')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isDangerousCommand('RM -RF /')).toBe(true);
    expect(isDangerousCommand('ShutDown -h now')).toBe(true);
  });

  it('allows benign commands', () => {
    expect(isDangerousCommand('ls -la')).toBe(false);
    expect(isDangerousCommand('echo hello')).toBe(false);
    expect(isDangerousCommand('git status')).toBe(false);
  });
});

describe('isAllowedWorkingDirectory', () => {
  it('denies the root directory', () => {
    expect(isAllowedWorkingDirectory('/')).toBe(false);
  });

  it('allows the default permitted directories', () => {
    expect(isAllowedWorkingDirectory('/tmp/ws')).toBe(true);
    expect(isAllowedWorkingDirectory('/home/user/project')).toBe(true);
    expect(isAllowedWorkingDirectory('/var/tmp/build')).toBe(true);
    expect(isAllowedWorkingDirectory('/Users/me/work')).toBe(true);
  });

  it('denies directories outside the default allow-list', () => {
    expect(isAllowedWorkingDirectory('/etc')).toBe(false);
    expect(isAllowedWorkingDirectory('/usr/bin')).toBe(false);
  });
});

describe('truncateOutput', () => {
  it('returns output unchanged when under the limit', () => {
    const output = 'short output';
    expect(truncateOutput(output, 4000)).toBe(output);
  });

  it('returns output unchanged when exactly at the limit', () => {
    const output = 'x'.repeat(10);
    expect(truncateOutput(output, 10)).toBe(output);
  });

  it('truncates output over the limit and appends a notice', () => {
    const output = 'x'.repeat(50);
    const result = truncateOutput(output, 10);

    expect(result.startsWith('x'.repeat(10))).toBe(true);
    expect(result).toContain('... (Output truncated due to length. Original length: 50 characters)');
    expect(result.length).toBeGreaterThan(10);
  });
});
