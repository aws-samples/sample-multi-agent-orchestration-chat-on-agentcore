import type { S3Client } from '@aws-sdk/client-s3';

/**
 * Pluggable logger interface.
 * Any logger that implements these four methods can be injected.
 */
export interface SyncLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Options for creating an S3WorkspaceSync instance.
 */
export interface S3WorkspaceSyncOptions {
  /** S3 bucket name (required) */
  bucket: string;
  /** S3 key prefix, e.g. "users/user123/workspace/" (required) */
  prefix: string;
  /** Local workspace directory path (required) */
  workspaceDir: string;
  /** AWS region (default: process.env.AWS_REGION || "us-east-1") */
  region?: string;
  /** Pre-configured S3Client instance (optional, overrides region) */
  s3Client?: S3Client;
  /** Download concurrency limit (default: 50) */
  downloadConcurrency?: number;
  /** Upload concurrency limit (default: 10) */
  uploadConcurrency?: number;
  /** Pluggable logger (default: console-based) */
  logger?: SyncLogger;
  /** Additional ignore patterns appended to built-in defaults */
  ignorePatterns?: string[];
  /** Custom content-type resolver (overrides built-in guesser) */
  contentTypeResolver?: (filename: string) => string;
}

/**
 * Metadata about a single file tracked by the sync engine.
 */
export interface FileInfo {
  path: string;
  size: number;
  mtime: number;
  hash: string;
}

/**
 * Result returned by pull() and push() operations.
 */
export interface SyncResult {
  success: boolean;
  downloadedFiles?: number;
  uploadedFiles?: number;
  deletedFiles?: number;
  errors?: string[];
  duration?: number;
}

/**
 * Progress event payload emitted during sync operations.
 */
export interface SyncProgress {
  phase: 'download' | 'upload' | 'cleanup';
  current: number;
  total: number;
  percentage: number;
  currentFile?: string;
}
