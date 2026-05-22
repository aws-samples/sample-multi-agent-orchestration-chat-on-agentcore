/**
 * AgentCore Runtime HTTP Server - Entry Point
 */

import { setupTracer, setupMeter } from '@strands-agents/sdk/telemetry';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { hydrateJwtVerifiers } from './libs/auth/jwt-verifier.js';
import { logger } from './libs/logger/index.js';
import { installStrandsSpanKindFixer } from './libs/observability/install-strands-span-kind-fixer.js';

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

// Adapt Strands TS SDK 1.2.0 spans to the shape AgentCore Observability
// expects: promote `invoke_agent` from INTERNAL to CLIENT (so the trace
// metrics token aggregator counts it), and project Strands' per-message
// span events onto the legacy `gen_ai.input.prompt` /
// `gen_ai.output.text` attributes the trace list view reads. Must run
// AFTER both ADOT's auto-init and the Strands `setupTracer({})` call
// above so we register against the final TracerProvider in the proxy
// chain.
installStrandsSpanKindFixer();

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
