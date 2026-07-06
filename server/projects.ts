import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/** A workspace the panel can switch between; each remembers its own resumable session. */
export interface Project {
  id: string;
  name: string;
  cwd: string;
  lastSessionId?: string;
}

interface ProjectsFile {
  current: string | null;
  projects: Project[];
}

/**
 * Persistent list of projects (state/projects.json). The manager keeps the
 * single-turn run path unchanged and uses this only to remember, per project,
 * which session to resume and in which directory — selecting a project swaps
 * the active session pointer.
 */
export class ProjectRegistry {
  private constructor(private readonly file: string, private data: ProjectsFile) {}

  static load(file: string): ProjectRegistry {
    if (!existsSync(file)) return new ProjectRegistry(file, { current: null, projects: [] });
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as ProjectsFile;
      if (!Array.isArray(data.projects)) return new ProjectRegistry(file, { current: null, projects: [] });
      return new ProjectRegistry(file, data);
    } catch {
      return new ProjectRegistry(file, { current: null, projects: [] });
    }
  }

  list(): Project[] {
    return this.data.projects.map((p) => ({ ...p }));
  }

  currentId(): string | null {
    return this.data.current;
  }

  get(id: string): Project | undefined {
    const p = this.data.projects.find((x) => x.id === id);
    return p ? { ...p } : undefined;
  }

  current(): Project | undefined {
    return this.data.current ? this.get(this.data.current) : undefined;
  }

  create(name: string, cwd: string): Project {
    const proj: Project = { id: randomUUID(), name: name.trim() || 'Untitled', cwd };
    this.data.projects.push(proj);
    if (!this.data.current) this.data.current = proj.id;
    this.save();
    return { ...proj };
  }

  select(id: string): void {
    if (!this.data.projects.some((p) => p.id === id)) throw new Error(`unknown project ${id}`);
    this.data.current = id;
    this.save();
  }

  rename(id: string, name: string): void {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) throw new Error(`unknown project ${id}`);
    p.name = name.trim() || p.name;
    this.save();
  }

  remove(id: string): void {
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    if (this.data.current === id) this.data.current = this.data.projects[0]?.id ?? null;
    this.save();
  }

  /** Record the session a project should resume next time it's selected. */
  setLastSession(id: string, sessionId: string): void {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) return;
    p.lastSessionId = sessionId;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
