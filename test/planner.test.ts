import { describe, expect, it } from "vitest";
import { importJson } from "../src/core/exchange";
import { buildPlan, daysBetween, findBottleneck, priorityFor, suggestDailyLoad, summarize } from "../src/core/planner";
import { theme } from "../src/theme";
import type { LifeRecord } from "../types";

const item = (overrides: Partial<LifeRecord> = {}): LifeRecord => ({
  id: "one", title: "Example", category: "General", dueDate: "2026-08-20", effort: 30,
  impact: 3, status: "planned", notes: "", createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z", ...overrides,
});

describe("planning engine", () => {
  it("calculates calendar-day distance without local time drift", () => expect(daysBetween("2026-08-19", "2026-08-20")).toBe(1));
  it("ranks overdue high-impact work above distant work", () => {
    const overdue = item({ id: "late", dueDate: "2026-08-18", impact: 5 });
    const distant = item({ id: "later", dueDate: "2026-09-20", impact: 2 });
    expect(buildPlan([distant, overdue], "2026-08-20")[0]!.item.id).toBe("late");
  });
  it("removes completed work from the active plan", () => expect(buildPlan([item({ status: "done" })], "2026-08-19")).toHaveLength(0));
  it("explains the score", () => expect(priorityFor(item(), "2026-08-19", new Map()).reasons.join(" ")).toContain("due in 1 day"));
  it("summarizes status and workload", () => {
    const result = summarize([item(), item({ id: "two", status: "done", category: "Other" })], "2026-08-19");
    expect(result).toMatchObject({ total: 2, completed: 1, dueSoon: 1, effort: 30 });
  });
  it("flags a day whose assigned effort exceeds capacity", () => {
    const week = suggestDailyLoad([item({ effort: 120 })], 60, "2026-08-19");
    expect(week.some((day) => day.overloaded)).toBe(true);
  });
  it("penalizes blocked tasks in priority", () => {
    const parent = item({ id: "parent", status: "planned" });
    const child = item({ id: "child", dependsOn: ["parent"], impact: 5 });
    const plan = buildPlan([parent, child], "2026-08-19");
    expect(plan.find(e => e.item.id === "child")?.isBlocked).toBe(true);
    expect(plan[0].item.id).toBe("parent");
  });
  it("unblocks tasks when dependencies are done", () => {
    const parent = item({ id: "parent", status: "done" });
    const child = item({ id: "child", dependsOn: ["parent"] });
    const plan = buildPlan([parent, child], "2026-08-19");
    expect(plan[0].item.id).toBe("child");
    expect(plan[0].isBlocked).toBe(false);
  });
  it("detects circular dependencies and penalizes score", () => {
    const a = item({ id: "a", dependsOn: ["b"] });
    const b = item({ id: "b", dependsOn: ["a"] });
    const plan = buildPlan([a, b], "2026-08-19");
    expect(plan.every(e => e.reasons.some(r => r.includes("circular")))).toBe(true);
    expect(plan.every(e => e.isBlocked)).toBe(true);
  });
  it("boosts priority of tasks with high blocking power", () => {
    const root = item({ id: "root", impact: 1 });
    const child1 = item({ id: "c1", dependsOn: ["root"] });
    const child2 = item({ id: "c2", dependsOn: ["root"] });
    const child3 = item({ id: "c3", dependsOn: ["root"] });
    const standalone = item({ id: "standalone", impact: 2 });
    
    const plan = buildPlan([root, child1, child2, child3, standalone], "2026-08-19");
    const rootEntry = plan.find(e => e.item.id === "root");
    expect(rootEntry?.reasons.some(r => r.includes("unblocks 3 task(s)"))).toBe(true);
    // root should likely be higher than standalone despite lower impact because of blocking power
    const standaloneIdx = plan.findIndex(e => e.item.id === "standalone");
    const rootIdx = plan.findIndex(e => e.item.id === "root");
    expect(rootIdx).toBeLessThan(standaloneIdx);
  });
  it("correctly identifies the bottleneck task", () => {
    const root = item({ id: "root" });
    const leaf1 = item({ id: "l1", dependsOn: ["root"] });
    const leaf2 = item({ id: "l2", dependsOn: ["root"] });
    const other = item({ id: "other" });
    const leaf3 = item({ id: "l3", dependsOn: ["other"] });
    
    expect(findBottleneck([root, leaf1, leaf2, other, leaf3], "2026-08-19")?.id).toBe("root");
  });
  it("distributes normal load across days to avoid spikes", () => {
    const tasks = [
      item({ id: "t1", effort: 30, dueDate: "2026-08-30" }),
      item({ id: "t2", effort: 30, dueDate: "2026-08-30" }),
      item({ id: "t3", effort: 30, dueDate: "2026-08-30" }),
    ];
    const week = suggestDailyLoad(tasks, 60, "2026-08-19");
    // With 60 capacity and 3 tasks of 30, they should ideally be split
    // or at least not all crammed into day 1 if the balance logic works.
    const daysWithTasks = week.filter(d => d.entries.length > 0);
    expect(daysWithTasks.length).toBeGreaterThan(1);
  });
});

describe("JSON exchange boundary", () => {
  const valid = () => item({ category: theme.categories[0] });
  const backup = (record: unknown) => JSON.stringify({ schema: 1, records: [record] });

  it("accepts a fully valid record", () => {
    expect(importJson(backup(valid()), theme)).toHaveLength(1);
  });

  it.each([
    ["string effort", { effort: "30" }],
    ["out-of-range impact", { impact: 9 }],
    ["unknown status", { status: "paused" }],
    ["impossible calendar date", { dueDate: "2026-02-30" }],
    ["empty title", { title: "" }],
    ["unknown category", { category: "Not in this project" }],
    ["non-string notes", { notes: 42 }],
    ["invalid timestamp", { updatedAt: "yesterday" }],
    ["numeric-looking loose timestamp", { createdAt: "0" }],
    ["normalized impossible timestamp", { updatedAt: "2026-02-30T00:00:00Z" }],
  ])("rejects %s", (_label, patch) => {
    expect(() => importJson(backup({ ...valid(), ...patch }), theme)).toThrow();
  });

  it("rejects duplicate ids instead of silently merging records", () => {
    const record = valid();
    expect(() => importJson(JSON.stringify({ schema: 1, records: [record, record] }), theme)).toThrow(/duplicate id/);
  });
});
