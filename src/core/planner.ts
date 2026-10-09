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

export function priorityFor(item: LifeRecord, today = localDay(), allItems = itemsToMap(item), criticalPathIds = new Set<string>(), blockingPower = 0, blockingDepth = 0, slack = 0, downstreamEffort = 0, dependencyValue = 0, isPrimaryBottleneck = false, inheritedUrgency = 0): PlanEntry {
  const daysUntilDue = daysBetween(today, item.dueDate);
  const reasons: string[] = [];
  
  const impactWeight = item.impact >= 4 ? item.impact * 15 : item.impact * 10;
  let score = impactWeight;
  
  if (item.category === "Health") {
    score += 10;
    reasons.push("wellness priority");
  } else if (item.category === "Documents") {
    score += 15;
    reasons.push("administrative critical");
  } else if (item.category === "Transport") {
    score += 5;
    reasons.push("logistics priority");
  }

  const effortLeadDays = Math.ceil(item.effort / 180);
  const effectiveDaysUntilDue = daysUntilDue - effortLeadDays;

  if (daysUntilDue < 0) {
    const overdueDays = Math.abs(daysUntilDue);
    const impactMultiplier = item.impact >= 4 ? 3 : 1;
    const overdueBonus = (55 + Math.min(overdueDays, 7) * (item.impact * 2)) * impactMultiplier + (overdueDays > 7 ? (overdueDays - 7) * 2 : 0);
    score += overdueBonus;
    reasons.push(`${overdueDays} day(s) overdue`);
  } else if (daysUntilDue === 0) {
    score += 45;
    reasons.push("due today");
  } else if (daysUntilDue <= 7) {
    const nearTermBonus = daysUntilDue <= 2 && item.impact >= 4 ? 20 : 0;
    score += (36 - daysUntilDue * 4) + nearTermBonus;
    if (nearTermBonus > 0) reasons.push("urgent high-impact task");
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

  const efficiency = item.impact / (Math.max(1, item.effort) / 60);
  const isQuickWin = efficiency > 4 && item.impact >= 3 && item.effort <= 60;
  if (isQuickWin) {
    score *= 1.2;
    reasons.push("🚀 quick win (high value, low effort)");
  } else if (efficiency > 4 && item.impact >= 3) {
    score *= 1.15;
    reasons.push("high efficiency (quick win)");
  }

  const effortPenalty = Math.min(item.effort / 20, 12);
  score -= effortPenalty;

  if (item.status === "active") {
    score += 8;
    reasons.push("already in progress");
  }

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
    const baseBoost = daysUntilDue <= 2 ? 80 : (daysUntilDue <= 5 ? 50 : 30);
    const depthMultiplier = Math.min(blockingDepth * 5, 40);
    score += baseBoost + depthMultiplier;
    reasons.push("on critical path");
  }

  if (blockingPower > 0) {
    const blockingWeight = dependencyValue > 10 ? 20 : 15;
    score += blockingPower * blockingWeight;
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
    const urgencyMultiplier = slack < 0 ? 1.4 : (1.2 + (item.impact - 4) * 0.1);
    score *= urgencyMultiplier;
    reasons.push(slack < 0 ? "extreme critical urgency" : "critical path urgency");
  }

  if (item.effort > 120 && item.impact >= 3 && slack < 3 && slack > 0) {
    const riskBoost = (3 - slack) * 15;
    score += riskBoost;
    reasons.push("high complexity risk");
  }

  if (isPrimaryBottleneck) {
    score += 40;
    reasons.push("primary project bottleneck");
  }

  if (item.impact >= 5 && daysUntilDue > 2 && daysUntilDue <= 14) {
    score *= 1.1;
    reasons.push("high-impact focus");
  }

  if (inheritedUrgency > 0) {
    score += inheritedUrgency;
    reasons.push(`urgent descendant pressure`);
  }

  if (reasons.length === 0) reasons.push("ranked by impact and effort");

  const isCritical = (daysUntilDue <= 0 && item.impact >= 4) || (daysUntilDue < -3) || (effectiveDaysUntilDue <= 0 && item.impact >= 4) || (slack <= 0 && item.impact >= 4);

  let criticality: PlanEntry["criticality"] = "low";
  if (isCritical || slack < 0) criticality = "high";
  else if (slack <= 2 || inheritedUrgency > 10) criticality = "medium";

  return { item, score: Math.round(score * 10) / 10, reasons, daysUntilDue, isBlocked: isBlocked || isCircular, isCritical, slack, criticality };
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
  const urgencyInheritance = new Map<string, number>();

  const computeTransitiveValues = (id: string, visited = new Set<string>()) => {
    if (visited.has(id)) return { value: 0, effort: 0, urgency: 0 };
    visited.add(id);

    let totalValue = 0;
    let totalEffort = 0;
    let maxUrgency = 0;

    for (const item of items) {
      if (item.status === "done") continue;
      if (item.dependsOn?.includes(id)) {
        const childStats = computeTransitiveValues(item.id, visited);
        totalValue += item.impact + childStats.value;
        totalEffort += item.effort + childStats.effort;
        maxUrgency = Math.max(maxUrgency, (daysBetween(today, item.dueDate) <= 2 ? 15 : 0) + childStats.urgency);
      }
    }

    return { value: totalValue, effort: totalEffort, urgency: maxUrgency };
  };

  for (const item of items) {
    if (item.status === "done") continue;
    const stats = computeTransitiveValues(item.id);
    const directDescendants = items.filter(i => i.status !== "done" && i.dependsOn?.includes(item.id)).length;
    blockingCounts.set(item.id, directDescendants);
    downstreamEfforts.set(item.id, stats.effort);
    dependencyValues.set(item.id, stats.value);
    urgencyInheritance.set(item.id, stats.urgency);
  }

  const bottleneckId = findBottleneck(items, today)?.id;

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
    
    const getChainEffort = (currentId: string, visited = new Set<string>()): number => {
      if (visited.has(currentId)) return 0;
      visited.add(currentId);
      const current = itemMap.get(currentId);
      if (!current) return 0;
      
      let maxDepEffort = 0;
      current.dependsOn?.forEach(depId => {
        const dep = itemMap.get(depId);
        if (dep && dep.status !== "done") {
          maxDepEffort = Math.max(maxDepEffort, getChainEffort(depId, visited));
        }
      });
      return current.effort + maxDepEffort;
    };

    const chainEffort = getChainEffort(id);
    
    const effortDays = Math.ceil(chainEffort / 480);
    let slack = due - effortDays;

    const windowSize = 7;
    const overlappingTasks = items.filter(i => 
      i.status !== "done" && 
      daysBetween(today, i.dueDate) >= 0 && 
      daysBetween(today, i.dueDate) <= (due + windowSize)
    ).length;
    
    const densityPenalty = overlappingTasks > 5 ? Math.ceil(overlappingTasks / 4) : 0;
    
    const complexityPenalty = item.effort > 120 ? 1 : 0;
    const impactAdjustment = item.impact >= 4 ? 2 : (item.impact >= 3 ? 1 : 0);
    const adjustedSlack = slack - impactAdjustment - complexityPenalty - densityPenalty;
    slackCache.set(id, adjustedSlack);
    return adjustedSlack;
  };

  const entries = items
    .map((item) => priorityFor(
      item, 
      today, 
      itemMap, 
      criticalPathIds, 
      blockingCounts.get(item.id) ?? 0, 
      getDepth(item.id),
      calculateSlack(item.id),
      downstreamEfforts.get(item.id) ?? 0,
      dependencyValues.get(item.id) ?? 0,
      item.id === bottleneckId,
      urgencyInheritance.get(item.id) ?? 0
    ))
    .filter((entry) => entry.item.status !== "done")
    .sort((a, b) => 
      b.score - a.score || 
      (b.item.impact / Math.max(1, b.item.effort)) - (a.item.impact / Math.max(1, a.item.effort)) || 
      a.item.dueDate.localeCompare(b.item.dueDate)
    );

  const dailyLoad = suggestDailyLoad(items, 480, today);
  const completionDates = new Map<string, string>();
  for (const day of dailyLoad) {
    for (const entry of day.entries) {
      completionDates.set(entry.item.id, day.date);
    }
  }

  return entries.map(entry => ({
    ...entry,
    estimatedCompletionDate: completionDates.get(entry.item.id)
  }));
}

export function findBottleneck(items: readonly LifeRecord[], today = localDay()): LifeRecord | null {
  const itemMap = itemsToMap(items);
  const plan = buildPlan(items, today);
  const bottleneckWeights = new Map<string, number>();

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

  for (const entry of plan) {
    if (entry.isBlocked) {
      const root = findBlockingRoot(entry.item, itemMap);
      if (root) {
        const criticalityMultiplier = entry.isCritical ? 3 : 1;
        const impactWeight = criticalityMultiplier * (entry.item.impact || 1);
        const volumeWeight = entry.item.effort / 60;
        const chainWeight = getDepth(root.id) * 2;
        bottleneckWeights.set(root.id, (bottleneckWeights.get(root.id) ?? 0) + impactWeight + volumeWeight + chainWeight);
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
  
  const plan = buildPlan(items, today).filter(e => e.estimatedCompletionDate === undefined);
  const remainingEffort = new Map<string, number>();
  const allocatedIds = new Set<string>();

  for (const item of items) {
    if (item.status !== "done") remainingEffort.set(item.id, item.effort);
  }

  const allocate = (entry: PlanEntry, strictCapacity: boolean, preferEarliest: boolean) => {
    const itemId = entry.item.id;
    const effortNeeded = remainingEffort.get(itemId) ?? 0;
    if (effortNeeded <= 0) return false;

    if (entry.item.dependsOn) {
      for (const depId of entry.item.dependsOn) {
        const depEffort = remainingEffort.get(depId) ?? 0;
        if (depEffort > 0) return false;
      }
    }

    const limit = strictCapacity ? capacity : capacity * 1.2;
    
    const todayDay = days.find(d => d.date === today);
    const alreadyStartedToday = todayDay && todayDay.entries.some(e => e.item.id === itemId);
    
    const candidates = days.filter((day) => {
      return day.date >= today && (day.used < limit);
    });

    if (candidates.length === 0) return false;

    let target;
    if (alreadyStartedToday && todayDay && todayDay.used < limit) {
      target = todayDay;
    } else if (preferEarliest) {
      target = candidates[0];
    } else {
      target = candidates.reduce((prev, curr) => {
        if (curr.used < prev.used) return curr;
        if (curr.used > prev.used) return prev;
        return curr.date < prev.date ? curr : prev;
      });
    }

    const available = limit - target.used;
    const taken = Math.min(effortNeeded, available);
    
    if (taken <= 0) return false;

    if (!target.entries.includes(entry)) {
      target.entries.push(entry);
    }
    
    target.used += taken;
    remainingEffort.set(itemId, effortNeeded - taken);
    
    if (remainingEffort.get(itemId) === 0) {
      allocatedIds.add(itemId);
    }

    return true;
  };

  let changed = true;
  let pass = 0;
  const remaining = [...plan];

  while (changed && pass < 20 && remaining.length > 0) {
    changed = false;
    pass++;
    
    const critical = remaining.filter(e => e.isCritical && e.slack <= 0);
    const urgent = remaining.filter(e => !critical.includes(e) && (e.daysUntilDue <= 2 || e.isCritical || e.slack <= 0 || e.item.impact >= 4));
    const normal = remaining.filter(e => !critical.includes(e) && !urgent.includes(e));

    critical.sort((a, b) => a.slack - b.slack || b.score - a.score).forEach(e => {
      if (allocate(e, false, true)) changed = true;
    });

    urgent.sort((a, b) => b.score - a.score).forEach(e => {
      const strict = e.item.impact < 4 && e.slack > 1;
      if (allocate(e, strict, true)) changed = true;
    });

    normal.sort((a, b) => {
      const aDensity = a.item.impact / a.item.effort;
      const bDensity = b.item.impact / b.item.effort;
      return bDensity - aDensity || a.item.dueDate.localeCompare(b.item.dueDate);
    }).forEach(e => {
      const preferEarliest = e.daysUntilDue <= 3 || e.item.impact >= 4;
      if (allocate(e, false, preferEarliest)) changed = true;
    });

    for (let i = remaining.length - 1; i >= 0; i--) {
      if (allocatedIds.has(remaining[i].item.id)) {
        remaining.splice(i, 1);
      }
    }
  }

  const completionDates = new Map<string, string>();
  for (const day of days) {
    for (const entry of day.entries) {
      completionDates.set(entry.item.id, day.date);
    }
  }

  const resultDays = days.map((day) => ({
    ...day,
    overloaded: day.used > capacity,
    overage: Math.max(0, day.used - capacity),
    completionDates,
  }));

  return resultDays;
}
