/**
 * Prompt loader using Bun's fast file I/O
 *
 * Benefits:
 * - Hot reload: Change prompts without rebuilding
 * - Clean code: Separates logic from text content
 * - Bun optimized: Zero-copy file reading
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cache for loaded prompts
const promptCache = new Map<string, string>();

/**
 * Load a prompt file from the prompts directory
 * Uses Bun.file() for optimal performance
 */
export async function loadPrompt(path: string): Promise<string> {
  // Check cache first
  const cached = promptCache.get(path);
  if (cached) {
    return cached;
  }

  const fullPath = join(__dirname, path);
  const file = Bun.file(fullPath);

  if (!(await file.exists())) {
    throw new Error(`Prompt file not found: ${fullPath}`);
  }

  const content = await file.text();
  promptCache.set(path, content);
  return content;
}

/**
 * Load agent prompt synchronously (for initialization)
 * Falls back to cached version or throws if not loaded
 */
export function getPrompt(path: string): string {
  const cached = promptCache.get(path);
  if (cached) {
    return cached;
  }
  throw new Error(`Prompt not loaded: ${path}. Call loadPrompt() first.`);
}

/**
 * Preload all agent prompts at startup
 */
export async function preloadAgentPrompts(): Promise<void> {
  const agents = [
    'agents/orchestrator.md',
    'agents/explorer.md',
    'agents/librarian.md',
    'agents/oracle.md',
    'agents/fixer.md',
    'agents/designer.md',
  ];

  await Promise.all(agents.map((agent) => loadPrompt(agent)));
}

/**
 * Clear prompt cache (useful for hot reload in development)
 */
export function clearPromptCache(): void {
  promptCache.clear();
}

// Export cached prompt getters for convenience
export const Prompts = {
  get orchestrator() {
    return getPrompt('agents/orchestrator.md');
  },
  get explorer() {
    return getPrompt('agents/explorer.md');
  },
  get librarian() {
    return getPrompt('agents/librarian.md');
  },
  get oracle() {
    return getPrompt('agents/oracle.md');
  },
  get fixer() {
    return getPrompt('agents/fixer.md');
  },
  get designer() {
    return getPrompt('agents/designer.md');
  },
};
