import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);

async function main(): Promise<void> {
  const scenarioPath = argv.includes('--resume')
    ? process.env.X056_FAKE_SCENARIO_RESUME
    : process.env.X056_FAKE_SCENARIO;
  if (!scenarioPath) {
    process.stderr.write('fake-claude: no scenario env set\n');
    process.exitCode = 2;
    return;
  }

  interface Directive {
    event?: Record<string, unknown>;
    delayMs?: number;
    exit?: number;
    hang?: boolean;
  }

  const directives: Directive[] = readFileSync(scenarioPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Directive);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const d of directives) {
    if (d.event) process.stdout.write(`${JSON.stringify(d.event)}\n`);
    if (d.delayMs) await sleep(d.delayMs);
    if (d.hang) await new Promise(() => {});
    if (d.exit !== undefined) {
      process.exitCode = d.exit;
      return;
    }
  }
  process.exitCode = 0;
}

await main();
