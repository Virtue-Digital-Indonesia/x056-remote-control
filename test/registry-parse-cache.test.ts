import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectRegistry } from '../server/projects.js';
import { ProjectSpaceRegistry } from '../server/project-space-registry.js';

// projects.json and project-spaces.json are read dozens of times per send.
// Both are cached by file identity; neither cache may hand out shared state.
afterEach(() => { vi.restoreAllMocks(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'registry-cache-')), file = join(dir, 'projects.json');
  const reg = ProjectRegistry.load(file);
  const a = reg.create('Alpha', dir), b = reg.create('Beta', dir);
  reg.addConversation(a.id, 's1', 'First');
  return { dir, file, a, b };
}

describe('ProjectRegistry parse cache', () => {
  it('parses an unchanged file once across many loads', () => {
    const { file } = setup();
    ProjectRegistry.load(file); // first load after the save parses its text
    const parse = vi.spyOn(JSON, 'parse');
    for (let i = 0; i < 20; i++) expect(ProjectRegistry.load(file).list()).toHaveLength(2);
    expect(parse).not.toHaveBeenCalled();
  });

  it('picks up an external write, including one of the same size', () => {
    const { file, a } = setup();
    expect(ProjectRegistry.load(file).get(a.id)!.name).toBe('Alpha');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.projects[0].name = 'Gamma';
    writeFileSync(file, JSON.stringify(data, null, 2));
    expect(ProjectRegistry.load(file).get(a.id)!.name).toBe('Gamma');
    // Same length, written in place: the mtime still tells them apart.
    data.projects[0].name = 'Delta';
    writeFileSync(file, JSON.stringify(data, null, 2));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(ProjectRegistry.load(file).get(a.id)!.name).toBe('Delta');
    // A broken file is still refused, not served from the cache.
    writeFileSync(file, '{"projects": 7}');
    expect(() => ProjectRegistry.load(file)).toThrow('Invalid project records');
  });

  it('sees a save through the registry on the next load', () => {
    const { file, a } = setup();
    const reg = ProjectRegistry.load(file);
    reg.rename(a.id, 'Renamed');
    reg.addConversation(a.id, 's2', 'Second');
    expect(ProjectRegistry.load(file).get(a.id)!.name).toBe('Renamed');
    expect(ProjectRegistry.load(file).conversations(a.id).map(c => c.sessionId)).toEqual(['s1', 's2']);
    expect(JSON.parse(readFileSync(file, 'utf8')).projects[0].name).toBe('Renamed');
  });

  it('never shares mutable state between loads', () => {
    const { file, a } = setup();
    const before = ProjectRegistry.load(file);
    // Callers' copies are their own.
    const listed = before.list(); listed[0].name = 'Mutated'; listed[0].conversations!.push({ sessionId: 'x', title: 'x', createdAt: 1 });
    const got = before.get(a.id)!; got.name = 'Mutated too';
    expect(ProjectRegistry.load(file).get(a.id)!.name).toBe('Alpha');
    expect(ProjectRegistry.load(file).conversations(a.id)).toHaveLength(1);
    // One registry's change does not leak into another loaded from the cache.
    const writer = ProjectRegistry.load(file), reader = ProjectRegistry.load(file);
    writer.rename(a.id, 'Changed');
    expect(reader.get(a.id)!.name).toBe('Alpha');
    expect(before.get(a.id)!.name).toBe('Alpha');
    // A registry loaded from the cache can still change, and again after a save.
    reader.rename(a.id, 'Reader');
    reader.setPrefs(a.id, { model: 'opus' });
    expect(ProjectRegistry.load(file).get(a.id)!.name).toBe('Reader');
    expect(ProjectRegistry.load(file).get(a.id)!.model).toBe('opus');
  });

  it('starts empty for a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-cache-'));
    expect(ProjectRegistry.load(join(dir, 'projects.json')).list()).toEqual([]);
  });
});

describe('ProjectSpaceRegistry validated-text cache', () => {
  function spaces() {
    const { dir, file } = setup();
    const registry = new ProjectSpaceRegistry(dir, () => ProjectRegistry.load(file).list());
    const space = registry.create({ requestId: 'space-create-001', name: 'One' });
    return { dir, registry, space, path: join(dir, 'project-spaces.json') };
  }
  it('hands every caller its own copy', () => {
    const { registry, space } = spaces();
    const snap = registry.snapshot(); snap.spaces[0].name = 'Mutated'; snap.spaces.push({ ...snap.spaces[0], id: 'space_other-0001' });
    expect(registry.snapshot().spaces.map(s => s.name)).toEqual(['One']);
    expect(registry.get(space.id).name).toBe('One');
    registry.get(space.id).name = 'Mutated again';
    expect(registry.list()[0].name).toBe('One');
  });
  it('sees its own saves and external writes, and still validates a changed file', () => {
    const { registry, path } = spaces();
    registry.create({ requestId: 'space-create-002', name: 'Two' });
    expect(registry.list().map(s => s.name)).toEqual(['One', 'Two']);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.spaces[0].name = 'Uno';
    writeFileSync(path, JSON.stringify(data));
    expect(registry.list().map(s => s.name)).toEqual(['Uno', 'Two']);
    data.spaces[0].id = 'not-a-space-id';
    writeFileSync(path, JSON.stringify(data));
    expect(() => registry.list()).toThrow('Invalid Space identity');
  });
});
