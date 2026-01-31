import { Prompts } from '../prompts/index.js';
import type { AgentDefinition } from './orchestrator.js';

export function createLibrarianAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  let prompt = Prompts.librarian;

  if (customPrompt) {
    prompt = customPrompt;
  } else if (customAppendPrompt) {
    prompt = `${Prompts.librarian}\n\n${customAppendPrompt}`;
  }

  return {
    name: 'librarian',
    description:
      'External documentation and library research. Use for official docs lookup, GitHub examples, and understanding library internals.',
    config: {
      model,
      temperature: 0.1,
      prompt,
    },
  };
}
