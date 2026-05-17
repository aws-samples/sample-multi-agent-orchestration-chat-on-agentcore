/**
 * Health check and info endpoints for AgentCore Runtime
 */

import { Request, Response } from 'express';

/**
 * Health check endpoint
 * Endpoint to verify that AgentCore Runtime is operating normally
 */
export function handlePing(req: Request, res: Response): void {
  res.json({
    status: 'Healthy',
    time_of_last_update: Math.floor(Date.now() / 1000),
  });
}

/**
 * Root endpoint (for information display)
 */
export function handleRoot(req: Request, res: Response): void {
  res.json({
    service: 'AgentCore Runtime Agent',
    version: '0.1.0',
    endpoints: {
      health: 'GET /ping',
      invoke: 'POST /invocations',
    },
    status: 'running',
  });
}

/**
 * 404 handler
 */
export function handleNotFound(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Not Found',
    message: `Endpoint ${req.method} ${req.path} not found`,
    availableEndpoints: ['GET /', 'GET /ping', 'POST /invocations'],
  });
}
