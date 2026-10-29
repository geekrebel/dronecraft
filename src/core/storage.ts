import type { KV } from './store';

/** A memory fallback keeps editing available, but must never claim the plan is saved. */
export function safeStorage(getStorage: () => Storage = () => localStorage): KV {
  try {
    const storage = getStorage();
    const key = '__dc_test__';
    storage.setItem(key, '1');
    storage.removeItem(key);
    return { durable: true, getItem: (k) => storage.getItem(k), setItem: (k, v) => storage.setItem(k, v) };
  } catch {
    const memory = new Map<string, string>();
    return { durable: false, getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v) };
  }
}
