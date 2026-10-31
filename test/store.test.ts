import { describe, expect, it } from "vitest";
import type { LifeRecord } from "../src/types";
import { normalizeDependencies } from "../src/core/store";

const record = (overrides: Partial<LifeRecord> = {}): LifeRecord => ({
  id: "one",
  title: "Example",
  category: "Documents",
  dueDate: "2026-08-20",
  effort: 30,
  impact: 3,
  status: "planned",
  notes: "",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  ...overrides,
});

describe("record store dependency normalization", () => {
  it("removes dangling, self, and duplicate references", () => {
    const records = [
      record({ id: "parent" }),
      record({ id: "child", dependsOn: ["parent", "parent", "child", "missing"] }),
    ];

    const normalized = normalizeDependencies(records);
    expect(normalized.find((item) => item.id === "child")?.dependsOn).toEqual(["parent"]);
  });

  it("preserves an empty dependency list when every reference is invalid", () => {
    const records = [record({ id: "item", dependsOn: ["missing"] })];

    expect(normalizeDependencies(records)[0]?.dependsOn).toEqual([]);
  });
});
