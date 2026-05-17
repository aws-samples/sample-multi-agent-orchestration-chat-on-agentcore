/**
 * Triggers API Client
 */

import { backendClient } from './client/backend-client';
import type {
  Trigger,
  CreateTriggerRequest,
  UpdateTriggerRequest,
  ListTriggersResponse,
  ListExecutionsResponse,
  ExecutionRecord,
} from '../types/trigger';

export interface TriggerResponse {
  trigger: Trigger;
  metadata: {
    requestId: string;
    timestamp: string;
    userId: string;
  };
}

export interface TriggersListResponse {
  triggers: Trigger[];
  nextToken?: string;
  metadata: {
    requestId: string;
    timestamp: string;
    userId: string;
    count: number;
  };
}

export interface ExecutionsListResponse {
  executions: ExecutionRecord[];
  nextToken?: string;
  metadata: {
    requestId: string;
    timestamp: string;
    count: number;
  };
}

export interface MessageResponse {
  message: string;
  metadata: {
    requestId: string;
    timestamp: string;
  };
}

/**
 * Parse a date string defensively, returning the original value if invalid
 */
function parseDateSafe(value: string | undefined): string {
  if (!value) return '';
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toISOString();
  } catch {
    return value;
  }
}

/**
 * Parse trigger dates from API response
 */
function parseTriggerDates(trigger: Trigger): Trigger {
  return {
    ...trigger,
    createdAt: parseDateSafe(trigger.createdAt),
    updatedAt: parseDateSafe(trigger.updatedAt),
    lastExecutedAt: trigger.lastExecutedAt ? parseDateSafe(trigger.lastExecutedAt) : undefined,
  };
}

/**
 * Parse execution record dates (defensive: handles missing/invalid dates)
 */
function parseExecutionDates(execution: ExecutionRecord): ExecutionRecord {
  if (!execution.executedAt) {
    return execution;
  }
  try {
    const date = new Date(execution.executedAt);
    if (isNaN(date.getTime())) {
      return { ...execution, executedAt: '' };
    }
    return { ...execution, executedAt: date.toISOString() };
  } catch {
    return { ...execution, executedAt: '' };
  }
}

/**
 * Get list of user's triggers
 */
export async function listTriggers(
  type?: string,
  limit?: number,
  nextToken?: string
): Promise<ListTriggersResponse> {
  const params = new URLSearchParams();
  if (type) params.append('type', type);
  if (limit) params.append('limit', limit.toString());
  if (nextToken) params.append('nextToken', nextToken);

  const queryString = params.toString();
  const url = `/triggers${queryString ? `?${queryString}` : ''}`;

  const data = await backendClient.get<TriggersListResponse>(url);

  return {
    triggers: data.triggers.map(parseTriggerDates),
    nextToken: data.nextToken,
  };
}

/**
 * Get a specific trigger
 */
export async function getTrigger(triggerId: string): Promise<Trigger> {
  const data = await backendClient.get<TriggerResponse>(`/triggers/${triggerId}`);
  return parseTriggerDates(data.trigger);
}

/**
 * Create a new trigger
 */
export async function createTrigger(input: CreateTriggerRequest): Promise<Trigger> {
  const data = await backendClient.post<TriggerResponse>('/triggers', input);
  return parseTriggerDates(data.trigger);
}

/**
 * Update an existing trigger
 */
export async function updateTrigger(
  triggerId: string,
  input: UpdateTriggerRequest
): Promise<Trigger> {
  const data = await backendClient.put<TriggerResponse>(`/triggers/${triggerId}`, input);
  return parseTriggerDates(data.trigger);
}

/**
 * Delete a trigger
 */
export async function deleteTrigger(triggerId: string): Promise<void> {
  await backendClient.delete<void>(`/triggers/${triggerId}`);
}

/**
 * Enable a trigger
 */
export async function enableTrigger(triggerId: string): Promise<Trigger> {
  const data = await backendClient.post<TriggerResponse>(`/triggers/${triggerId}/enable`);
  return parseTriggerDates(data.trigger);
}

/**
 * Disable a trigger
 */
export async function disableTrigger(triggerId: string): Promise<Trigger> {
  const data = await backendClient.post<TriggerResponse>(`/triggers/${triggerId}/disable`);
  return parseTriggerDates(data.trigger);
}

/**
 * Get execution history for a trigger
 */
export async function getExecutionHistory(
  triggerId: string,
  limit?: number,
  nextToken?: string
): Promise<ListExecutionsResponse> {
  const params = new URLSearchParams();
  if (limit) params.append('limit', limit.toString());
  if (nextToken) params.append('nextToken', nextToken);

  const queryString = params.toString();
  const url = `/triggers/${triggerId}/executions${queryString ? `?${queryString}` : ''}`;

  const data = await backendClient.get<ExecutionsListResponse>(url);

  return {
    executions: data.executions.map(parseExecutionDates),
    nextToken: data.nextToken,
  };
}
