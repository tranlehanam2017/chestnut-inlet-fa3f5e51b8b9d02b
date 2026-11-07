import type { LifeRecord } from "../types";

interface StoreEnvelope { version: 1; records: LifeRecord[]; savedAt: string }
type Listener = (records: readonly LifeRecord[]) => void;

function cloneRecord(record: LifeRecord): LifeRecord {
  return {
    ...record,
    dependsOn: Array.isArray(record.dependsOn) ? [...record.dependsOn] : record.dependsOn,
  };
}

export function normalizeDependencies(records: readonly LifeRecord[]): LifeRecord[] {
  const ids = new Set(records.map((record) => record.id));
  return records.map((record) => {
    if (!Array.isArray(record.dependsOn)) {
      return cloneRecord(record);
    }

    const seen = new Set<string>();
    const dependsOn = record.dependsOn.filter((dependency) => {
      if (dependency === record.id || !ids.has(dependency) || seen.has(dependency)) return false;
      seen.add(dependency);
      return true;
    });
    return { ...cloneRecord(record), dependsOn };
  });
}

export class RecordStore {
  private readonly listeners = new Set<Listener>();
  private records: LifeRecord[];

  constructor(private readonly key: string, initial: LifeRecord[]) {
    this.records = this.read(initial);
  }

  all(): readonly LifeRecord[] { return this.records.map(cloneRecord); }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.all());
    return () => this.listeners.delete(listener);
  }

  upsert(record: LifeRecord): void {
    this.records = normalizeDependencies([...this.records.filter((item) => item.id !== record.id), cloneRecord(record)]);
    this.commit();
  }

  remove(id: string): void {
    this.records = normalizeDependencies(
      this.records
        .filter((item) => item.id !== id)
        .map((item) => cloneRecord(item.dependsOn?.includes(id)
          ? { ...item, dependsOn: item.dependsOn!.filter((dep) => dep !== id) }
          : item)),
    );
    this.commit();
  }

  replace(records: LifeRecord[]): void {
    this.records = normalizeDependencies(records.map(cloneRecord));
    this.commit();
  }

  private read(fallback: LifeRecord[]): LifeRecord[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(this.key) ?? "null") as StoreEnvelope | null;
      if (parsed?.version === 1 && Array.isArray(parsed.records)) return normalizeDependencies(parsed.records.map(cloneRecord));
    } catch {
      try {
        localStorage.removeItem(this.key);
      } catch {
        // Storage can be unavailable; keep the in-memory fallback either way.
      }
    }
    return normalizeDependencies(fallback.map(cloneRecord));
  }

  private commit(): void {
    const envelope: StoreEnvelope = { version: 1, records: this.records.map(cloneRecord), savedAt: new Date().toISOString() };
    try {
      localStorage.setItem(this.key, JSON.stringify(envelope));
    } catch {
      // Storage can be unavailable or quota-limited; keep the update in memory either way.
    }
    for (const listener of this.listeners) listener(this.all());
  }
}
