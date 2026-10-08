import { backupProjectSpaces, restoreProjectSpaces, projectSpacesRecoveryReport, type BackupScope } from '../server/project-spaces-recovery.js';
const [command, source, output, confirmation, ...flags] = process.argv.slice(2);
if (!source) throw new Error('Usage: node --import tsx scripts/project-spaces-recovery.ts report STATE | backup STATE NEW_DEST --offline [--scope=full|application-state] | restore SNAPSHOT NEW_DEST');
if (command === 'report') console.log(JSON.stringify(projectSpacesRecoveryReport(source), null, 2));
else if (command === 'backup' && output) {
  if (flags.length > 1 || flags.some(flag => flag !== '--scope=full' && flag !== '--scope=application-state')) throw new Error('Invalid backup scope or unknown backup option');
  const scope = (flags[0]?.slice('--scope='.length) ?? 'full') as BackupScope;
  const manifest = await backupProjectSpaces(source, output, confirmation === '--offline', { summaryOnly: true, scope });
  console.log(JSON.stringify({ ...manifest, output }));
}
else if (command === 'restore' && output) { const manifest = restoreProjectSpaces(source, output); console.log(JSON.stringify({ restored: manifest.files.length, scope: manifest.scope, excludedPathPatterns: manifest.excludedPathPatterns, output })); }
else throw new Error('Unknown recovery command or missing output');
