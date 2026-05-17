/**
 * Backend API Client
 * HTTP client for Backend Service (VITE_BACKEND_URL)
 */

import { BaseApiClient, normalizeBaseUrl } from './base-client';

/**
 * Get Backend Service base URL
 */
function getBaseUrl(): string {
  return normalizeBaseUrl(import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000');
}

/**
 * Backend API Client
 * Extends BaseApiClient with JSON response parsing and REST helpers
 */
class BackendClient extends BaseApiClient {
  constructor() {
    super('Backend');
  }

  /**
   * Generic backend API request
   * @param endpoint - API endpoint (e.g., '/agents')
   * @param options - Fetch options
   * @returns Parsed JSON response
   */
  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await this.fetchWithAuth(`${getBaseUrl()}${endpoint}`, options);

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    return response.json();
  }

  /**
   * GET request
   */
  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' });
  }

  /**
   * POST request
   */
  async post<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * PUT request
   */
  async put<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * DELETE request
   */
  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }
}

// Singleton instance
const backendClient = new BackendClient();

// Export instance for direct usage
export { backendClient };
