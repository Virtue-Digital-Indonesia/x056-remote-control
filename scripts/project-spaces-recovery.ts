import { backupProjectSpaces, restoreProjectSpaces, projectSpacesRecoveryReport } from '../server/project-spaces-recovery.js';
const [command, source, output, confirmation] = process.argv.slice(2);
if (!source) throw new Error('Usage: node --import tsx scripts/project-spaces-recovery.ts report STATE | backup STATE NEW_DEST --offline | restore SNAPSHOT NEW_DEST');
if (command === 'report') console.log(JSON.stringify(projectSpacesRecoveryReport(source), null, 2));
else if (command === 'backup' && output) { const manifest = await backupProjectSpaces(source, output, confirmation === '--offline'); console.log(JSON.stringify({ saved: manifest.files.length, databases: manifest.databases, output })); }
else if (command === 'restore' && output) { const manifest = restoreProjectSpaces(source, output); console.log(JSON.stringify({ restored: manifest.files.length, output })); }
else throw new Error('Unknown recovery command or missing output');
