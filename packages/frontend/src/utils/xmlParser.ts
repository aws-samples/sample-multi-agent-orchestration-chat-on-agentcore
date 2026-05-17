/**
 * Helper functions for streaming XML parsing
 */

export interface ParsedAgentConfig {
  systemPrompt: string;
  enabledTools: string[];
  scenarios: Array<{
    title: string;
    prompt: string;
  }>;
}

export interface XmlParseState {
  currentTag: string | null;
  systemPrompt: string;
  enabledTools: string[];
  scenarios: Array<{
    title: string;
    prompt: string;
  }>;
  currentScenario: {
    title: string;
    prompt: string;
  };
  isInScenarioTitle: boolean;
  isInScenarioPrompt: boolean;
}

/**
 * Create initial state for the XML parser
 */
export const createInitialXmlState = (): XmlParseState => ({
  currentTag: null,
  systemPrompt: '',
  enabledTools: [],
  scenarios: [],
  currentScenario: {
    title: '',
    prompt: '',
  },
  isInScenarioTitle: false,
  isInScenarioPrompt: false,
});

/**
 * Incrementally parse streaming XML text
 * Returns content when a complete tag is closed
 */
export const parseStreamingXml = (
  xmlChunk: string,
  state: XmlParseState
): {
  state: XmlParseState;
  updates: {
    systemPrompt?: string;
    newTool?: string;
    newScenario?: {
      title: string;
      prompt: string;
    };
  };
} => {
  const updates: {
    systemPrompt?: string;
    newTool?: string;
    newScenario?: {
      title: string;
      prompt: string;
    };
  } = {};

  // Regular expression for processing tool tags
  const toolTagRegex = /<tool>(.*?)<\/tool>/g;

  const workingChunk = xmlChunk;

  // Process system_prompt
  const systemPromptMatch = workingChunk.match(/<system_prompt>([\s\S]*?)(?:<\/system_prompt>|$)/);
  if (systemPromptMatch) {
    const content = systemPromptMatch[1];
    if (content !== state.systemPrompt) {
      state.systemPrompt = content;
      updates.systemPrompt = content;
    }
  }

  // Process tool tags (complete tags only)
  let toolMatch;
  while ((toolMatch = toolTagRegex.exec(workingChunk)) !== null) {
    const toolName = toolMatch[1].trim();
    if (!state.enabledTools.includes(toolName)) {
      state.enabledTools.push(toolName);
      updates.newTool = toolName;
    }
  }

  // Process scenario tags
  const scenarioMatches = workingChunk.match(/<scenario>([\s\S]*?)<\/scenario>/g);
  if (scenarioMatches) {
    scenarioMatches.forEach((scenarioXml) => {
      const titleMatch = scenarioXml.match(/<title>(.*?)<\/title>/s);
      const promptMatch = scenarioXml.match(/<prompt>([\s\S]*?)<\/prompt>/s);

      if (titleMatch && promptMatch) {
        const title = titleMatch[1].trim();
        const prompt = promptMatch[1].trim();

        // Only add if a scenario with the same title does not already exist
        const existingScenario = state.scenarios.find((s) => s.title === title);
        if (!existingScenario) {
          const newScenario = { title, prompt };
          state.scenarios.push(newScenario);
          updates.newScenario = newScenario;
        }
      }
    });
  }

  return { state, updates };
};

/**
 * Returns the completed ParsedAgentConfig object
 */
export const getFinalConfig = (state: XmlParseState): ParsedAgentConfig => ({
  systemPrompt: state.systemPrompt,
  enabledTools: [...state.enabledTools],
  scenarios: [...state.scenarios],
});
