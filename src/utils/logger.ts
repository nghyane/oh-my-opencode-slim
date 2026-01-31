import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LOG_FILE = path.join(os.tmpdir(), 'oh-my-opencode-slim.log');

export function log(message: string, data?: unknown): void {
  try {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message} ${data ? JSON.stringify(data) : ''}\n`;
    fs.appendFileSync(LOG_FILE, logEntry);
  } catch {
    // Silently ignore logging errors
  }
}
