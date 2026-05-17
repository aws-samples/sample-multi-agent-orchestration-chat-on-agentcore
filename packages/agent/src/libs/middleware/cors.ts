/**
 * CORS configuration for AgentCore Runtime
 */

import { CorsOptions } from 'cors';
import { config } from '../../config/index.js';
import { logger } from '../logger/index.js';
/**
 * CORS configuration options
 */
export const corsOptions: CorsOptions = {
  // Allowed origins (set from environment variable, default allows all)
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allowed?: boolean) => void
  ) => {
    const allowedOrigins = config.CORS_ALLOWED_ORIGINS;

    // Allow localhost for local development
    const developmentOrigins = [
      'http://localhost:5173', // Vite dev server
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ];

    // Allow if no origin (requests from tools like Postman)
    if (!origin) {
      return callback(null, true);
    }

    // Allow if configured origin or development origin
    if (
      allowedOrigins.includes('*') ||
      allowedOrigins.includes(origin) ||
      developmentOrigins.includes(origin)
    ) {
      callback(null, true);
    } else {
      logger.warn({ origin }, 'CORS blocked origin:');
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id',
    'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token',
  ],
  credentials: true,
  maxAge: 86400, // Preflight cache 24 hours
};
