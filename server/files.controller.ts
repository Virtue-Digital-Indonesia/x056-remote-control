import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import busboy from 'busboy';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FileError, MAX_BATCH_BYTES, MAX_FILE_BYTES, type FileStore } from './file-store.js';
import { SessionManager } from './manager.js';

@Controller(['api/chats/:chatId/files', 'api/project-spaces/:chatId/files'])
export class FilesController {
  constructor(@Inject(SessionManager) private readonly manager: SessionManager) {}
  private async call<T>(work: () => T | Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { throw new HttpException((error as Error).message, error instanceof FileError ? error.status : 400); }
  }
  @Get()
  list(@Param('chatId') id: string, @Query('projectId') pid?: string, @Query('sessionId') sid?: string) {
    return this.call(() => {
      if (pid || sid) this.manager.fileExecution(id, pid!, sid!);
      return { files: this.manager.files().list(id), epoch: this.manager.files().epoch(id),
        ...(pid && sid ? { attempt: this.manager.files().attempt(pid, sid) } : {}) };
    });
  }

  @Post('copy') copy(@Param('chatId') id: string, @Body() body: { sourceOwnerId: string; fileId: string; versionId: string; operationId: string }) {
    return this.call(() => this.manager.files().addToProject(body.sourceOwnerId, body, id, body.operationId));
  }
  @Post('import-artifact') importArtifact(@Param('chatId') id: string, @Body() body: { executionId: string; sessionId: string; artifactId: string; operationId: string }) {
    return this.call(() => this.manager.files().importArtifact(id, body.executionId, body.sessionId, body.artifactId, body.operationId));
  }

  @Post('register')
  register(@Param('chatId') id: string, @Body() body: Parameters<FileStore['register']>[1]) {
    return this.call(() => this.manager.files().register(id, body));
  }

  @Post(':fileId/restore')
  restore(@Param('chatId') id: string, @Param('fileId') fileId: string, @Body() body: Parameters<FileStore['restore']>[2]) {
    return this.call(() => this.manager.files().restore(id, fileId, body));
  }

  @Post(':fileId')
  setRemoved(@Param('chatId') id: string, @Param('fileId') fileId: string, @Body() body: { removed: boolean }) {
    return this.call(() => this.manager.files().setRemoved(id, fileId, body.removed));
  }

  @Get(':fileId/versions/:versionId/preview')
  preview(@Param('chatId') id: string, @Param('fileId') fileId: string, @Param('versionId') versionId: string) {
    return this.call(() => this.manager.files().preview(id, { fileId, versionId }));
  }

  @Post(':fileId/versions/:versionId/preview')
  retryPreview(@Param('chatId') id: string, @Param('fileId') fileId: string, @Param('versionId') versionId: string) {
    return this.call(() => this.manager.files().preview(id, { fileId, versionId }, true));
  }

  @Get(':fileId/versions/:versionId/preview/:index')
  previewContent(@Param('chatId') id: string, @Param('fileId') fileId: string, @Param('versionId') versionId: string, @Param('index') index: string, @Res() res: Response) {
    return this.call(() => {
      const output = this.manager.files().previewOutput(id, { fileId, versionId }, Number(index));
      res.setHeader('Content-Type', output.mime);
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.sendFile(output.path, { cacheControl: false, dotfiles: 'allow' }, error => { if (error && !res.headersSent) res.status(404).end(); });
    });
  }

  @Post()
  upload(@Param('chatId') id: string, @Req() req: Request) {
    return this.call(async () => {
      const chat = this.manager.fileOwner(id);
      if (chat.archivedAt) throw new FileError('Restore this Chat before uploading', 409);
      const operationId = req.get('x-upload-id') ?? '';
      if (!/^[\w-]{8,128}$/.test(operationId)) throw new FileError('A stable x-upload-id is required');
      if (Number(req.get('content-length')) > MAX_BATCH_BYTES + 1024 * 1024) throw new FileError('Batch exceeds 200 MiB', 413);
      const store = this.manager.files(), dir = join(store.stagingDir, randomUUID());
      mkdirSync(dir, { recursive: true });
      const uploads: { path: string; name: string }[] = [], writes: Promise<void>[] = [];
      let error: Error | undefined, total = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          const parser = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { fileSize: MAX_FILE_BYTES + 1, files: 20, fields: 0, parts: 20 } });
          const aborted = () => parser.destroy(new FileError('Upload cancelled'));
          req.once('aborted', aborted);
          const count = (data: Buffer) => { total += data.length; if (total > MAX_BATCH_BYTES + 1024 * 1024) parser.destroy(new FileError('Batch exceeds 200 MiB', 413)); };
          req.on('data', count);
          parser.on('file', (_field, stream, info) => {
            const path = join(dir, randomUUID()); uploads.push({ path, name: info.filename });
            stream.on('limit', () => { error = new FileError('File exceeds 50 MiB', 413); });
            writes.push(pipeline(stream, createWriteStream(path, { flags: 'wx', mode: 0o600 })).catch(e => { error ??= e; }));
          });
          for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => { error = new FileError('Upload at most 20 files, without form fields'); });
          parser.once('error', reject);
          parser.once('close', () => { req.off('aborted', aborted); req.off('data', count); req.unpipe(parser); resolve(); });
          req.pipe(parser);
        });
        await Promise.all(writes);
        if (error) throw error;
        return { files: await store.upload(id, operationId, uploads) };
      } finally { await Promise.all(writes); rmSync(dir, { force: true, recursive: true }); }
    });
  }

  @Post(':fileId/checkout')
  checkout(@Param('chatId') id: string, @Param('fileId') fileId: string, @Body() body: { versionId: string; executionId?: string; sessionId?: string }) {
    return this.call(() => {
      if (this.manager.fileOwner(id).kind === 'chat') return this.manager.files().checkout(id, { fileId, versionId: body.versionId });
      if (!body.executionId || !body.sessionId) throw new FileError('Choose a Chat or Work conversation');
      return this.manager.files().checkoutShared(id, { fileId, versionId: body.versionId }, body.executionId, body.sessionId);
    });
  }

  @Post(':fileId/versions')
  commit(@Param('chatId') id: string, @Param('fileId') fileId: string, @Body() body: Parameters<FileStore['commit']>[2]) {
    return this.call(() => {
      if (this.manager.fileOwner(id).kind !== 'chat') {
        if (!body.executionId || !body.sessionId) throw new FileError('Choose the checkout’s Chat or Work conversation');
        this.manager.fileExecution(id, body.executionId, body.sessionId);
      }
      return this.manager.files().commit(id, fileId, body);
    });
  }

  @Get(':fileId/versions/:versionId/download')
  download(@Param('chatId') id: string, @Param('fileId') fileId: string, @Param('versionId') versionId: string, @Res() res: Response) {
    return this.serve(id, fileId, versionId, res, false);
  }

  @Get(':fileId/versions/:versionId/content')
  content(@Param('chatId') id: string, @Param('fileId') fileId: string, @Param('versionId') versionId: string, @Res() res: Response) {
    return this.serve(id, fileId, versionId, res, true);
  }

  private serve(id: string, fileId: string, versionId: string, res: Response, inline: boolean) {
    return this.call(() => {
      const { file, version, path } = this.manager.files().version(id, { fileId, versionId });
      const safe = ['image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain','text/markdown','text/csv','application/json'].includes(version.mime);
      const disposition = inline && safe ? 'inline' : 'attachment';
      res.setHeader('Content-Type', inline && version.mime.startsWith('text/') ? 'text/plain; charset=utf-8' : version.mime);
      res.setHeader('Content-Disposition', `${disposition}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('ETag', `"${version.hash}"`);
      // The service resolved an exact catalog blob; parent directories may be
      // hidden in isolated worktrees, while the filename is always a hash.
      res.sendFile(path, { dotfiles: 'allow', cacheControl: false }, error => { if (error && !res.headersSent) res.status(404).end(); });
    });
  }
}
