/** Turn completion and conversation completion are different when descendants
 * or an automatic provider continuation are still running. Keep delivery/queue
 * events immediate, but wait for a stable idle observation before notifying. */
export class CompletionGate {
  private pending = new Map<string, { data: Record<string, unknown>; quietSince?: number; timer?: ReturnType<typeof setTimeout> }>();
  constructor(
    private readonly busy: (sessionId: string) => boolean,
    private readonly complete: (data: Record<string, unknown>) => void,
    private readonly quietMs = 2000,
  ) {}

  cancel(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pending.delete(sessionId);
  }
  touch(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (pending) pending.quietSince = undefined;
  }
  queue(sessionId: string, data: Record<string, unknown>): void {
    this.cancel(sessionId);
    const pending = { data } as { data: Record<string, unknown>; quietSince?: number; timer?: ReturnType<typeof setTimeout> };
    this.pending.set(sessionId, pending);
    const check = () => {
      if (this.pending.get(sessionId) !== pending) return;
      if (this.busy(sessionId)) pending.quietSince = undefined;
      else {
        pending.quietSince ??= Date.now();
        if (Date.now() - pending.quietSince >= this.quietMs) {
          this.pending.delete(sessionId);
          this.complete({ ...pending.data, completionPending: false });
          return;
        }
      }
      pending.timer = setTimeout(check, Math.min(500, this.quietMs));
      pending.timer.unref?.();
    };
    check();
  }
  close(): void { for (const id of this.pending.keys()) this.cancel(id); }
}
