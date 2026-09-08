import { Ajv } from 'ajv';
import { expect } from 'vitest';
import { TOOLS } from '../../scripts/x056-mcp-tools.mjs';

export const ajv = new Ajv({ strict: true, allErrors: true });
export const validators = new Map(TOOLS.map(tool => [tool.name, ajv.compile(tool.outputSchema)]));
export function validateResult(name: string, result: any) {
  const validate = validators.get(name);
  if (!validate) return; // The transport also tests unknown tool errors.
  expect(result.structuredContent, name + ' must return an object').toBeTypeOf('object');
  const wire = JSON.parse(JSON.stringify(result.structuredContent));
  const valid = validate(wire);
  expect(valid, name + ': ' + ajv.errorsText(validate.errors)).toBe(true);
  if (result.isError) expect(result.content[0].text).toBe('error: ' + wire.error);
  return wire;
}
