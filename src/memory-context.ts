const START = '[Shared memory reference]\n';
const END = '\n[End shared memory reference]\n\nCurrent user message:\n';
export function withMemoryContext(prompt: string, context: string): string {
  return context && !prompt.trimStart().startsWith('/') ? START + context + END + prompt : prompt;
}
export function stripMemoryContext(text: string): string {
  if (!text.startsWith(START)) return text;
  const end = text.indexOf(END, START.length);
  return end < 0 ? text : text.slice(end + END.length);
}
