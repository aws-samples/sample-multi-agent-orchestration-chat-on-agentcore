/**
 * Install the {@link StrandsSpanKindFixer} on whichever TracerProvider
 * is currently registered with the global OTel API.
 *
 * OTel SDK 2.x removed the public `addSpanProcessor` method — providers
 * accept processors only at construction time. By the time our code
 * runs, ADOT auto-instrumentation has already constructed and
 * registered its provider, so we have to reach in and append our
 * processor to the provider's internal `MultiSpanProcessor._spanProcessors`
 * array. This is a documented escape hatch (see `BasicTracerProvider`
 * source) but technically a private field.
 *
 * The fixer is stateless and mutates the span object directly in `onStart`
 * (kind) and `onEnd` (legacy input/output attributes). Ordering against
 * any sibling BatchSpanProcessor is irrelevant: BSP only buffers a span
 * reference in its own `onEnd`, and the OTLP exporter reads
 * `span.attributes` / `span.events` at export time — by which point our
 * mutations are visible regardless of which processor ran first.
 */

import { trace } from '@opentelemetry/api';
import { logger } from '../logger/index.js';
import { StrandsSpanKindFixer } from './strands-span-kind-fixer.js';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * Shape of the OTel API's ProxyTracerProvider — exposes the underlying
 * SDK provider via `getDelegate()` once `setGlobalTracerProvider` has
 * been called.
 */
interface ProxyTracerProviderLike {
  getDelegate(): unknown;
}

/**
 * Shape of `BasicTracerProvider` / `NodeTracerProvider` from
 * `@opentelemetry/sdk-trace-base@>=2.0`. The `_activeSpanProcessor`
 * field is a `MultiSpanProcessor`.
 */
interface SdkTracerProviderLike {
  _activeSpanProcessor?: { _spanProcessors?: SpanProcessor[] };
}

function unwrapProvider(provider: unknown): SdkTracerProviderLike | undefined {
  if (!provider || typeof provider !== 'object') return undefined;
  const proxy = provider as ProxyTracerProviderLike;
  if (typeof proxy.getDelegate === 'function') {
    const delegate = proxy.getDelegate();
    return (delegate as SdkTracerProviderLike) || undefined;
  }
  return provider as SdkTracerProviderLike;
}

export function installStrandsSpanKindFixer(): void {
  const provider = unwrapProvider(trace.getTracerProvider());
  const processors = provider?._activeSpanProcessor?._spanProcessors;
  if (!Array.isArray(processors)) {
    logger.warn(
      'Could not install StrandsSpanKindFixer: unexpected TracerProvider shape. ' +
        'Trace-level token metrics may report 0 in AgentCore Observability.'
    );
    return;
  }
  processors.push(new StrandsSpanKindFixer());
  logger.info(
    { processorCount: processors.length },
    'StrandsSpanKindFixer installed on the active TracerProvider'
  );
}
