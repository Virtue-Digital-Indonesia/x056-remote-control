import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DOCUMENT_CONVERTER = 'rc-documents-1-libreoffice-7.4.7-deb12u14-poppler-22.12.0-deb12u3';
export const DOCUMENT_SKILL = fileURLToPath(new URL('../skills/rc-documents/', import.meta.url));
export function documentCommand(command: string, ...args: string[]): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const python = process.env.X056_DOCUMENT_PYTHON || (existsSync('/opt/rc-documents/bin/python') ? '/opt/rc-documents/bin/python' : 'python3');
    const child = spawn(python, [fileURLToPath(new URL('../skills/rc-documents/scripts/documents.py', import.meta.url)), command, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failed = false;
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { failed = true; kill(); reject(new Error('Document processing timed out')); }, 180_000);
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 4 * 1024 * 1024) { failed = true; kill(); reject(new Error('Document inspection output exceeds limit')); } });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) { let message = 'Document processing failed'; try { message = JSON.parse(stderr.trim()).error || message; } catch { if (/No module named/.test(stderr)) message = 'Document toolkit is unavailable; install the runtime document dependencies'; } reject(new Error(message)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid document processor response')); }
    });
  });
}
