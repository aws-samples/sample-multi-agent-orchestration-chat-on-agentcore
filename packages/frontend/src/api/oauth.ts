/**
 * OAuth API Client
 * Completes Gateway 3LO session binding (POST /oauth/complete).
 */

import { backendClient } from './client/backend-client';

export async function completeOAuthAuthorization(sessionUri: string): Promise<void> {
  await backendClient.post<{ completed: boolean }>('/oauth/complete', { sessionUri });
}
