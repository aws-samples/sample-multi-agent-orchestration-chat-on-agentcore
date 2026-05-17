/**
 * Events API client
 * API for retrieving available event sources
 */

import { backendClient } from './client/backend-client';

/**
 * EventBridge event pattern structure
 */
export interface EventPattern {
  source: string[];
  detailType: string[];
  detail?: Record<string, unknown>;
}

export interface EventSource {
  id: string;
  name: string;
  description: string;
  icon?: string;
  eventPattern?: EventPattern;
}

export interface EventSourcesResponse {
  eventSources: EventSource[];
  metadata?: {
    requestId: string;
    timestamp: string;
    count: number;
  };
}

/**
 * Get available event sources
 */
export async function getEventSources(): Promise<EventSource[]> {
  const data = await backendClient.get<EventSourcesResponse>('/events');
  return data.eventSources;
}
