/**
 * AgentCore Runtime HTTP Server - Entry Point
 */

import { createApp } from './app.js';
import { config } from './config/index.js';
import { hydrateJwtVerifiers } from './libs/auth/jwt-verifier.js';
import { logger } from './libs/logger/index.js';
import { getInFlightCount, isBusy } from './libs/health/in-flight.js';
import { getTimeOfLastUpdate } from './libs/health/last-activity.js';
import { installStrandsSpanKindFixer } from './libs/observability/install-strands-span-kind-fixer.js';
import { getActiveWorkspaceSyncs } from './services/workspace-sync-helper.js';

// Adapt Strands TS SDK 1.2.0 spans to the shape AgentCore Observability
// expects: promote `invoke_agent` from INTERNAL to CLIENT (so the trace
// metrics token aggregator counts it), and project Strands' per-message
// span events onto the `gen_ai.input.messages` / `gen_ai.output.messages`
// attributes the ADOT JS distro's LLO handler reads (and onto the legacy
// `gen_ai.input.prompt` / `gen_ai.output.text` keys as a fallback).
//
// We do NOT call `setupTracer({}) / setupMeter({})` from `@strands-agents/sdk/
// telemetry`. Strands SDK 1.2.0's `setupTracer` unconditionally constructs a
// new `DefaultTracerProvider` and calls `trace.setGlobalTracerProvider`
// (telemetry/config.js:114-115), which the OTel API rejects with
// "Attempted duplicate registration of API: trace" because ADOT
// auto-instrumentation (scripts/startup.sh:
// `--require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register`)
// has already registered its provider. Strands' Agent does not auto-call
// `setupTracer` — it reads the global OTel tracer/meter directly — so
// skipping these calls leaves ADOT's provider intact and Strands' spans
// flow through it as expected.
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
  // Activity at SIGTERM time lets ops detect a reclaim during in-flight work.
  const timeOfLastUpdate = getTimeOfLastUpdate();
  logger.info(
    {
      busy: isBusy(),
      inFlight: getInFlightCount(),
      timeOfLastUpdate,
      idleSeconds: Math.floor(Date.now() / 1000) - timeOfLastUpdate,
    },
    'Received SIGTERM, shutting down gracefully'
  );

  // B4: Best-effort workspace sync on SIGTERM.
  // Attempt to push any unsaved workspace files to S3 before exiting.
  // Limited to 10 seconds — the platform's SIGTERM-to-kill window varies,
  // so we keep this short and treat it as a best-effort safety net.
  // Failures are logged and swallowed; the per-turn final sync in runTurn()
  // is the primary guarantee.
  const activeSyncs = getActiveWorkspaceSyncs();
  if (activeSyncs.size > 0) {
    const SIGTERM_SYNC_TIMEOUT_MS = 10_000;
    logger.info({ count: activeSyncs.size }, 'SIGTERM: attempting best-effort workspace sync');
    Promise.race([
      Promise.allSettled([...activeSyncs].map((ws) => ws.syncToS3())),
      new Promise<void>((resolve) => setTimeout(resolve, SIGTERM_SYNC_TIMEOUT_MS)),
    ])
      .then(() => {
        logger.info('SIGTERM: workspace sync attempt completed');
      })
      .catch((err) => {
        logger.warn({ err }, 'SIGTERM: workspace sync attempt failed');
      })
      .finally(() => {
        process.exit(0);
      });
  } else {
    process.exit(0);
  }
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  process.exit(0);
});
