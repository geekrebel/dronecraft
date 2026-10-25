import { describe, expect, it } from 'vitest';
import { KV, PlanStore, STORE_KEY, uniqueName } from './store';

class MemKV implements KV {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

const doc = (name: string) => ({
  name,
  polygon: [
    [0, 0],
    [1, 0],
    [1, 1],
  ] as [number, number][],
  home: [0, -1] as [number, number],
  settings: { altitudeM: 80 },
});

function clock() {
  let t = 1000;
  return () => (t += 10);
}

describe('plan store', () => {
  it('creates plans, makes the new one current, and persists', () => {
    const kv = new MemKV();
    const s = new PlanStore(kv, clock());
    const a = s.create(doc('A'));
    const b = s.create(doc('B'));
    expect(s.currentId()).toBe(b.id);
    expect(s.list().map((p) => p.name)).toEqual(['B', 'A']);
    const reloaded = new PlanStore(kv);
    expect(reloaded.list().length).toBe(2);
    expect(reloaded.currentId()).toBe(b.id);
    expect(reloaded.get(a.id)?.name).toBe('A');
  });

  it('save updates the plan and moves it to the top', () => {
    const s = new PlanStore(new MemKV(), clock());
    const a = s.create(doc('A'));
    s.create(doc('B'));
    s.save({ ...a, name: 'A renamed' });
    expect(s.list()[0].name).toBe('A renamed');
  });

  it('stored copies are independent of the caller', () => {
    const s = new PlanStore(new MemKV(), clock());
    const d = doc('A');
    const a = s.create(d);
    d.polygon[0][0] = 99;
    expect(s.get(a.id)!.polygon[0][0]).toBe(0);
  });

  it('duplicate makes a uniquely named copy and opens it', () => {
    const s = new PlanStore(new MemKV(), clock());
    const a = s.create(doc('Site'));
    const c1 = s.duplicate(a.id)!;
    const c2 = s.duplicate(a.id)!;
    expect(c1.name).toBe('Site copy');
    expect(c2.name).toBe('Site copy 2');
    expect(s.currentId()).toBe(c2.id);
    expect(c1.polygon).toEqual(a.polygon);
  });

  it('removing the current plan falls back to the most recent one', () => {
    const s = new PlanStore(new MemKV(), clock());
    const a = s.create(doc('A'));
    const b = s.create(doc('B'));
    const c = s.create(doc('C'));
    s.open(a.id);
    s.remove(a.id);
    expect(s.currentId()).toBe(c.id);
    s.remove(c.id);
    s.remove(b.id);
    expect(s.currentId()).toBeNull();
    expect(s.list()).toEqual([]);
  });

  it('survives corrupt storage', () => {
    const kv = new MemKV();
    kv.setItem(STORE_KEY, '{not json');
    expect(new PlanStore(kv).list()).toEqual([]);
  });

  it('uniqueName', () => {
    expect(uniqueName('X', [])).toBe('X');
    expect(uniqueName('X', ['X', 'X 2'])).toBe('X 3');
  });
});
