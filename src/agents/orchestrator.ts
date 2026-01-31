import type { AgentConfig } from '@opencode-ai/sdk';
import { Prompts } from '../prompts/index';

export interface AgentDefinition {
  name: string;
  description?: string;
  config: AgentConfig;
}

export function createOrchestratorAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  const prompt =
    customPrompt ??
    (customAppendPrompt
      ? `${Prompts.orchestrator}\n\n${customAppendPrompt}`
      : Prompts.orchestrator);

  return {
    name: 'orchestrator',
    description:
      'AI coding orchestrator that delegates tasks to specialist agents for optimal quality, speed, and cost',
    config: {
      model,
      temperature: 0.1,
      prompt,
    },
  };
}
