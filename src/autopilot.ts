export const AUTOPILOT_INSTRUCTION_HEADER = 'Standing instruction from the user:';
export const AUTOPILOT_INSTRUCTION_MARKER = '\n\n' + AUTOPILOT_INSTRUCTION_HEADER + '\n';
export const DEFAULT_AUTOPILOT_PROMPT = 'Continue working on the task, one concrete step at a time. Do the work directly and synchronously — never background it.';

export function normalizeAutopilotInstruction(instruction = ''): string {
  return instruction.trim().slice(0, 4000).trimEnd();
}

export function autopilotStopInstruction(stopPhrase: string): string {
  return 'When the entire task is fully complete, reply with exactly: ' + stopPhrase;
}

/** Preserve the base prompt and append the protocol and current user instruction. */
export function composeAutopilotPrompt(ap: { prompt: string; stopPhrase: string; instruction?: string }): string {
  const stop = autopilotStopInstruction(ap.stopPhrase);
  const base = ap.prompt.includes(stop) ? ap.prompt : ap.prompt + '\n\n' + stop;
  return base + (ap.instruction ? AUTOPILOT_INSTRUCTION_MARKER + ap.instruction : '');
}

/** Picker context excludes this repeated instruction, while history retains it. */
export function stripAutopilotInstruction(text: string): string {
  const index = text.indexOf(AUTOPILOT_INSTRUCTION_MARKER);
  return index < 0 ? text : text.slice(0, index);
}
