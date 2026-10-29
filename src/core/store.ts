/** Saved flight plans, kept in a key-value storage (localStorage in the app, a Map in tests). */
export interface KV {
  /** False for a temporary memory fallback. Omitted by persistent test/adaptor stores. */
  readonly durable?: boolean;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export interface PlanDoc<S = unknown> {
  id: string;
  name: string;
  polygon: [number, number][];
  home: [number, number] | null;
  settings: S;
  updatedAt: number;
}

interface Data<S> {
  current: string | null;
  plans: Record<string, PlanDoc<S>>;
}

export const STORE_KEY = 'dronecraft:plans:v1';

let seq = 0;
export function newId(now = Date.now()): string {
  seq = (seq + 1) % 1e6;
  return `${now.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class PlanStore<S> {
  private data: Data<S>;
  constructor(
    private kv: KV,
    private now: () => number = Date.now,
  ) {
    let d: Data<S> = { current: null, plans: {} };
    try {
      const raw = kv.getItem(STORE_KEY);
      if (raw) d = JSON.parse(raw);
    } catch {
      /* corrupt or unavailable: start empty */
    }
    this.data = d && d.plans ? d : { current: null, plans: {} };
    this.saved = kv.durable !== false;
  }

  /** True only after a durable write succeeds; memory-only sessions remain unsaved. */
  saved: boolean;

  private persist() {
    try {
      this.kv.setItem(STORE_KEY, JSON.stringify(this.data));
      this.saved = this.kv.durable !== false;
    } catch {
      // Keep working in memory, but let the app tell the user their changes are not stored.
      this.saved = false;
    }
  }

  list(): PlanDoc<S>[] {
    return Object.values(this.data.plans).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string): PlanDoc<S> | undefined {
    return this.data.plans[id];
  }
  currentId(): string | null {
    return this.data.current && this.data.plans[this.data.current] ? this.data.current : null;
  }
  current(): PlanDoc<S> | undefined {
    const id = this.currentId();
    return id ? this.data.plans[id] : undefined;
  }

  create(doc: Omit<PlanDoc<S>, 'id' | 'updatedAt'>, makeCurrent = true): PlanDoc<S> {
    const d: PlanDoc<S> = { ...structuredClone(doc), id: newId(this.now()), updatedAt: this.now() };
    this.data.plans[d.id] = d;
    if (makeCurrent) this.data.current = d.id;
    this.persist();
    return d;
  }

  /** Overwrite the stored copy of a plan. */
  save(doc: PlanDoc<S>) {
    this.data.plans[doc.id] = { ...structuredClone(doc), updatedAt: this.now() };
    this.persist();
  }

  open(id: string): PlanDoc<S> | undefined {
    if (!this.data.plans[id]) return undefined;
    this.data.current = id;
    this.persist();
    return this.data.plans[id];
  }

  duplicate(id: string): PlanDoc<S> | undefined {
    const src = this.data.plans[id];
    if (!src) return undefined;
    const { id: _id, updatedAt: _u, ...rest } = src;
    return this.create({ ...rest, name: uniqueName(`${src.name} copy`, this.list().map((p) => p.name)) });
  }

  /** Delete a plan. If it was current, the most recently updated remaining plan becomes current. */
  remove(id: string) {
    delete this.data.plans[id];
    if (this.data.current === id) this.data.current = this.list()[0]?.id ?? null;
    this.persist();
  }
}

export function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}
