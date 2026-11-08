/**
 * Unit tests for Browser tool definition.
 *
 * AC5: The description must document that AgentCore Browser runs outside the
 * agent container and cannot reach localhost / 127.0.0.1 / file:// URLs that
 * are served from the agent workspace, and must point to the local headless
 * Chromium alternative via execute_command.
 */

import { browserDefinition } from '../definitions/browser';

describe('Browser Tool Definition', () => {
  it('should have correct tool name', () => {
    expect(browserDefinition.name).toBe('browser');
  });

  describe('network-boundary documentation (AC5)', () => {
    it('states that localhost is not reachable from the managed browser', () => {
      expect(browserDefinition.description).toMatch(/localhost/i);
    });

    it('states that 127.0.0.1 is not reachable from the managed browser', () => {
      expect(browserDefinition.description).toContain('127.0.0.1');
    });

    it('states that file:// URLs are not reachable from the managed browser', () => {
      expect(browserDefinition.description).toContain('file://');
    });

    it('documents that the browser runs outside the agent container', () => {
      // Must clarify the managed nature — not inside the agent container
      expect(browserDefinition.description).toMatch(
        /not inside (this )?agent container|outside (this )?agent container|managed.*environment/i
      );
    });

    it('points to local headless Chromium via execute_command as the alternative', () => {
      expect(browserDefinition.description).toMatch(/execute_command/i);
    });

    it('does not suggest `npx playwright` (only playwright-core is in the image)', () => {
      // `npx playwright` would fetch the full `playwright` package at runtime.
      expect(browserDefinition.description).not.toMatch(/npx playwright/);
    });
  });
});
