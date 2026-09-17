export interface SystemPromptInput {
  safetyRules: readonly string[];
  workspaceContext: readonly string[];
  enabledToolContracts: readonly string[];
  userInstructions: string;
}

export function composeSystemPrompt(input: SystemPromptInput): string {
  const section = (title: string, values: readonly string[]): string => `${title}\n${values.join("\n")}`;
  return [
    section("PLATFORM SAFETY RULES", input.safetyRules),
    section("WORKSPACE CONTEXT", input.workspaceContext),
    section("ENABLED TOOL CONTRACTS", input.enabledToolContracts),
    "USER INSTRUCTIONS",
    input.userInstructions,
    "PLATFORM SAFETY REMINDER",
    input.safetyRules.join("\n")
  ].join("\n\n");
}
