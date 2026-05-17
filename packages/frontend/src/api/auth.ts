/**
 * Auth API
 * Endpoints for authentication information
 */

import { backendClient } from './client/backend-client';

/**
 * /me endpoint response type
 */
export interface MeResponse {
  authenticated: boolean;
  user: {
    id: string | null;
    username: string | null;
    email: string | null;
    groups: string[];
  };
  jwt: {
    tokenUse: string | null;
    issuer: string | null;
    audience: string | null;
    issuedAt: string | null;
    expiresAt: string | null;
    clientId: string | null;
    authTime: string | null;
  };
  request: {
    id: string;
    timestamp: string;
    ip: string;
    userAgent: string;
  };
}

/**
 * Get current authenticated user info from backend /me endpoint
 */
export async function getMe(): Promise<MeResponse> {
  return backendClient.get<MeResponse>('/me');
}
