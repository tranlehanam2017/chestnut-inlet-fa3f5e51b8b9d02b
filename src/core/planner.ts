import type { LifeRecord, PlanEntry, PlanSummary, ThemeConfig } from "../types";

const DAY_MS = 86_400_000;

export function localDay(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.POSITIVE_INFINITY;
  return Math.round((end - start) / DAY_MS);
}

export function validateRecord(input: Partial<LifeRecord>, theme: ThemeConfig): string[] {
  const errors: string[] = [];
  if (!input.title?.trim()) errors.push(`${theme.itemLabel} needs a title.`);
  if (!input.category || !theme.categories.includes(input.category)) errors.push("Choose a valid category.");
  if (!input.dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) errors.push("Choose a valid date.");
  if (!Number.isFinite(input.effort) || Number(input.effort) < 1 || Number(input.effort) > 480) {
    errors.push(`${theme.effortLabel} must be between 1 and 480.`);
  }
  if (!Number.isInteger(input.impact) || Number(input.impact) < 1 || Number(input.impact) > 5) {
    errors.push(`${theme.impactLabel} must be an integer from 1 to 5.`);
  }
  return errors;
}

function hasCycle(id: string, allItems: Map<string, LifeRecord>, visited = new Set<string>(), stack = new Set<string>()): boolean {
  visited.add(id);
  stack.add(id);

  const item = allItems.get(id);
  if (item && item.dependsOn) {
    for (const depId of item.dependsOn) {
      if (!visited.has(depId)) {
        if (hasCycle(depId, allItems, visited, stack)) return true;
      } else if (stack.has(depId)) {
        return true;
      }
    }
  }

  stack.delete(id);
  return false;
}

export function priorityFor(item: LifeRecord, today = localDay(), allItems = itemsToMap(item)): PlanEntry {
  const daysUntilDue = daysBetween(today, item.dueDate);
  const reasons: string[] = [];
  let score = item.impact * 12;
  
  if (daysUntilDue < 0) {
    score += 55 + Math.min(Math.abs(daysUntilDue), 14) * 3;
    reasons.push(`${Math.abs(daysUntilDue)} day(s) overdue`);
  } else if (daysUntilDue === 0) {
    score += 45;
    reasons.push("due today");
  } else if (daysUntilDue <= 7) {
    score += 36 - daysUntilDue * 4;
    reasons.push(`due in ${daysUntilDue} day(s)`);
  }

  const effortPenalty = Math.min(item.effort / 20, 12);
  score -= effortPenalty;

  if (item.status === "active") {
    score += 8;
    reasons.push("already in progress");
  }

  if (item.status === "done") score = -1;

  const isBlocked = item.dependsOn?.some(depId => {
    const dep = allItems.get(depId);
    return dep && dep.status !== "done";
  }) ?? false;

  const isCircular = hasCycle(item.id, allItems);

  if (isCircular) {
    score -= 200;
    reasons.push("circular dependency detected");
  } else if (isBlocked) {
    score -= 100;
    reasons.push("blocked by dependency");
  }

  if (reasons.length === 0) reasons.push("ranked by impact and effort");
  return { item, score: Math.round(score * 10) / 10, reasons, daysUntilDue, isBlocked: isBlocked || isCircular };
}

function itemsToMap(items: any): Map<string, LifeRecord> {
  if (items instanceof Map) return items;
  if (Array.isArray(items)) return new Map(items.map(i => [i.id, i]));
  return new Map();
}

export function buildPlan(items: readonly LifeRecord[], today = localDay()): PlanEntry[] {
  const itemMap = itemsToMap(items);
  return items
    .map((item) => priorityFor(item, today, itemMap))
    .filter((entry) => entry.item.status !== "done")
    .sort((a, b) => b.score - a.score || a.item.dueDate.localeCompare(b.item.dueDate));
}

export function summarize(items: readonly LifeRecord[], today = localDay()): PlanSummary {
  return items.reduce<PlanSummary>((summary, item) => {
    summary.total += 1;
    summary.effort += item.status === "done" ? 0 : item.effort;
    summary.completed += item.status === "done" ? 1 : 0;
    const days = daysBetween(today, item.dueDate);
    summary.overdue += item.status !== "done" && days < 0 ? 1 : 0;
    summary.dueSoon += item.status !== "done" && days >= 0 && days <= 7 ? 1 : 0;
    summary.byCategory[item.category] = (summary.byCategory[item.category] ?? 0) + 1;
    return summary;
  }, { total: 0, completed: 0, overdue: 0, dueSoon: 0, effort: 0, byCategory: {} });
}

export function suggestDailyLoad(items: readonly LifeRecord[], minutesPerDay: number, today = localDay()) {
  const capacity = Math.max(1, minutesPerDay);
  const days = Array.from({ length: 7 }, (_, offset) => ({
    date: new Date(Date.parse(`${today}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10),
    used: 0,
    entries: [] as PlanEntry[],
  }));
  
  const plan = buildPlan(items, today);
  
  for (const entry of plan) {
    if (entry.isBlocked) continue;
    
    // Prioritize filling days that are earliest but have remaining capacity
    // before spilling over to later days.
    const candidates = days.filter((day) => {
      const isFuture = day.date >= today;
      const hasRoom = day.used + entry.item.effort <= capacity * 1.2; // Allow slight overage
      return isFuture && hasRoom;
    });

    const target = candidates.length > 0 ? candidates[0] : days[0];
    if (!target) continue;
    
    target.entries.push(entry);
    target.used += entry.item.effort;
  }
  return days.map((day) => ({ ...day, overloaded: day.used > capacity }));
}
