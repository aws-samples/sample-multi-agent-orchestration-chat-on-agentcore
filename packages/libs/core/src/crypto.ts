/**
 * Cross-runtime Secure Random Bytes
 *
 * Cryptographic random utility that works in both Node.js 19+ and browsers.
 * Uses globalThis.crypto.getRandomValues() to eliminate runtime-specific branching.
 */

/**
 * Generate cryptographically secure random bytes.
 *
 * @param size - Number of bytes to generate
 * @returns Uint8Array containing random bytes
 */
export function getSecureRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}
