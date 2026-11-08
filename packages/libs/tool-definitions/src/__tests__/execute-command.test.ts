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

  describe('background process guidance', () => {
    // Verified live: an un-redirected `python3 -m http.server &` answers the
    // first request, then returns empty replies once the call's pipes close,
    // and agents misdiagnose this as "localhost is blocked".
    it('tells agents to redirect output of background processes', () => {
      expect(executeCommandDefinition.description).toMatch(/> \S+ 2>&1 &/);
    });
  });
});
