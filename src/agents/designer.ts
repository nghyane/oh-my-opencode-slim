import { Prompts } from '../prompts/index';
import type { AgentDefinition } from './orchestrator';

export function createDesignerAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  let prompt = Prompts.designer;

  if (customPrompt) {
    prompt = customPrompt;
  } else if (customAppendPrompt) {
    prompt = `${Prompts.designer}\n\n${customAppendPrompt}`;
  }

  return {
    name: 'designer',
    description:
      'UI/UX design and implementation. Use for styling, responsive design, component architecture and visual polish.',
    config: {
      model,
      temperature: 0.7,
      prompt,
    },
  };
}
