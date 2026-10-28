import "./style.css";
import { theme } from "./theme";
import { RecordStore } from "./core/store";
import { buildPlan, suggestDailyLoad, summarize, localDay, validateRecord } from "./core/planner";
import { exportJson, exportCsv, download, importJson } from "./core/exchange";
import { revisionLedger } from "./generated/revision-ledger";
import type { ItemStatus, LifeRecord } from "./types";

const storageKey = "departure-canvas-records";

function seedRecords(): LifeRecord[] {
  const now = new Date().toISOString();
  return theme.seeds.map((seed, index) => ({
    id: `seed-${index + 1}`,
    title: seed[0],
    category: seed[1],
    dueDate: localDay(new Date(Date.now() + (index + 3) * 86_400_000)),
    effort: seed[2],
    impact: seed[3],
    status: "planned",
    notes: "",
    createdAt: now,
    updatedAt: now,
    dependsOn: [],
  }));
}

const store = new RecordStore(storageKey, seedRecords());
const app = document.getElementById("app");
if (!app) throw new Error("Missing #app root element.");

let records: readonly LifeRecord[] = [];
store.subscribe((next) => {
  records = next;
  render();
});

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function render(): void {
  const today = localDay();
  const plan = buildPlan(records, today);
  const summary = summarize(records, today);
  const week = suggestDailyLoad(records, 480, today);

  app.replaceChildren();

  const hero = element("section", "hero");
  const heroText = element("div");
  const eyebrow = element("p", "eyebrow");
  eyebrow.textContent = theme.tagline;
  const title = element("h1");
  title.textContent = theme.product;
  const subtitle = element("p");
  subtitle.textContent = "Organize trip preparation with dependency-aware priorities.";
  heroText.append(eyebrow, title, subtitle);

  const revision = element("div", "revision");
  const revisionLabel = element("span");
  revisionLabel.textContent = "Revision";
  const revisionValue = element("strong");
  revisionValue.textContent = String(revisionLedger.ordinal);
  const revisionDate = element("small");
  revisionDate.textContent = revisionLedger.day;
  revision.append(revisionLabel, revisionValue, revisionDate);
  hero.append(heroText, revision);
  app.append(hero);

  const summaryGrid = element("section", "summary");
  const summaryItems: readonly [string, string | number][] = [
    ["Tasks", summary.total],
    ["Completed", summary.completed],
    ["Overdue", summary.overdue],
    ["Effort", `${summary.effort} min`],
  ];
  for (const [label, value] of summaryItems) {
    const card = element("article");
    const labelElement = element("span");
    labelElement.textContent = label;
    const valueElement = element("strong");
    valueElement.textContent = String(value);
    card.append(labelElement, valueElement);
    summaryGrid.append(card);
  }
  app.append(summaryGrid);

  const layout = element("section", "layout");

  const formPanel = element("section", "panel");
  const formTitle = element("div", "panel-title");
  const formHeading = element("h2");
  formHeading.textContent = `New ${theme.itemLabel}`;
  formTitle.append(formHeading);
  formPanel.append(formTitle);

  const form = element("form");
  const grid = element("div", "form-grid");

  const titleInput = element("input");
  titleInput.type = "text";
  titleInput.placeholder = `${theme.itemLabel} title`;
  const titleLabel = element("label");
  titleLabel.textContent = "Title";
  titleLabel.append(titleInput);

  const categorySelect = element("select");
  for (const category of theme.categories) {
    const option = element("option");
    option.value = category;
    option.textContent = category;
    categorySelect.append(option);
  }
  const categoryLabel = element("label");
  categoryLabel.textContent = "Category";
  categoryLabel.append(categorySelect);

  const dueDateInput = element("input");
  dueDateInput.type = "date";
  dueDateInput.value = localDay(new Date(Date.now() + 7 * 86_400_000));
  const dueDateLabel = element("label");
  dueDateLabel.textContent = theme.dateLabel;
  dueDateLabel.append(dueDateInput);

  const effortInput = element("input");
  effortInput.type = "number";
  effortInput.min = "1";
  effortInput.max = "480";
  effortInput.value = "30";
  const effortLabel = element("label");
  effortLabel.textContent = theme.effortLabel;
  effortLabel.append(effortInput);

  const impactInput = element("input");
  impactInput.type = "number";
  impactInput.min = "1";
  impactInput.max = "5";
  impactInput.value = "3";
  const impactLabel = element("label");
  impactLabel.textContent = theme.impactLabel;
  impactLabel.append(impactInput);

  const statusSelect = element("select");
  for (const status of ["planned", "active", "done"] as const) {
    const option = element("option");
    option.value = status;
    option.textContent = status;
    statusSelect.append(option);
  }
  const statusLabel = element("label");
  statusLabel.textContent = "Status";
  statusLabel.append(statusSelect);

  const notesInput = element("textarea");
  notesInput.rows = 3;
  notesInput.placeholder = "Notes";
  const notesLabel = element("label");
  notesLabel.textContent = "Notes";
  notesLabel.append(notesInput);

  const dependenciesInput = element("input");
  dependenciesInput.type = "text";
  dependenciesInput.placeholder = "Dependency task ids, comma separated";
  const dependenciesLabel = element("label");
  dependenciesLabel.textContent = "Dependencies";
  dependenciesLabel.append(dependenciesInput);

  grid.append(
    titleLabel,
    categoryLabel,
    dueDateLabel,
    effortLabel,
    impactLabel,
    statusLabel,
    notesLabel,
    dependenciesLabel,
  );

  const actions = element("div", "form-actions");
  const formErrors = element("div", "errors");
  const addButton = element("button");
  addButton.type = "button";
  addButton.textContent = `Add ${theme.itemLabel}`;
  addButton.addEventListener("click", () => {
    const title = titleInput.value.trim();
    if (!title) {
      formErrors.textContent = `${theme.itemLabel} needs a title.`;
      return;
    }
    const now = new Date().toISOString();
    const dependsOn = dependenciesInput.value
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const record: LifeRecord = {
      id: crypto.randomUUID(),
      title,
      category: categorySelect.value,
      dueDate: dueDateInput.value,
      effort: Number(effortInput.value),
      impact: Number(impactInput.value),
      status: statusSelect.value as ItemStatus,
      notes: notesInput.value,
      createdAt: now,
      updatedAt: now,
      dependsOn,
    };
    const validationErrors = validateRecord(record, theme);
    if (validationErrors.length > 0) {
      formErrors.textContent = validationErrors.join(" ");
      return;
    }
    formErrors.textContent = "";
    store.upsert(record);
    form.reset();
    statusSelect.value = "planned";
    effortInput.value = "30";
    impactInput.value = "3";
    dueDateInput.value = localDay(new Date(Date.now() + 7 * 86_400_000));
    dependenciesInput.value = "";
  });
  actions.append(addButton);

  const exchange = element("div", "exchange");
  const exportJsonButton = element("button", "ghost");
  exportJsonButton.type = "button";
  exportJsonButton.textContent = "Export JSON";
  exportJsonButton.addEventListener("click", () => {
    download("departure-canvas.json", exportJson(records), "application/json");
  });

  const exportCsvButton = element("button", "ghost");
  exportCsvButton.type = "button";
  exportCsvButton.textContent = "Export CSV";
  exportCsvButton.addEventListener("click", () => {
    download("departure-canvas.csv", exportCsv(records), "text/csv");
  });

  const fileLabel = element("label", "file");
  const fileInput = element("input");
  fileInput.type = "file";
  fileInput.accept = "application/json";
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      store.replace(importJson(text, theme));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Import failed.");
    }
    fileInput.value = "";
  });
  fileLabel.append(fileInput, document.createTextNode("Import JSON"));
  exchange.append(exportJsonButton, exportCsvButton, fileLabel);

  form.append(grid, actions, formErrors, exchange);
  formPanel.append(form);

  const listPanel = element("section", "panel");
  const listTitle = element("div", "panel-title");
  const listHeading = element("h2");
  listHeading.textContent = "Prioritized plan";
  listTitle.append(listHeading);
  listPanel.append(listTitle);

  const list = element("div");
  if (plan.length === 0) {
    const empty = element("div", "empty");
    empty.textContent = "No active tasks.";
    list.append(empty);
  } else {
    for (const entry of plan) {
      const row = element("article", "record");
      if (entry.isCritical) row.classList.add("critical");
      if (entry.isBlocked) row.classList.add("blocked");
      if (entry.daysUntilDue < 0) row.classList.add("overdue");

      const body = element("div");
      const itemTitle = element("h3");
      itemTitle.textContent = entry.item.title;
      const itemMeta = element("p");
      itemMeta.textContent = `${entry.item.category} · ${entry.item.effort} min · impact ${entry.item.impact} · ${entry.reasons.join(", ")}`;
      body.append(itemTitle, itemMeta);

      const controls = element("div", "record-actions");
      const score = element("strong");
      score.textContent = entry.score.toFixed(1);
      const doneButton = element("button", "ghost");
      doneButton.type = "button";
      doneButton.textContent = "Done";
      doneButton.addEventListener("click", () => {
        const now = new Date().toISOString();
        store.upsert({ ...entry.item, status: "done", updatedAt: now });
      });
      const removeButton = element("button", "ghost");
      removeButton.type = "button";
      removeButton.textContent = "Delete";
      removeButton.addEventListener("click", () => store.remove(entry.item.id));
      controls.append(score, doneButton, removeButton);
      row.append(body, controls);
      list.append(row);
    }
  }
  listPanel.append(list);

  layout.append(formPanel, listPanel);
  app.append(layout);

  const weekPanel = element("section", "panel week-panel");
  const weekTitle = element("div", "panel-title");
  const weekHeading = element("h2");
  weekHeading.textContent = "Seven-day load";
  weekTitle.append(weekHeading);
  weekPanel.append(weekTitle);

  const weekGrid = element("div", "week");
  for (const day of week) {
    const dayElement = element("div", `day${day.overloaded ? " over" : ""}`);
    const date = element("span");
    date.textContent = day.date;
    const used = element("strong");
    used.textContent = `${day.used} min`;
    const tasks = element("small");
    tasks.textContent = day.entries.map((entry) => entry.item.title).join(", ");
    dayElement.append(date, used, tasks);
    weekGrid.append(dayElement);
  }
  weekPanel.append(weekGrid);
  app.append(weekPanel);
}