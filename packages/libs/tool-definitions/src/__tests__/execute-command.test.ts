/**
 * The execute_command description is where agents learn what the container
 * ships with. Without the local-browser note, agents probe with
 * `which chromium` / filename searches, miss the versioned binary under
 * /opt/ms-playwright, and wrongly report that Chromium is not installed.
 */

import { executeCommandDefinition } from '../definitions/execute-command';

describe('Execute Command Tool Definition', () => {
  it('should have correct tool name', () => {
    expect(executeCommandDefinition.name).toBe('execute_command');
  });

  describe('pre-installed local browser documentation', () => {
    it('advertises the `chromium` command on PATH', () => {
      expect(executeCommandDefinition.description).toMatch(/`chromium/);
    });

    it('advertises playwright-core for scripted use', () => {
      expect(executeCommandDefinition.description).toContain('playwright-core');
    });

    it('states that it works against localhost servers', () => {
      expect(executeCommandDefinition.description).toMatch(/localhost/);
    });

    it('states that no install is needed', () => {
      expect(executeCommandDefinition.description).toMatch(/no install/i);
    });
  });
});
