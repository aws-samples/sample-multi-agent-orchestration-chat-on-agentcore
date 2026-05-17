/**
 * AgentCore Runtime HTTP Server - Entry Point
 */

import { createApp } from './app.js';
import { config } from './config/index.js';
import { hydrateJwtVerifiers } from './libs/auth/jwt-verifier.js';
import { logger } from './libs/logger/index.js';
const PORT = config.PORT;

/**
 * Start application
 */
async function startServer(): Promise<void> {
  try {
    const app = createApp();

    // Pre-warm the JWKS cache so the first `/invocations` does not
    // pay the network round-trip to Cognito. Failures here are
    // non-fatal — `verifyAccessToken` / `verifyIdToken` will retry
    // lazily on the first real request.
    await hydrateJwtVerifiers();

    // Start HTTP server (Agent initialization executed on first request)
    app.listen(PORT, () => {
      logger.info(
        {
          port: PORT,
          healthCheck: `http://localhost:${PORT}/ping`,
          agentEndpoint: `POST http://localhost:${PORT}/invocations`,
          note: 'Agent is initialized on first request',
        },
        'AgentCore Runtime server started:'
      );
    });
  } catch (error) {
    logger.error({ error }, 'Server start failed:');
    process.exit(1);
  }
}

// Start server
startServer();

// Graceful shutdown handling
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  process.exit(0);
});
