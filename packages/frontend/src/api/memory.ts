/**
 * Memory API Client
 * Client for calling the Backend Memory API
 */

import { backendClient } from './client/backend-client';

/**
 * Type definition for memory record
 */
export interface MemoryRecord {
  recordId: string;
  namespace: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Type definition for memory record list
 */
export interface MemoryRecordList {
  records: MemoryRecord[];
  nextToken?: string;
}

/**
 * Type definition for semantic search request
 */
export interface SearchMemoryRequest {
  query: string;
  topK?: number;
  relevanceScore?: number;
}

/**
 * Type definition for semantic search response
 */
interface SearchMemoryResponse {
  records: MemoryRecord[];
}

/**
 * Fetch memory record list
 * @param nextToken Pagination token for fetching the next page
 * @returns Memory record list
 */
export async function fetchMemoryRecords(nextToken?: string): Promise<MemoryRecordList> {
  const params = nextToken ? `?nextToken=${encodeURIComponent(nextToken)}` : '';
  return backendClient.get<MemoryRecordList>(`/memory/records${params}`);
}

/**
 * Semantic search for memory records
 * @param searchRequest Search request
 * @returns Search results
 */
export async function searchMemoryRecords(
  searchRequest: SearchMemoryRequest
): Promise<MemoryRecord[]> {
  const data = await backendClient.post<SearchMemoryResponse>('/memory/search', searchRequest);
  return data.records;
}
