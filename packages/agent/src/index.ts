/**
 * AgentCore Runtime HTTP Server - Entry Point
 */

import { setupTracer, setupMeter } from '@strands-agents/sdk/telemetry';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { hydrateJwtVerifiers } from './libs/auth/jwt-verifier.js';
import { logger } from './libs/logger/index.js';

// Strands Agents SDK >=1.0 requires explicit telemetry setup before any
// `Agent` instance is constructed. The SDK uses the global OTel API, so any
// TracerProvider/MeterProvider already registered by ADOT auto-instrumentation
// (see scripts/startup.sh: `--require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register`)
// is reused — `setupTracer({})` here only attaches the SDK's W3C propagators
// and async context manager, it does NOT replace the ADOT-provided exporter.
//
// Without this call, Strands' own spans (Cycle, Model invoke) carrying
// `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` are dropped and
// CloudWatch GenAI Observability shows only the surrounding HTTP/X-Ray spans.
setupTracer({});
setupMeter({});

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
