import type { LifeRecord } from "../types";

interface StoreEnvelope { version: 1; records: LifeRecord[]; savedAt: string }
type Listener = (records: readonly LifeRecord[]) => void;

function cloneRecord(record: LifeRecord): LifeRecord {
  return {
    ...record,
    dependsOn: Array.isArray(record.dependsOn) ? [...record.dependsOn] : record.dependsOn,
  };
}

function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const canonical = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return parsed.toISOString() === canonical;
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

export function isPersistedRecord(value: unknown): value is LifeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length < 1 || raw.id.length > 120) return false;
  if (typeof raw.title !== "string" || raw.title.trim().length < 1 || raw.title.length > 100) return false;
  if (typeof raw.category !== "string" || raw.category.trim().length < 1 || raw.category.length > 80) return false;
  if (!isCalendarDay(raw.dueDate)) return false;
  if (typeof raw.effort !== "number" || !Number.isFinite(raw.effort) || raw.effort < 1 || raw.effort > 480) return false;
  if (typeof raw.impact !== "number" || !Number.isInteger(raw.impact) || raw.impact < 1 || raw.impact > 5) return false;
  if (typeof raw.status !== "string" || !["planned", "active", "done"].includes(raw.status)) return false;
  if (typeof raw.notes !== "string" || raw.notes.length > 600) return false;
  if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) return false;

  if (raw.dependsOn !== undefined) {
    if (!Array.isArray(raw.dependsOn)) return false;
    for (const dependency of raw.dependsOn) {
      if (typeof dependency !== "string" || dependency.length < 1 || dependency.length > 120) {
        return false;
      }
    }
  }

  return true;
}

function isPersistedSnapshot(value: unknown): value is StoreEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return false;
  if (!Array.isArray(raw.records)) return false;
  if (!isTimestamp(raw.savedAt)) return false;
  return raw.records.every(isPersistedRecord);
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
      const stored = localStorage.getItem(this.key);
      if (stored === null) return normalizeDependencies(fallback.map(cloneRecord));

      const parsed = JSON.parse(stored) as unknown;
      if (!isPersistedSnapshot(parsed)) throw new Error("Invalid persisted snapshot.");
      return normalizeDependencies(parsed.records.map(cloneRecord));
    } catch {
      try {
        localStorage.removeItem(this.key);
      } catch {
        // Storage can be unavailable; keep the in-memory fallback either way.
      }
      return normalizeDependencies(fallback.map(cloneRecord));
    }
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