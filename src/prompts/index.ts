/**
 * Agent prompts - loaded at build time via Bun import assertions
 */
import designer from './agents/designer.md' with { type: 'text' };
import explorer from './agents/explorer.md' with { type: 'text' };
import fixer from './agents/fixer.md' with { type: 'text' };
import librarian from './agents/librarian.md' with { type: 'text' };
import oracle from './agents/oracle.md' with { type: 'text' };
import orchestrator from './agents/orchestrator.md' with { type: 'text' };

export const Prompts = {
  designer,
  explorer,
  fixer,
  librarian,
  oracle,
  orchestrator,
} as const;
