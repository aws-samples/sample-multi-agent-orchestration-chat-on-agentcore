import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * Calculate the SHA-256 hash of a file using streaming reads.
 *
 * @param filePath - Absolute path to the file
 * @returns Hex-encoded SHA-256 hash string
 */
export function calculateFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
