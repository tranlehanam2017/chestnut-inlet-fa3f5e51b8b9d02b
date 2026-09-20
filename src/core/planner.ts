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

export function priorityFor(item: LifeRecord, today = localDay(), allItems = itemsToMap(item), criticalPathIds = new Set<string>(), blockingPower = 0, blockingDepth = 0, slack = 0, downstreamEffort = 0, dependencyValue = 0): PlanEntry {
  const daysUntilDue = daysBetween(today, item.dueDate);
  const reasons: string[] = [];
  
  // Non-linear impact weighting: High impact (4, 5) tasks are significantly more critical
  const impactWeight = item.impact >= 4 ? item.impact * 15 : item.impact * 10;
  let score = impactWeight;
  
  // Domain boost: Prioritize Health to ensure wellbeing during trip prep
  if (item.category === "Health") {
    score += 10;
    reasons.push("wellness priority");
  }

  // Effort-adjusted urgency: High effort tasks are effectively due sooner
  const effortLeadDays = Math.floor(item.effort / 120); // Every 2 hours of work adds 1 'lead day' urgency
  const effectiveDaysUntilDue = daysUntilDue - effortLeadDays;

  if (daysUntilDue < 0) {
    // Refine: low impact overdue tasks don't climb as fast as high impact ones
    const overdueBonus = 55 + Math.min(Math.abs(daysUntilDue), 14) * (item.impact >= 4 ? 5 : 2);
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

  if (effortLeadDays > 0 && daysUntilDue > 0) {
    const leadBonus = effortLeadDays * 5;
    score += leadBonus;
    reasons.push(`substantial effort (${effortLeadDays}d lead)`);
  }

  // Quick Win bonus: High impact / Low effort ratio
  const efficiency = item.impact / (Math.max(1, item.effort) / 60);
  if (efficiency > 4 && item.impact >= 3) {
    score += 15;
    reasons.push("high efficiency (quick win)");
  }

  const effortPenalty = Math.min(item.effort / 20, 12);
  score -= effortPenalty;

  if (item.status === "active") {
    score += 8;
    reasons.push("already in progress");
  }

  // Staleness penalty
  const updatedDate = item.updatedAt.slice(0, 10);
  const daysSinceUpdate = daysBetween(updatedDate, today);
  if (daysSinceUpdate > 30) {
    const stalePenalty = Math.min((daysSinceUpdate - 30) * 0.2, 10);
    score -= stalePenalty;
    if (daysSinceUpdate > 60) reasons.push("stale record");
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
    // Critical path boost scales with the depth of the chain it unlocks
    const baseBoost = daysUntilDue <= 3 ? 60 : 40;
    const depthMultiplier = Math.min(blockingDepth * 2, 20);
    score += baseBoost + depthMultiplier;
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

  if (downstreamEffort > 0) {
    const effortBoost = Math.min(downstreamEffort / 30, 30);
    score += effortBoost;
    if (downstreamEffort >= 180) reasons.push(`unlocks substantial work (${Math.round(downstreamEffort/60)}h)`);
  }

  if (dependencyValue > 0) {
    const valueBoost = Math.min(dependencyValue * 5, 40);
    score += valueBoost;
    if (dependencyValue >= 10) reasons.push("unlocks high-value tasks");
  }

  if (daysUntilDue > 7 && blockingPower === 0 && blockingDepth === 0) {
    score -= 10;
    reasons.push("has high slack");
  } else if (daysUntilDue <= 3 && blockingPower > 0) {
    score += 5;
    reasons.push("tight window for blocker");
  }

  if (slack <= 0 && item.impact >= 4) {
    score *= 1.2;
    reasons.push("critical path urgency");
  }

  if (reasons.length === 0) reasons.push("ranked by impact and effort");

  const isCritical = (daysUntilDue <= 0 && item.impact >= 4) || (daysUntilDue < -3) || (effectiveDaysUntilDue <= 0 && item.impact >= 4) || (slack <= 0 && item.impact >= 4);

  return { item, score: Math.round(score * 10) / 10, reasons, daysUntilDue, isBlocked: isBlocked || isCircular, isCritical, slack };
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
  const downstreamEfforts = new Map<string, number>();
  const dependencyValues = new Map<string, number>();

  for (const item of items) {
    if (item.status === "done") continue;
    const root = findBlockingRoot(item, itemMap);
    if (root) {
      blockingCounts.set(root.id, (blockingCounts.get(root.id) ?? 0) + 1);
      downstreamEfforts.set(root.id, (downstreamEfforts.get(root.id) ?? 0) + item.effort);
      dependencyValues.set(root.id, (dependencyValues.get(root.id) ?? 0) + item.impact);
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

  const slackCache = new Map<string, number>();
  const calculateSlack = (id: string): number => {
    if (slackCache.has(id)) return slackCache.get(id)!;
    const item = itemMap.get(id);
    if (!item) return 0;
    const due = daysBetween(today, item.dueDate);
    const lead = Math.floor(item.effort / 120);
    let slack = due - lead;
    item.dependsOn?.forEach(depId => {
      const dep = itemMap.get(depId);
      if (dep && dep.status !== "done") {
        slack -= Math.floor(dep.effort / 120);
      }
    });
    const adjustedSlack = item.impact >= 4 ? slack - 1 : slack;
    slackCache.set(id, adjustedSlack);
    return adjustedSlack;
  };

  return items
    .map((item) => priorityFor(
      item, 
      today, 
      itemMap, 
      criticalPathIds, 
      blockingCounts.get(item.id) ?? 0, 
      getDepth(item.id),
      calculateSlack(item.id),
      downstreamEfforts.get(item.id) ?? 0,
      dependencyValues.get(item.id) ?? 0
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
  const allocatedIds = new Set<string>();

  const allocate = (entry: PlanEntry, strictCapacity: boolean, preferEarliest: boolean) => {
    if (entry.item.dependsOn) {
      for (const depId of entry.item.dependsOn) {
        const dep = items.find(i => i.id === depId);
        if (dep && dep.status !== "done" && !allocatedIds.has(depId)) return false;
      }
    }

    const limit = strictCapacity ? capacity : capacity * 1.2;
    const candidates = days.filter((day) => {
      return day.date >= today && (day.used + entry.item.effort <= limit);
    });

    if (candidates.length === 0) return false;

    let target;
    if (preferEarliest) {
      target = candidates[0];
    } else {
      // Balanced distribution: prefer the day with the lowest current load,
      // but if there's a tie, pick the earliest one.
      target = candidates.reduce((prev, curr) => {
        return curr.used < prev.used ? curr : prev;
      });
    }

    target.entries.push(entry);
    target.used += entry.item.effort;
    allocatedIds.add(entry.item.id);
    return true;
  };

  let changed = true;
  let pass = 0;
  const remaining = [...plan];

  while (changed && pass < 10 && remaining.length > 0) {
    changed = false;
    pass++;
    
    // Refine: Hard-stop priority for tasks with zero or negative slack
    const critical = remaining.filter(e => e.slack <= 0 && e.item.impact >= 4);
    const urgent = remaining.filter(e => !critical.includes(e) && (e.daysUntilDue <= 2 || e.isCritical || e.slack <= 0 || e.item.impact >= 4));
    const normal = remaining.filter(e => !critical.includes(e) && !urgent.includes(e));

    critical.sort((a, b) => b.score - a.score).forEach(e => {
      if (allocate(e, false, true)) {
        changed = true;
      }
    });

    urgent.sort((a, b) => b.score - a.score).forEach(e => {
      if (allocate(e, true, true)) {
        changed = true;
      }
    });

    // Normal tasks: prioritize based on impact/dueDate proximity while balancing
    normal.sort((a, b) => b.score - a.score || a.item.dueDate.localeCompare(b.item.dueDate)).forEach(e => {
      const preferEarliest = e.daysUntilDue <= 4 || e.item.impact >= 4;
      if (allocate(e, false, preferEarliest)) {
        changed = true;
      }
    });

    for (let i = remaining.length - 1; i >= 0; i--) {
      if (allocatedIds.has(remaining[i].item.id)) {
        remaining.splice(i, 1);
      }
    }
  }

  return days.map((day) => ({
    ...day,
    overloaded: day.used > capacity,
    overage: Math.max(0, day.used - capacity),
  }));
}
