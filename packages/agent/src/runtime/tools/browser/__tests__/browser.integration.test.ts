/**
 * AgentCore Browser Integration Tests
 *
 * These tests make actual calls to AWS AgentCore Browser service.
 * Valid AWS credentials with browser permissions are required.
 *
 * Run with:
 * npm run test:integration -- browser.integration.test.ts
 */

import { describe, it, expect, afterAll } from '@jest/globals';
import {
  BedrockAgentCoreClient,
  StartBrowserSessionCommand,
  GetBrowserSessionCommand,
  StopBrowserSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const BROWSER_REGION = process.env.AWS_REGION || 'us-east-1';
const BROWSER_IDENTIFIER = 'aws.browser.v1';

let client: BedrockAgentCoreClient;
let testSessionId: string | undefined;

beforeAll(() => {
  client = new BedrockAgentCoreClient({ region: BROWSER_REGION });
  console.log(`AgentCore Browser tests running in region: ${BROWSER_REGION}`);
});

// Cleanup: stop session after all tests
afterAll(async () => {
  if (testSessionId) {
    try {
      await client.send(
        new StopBrowserSessionCommand({
          browserIdentifier: BROWSER_IDENTIFIER,
          sessionId: testSessionId,
        })
      );
      console.log(`Cleanup: Session ${testSessionId} stopped`);
    } catch (error) {
      // nosemgrep: unsafe-formatstring - test cleanup log, no user-controlled input
      console.warn(`Cleanup: Failed to stop session ${testSessionId}:`, error);
    }
  }
});

describe('AgentCore Browser - Session Management', () => {
  it('should start a browser session', async () => {
    const sessionName = `test-session-${Date.now()}`;

    const command = new StartBrowserSessionCommand({
      browserIdentifier: BROWSER_IDENTIFIER,
      name: sessionName,
      sessionTimeoutSeconds: 300, // 5 minutes for testing
      viewPort: {
        width: 1280,
        height: 720,
      },
    });

    const response = await client.send(command);

    expect(response.sessionId).toBeDefined();
    expect(response.browserIdentifier).toBeDefined();
    expect(response.streams).toBeDefined();
    expect(response.streams?.automationStream).toBeDefined();
    expect(response.streams?.automationStream?.streamEndpoint).toBeDefined();
    expect(response.streams?.automationStream?.streamStatus).toBeDefined();

    testSessionId = response.sessionId;
    console.log(`Session started: ${testSessionId}`);
    console.log(`Automation endpoint: ${response.streams?.automationStream?.streamEndpoint}`);

    if (response.streams?.liveViewStream?.streamEndpoint) {
      console.log(`Live view: ${response.streams.liveViewStream.streamEndpoint}`);
    }
  }, 30000);

  it('should get browser session info', async () => {
    if (!testSessionId) {
      console.log('Skipping: no active session');
      return;
    }

    const command = new GetBrowserSessionCommand({
      browserIdentifier: BROWSER_IDENTIFIER,
      sessionId: testSessionId,
    });

    const response = await client.send(command);

    expect(response.sessionId).toBe(testSessionId);
    console.log(`Session status: ${response.status}`);
  }, 15000);

  it('should stop a browser session', async () => {
    if (!testSessionId) {
      console.log('Skipping: no active session');
      return;
    }

    const command = new StopBrowserSessionCommand({
      browserIdentifier: BROWSER_IDENTIFIER,
      sessionId: testSessionId,
    });

    await client.send(command);
    console.log(`Session ${testSessionId} stopped successfully`);

    // Clear testSessionId so afterAll doesn't try to stop it again
    testSessionId = undefined;
  }, 15000);
});

describe('AgentCore Browser - Session with Viewport', () => {
  let sessionId: string | undefined;

  afterAll(async () => {
    if (sessionId) {
      try {
        await client.send(
          new StopBrowserSessionCommand({
            browserIdentifier: BROWSER_IDENTIFIER,
            sessionId,
          })
        );
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('should start a session with custom viewport', async () => {
    const command = new StartBrowserSessionCommand({
      browserIdentifier: BROWSER_IDENTIFIER,
      name: `test-viewport-${Date.now()}`,
      sessionTimeoutSeconds: 300,
      viewPort: {
        width: 1920,
        height: 1080,
      },
    });

    const response = await client.send(command);

    expect(response.sessionId).toBeDefined();
    expect(response.streams?.automationStream?.streamEndpoint).toBeDefined();

    sessionId = response.sessionId;
    console.log(`Custom viewport session started: ${sessionId}`);
  }, 30000);
});
