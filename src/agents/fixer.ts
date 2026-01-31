import { Prompts } from '../prompts/index.js';
import type { AgentDefinition } from './orchestrator.js';

export function createFixerAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  let prompt = Prompts.fixer;

  if (customPrompt) {
    prompt = customPrompt;
  } else if (customAppendPrompt) {
    prompt = `${Prompts.fixer}\n\n${customAppendPrompt}`;
  }

  return {
    name: 'fixer',
    description:
      'Fast implementation specialist. Receives complete context and task spec, executes code changes efficiently.',
    config: {
      model,
      temperature: 0.2,
      prompt,
    },
  };
}
