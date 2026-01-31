import { Prompts } from '../prompts/index.js';
import type { AgentDefinition } from './orchestrator.js';

export function createExplorerAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  let prompt = Prompts.explorer;

  if (customPrompt) {
    prompt = customPrompt;
  } else if (customAppendPrompt) {
    prompt = `${Prompts.explorer}\n\n${customAppendPrompt}`;
  }

  return {
    name: 'explorer',
    description:
      "Fast codebase search and pattern matching. Use for finding files, locating code patterns, and answering 'where is X?' questions.",
    config: {
      model,
      temperature: 0.1,
      prompt,
    },
  };
}
