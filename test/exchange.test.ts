import { describe, expect, it } from "vitest";
import { importCsv } from "../src/core/exchange";
import { theme } from "../src/theme";

const header = "id,title,category,dueDate,effort,impact,status,notes";

function csv(...rows: string[]): string {
  return [header, ...rows].join("\n");
}

describe("CSV exchange boundary", () => {
  it("imports a valid CSV record", () => {
    const source = csv(
      `one,Example,${theme.categories[0]},2026-08-20,30,3,planned,"a,b"`,
    );
    const records = importCsv(source, theme);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "one",
      title: "Example",
      category: theme.categories[0],
      dueDate: "2026-08-20",
      effort: 30,
      impact: 3,
      status: "planned",
      notes: "a,b",
    });
  });

  it("rejects an unsupported header", () => {
    expect(() => importCsv("foo,bar", theme)).toThrow(/Unsupported CSV header/);
  });

  it("rejects rows with the wrong column count", () => {
    expect(() => importCsv(csv("one,Example"), theme)).toThrow(/column count/);
  });

  it("rejects invalid field values", () => {
    expect(() =>
      importCsv(csv(`one,Example,${theme.categories[0]},2026-08-20,abc,3,planned,`), theme),
    ).toThrow(/invalid effort/);
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      importCsv(
        csv(
          `one,Example,${theme.categories[0]},2026-08-20,30,3,planned,`,
          `one,Other,${theme.categories[0]},2026-08-21,15,2,planned,`,
        ),
        theme,
      ),
    ).toThrow(/duplicate id/);
  });
});
