import type { LifeRecord, PlanEntry, PlanSummary, ThemeConfig } from "../types";

export interface DailyLoadEntry {
  item: LifeRecord;
  minutes: number;
}

export interface DayLoad {
  date: string;
  used: number;
  capacity: number;
  entries: DailyLoadEntry[];
  overloaded: boolean;
  completionDates: Map<string, string>;
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

function parseDay(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b) - parseDay(a)) / 86_400_000);
}

export function localDay(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function findCycleNodes(records: readonly LifeRecord[], itemMap: Map<string, LifeRecord>): Set<string> {
  const state = new Map<string, number>();
  const cycleNodes = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    state.set(id, 1);
    stack.push(id);
    const record = itemMap.get(id);
    const dependencies = Array.isArray(record?.dependsOn) ? record.dependsOn : [];
    for (const dependency of dependencies) {
      if (!itemMap.has(dependency)) continue;
      if (!state.has(dependency)) {
        visit(dependency);
      } else if (state.get(dependency) === 1) {
        const start = stack.indexOf(dependency);
        if (start >= 0) {
          for (let index = start; index < stack.length; index++) {
            cycleNodes.add(stack[index]);
          }
        }
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const record of records) {
    if (!state.has(record.id)) visit(record.id);
  }
  return cycleNodes;
}

function isBlocked(item: LifeRecord, itemMap: Map<string, LifeRecord>, cycleNodes: Set<string>): boolean {
  if (cycleNodes.has(item.id)) return true;
  const dependencies = Array.isArray(item.dependsOn) ? item.dependsOn : [];
  return dependencies.some((dependency) => {
    const dependencyItem = itemMap.get(dependency);
    return Boolean(dependencyItem && dependencyItem.status !== "done");
  });
}

export function findBlockingRoot(item: LifeRecord, itemMap: Map<string, LifeRecord>): LifeRecord | null {
  const visited = new Set<string>();
  let current: LifeRecord | undefined = item;

  while (current) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);

    const dependencies = Array.isArray(current.dependsOn) ? current.dependsOn : [];
    const blockerId = dependencies.find((dependency) => {
      const dependencyItem = itemMap.get(dependency);
      return Boolean(dependencyItem && dependencyItem.status !== "done");
    });
    if (!blockerId) return null;

    const blocker = itemMap.get(blockerId);
    if (!blocker) return null;

    const blockerDependencies = Array.isArray(blocker.dependsOn) ? blocker.dependsOn : [];
    const blockerHasUndoneDependency = blockerDependencies.some((dependency) => {
      const dependencyItem = itemMap.get(dependency);
      return Boolean(dependencyItem && dependencyItem.status !== "done");
    });
    if (!blockerHasUndoneDependency) return blocker;
    current = blocker;
  }

  return null;
}

export function findBottleneck(records: readonly LifeRecord[], _today: string): LifeRecord | null {
  const active = records.filter((record) => record.status !== "done");
  if (active.length === 0) return null;

  const itemMap = new Map(active.map((record) => [record.id, record]));
  const cycleNodes = findCycleNodes(active, itemMap);
  const dependents = new Map(active.map((record) => [record.id, [] as string[]]));
  for (const record of active) {
    if (cycleNodes.has(record.id)) continue;
    const dependencies = Array.isArray(record.dependsOn) ? record.dependsOn : [];
    for (const dependency of dependencies) {
      if (dependency === record.id) continue;
      if (cycleNodes.has(dependency)) continue;
      if (dependents.has(dependency)) dependents.get(dependency)!.push(record.id);
    }
  }

  let best: LifeRecord | null = null;
  let bestCount = 0;
  for (const record of active) {
    if (cycleNodes.has(record.id)) continue;
    const seen = new Set<string>();
    const stack = [...(dependents.get(record.id) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === record.id || seen.has(id) || cycleNodes.has(id)) continue;
      seen.add(id);
      for (const child of dependents.get(id) ?? []) {
        if (child !== record.id && !seen.has(child) && !cycleNodes.has(child)) stack.push(child);
      }
    }
    if (seen.size > bestCount || (seen.size === bestCount && best !== null && record.id.localeCompare(best.id) < 0)) {
      bestCount = seen.size;
      best = record;
    }
  }

  return best;
}

function countDirectDependents(id: string, records: readonly LifeRecord[], cycleNodes: Set<string> = new Set<string>()): number {
  return records.filter((record) =>
    record.status !== "done" &&
    record.id !== id &&
    !cycleNodes.has(record.id) &&
    Array.isArray(record.dependsOn) &&
    record.dependsOn.includes(id),
  ).length;
}

function slackFor(item: LifeRecord, daysUntilDue: number): number {
  const dailyCapacity = 480;
  const daysNeeded = Math.max(1, Math.ceil(item.effort / dailyCapacity));
  return daysUntilDue - daysNeeded;
}

export function suggestDailyLoad(
  records: readonly LifeRecord[],
  capacity: number,
  today: string,
  _plan?: readonly PlanEntry[],
): DayLoad[] {
  const active = records.filter((record) => record.status !== "done");
  const days: DayLoad[] = [];
  for (let index = 0; index < 7; index++) {
    days.push({
      date: addDays(today, index),
      used: 0,
      capacity,
      entries: [],
      overloaded: false,
      completionDates: new Map<string, string>(),
    });
  }
  const completionDates = new Map<string, string>();

  const sorted = [...active].sort((a, b) =>
    daysBetween(today, a.dueDate) - daysBetween(today, b.dueDate) || a.id.localeCompare(b.id),
  );

  for (const item of sorted) {
    const dueOffset = daysBetween(today, item.dueDate);
    const lastDayIndex = Math.min(6, Math.max(0, dueOffset));

    if (item.effort <= capacity) {
      let chosen = -1;
      for (let index = lastDayIndex; index >= 0; index--) {
        if (days[index].used + item.effort <= capacity) {
          chosen = index;
          break;
        }
      }
      if (chosen === -1) {
        let bestIndex = 0;
        let bestUsed = Number.POSITIVE_INFINITY;
        for (let index = 0; index <= lastDayIndex; index++) {
          if (days[index].used < bestUsed) {
            bestUsed = days[index].used;
            bestIndex = index;
          }
        }
        chosen = bestIndex;
      }
      days[chosen].entries.push({ item, minutes: item.effort });
      days[chosen].used += item.effort;
      completionDates.set(item.id, days[chosen].date);
    } else {
      let remaining = item.effort;
      let index = 0;
      while (remaining > 0 && index <= lastDayIndex) {
        const day = days[index];
        const available = capacity - day.used;
        if (available > 0) {
          const allocation = Math.min(remaining, available);
          day.entries.push({ item, minutes: allocation });
          day.used += allocation;
          remaining -= allocation;
          if (remaining <= 0) completionDates.set(item.id, day.date);
        }
        index++;
      }
      if (remaining > 0) {
        const day = days[lastDayIndex];
        day.entries.push({ item, minutes: remaining });
        day.used += remaining;
        completionDates.set(item.id, day.date);
      }
    }
  }

  for (const day of days) {
    day.completionDates = completionDates;
    day.overloaded = day.used > day.capacity || day.entries.some((entry) => entry.minutes > day.capacity);
  }

  return days;
}

function createEntry(
  item: LifeRecord,
  today: string,
  itemMap: Map<string, LifeRecord>,
  cycleNodes: Set<string>,
  completionDates: Map<string, string>,
): PlanEntry {
  const daysUntilDue = daysBetween(today, item.dueDate);
  const blocked = isBlocked(item, itemMap, cycleNodes);
  const circular = cycleNodes.has(item.id);
  const blockingCount = countDirectDependents(item.id, Array.from(itemMap.values()), cycleNodes);
  const slack = slackFor(item, daysUntilDue);
  const reasons: string[] = [];
  let score = 0;

  if (item.pinned) {
    score += 250;
    reasons.push("pinned");
  }

  if (daysUntilDue < 0) {
    const overdueDays = Math.abs(daysUntilDue);
    score += 100 + overdueDays * 5;
    reasons.push(`overdue by ${overdueDays} day${overdueDays === 1 ? "" : "s"}`);
  } else if (daysUntilDue === 0) {
    score += 90;
    reasons.push("due today");
  } else if (daysUntilDue <= 3) {
    score += 70 - daysUntilDue * 5;
    reasons.push(`due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}`);
  } else if (daysUntilDue <= 7) {
    score += 40 - daysUntilDue * 2;
    reasons.push(`due in ${daysUntilDue} days`);
  } else {
    score += Math.max(0, 20 - daysUntilDue);
    reasons.push(`due in ${daysUntilDue} days`);
  }

  score += item.impact * 8;
  score += Math.max(0, (120 - item.effort) / 10);
  if (item.status === "active") score += 10;

  if (circular) {
    score -= 60;
    reasons.push("circular dependency");
  } else if (blocked) {
    score -= 40;
    reasons.push("blocked");
  }

  if (blockingCount > 0) {
    score += blockingCount * 15;
    reasons.push(`unblocks ${blockingCount} task(s)`);
  }

  if (!blocked && item.impact >= 4 && slack <= 1) {
    score += 30;
    reasons.push("critical path urgency");
  }

  if (item.effort <= 30 && item.impact >= 4) {
    score += 25;
    reasons.push("quick win");
  }

  const isCritical = item.pinned || slack <= 0 || (item.impact >= 4 && slack <= 1);
  const criticality: PlanEntry["criticality"] = item.pinned || slack <= 0 ? "high" : slack <= 2 ? "medium" : "low";

  return {
    item,
    score,
    reasons,
    daysUntilDue,
    isBlocked: blocked,
    isCritical,
    criticality,
    slack,
    estimatedCompletionDate: completionDates.get(item.id),
  };
}

export function buildPlan(records: readonly LifeRecord[], today: string): PlanEntry[] {
  const active = records.filter((record) => record.status !== "done");
  const itemMap = new Map(active.map((record) => [record.id, record]));
  const cycleNodes = findCycleNodes(active, itemMap);
  const load = suggestDailyLoad(active, 480, today);
  const completionDates = load[0]?.completionDates ?? new Map<string, string>();

  const entries = active.map((item) => createEntry(item, today, itemMap, cycleNodes, completionDates));
  entries.sort((a, b) =>
    (b.item.pinned ? 1 : 0) - (a.item.pinned ? 1 : 0) ||
    b.score - a.score ||
    a.daysUntilDue - b.daysUntilDue ||
    a.item.id.localeCompare(b.item.id),
  );
  return entries;
}

export function priorityFor(
  item: LifeRecord,
  today: string,
  itemMap: Map<string, LifeRecord>,
): PlanEntry {
  const records = Array.from(itemMap.values()).filter((record) => record.id !== item.id);
  records.push(item);
  const active = records.filter((record) => record.status !== "done");
  const activeMap = new Map(active.map((record) => [record.id, record]));
  const cycleNodes = findCycleNodes(active, activeMap);
  const load = suggestDailyLoad(active, 480, today);
  const completionDates = load[0]?.completionDates ?? new Map<string, string>();
  return createEntry(item, today, activeMap, cycleNodes, completionDates);
}

export function summarize(records: readonly LifeRecord[], today: string): PlanSummary {
  const active = records.filter((record) => record.status !== "done");
  const byCategory: Record<string, number> = {};
  for (const record of active) {
    byCategory[record.category] = (byCategory[record.category] ?? 0) + record.effort;
  }

  return {
    total: records.length,
    completed: records.filter((record) => record.status === "done").length,
    overdue: active.filter((record) => daysBetween(today, record.dueDate) < 0).length,
    dueSoon: active.filter((record) => {
      const days = daysBetween(today, record.dueDate);
      return days >= 0 && days <= 7;
    }).length,
    effort: active.reduce((sum, record) => sum + record.effort, 0),
    byCategory,
  };
}

export function validateRecord(record: LifeRecord, theme: ThemeConfig): string[] {
  const errors: string[] = [];

  if (typeof record.id !== "string" || record.id.length < 1 || record.id.length > 120) {
    errors.push("Invalid id.");
  }
  if (typeof record.title !== "string" || record.title.trim().length < 1 || record.title.length > 100) {
    errors.push("Invalid title.");
  }
  if (typeof record.category !== "string" || !theme.categories.includes(record.category)) {
    errors.push("Unknown category.");
  }
  if (!isCalendarDay(record.dueDate)) errors.push("Invalid due date.");
  if (typeof record.effort !== "number" || !Number.isFinite(record.effort) || record.effort < 1 || record.effort > 480) {
    errors.push("Invalid effort.");
  }
  if (typeof record.impact !== "number" || !Number.isInteger(record.impact) || record.impact < 1 || record.impact > 5) {
    errors.push("Invalid impact.");
  }
  if (typeof record.status !== "string" || !["planned", "active", "done"].includes(record.status)) {
    errors.push("Invalid status.");
  }
  if (typeof record.notes !== "string" || record.notes.length > 600) {
    errors.push("Invalid notes.");
  }
  if (!isTimestamp(record.createdAt)) errors.push("Invalid creation timestamp.");
  if (!isTimestamp(record.updatedAt)) errors.push("Invalid update timestamp.");

  if (record.pinned !== undefined && typeof record.pinned !== "boolean") {
    errors.push("Invalid pinned flag.");
  }

  if (record.dependsOn !== undefined) {
    if (!Array.isArray(record.dependsOn)) {
      errors.push("Invalid dependencies.");
    } else {
      const seen = new Set<string>();
      for (const dependency of record.dependsOn) {
        if (typeof dependency !== "string" || dependency.length < 1 || dependency.length > 120) {
          errors.push("Invalid dependency.");
          continue;
        }
        if (dependency === record.id) errors.push("A task cannot depend on itself.");
        if (seen.has(dependency)) errors.push("Duplicate dependency.");
        seen.add(dependency);
      }
    }
  }

  return errors;
}