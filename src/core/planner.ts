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

export function findBlockingRoot(item: LifeRecord, allItems: Map<string, LifeRecord>): LifeRecord | null {
  if (!item.dependsOn || item.dependsOn.length === 0) return null;

  for (const depId of item.dependsOn) {
    const dep = allItems.get(depId);
    if (!dep || dep.status === "done") continue;
    
    const root = findBlockingRoot(dep, allItems);
    if (root) return root;
    return dep;
  }
  return null;
}

export function priorityFor(item: LifeRecord, today = localDay(), allItems = itemsToMap(item), criticalPathIds = new Set<string>(), blockingPower = 0, blockingDepth = 0): PlanEntry {
  const daysUntilDue = daysBetween(today, item.dueDate);
  const reasons: string[] = [];
  let score = item.impact * 12;
  
  if (daysUntilDue < 0) {
    const overdueBonus = 55 + Math.min(Math.abs(daysUntilDue), 14) * (item.impact >= 4 ? 5 : 3);
    score += overdueBonus;
    reasons.push(`${Math.abs(daysUntilDue)} day(s) overdue`);
  } else if (daysUntilDue === 0) {
    score += 45;
    reasons.push("due today");
  } else if (daysUntilDue <= 7) {
    score += 36 - daysUntilDue * 4;
    reasons.push(`due in ${daysUntilDue} day(s)`);
  } else {
    const decay = Math.min(daysUntilDue * 0.5, 15);
    score -= decay;
    reasons.push(`due in ${daysUntilDue} day(s)`);
  }

  const effortPenalty = Math.min(item.effort / 20, 12);
  score -= effortPenalty;

  if (item.status === "active") {
    score += 8;
    reasons.push("already in progress");
  }

  if (item.status === "done") score = -1;

  const blockers = item.dependsOn?.filter(depId => {
    const dep = allItems.get(depId);
    return dep && dep.status !== "done";
  }) ?? [];

  const isBlocked = blockers.length > 0;
  const isCircular = hasCycle(item.id, allItems);

  if (isCircular) {
    score -= 200;
    reasons.push("circular dependency detected");
  } else if (isBlocked) {
    score -= 100;
    if (blockers.length > 1) {
      reasons.push(`blocked by ${blockers.length} task(s)`);
    } else {
      const root = findBlockingRoot(item, allItems);
      reasons.push(root ? `blocked by "${root.title}"` : "blocked by dependency");
    }
  }

  if (criticalPathIds.has(item.id)) {
    score += 40;
    reasons.push("on critical path");
  }

  if (blockingPower > 0) {
    score += blockingPower * 15;
    reasons.push(`unblocks ${blockingPower} task(s)`);
  }

  if (blockingDepth > 1) {
    score += blockingDepth * 10;
    reasons.push(`unlocks chain of ${blockingDepth} tasks`);
  }

  if (daysUntilDue > 7 && blockingPower === 0 && blockingDepth === 0) {
    score -= 10;
    reasons.push("has high slack");
  } else if (daysUntilDue <= 3 && blockingPower > 0) {
    score += 5;
    reasons.push("tight window for blocker");
  }

  if (reasons.length === 0) reasons.push("ranked by impact and effort");

  const isCritical = (daysUntilDue <= 0 && item.impact >= 4) || (daysUntilDue < -3);

  return { item, score: Math.round(score * 10) / 10, reasons, daysUntilDue, isBlocked: isBlocked || isCircular, isCritical };
}

function itemsToMap(items: any): Map<string, LifeRecord> {
  if (items instanceof Map) return items;
  if (Array.isArray(items)) return new Map(items.map(i => [i.id, i]));
  return new Map();
}

export function buildPlan(items: readonly LifeRecord[], today = localDay()): PlanEntry[] {
  const itemMap = itemsToMap(items);
  
  const criticalPathIds = new Set<string>();
  const urgentItems = items.filter(i => i.status !== "done" && (daysBetween(today, i.dueDate) <= 0 || i.impact >= 4));
  
  const markCriticalTransitive = (id: string) => {
    if (criticalPathIds.has(id)) return;
    criticalPathIds.add(id);
    const item = itemMap.get(id);
    item?.dependsOn?.forEach(depId => markCriticalTransitive(depId));
  };

  for (const urgent of urgentItems) {
    markCriticalTransitive(urgent.id);
  }

  const blockingCounts = new Map<string, number>();
  for (const item of items) {
    if (item.status === "done") continue;
    const root = findBlockingRoot(item, itemMap);
    if (root) {
      blockingCounts.set(root.id, (blockingCounts.get(root.id) ?? 0) + 1);
    }
  }

  const depthCache = new Map<string, number>();
  const getDepth = (id: string): number => {
    if (depthCache.has(id)) return depthCache.get(id)!;
    
    let maxDepth = 0;
    for (const item of items) {
      if (item.status === "done") continue;
      if (item.dependsOn?.includes(id)) {
        maxDepth = Math.max(maxDepth, 1 + getDepth(item.id));
      }
    }
    depthCache.set(id, maxDepth);
    return maxDepth;
  };

  return items
    .map((item) => priorityFor(
      item, 
      today, 
      itemMap, 
      criticalPathIds, 
      blockingCounts.get(item.id) ?? 0, 
      getDepth(item.id)
    ))
    .filter((entry) => entry.item.status !== "done")
    .sort((a, b) => b.score - a.score || a.item.dueDate.localeCompare(b.item.dueDate));
}

export function findBottleneck(items: readonly LifeRecord[], today = localDay()): LifeRecord | null {
  const itemMap = itemsToMap(items);
  const plan = buildPlan(items, today);
  const bottleneckWeights = new Map<string, number>();

  for (const entry of plan) {
    if (entry.isBlocked) {
      const root = findBlockingRoot(entry.item, itemMap);
      if (root) {
        const weight = entry.isCritical ? 5 : 1;
        bottleneckWeights.set(root.id, (bottleneckWeights.get(root.id) ?? 0) + weight);
      }
    }
  }

  let maxWeight = 0;
  let bottleneckId: string | null = null;

  for (const [id, weight] of bottleneckWeights.entries()) {
    if (weight > maxWeight) {
      maxWeight = weight;
      bottleneckId = id;
    }
  }

  return bottleneckId ? itemMap.get(bottleneckId) || null : null;
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
  
  const urgent = plan.filter(e => e.daysUntilDue <= 2 || e.isCritical);
  const normal = plan.filter(e => e.daysUntilDue > 2 && !e.isCritical);

  const allocate = (entry: PlanEntry, strictCapacity: boolean) => {
    if (entry.isBlocked) return false;
    
    const candidates = days.filter((day) => {
      const isFuture = day.date >= today;
      const limit = strictCapacity ? capacity : capacity * 1.2;
      return isFuture && (day.used + entry.item.effort <= limit);
    });

    if (candidates.length === 0) return false;

    // Find the day with the most remaining capacity to distribute load evenly
    const target = candidates.reduce((prev, curr) => {
      return (capacity - curr.used) > (capacity - prev.used) ? curr : prev;
    });

    target.entries.push(entry);
    target.used += entry.item.effort;
    return true;
  };

  // Prioritize high-blocking-power urgent items first
  urgent.sort((a, b) => b.score - a.score).forEach(e => allocate(e, true));
  normal.sort((a, b) => b.score - a.score).forEach(e => allocate(e, false));

  return days.map((day) => ({
    ...day,
    overloaded: day.used > capacity,
    overage: Math.max(0, day.used - capacity),
  }));
}
