/**
 * CJS shim for uuid — avoids ESM import issues in Jest.
 * Uses crypto.randomUUID() which is available in Node 16+.
 */

import crypto from 'crypto';

export function v4(): string {
  return crypto.randomUUID();
}

export default { v4 };
