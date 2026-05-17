/**
 * Jest test setup file
 */

import { config } from 'dotenv';
import path from 'path';

// Load environment variables for testing
config({ path: path.resolve('.env') });

// Set test timeout to 30 seconds
jest.setTimeout(30000);
