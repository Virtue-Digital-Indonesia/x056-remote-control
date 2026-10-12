/** Claude CLI task_type values that are agents (the rest are shells or monitors). */
// A Workflow run is agents too; shells and monitors are the rest.
const AGENT_TASK_TYPES = new Set(['local_agent', 'remote_agent', 'in_process_teammate', 'local_workflow']);

/** Provider lifecycle evidence, separate from the pool's eviction grace period.
 * No transcript text is retained here. Foreign-thread messages never become
 * parent messages; only registered descendants contribute to activity. */
/** How long a finished background task may be followed by silence before
 *  the reply it should wake is taken as not coming. */
export const WAKE_WINDOW_MS = 3 * 60_000;

export class ProviderActivity {
  private parent = false;
  /** When a top-level background task finished between replies: the CLI
   *  wakes the model, which then thinks in silence (no partial messages)
   *  until its first message. null = no wake pending. */
  private wakeAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** A woken reply is expected and has not started yet (see wakeAt). */
  waking(): boolean { return this.wakeAt !== null && this.now() - this.wakeAt < WAKE_WINDOW_MS; }
  private agents = new Map<string, boolean>();
  /** Claude top-level tasks (task_started/task_progress/task_notification), by task_id. */
  private claudeTasks = new Map<string, { agent: boolean; running: boolean }>();
  private commands = new Map<string, string>();
  private earlyChildren = new Map<string, boolean>();

  start(): void { this.parent = true; }
  endTurn(): void { this.parent = false; }
  agentRunning(id: string): boolean | undefined {
    return this.agents.get(id) ?? this.claudeTasks.get(id)?.running;
  }
  stop(): void { this.parent = false; this.wakeAt = null; this.agents.clear(); this.claudeTasks.clear(); this.commands.clear(); }
  /** Running work by kind. `agents` = subagents (Claude agent-type tasks and Codex children);
   * `shells` = Claude background shells and any other top-level Claude task whose kind is not an agent. */
  counts(): { agents: number; shells: number; total: number } {
    let agents = [...this.agents.values()].filter(Boolean).length;
    let shells = 0;
    for (const t of this.claudeTasks.values()) {
      if (!t.running) continue;
      if (t.agent) agents++; else shells++;
    }
    return { agents, shells, total: agents + shells };
  }
  snapshot() {
    const { agents, shells } = this.counts();
    const tasks = this.commands.size;
    return { active: this.parent || this.waking() || agents > 0 || shells > 0 || tasks > 0, parentActive: this.parent, agents, tasks };
  }

  /** Top-level Claude task. Agent-type when task_type says so; otherwise a Task-tool subagent
   * (subagent_type set) is an agent, and anything else (local_bash, monitors, workflows, unknown) is a shell. */
  private claudeTask(m: any): void {
    const id: string = m.task_id;
    const prev = this.claudeTasks.get(id);
    if (m.subtype === 'task_notification') {
      if (!prev) return;
      prev.running = false;
      // Between replies, a finished task wakes the model; until its first
      // message nothing is written, and that silence must not read as idle.
      if (!this.parent) this.wakeAt = this.now();
      return;
    }
    // Nested: started inside a subagent. The CLI's task_started carries no
    // parent_tool_use_id; it marks nesting with owned_by_subagent,
    // parent_task_id and spawn_depth (read from CLI 2.1.295). Such a task's
    // notification may never reach this stream, so it is never tracked.
    if (m.subtype === 'task_started' && (m.owned_by_subagent === true || !!m.parent_task_id || (typeof m.spawn_depth === 'number' && m.spawn_depth > 1))) return;
    // Progress for a task we never saw start (a nested one) is not tracked either.
    if (!prev && m.subtype !== 'task_started') return;
    // task_progress carries no type; it keeps the kind task_started gave the task.
    if (m.subtype === 'task_started' || !prev) {
      const agent = typeof m.task_type === 'string' ? AGENT_TASK_TYPES.has(m.task_type)
        : typeof m.subagent_type === 'string' && m.subagent_type !== '';
      this.claudeTasks.set(id, { agent, running: true });
    } else prev.running = true;
    if (this.claudeTasks.size > 512) for (const [key, t] of this.claudeTasks) if (!t.running) { this.claudeTasks.delete(key); break; }
  }

  private agent(id: unknown, active: boolean): void {
    if (typeof id !== 'string' || !id) return;
    this.agents.set(id, this.earlyChildren.get(id) ?? active);
    this.earlyChildren.delete(id);
  }

  observe(provider: 'codex' | 'claude', line: string, owner?: unknown): void {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (provider === 'claude') {
      // Claude task lifecycle survives a parent `result`. A subagent's result
      // is not a result for the parent conversation.
      // Only top-level tasks count (see claudeTask for how nesting is marked);
      // a subagent's own stream events carry parent_tool_use_id.
      if (m.parent_tool_use_id) return;
      if (m.type === 'system' && typeof m.task_id === 'string' && ['task_started', 'task_progress', 'task_notification'].includes(m.subtype)) {
        this.claudeTask(m);
      }
      if (m.type === 'result') { this.parent = false; this.wakeAt = null; }
      else if (['assistant', 'stream_event', 'tool_progress'].includes(m.type)) { this.parent = true; this.wakeAt = null; }
      return;
    }
    const p = m.params;
    if (!p || typeof p !== 'object' || typeof owner !== 'string' || !owner) return;
    const thread = p.threadId ?? p.thread_id;
    const mine = thread === owner;
    const known = mine || this.agents.has(thread);
    const lifecycle = m.method === 'turn/started' ? true
      : m.method === 'turn/completed' ? false
      : m.method === 'thread/status/changed' && ['active', 'idle', 'notLoaded', 'systemError'].includes(p.status?.type)
        ? p.status.type === 'active' : undefined;
    if (lifecycle !== undefined) {
      if (mine) this.parent = lifecycle;
      else if (typeof thread === 'string') {
        if (known) this.agents.set(thread, lifecycle);
        else {
          // A fast child can finish before its spawn reply registers it.
          this.earlyChildren.set(thread, lifecycle);
          if (this.earlyChildren.size > 256) this.earlyChildren.delete(this.earlyChildren.keys().next().value!);
        }
      }
      if (!lifecycle && known) for (const [key, tid] of this.commands) if (tid === thread) this.commands.delete(key);
    }
    if (!known || !['item/started', 'item/completed'].includes(m.method)) return;
    const it = p.item;
    if (!it || typeof it !== 'object') return;
    if (it.type === 'collabAgentToolCall') {
      for (const [id, state] of Object.entries(it.agentsStates ?? {})) {
        const status = (state as any)?.status;
        if (typeof status === 'string') this.agent(id, ['running', 'pendingInit'].includes(status));
      }
      // Only spawn/followup starts work. Sending a message or listing agents
      // does not prove the recipient is running.
      if (m.method === 'item/completed' && it.status === 'completed' && ['spawnAgent', 'followupTask'].includes(it.tool)) {
        for (const id of it.receiverThreadIds ?? []) if (!(id in (it.agentsStates ?? {}))) this.agent(id, true);
      }
    }
    if (it.type === 'subAgentActivity') {
      if (it.kind === 'started') this.agent(it.agentThreadId, true);
      if (['completed', 'interrupted'].includes(it.kind)) this.agent(it.agentThreadId, false);
    }
    if (it.type === 'commandExecution' && typeof it.id === 'string') {
      const key = thread + ':' + it.id;
      if (m.method === 'item/started') this.commands.set(key, thread);
      else this.commands.delete(key);
    }
  }
}
