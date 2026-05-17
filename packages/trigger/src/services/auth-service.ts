/**
 * Authentication service for obtaining Machine User tokens
 * and per-user OpenID Tokens via Developer Authenticated Identities.
 */

import {
  CognitoIdentityClient,
  GetOpenIdTokenForDeveloperIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import { type IdentityId, parseIdentityId } from '@moca/core';
import { createLogger } from '../libs/logger/index.js';

const log = createLogger('AuthService');

/**
 * Configuration for Machine User authentication
 */
interface MachineUserConfig {
  cognitoDomain: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

/**
 * Machine User token response
 */
interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
}

/**
 * OAuth2 Token Response from Cognito
 */
interface OAuth2TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * OpenID Token response for a specific user
 */
export interface OpenIdTokenResponse {
  /** Short-lived OpenID Token (15 min) issued by GetOpenIdTokenForDeveloperIdentity */
  openIdToken: string;
  /** Identity Pool identityId resolved for this user */
  identityId: IdentityId;
}

/**
 * Service for obtaining Machine User authentication tokens
 * and per-user OpenID Tokens via Developer Authenticated Identities.
 */
export class AuthService {
  private readonly config: MachineUserConfig;

  constructor(config: MachineUserConfig) {
    this.config = config;
  }

  /**
   * Obtain Machine User token using OAuth2 Client Credentials flow
   */
  async getMachineUserToken(): Promise<TokenResponse> {
    const tokenUrl = `https://${this.config.cognitoDomain}/oauth2/token`;
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64'
    );

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      ...(this.config.scope && { scope: this.config.scope }),
    });

    try {
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },
        body: body.toString(),
      });

      if (!response.ok) {
        throw new Error(`Token request failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as OAuth2TokenResponse;

      return {
        accessToken: data.access_token,
        tokenType: data.token_type,
        expiresIn: data.expires_in,
      };
    } catch (error) {
      log.error({ err: error }, 'Failed to obtain Machine User token');
      throw new Error(
        'Authentication failed: ' + (error instanceof Error ? error.message : String(error)),
        { cause: error }
      );
    }
  }

  /**
   * Obtain a short-lived OpenID Token for a specific user via Developer Authenticated Identities.
   *
   * Calls GetOpenIdTokenForDeveloperIdentity without an explicit IdentityId.
   * Cognito resolves the correct Identity Pool identity (identityId A) from the developer
   * login link that was established by the Backend API on the user's first authenticated
   * request (see packages/backend/src/libs/auth/identity-resolver.ts:
   * linkDeveloperAuthToIdentity).
   *
   * The returned openIdToken is forwarded to the AgentCore Runtime via
   * X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token, where it is used by
   * scoped-credentials.ts to call GetCredentialsForIdentity and obtain per-user
   * S3/DynamoDB credentials.
   *
   * @param userId Cognito User Pool sub (UUID)
   * @returns openIdToken and resolved identityId
   */
  async getOpenIdTokenForUser(userId: string): Promise<OpenIdTokenResponse> {
    const identityPoolId = process.env.IDENTITY_POOL_ID;
    const developerProviderName = process.env.DEVELOPER_PROVIDER_NAME;
    const region = process.env.AWS_REGION || 'us-east-1';

    log.info(
      { userId, identityPoolId, developerProviderName, region },
      'getOpenIdTokenForUser called'
    );

    if (!identityPoolId || !developerProviderName) {
      throw new Error(
        'IDENTITY_POOL_ID and DEVELOPER_PROVIDER_NAME environment variables are required'
      );
    }

    // Call GetOpenIdTokenForDeveloperIdentity without IdentityId.
    // Cognito resolves identityId A from the developer login link established by
    // the Backend API's identity-resolver on each authenticated request (Frontend
    // hits /agents on app load, and Trigger creation goes through POST /triggers).
    const identityClient = new CognitoIdentityClient({ region });
    const command = new GetOpenIdTokenForDeveloperIdentityCommand({
      IdentityPoolId: identityPoolId,
      Logins: { [developerProviderName]: userId },
      // IdentityId omitted: Cognito resolves it from the developer login link.
      // TokenDuration omitted: use the default (15 minutes).
    });

    log.info(
      { IdentityPoolId: identityPoolId, developerProviderName, userId },
      'Calling GetOpenIdTokenForDeveloperIdentity'
    );

    try {
      const response = await identityClient.send(command);

      if (!response.Token || !response.IdentityId) {
        throw new Error('GetOpenIdTokenForDeveloperIdentity returned incomplete response');
      }

      log.info(
        { userId, developerIdentityId: response.IdentityId },
        'GetOpenIdTokenForDeveloperIdentity succeeded'
      );

      return {
        openIdToken: response.Token,
        identityId: parseIdentityId(response.IdentityId),
      };
    } catch (error) {
      log.error({ err: error, userId }, 'Failed to obtain OpenID Token for user');
      throw new Error(
        'Failed to obtain OpenID Token: ' +
          (error instanceof Error ? error.message : String(error)),
        { cause: error }
      );
    }
  }

  /**
   * Create AuthService from environment variables
   */
  static fromEnvironment(): AuthService {
    const cognitoDomain = process.env.COGNITO_DOMAIN;
    const clientId = process.env.COGNITO_CLIENT_ID;
    const clientSecret = process.env.COGNITO_CLIENT_SECRET;
    const scope = process.env.COGNITO_SCOPE;

    if (!cognitoDomain || !clientId || !clientSecret) {
      throw new Error('Missing required environment variables for Machine User authentication');
    }

    return new AuthService({
      cognitoDomain,
      clientId,
      clientSecret,
      scope,
    });
  }
}
