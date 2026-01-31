import { Prompts } from '../prompts/index';
import type { AgentDefinition } from './orchestrator';

export function createOracleAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  let prompt = Prompts.oracle;

  if (customPrompt) {
    prompt = customPrompt;
  } else if (customAppendPrompt) {
    prompt = `${Prompts.oracle}\n\n${customAppendPrompt}`;
  }

  return {
    name: 'oracle',
    description:
      'Strategic technical advisor. Use for architecture decisions, complex debugging, code review, and engineering guidance.',
    config: {
      model,
      temperature: 0.1,
      prompt,
    },
  };
}
