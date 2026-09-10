import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readState, writeState } from './workspace-store.js';
import { cleanMemorySource } from './memory-sources.js';
import type { Conversation, ProjectRegistry } from './projects.js';
import type { AccountRegistry, AccountRouteContext } from '../src/accounts.js';
import type { HistoryEntry, ProviderId } from '../src/provider.js';
import { generateTitle, type TitleGenerator } from './title-generator.js';

type Target = { projectId: string; sessionId: string };
export interface TitleSettings {
  enabled: boolean;
  models: Partial<Record<ProviderId, string>>;
}
export interface TitleJob extends Target {
  id: string;
  mode: 'automatic' | 'suggestion';
  status: 'waiting' | 'generating' | 'ready' | 'applied' | 'skipped' | 'failed' | 'stale' | 'undone';
  before: string;
  beforeOrigin?: Conversation['titleOrigin'];
  revision: number;
  title?: string;
  appliedRevision?: number;
  provider: ProviderId;
  account?: string;
  model?: string;
  context: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  notBefore: number;
  reason?: string;
}
interface TitleState {
  settings: TitleSettings;
  jobs: TitleJob[];
  lastAccounts?: Partial<Record<ProviderId, string>>;
}
interface Options {
  projects(): ProjectRegistry;
  accounts(): AccountRegistry;
  loads(): Record<string, number>;
  history(pid: string, sid: string): HistoryEntry[];
  routing(pid: string, sid: string): AccountRouteContext;
  priorityWork(provider: ProviderId): boolean;
  changed(pid: string): void;
  generate?: TitleGenerator;
  claudePath?: string;
}
export function temporaryTitle(prompt: string): string {
  const lines = cleanMemorySource(prompt)
    .split('\n')
    .map((x) => x.trim())
    .filter(
      (x) =>
        x &&
        !x.startsWith('[The user attached') &&
        !/^(?:hi|hello|hey|halo)(?:\s+[\p{L}-]+)?[!,. ]*$/iu.test(x),
    );
  for (const line of lines) {
    const title = line
      .replace(/^(?:hi|hello|hey|halo)(?:\s+[\p{L}-]+)?[,!:]\s*/iu, '')
      .replace(/^\s*(?:[-*#>]+|\d+[.)])\s+/, '')
      .replace(/^(?:can|could|would)\s+you\s+/iu, '')
      .replace(
        /^(?:please\s+|help\s+me\s+(?:to\s+)?|i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to\s+)/iu,
        '',
      )
      .replace(/\s+/g, ' ')
      .replace(/[.!?]+$/u, '')
      .trim();
    if (!title || /^(?:i\s+(?:want|need)|please)\s*:?$/iu.test(title)) continue;
    const concise = title.split(' ').slice(0, 9).join(' ');
    return Array.from(concise).slice(0, 60).join('');
  }
  return 'New conversation';
}
function meaningful(text: string): boolean {
  const clean = cleanMemorySource(text)
    .replace(/\[The user attached[^\]]*\]/g, '')
    .trim();
  if (
    /^(?:continue|resume|go ahead|build it|do it|yes|no|okay|ok|thanks|thank you|lgtm|what['’]?s next|hi|hello|hey|lanjut|lanjutkan|ya|oke|terima kasih)[.!?\s]*$/i.test(
      clean,
    )
  )
    return false;
  return clean.length >= 10 && (clean.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)?.length || 0) >= 2;
}

export class ConversationTitles {
  private file: string;
  private data: TitleState;
  private active?: { id: string; account: string; abort: AbortController };
  constructor(
    private stateDir: string,
    private opts: Options,
  ) {
    this.file = join(stateDir, 'conversation-titles.json');
    this.data = readState<TitleState>(this.file, { settings: { enabled: true, models: {} }, jobs: [] });
    this.data.settings = {
      enabled: this.data.settings?.enabled !== false,
      models: this.data.settings?.models || {},
    };
    for (const job of this.data.jobs)
      if (job.status === 'generating') {
        job.status = 'waiting';
        job.reason = 'Resuming after a server restart';
        job.notBefore = Date.now() + 5000;
      } else if (
        ['waiting', 'failed'].includes(job.status) &&
        job.reason === 'The naming request tried to use tools'
      ) {
        // Older workers mistook Claude's schema-return channel for workspace
        // tool activity. Retry those jobs once under the corrected classifier.
        job.status = 'waiting';
        job.attempts = 0;
        job.reason = 'Retrying with the updated title generator';
        job.notBefore = Date.now() + 5000;
      }
  }
  private save() {
    // Retain every pending job plus the latest 300 completed previews/undo records.
    const retained = this.data.jobs
      .filter((x) => !['waiting', 'generating'].includes(x.status))
      .slice(-300);
    const keep = new Set(retained.map((x) => x.id));
    this.data.jobs = this.data.jobs.filter(
      (x) => keep.has(x.id) || ['waiting', 'generating'].includes(x.status),
    );
    writeState(this.file, this.data);
  }
  settings() {
    return structuredClone(this.data.settings);
  }
  configure(patch: Partial<TitleSettings>) {
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')
      throw new Error('Invalid automatic naming setting');
    if (patch.models !== undefined) {
      if (!patch.models || typeof patch.models !== 'object' || Array.isArray(patch.models))
        throw new Error('Invalid models');
      for (const [provider, model] of Object.entries(patch.models)) {
        if (
          !['claude', 'codex'].includes(provider) ||
          typeof model !== 'string' ||
          model.length > 120 ||
          /[\s\x00-\x1f]/.test(model)
        )
          throw new Error('Invalid title model');
        if (model && /^(gpt-|codex-)/i.test(model) !== (provider === 'codex'))
          throw new Error('The model belongs to another provider');
      }
    }
    this.data.settings = {
      ...this.data.settings,
      ...patch,
      models: { ...this.data.settings.models, ...patch.models },
    };
    if (!this.data.settings.enabled) {
      for (const job of this.data.jobs)
        if (job.mode === 'automatic' && ['waiting', 'generating'].includes(job.status)) {
          job.status = 'skipped';
          job.reason = 'Automatic naming is off';
          if (this.active?.id === job.id) this.preempt();
        }
    }
    this.save();
    return this.settings();
  }
  private conversation(target: Target) {
    const project = this.opts.projects().get(target.projectId);
    const conversation = project?.conversations?.find((c) => c.sessionId === target.sessionId);
    if (!project || !conversation) throw new Error('Conversation not found');
    return { project, conversation };
  }
  private valid(job: TitleJob) {
    try {
      const c = this.conversation(job).conversation;
      return (
        c.title === job.before &&
        (c.titleRevision || 0) === job.revision &&
        (job.mode !== 'automatic' || c.titleOrigin === 'temporary')
      );
    } catch {
      return false;
    }
  }
  private enqueue(target: Target, mode: TitleJob['mode'], rows: HistoryEntry[]) {
    const { project, conversation: c } = this.conversation(target);
    const pending = this.data.jobs.find(
      (j) =>
        j.projectId === target.projectId &&
        j.sessionId === target.sessionId &&
        j.mode === mode &&
        j.revision === (c.titleRevision || 0) &&
        ['waiting', 'generating'].includes(j.status),
    );
    if (pending) return pending;
    if (this.data.jobs.filter((j) => ['waiting', 'generating'].includes(j.status)).length >= 100)
      throw new Error('The title queue is full. Wait for pending suggestions to finish.');
    const excerpts = rows
      .filter((x) => ['user', 'assistant'].includes(x.role))
      .map((x) => ({
        role: x.role,
        text: cleanMemorySource(x.text).slice(0, x.role === 'user' ? 2200 : 1500),
      }))
      .filter((x) => x.text);
    const selected =
      mode === 'automatic'
        ? excerpts.slice(0, 2)
        : [...excerpts.slice(0, 3), ...excerpts.slice(3).slice(-2)];
    const sufficient = selected.some((x) => x.role === 'user' && meaningful(x.text));
    const job: TitleJob = {
      ...target,
      id: randomUUID(),
      mode,
      status: sufficient ? 'waiting' : 'skipped',
      before: c.title,
      beforeOrigin: c.titleOrigin,
      revision: c.titleRevision || 0,
      provider: c.provider || 'claude',
      attempts: 0,
      context: JSON.stringify({ project: project.name.slice(0, 120), messages: selected }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      notBefore: Date.now() + 1500,
      ...(!sufficient
        ? { reason: 'More conversation context is needed to suggest a useful title' }
        : {}),
    };
    this.data.jobs.push(job);
    this.save();
    this.opts.changed(target.projectId);
    return job;
  }
  observe(projectId: string, sessionId: string, prompt: string, response: string) {
    if (!this.data.settings.enabled || !response.trim() || !meaningful(prompt)) return;
    const target = { projectId, sessionId },
      c = this.conversation(target).conversation;
    if (c.titleOrigin !== 'temporary') return;
    const previous = this.data.jobs.find(
      (j) =>
        j.projectId === projectId &&
        j.sessionId === sessionId &&
        j.mode === 'automatic' &&
        j.revision === (c.titleRevision || 0) &&
        j.status !== 'skipped',
    );
    if (!previous)
      this.enqueue(target, 'automatic', [
        { role: 'user', text: prompt },
        { role: 'assistant', text: response },
      ]);
  }
  suggest(items: Target[]) {
    if (!Array.isArray(items) || !items.length || items.length > 50)
      throw new Error('Select between 1 and 50 conversations');
    items.forEach((x) => this.conversation(x));
    return items.map((target) =>
      this.publicJob(
        this.enqueue(target, 'suggestion', this.opts.history(target.projectId, target.sessionId)),
      ),
    );
  }
  private publicJob(job: TitleJob) {
    const { context, ...publicData } = job;
    return structuredClone(publicData);
  }
  list(pid?: string, sid?: string) {
    return this.data.jobs
      .filter((j) => (!pid || j.projectId === pid) && (!sid || j.sessionId === sid))
      .reverse()
      .map((j) => this.publicJob(j));
  }
  get activeAccount() {
    return this.active && !this.active.abort.signal.aborted ? this.active.account : undefined;
  }
  preempt() {
    this.active?.abort.abort();
  }
  close() {
    this.preempt();
  }
  async tick() {
    if (this.active) return;
    const candidates = this.data.jobs
      .filter((j) => j.status === 'waiting' && j.notBefore <= Date.now())
      .sort(
        (a, b) =>
          Number(a.mode === 'automatic') - Number(b.mode === 'automatic') || a.createdAt - b.createdAt,
      );
    for (const job of candidates) {
      if (!this.valid(job)) {
        job.status = 'stale';
        job.reason = 'The conversation title changed';
        this.save();
        this.opts.changed(job.projectId);
        continue;
      }
      if (job.mode === 'automatic' && !this.data.settings.enabled) continue;
      if (this.opts.priorityWork(job.provider)) continue;
      const registry = this.opts.accounts(),
        model = this.data.settings.models[job.provider] || undefined;
      // Keep conversation account locks; metadata never spends quota reserves or consumes a next-account override.
      const context = { ...this.opts.routing(job.projectId, job.sessionId), useReserve: false, model };
      delete context.preferredAccount;
      const route = registry.explain(
        Math.floor(Date.now() / 1000),
        job.provider,
        this.opts.loads(),
        context,
      );
      let eligible = route.candidates.filter((x) => x.eligible && x.load === 0);
      if (route.strategy === 'round-robin' && !context.lockedAccount) {
        const last = eligible.findIndex((x) => x.name === this.data.lastAccounts?.[job.provider]);
        if (last >= 0) eligible = [...eligible.slice(last + 1), ...eligible.slice(0, last + 1)];
      }
      const choice = eligible[0];
      if (!choice) {
        if (job.reason !== 'Waiting for idle account capacity') {
          job.reason = 'Waiting for idle account capacity';
          this.save();
          this.opts.changed(job.projectId);
        }
        continue;
      }
      const abort = new AbortController();
      (this.data.lastAccounts ??= {})[job.provider] = choice.name;
      this.active = { id: job.id, account: choice.name, abort };
      job.status = 'generating';
      job.account = choice.name;
      job.model = model;
      job.reason = undefined;
      job.attempts++;
      job.updatedAt = Date.now();
      this.save();
      this.opts.changed(job.projectId);
      try {
        const title = await (this.opts.generate || generateTitle)({
          account: registry.get(choice.name),
          registry,
          provider: job.provider,
          model,
          prompt: job.context,
          stateDir: this.stateDir,
          signal: abort.signal,
          claudePath: this.opts.claudePath,
        });
        if (abort.signal.aborted) throw new Error('Title generation paused');
        if (job.status !== 'generating') return;
        if (!this.valid(job)) {
          job.status = 'stale';
          job.reason = 'The conversation title changed';
        } else if (!title) {
          job.status = 'skipped';
          job.reason = 'More context is needed for a useful title';
        } else {
          job.title = title;
          job.status = 'ready';
          if (job.mode === 'automatic') this.apply([job.id]);
        }
      } catch (error) {
        if (job.status === 'generating') {
          if (abort.signal.aborted) {
            job.attempts--;
            job.status = 'waiting';
            job.reason = 'Paused for conversation work';
          } else {
            job.status = job.attempts >= 3 ? 'failed' : 'waiting';
            job.reason = (error as Error).message.slice(0, 250);
          }
          job.notBefore =
            Date.now() + (abort.signal.aborted ? 10000 : Math.min(300000, 30000 * job.attempts));
        }
      } finally {
        this.active = undefined;
        job.updatedAt = Date.now();
        this.save();
        this.opts.changed(job.projectId);
      }
      return;
    }
  }
  private ids(ids: string[]) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some((x) => typeof x !== 'string'))
      throw new Error('Select between 1 and 50 suggestions');
    return [...new Set(ids)].map((id) => {
      const j = this.data.jobs.find((x) => x.id === id);
      if (!j) throw new Error('Suggestion not found');
      return j;
    });
  }
  apply(ids: string[]) {
    const jobs = this.ids(ids),
      applied: string[] = [],
      skipped: { id: string; reason: string }[] = [];
    for (const job of jobs) {
      if (job.status === 'applied') {
        applied.push(job.id);
        continue;
      }
      try {
        if (job.status !== 'ready' || !job.title) throw new Error('This suggestion is not ready');
        const c = this.opts
          .projects()
          .applyTitle(
            job.projectId,
            job.sessionId,
            job.title,
            { title: job.before, revision: job.revision },
            'generated',
          );
        job.status = 'applied';
        job.appliedRevision = c.titleRevision;
        job.updatedAt = Date.now();
        applied.push(job.id);
      } catch (error) {
        skipped.push({ id: job.id, reason: (error as Error).message });
        if (!this.valid(job)) job.status = 'stale';
      }
      this.opts.changed(job.projectId);
    }
    this.save();
    return { applied, skipped };
  }
  undo(ids: string[]) {
    const undone: string[] = [],
      skipped: { id: string; reason: string }[] = [];
    for (const job of this.ids(ids)) {
      if (job.status === 'undone') {
        undone.push(job.id);
        continue;
      }
      try {
        if (job.status !== 'applied' || !job.title || job.appliedRevision === undefined)
          throw new Error('This title was not applied');
        this.opts
          .projects()
          .applyTitle(
            job.projectId,
            job.sessionId,
            job.before,
            { title: job.title, revision: job.appliedRevision },
            job.beforeOrigin,
          );
        job.status = 'undone';
        job.updatedAt = Date.now();
        undone.push(job.id);
      } catch (error) {
        skipped.push({ id: job.id, reason: (error as Error).message });
      }
      this.opts.changed(job.projectId);
    }
    this.save();
    return { undone, skipped };
  }
  dismiss(ids: string[]) {
    for (const job of this.ids(ids)) {
      if (['applied', 'undone'].includes(job.status)) continue;
      job.status = 'skipped';
      job.reason = 'Dismissed';
      if (this.active?.id === job.id) this.preempt();
      this.opts.changed(job.projectId);
    }
    this.save();
    return { ok: true };
  }
}
