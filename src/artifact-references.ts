/** Only explicit local image paths, never a filesystem crawl or tool output dump. */
export function imagePaths(text: string): string[] {
  const paths = new Set<string>();
  for (const pattern of [
    /(?:["'`<])((?:sandbox:)?\/(?!\/)[^"'`<>\n]+?\.(?:png|jpe?g|webp|gif))(?=["'`>])/gi,
    /(?:^|[\s("'`=:])((?:sandbox:)?\/(?!\/)[^\s"'`<>()[\]{};|\\]+?\.(?:png|jpe?g|webp|gif))(?=$|[\s"'`>)\],;:}])/gi,
  ]) {
    for (const match of text.slice(0, 1_000_000).matchAll(pattern))
      paths.add(match[1].replace(/^sandbox:/, ''));
  }
  return [...paths].slice(0, 100);
}
export function toolImagePaths(event: Record<string, unknown>): string[] {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const payload = obj(event.payload),
    item = obj(event.item || payload.item),
    message = obj(event.message);
  const blocks = [
    event,
    payload,
    item,
    ...(Array.isArray(message.content) ? message.content.map(obj) : []),
  ];
  const result = new Set<string>();
  let visited = 0;
  const visit = (value: unknown, depth = 0): void => {
    if (++visited > 1000 || depth > 10 || result.size >= 100) return;
    if (typeof value === 'string') {
      const text = value.slice(0, 1_000_000);
      // Codex records arguments as JSON; parse the strings before scanning so
      // quoted paths (including spaces) retain their original boundaries.
      if (/^\s*[\[{]/.test(text)) {
        try {
          visit(JSON.parse(text), depth + 1);
          return;
        } catch {}
      }
      for (const path of imagePaths(text)) result.add(path);
      if (/^(?:sandbox:)?\/[^\n"'`]+\.(?:png|jpe?g|webp|gif)$/i.test(text))
        result.add(text.replace(/^sandbox:/, ''));
    } else if (Array.isArray(value)) {
      for (const child of value.slice(0, 100)) visit(child, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value).slice(0, 100)) visit(child, depth + 1);
    }
  };
  for (const b of blocks) {
    if (
      ![
        'tool_use',
        'function_call',
        'custom_tool_call',
        'command_execution',
        'CommandExecution',
        'mcp_tool_call',
        'mcpToolCall',
      ].includes(String(b.type))
    )
      continue;
    for (const value of [b.input, b.arguments, b.command]) {
      if (value === undefined) continue;
      visit(value);
    }
  }
  return [...result].slice(0, 100);
}
