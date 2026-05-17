/**
 * OpenTelemetry observability context management.
 * Manages OTel span attributes and baggage for CloudWatch GenAI Observability correlation.
 */
import { trace, context as otelContext, propagation, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { logger } from '../logger/index.js';
import type { SessionType } from '../../types/index.js';

/** Tracer instance for creating custom spans */
const tracer = trace.getTracer('moca-agent');

/** Parameters for building observability context */
export interface ObservabilityParams {
  actorId: string;
  sessionId?: string;
  sessionType?: SessionType;
  agentId?: string;
  modelId?: string;
  isMachineUser?: boolean;
  memoryEnabled?: boolean;
}

/**
 * Manages OpenTelemetry observability context for agent invocations.
 * Creates a custom traced span with agent-specific attributes and propagates
 * session.id via baggage for CloudWatch GenAI Observability correlation.
 *
 * @example
 * ```typescript
 * const otelCtx = new ObservabilityContext({ actorId, sessionId, modelId });
 * await otelCtx.traceAsync('agent.invocation', async (span) => {
 *   // Agent processing here - span has all custom attributes
 * });
 * ```
 */
export class ObservabilityContext {
  private readonly entries: Record<string, { value: string }>;
  private readonly params: ObservabilityParams;

  constructor(params: ObservabilityParams) {
    this.params = params;
    this.entries = this.buildEntries();
  }

  /**
   * Build entries from invocation parameters.
   * Maps agent context to OTel semantic convention attributes.
   */
  private buildEntries(): Record<string, { value: string }> {
    const entries: Record<string, { value: string }> = {
      'enduser.id': { value: this.params.actorId },
    };

    if (this.params.sessionId) {
      entries['session.id'] = { value: this.params.sessionId };
    }
    if (this.params.agentId) {
      entries['gen_ai.agent.id'] = { value: this.params.agentId };
    }
    if (this.params.modelId) {
      entries['gen_ai.request.model'] = { value: this.params.modelId };
    }
    if (this.params.sessionType) {
      entries['session.type'] = { value: this.params.sessionType };
    }
    if (this.params.isMachineUser) {
      entries['enduser.type'] = { value: 'machine' };
    }
    if (this.params.memoryEnabled) {
      entries['gen_ai.memory.enabled'] = { value: 'true' };
    }

    return entries;
  }

  /** Get the list of entry keys set on this context */
  get entryKeys(): string[] {
    return Object.keys(this.entries);
  }

  /**
   * Convert entries to flat span attributes.
   * @returns Record of attribute key-value pairs for span.setAttributes()
   */
  toSpanAttributes(): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const [key, entry] of Object.entries(this.entries)) {
      attrs[key] = entry.value;
    }
    return attrs;
  }

  /**
   * Execute an async function within a traced span that includes all observability attributes.
   * Creates a custom span as a child of the current active span (e.g., Express HTTP span),
   * sets all agent-specific attributes, and propagates session.id via baggage.
   *
   * @param spanName - Name of the span (e.g., 'agent.invocation')
   * @param fn - Async function to execute within the span context
   * @returns The return value of the provided function
   */
  async traceAsync<T>(spanName: string, fn: (span: Span) => Promise<T>): Promise<T> {
    // Set session.id baggage for AWS ADOT session correlation before starting span
    let activeContext = otelContext.active();
    if (this.params.sessionId) {
      const baggage = propagation.createBaggage({
        'session.id': { value: this.params.sessionId },
      });
      activeContext = propagation.setBaggage(activeContext, baggage);
    }

    return tracer.startActiveSpan(
      spanName,
      { attributes: this.toSpanAttributes() },
      activeContext,
      async (span) => {
        logger.debug(
          {
            spanName,
            entries: this.entryKeys,
            spanId: span.spanContext().spanId,
            traceId: span.spanContext().traceId,
          },
          'OTEL traced span started:'
        );

        try {
          const result = await fn(span);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }
}
