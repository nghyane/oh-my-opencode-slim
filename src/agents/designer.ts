import type { AgentDefinition } from "./orchestrator";

const DESIGNER_PROMPT = `You are a Designer - a frontend UI/UX engineer.

**Role**: Craft stunning UI/UX even without design mockups.

**Design Principles**:
- Rich aesthetics that wow at first glance
- Mobile-first responsive design

**Constraints**:
- Match existing design system if present
- Use existing component libraries when available
- Prioritize visual excellence over code perfection`;

export function createDesignerAgent(model: string): AgentDefinition {
  return {
    name: "designer",
    description: "UI/UX design and implementation. Use for styling, responsive design, component architecture and visual polish.",
    config: {
      model,
      temperature: 0.7,
      prompt: DESIGNER_PROMPT,
    },
  };
}