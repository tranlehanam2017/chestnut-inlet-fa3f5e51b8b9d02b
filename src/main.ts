import "./style.css";
import { theme } from "./theme";
import { RecordStore } from "./core/store";
import { buildPlan, suggestDailyLoad, summarize, localDay, validateRecord, findBlockingRoot, findBottleneck } from "./core/planner";
import { exportJson, exportCsv, download, importJson, importCsv } from "./core/exchange";
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
    pinned: false,
  }));
}

const store = new RecordStore(storageKey, seedRecords());
const app = document.getElementById("app");
if (!app) throw new Error("Missing #app root element.");

let records: readonly LifeRecord[] = [];
let searchQuery = "";
let categoryFilter = "all";
let quickFilter: "all" | "overdue" | "due-soon" | "blocked" = "all";
let editingId: string | null = null;
let selectedId: string | null = null;

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
  const activeElement = document.activeElement;
  const activeId = activeElement instanceof HTMLElement ? activeElement.id : "";
  const selectionStart =
    activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
      ? activeElement.selectionStart
      : null;
  const selectionEnd =
    activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
      ? activeElement.selectionEnd
      : null;

  const today = localDay();
  const plan = buildPlan(records, today);
  const summary = summarize(records, today);
  const week = suggestDailyLoad(records, 480, today, plan);
  const itemMap = new Map(records.map((record) => [record.id, record]));
  const bottleneckRaw = findBottleneck(records, today) as unknown;
  const bottleneck =
    bottleneckRaw && typeof bottleneckRaw === "object"
      ? (bottleneckRaw as { id?: unknown; title?: unknown })
      : null;
  const bottleneckId = typeof bottleneck?.id === "string" ? bottleneck.id : null;

  const editingRecord = editingId ? records.find((record) => record.id === editingId) ?? null : null;
  if (editingId && !editingRecord) editingId = null;

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredEntries = plan.filter((entry) => {
    if (categoryFilter !== "all" && entry.item.category !== categoryFilter) return false;
    if (quickFilter === "overdue" && !(entry.daysUntilDue < 0)) return false;
    if (quickFilter === "due-soon" && !(entry.daysUntilDue >= 0 && entry.daysUntilDue <= 7)) return false;
    if (quickFilter === "blocked" && !entry.isBlocked) return false;
    if (!normalizedQuery) return true;
    const haystack = [
      entry.item.title,
      entry.item.category,
      entry.item.notes,
      ...entry.reasons,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });

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
  formHeading.textContent = editingRecord ? `Edit ${theme.itemLabel}` : `New ${theme.itemLabel}`;
  formTitle.append(formHeading);
  formPanel.append(formTitle);

  const form = element("form");
  const grid = element("div", "form-grid");

  const titleInput = element("input");
  titleInput.type = "text";
  titleInput.placeholder = `${theme.itemLabel} title`;
  titleInput.value = editingRecord?.title ?? "";
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
  if (editingRecord && theme.categories.includes(editingRecord.category)) {
    categorySelect.value = editingRecord.category;
  } else {
    categorySelect.value = theme.categories[0];
  }
  const categoryLabel = element("label");
  categoryLabel.textContent = "Category";
  categoryLabel.append(categorySelect);

  const dueDateInput = element("input");
  dueDateInput.type = "date";
  dueDateInput.value =
    editingRecord?.dueDate ?? localDay(new Date(Date.now() + 7 * 86_400_000));
  const dueDateLabel = element("label");
  dueDateLabel.textContent = theme.dateLabel;
  dueDateLabel.append(dueDateInput);

  const effortInput = element("input");
  effortInput.type = "number";
  effortInput.min = "1";
  effortInput.max = "480";
  effortInput.value = String(editingRecord?.effort ?? 30);
  const effortLabel = element("label");
  effortLabel.textContent = theme.effortLabel;
  effortLabel.append(effortInput);

  const impactInput = element("input");
  impactInput.type = "number";
  impactInput.min = "1";
  impactInput.max = "5";
  impactInput.value = String(editingRecord?.impact ?? 3);
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
  statusSelect.value = editingRecord?.status ?? "planned";
  const statusLabel = element("label");
  statusLabel.textContent = "Status";
  statusLabel.append(statusSelect);

  const notesInput = element("textarea");
  notesInput.rows = 3;
  notesInput.placeholder = "Notes";
  notesInput.value = editingRecord?.notes ?? "";
  const notesLabel = element("label");
  notesLabel.textContent = "Notes";
  notesLabel.append(notesInput);

  const dependenciesInput = element("input");
  dependenciesInput.type = "text";
  dependenciesInput.placeholder = "Dependency task ids, comma separated";
  dependenciesInput.value = editingRecord?.dependsOn?.join(", ") ?? "";
  const dependenciesLabel = element("label");
  dependenciesLabel.textContent = "Dependencies";
  dependenciesLabel.append(dependenciesInput);

  const pinnedInput = element("input");
  pinnedInput.type = "checkbox";
  pinnedInput.checked = editingRecord?.pinned ?? false;
  const pinnedLabel = element("label");
  pinnedLabel.append(pinnedInput, document.createTextNode(" Pinned to top"));

  grid.append(
    titleLabel,
    categoryLabel,
    dueDateLabel,
    effortLabel,
    impactLabel,
    statusLabel,
    notesLabel,
    dependenciesLabel,
    pinnedLabel,
  );

  const actions = element("div", "form-actions");
  const formErrors = element("div", "errors");
  const addButton = element("button");
  addButton.type = "button";
  addButton.textContent = editingRecord ? `Update ${theme.itemLabel}` : `Add ${theme.itemLabel}`;
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
      id: editingRecord ? editingRecord.id : crypto.randomUUID(),
      title,
      category: categorySelect.value,
      dueDate: dueDateInput.value,
      effort: Number(effortInput.value),
      impact: Number(impactInput.value),
      status: statusSelect.value as ItemStatus,
      notes: notesInput.value,
      createdAt: editingRecord?.createdAt ?? now,
      updatedAt: now,
      dependsOn,
      pinned: pinnedInput.checked,
    };
    const validationErrors = validateRecord(record, theme);
    if (validationErrors.length > 0) {
      formErrors.textContent = validationErrors.join(" ");
      return;
    }
    formErrors.textContent = "";
    store.upsert(record);
    editingId = null;
  });
  actions.append(addButton);

  if (editingRecord) {
    const cancelButton = element("button", "ghost");
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => {
      editingId = null;
      render();
    });
    actions.append(cancelButton);
  }

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
  fileInput.accept = "application/json,text/csv,.json,.csv";
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = file.name.toLowerCase().endsWith(".csv")
        ? importCsv(text, theme)
        : importJson(text, theme);
      store.replace(imported);
      editingId = null;
      selectedId = null;
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Import failed.");
    }
    fileInput.value = "";
  });
  fileLabel.append(fileInput, document.createTextNode("Import JSON/CSV"));

  const clearCompletedButton = element("button", "ghost");
  clearCompletedButton.type = "button";
  clearCompletedButton.textContent = "Clear completed";
  clearCompletedButton.addEventListener("click", () => {
    const completed = records.filter((record) => record.status === "done");
    if (completed.length === 0) return;
    if (!window.confirm(`Remove ${completed.length} completed task(s)?`)) return;
    const completedIds = new Set(completed.map((record) => record.id));
    if (editingId && completedIds.has(editingId)) editingId = null;
    if (selectedId && completedIds.has(selectedId)) selectedId = null;
    store.clearCompleted();
  });

  exchange.append(exportJsonButton, exportCsvButton, fileLabel, clearCompletedButton);

  form.append(grid, actions, formErrors, exchange);
  formPanel.append(form);

  const listPanel = element("section", "panel");
  const listTitle = element("div", "panel-title");
  const listHeading = element("h2");
  listHeading.textContent = "Prioritized plan";
  const searchInput = element("input");
  searchInput.id = "search";
  searchInput.type = "search";
  searchInput.placeholder = "Search tasks";
  searchInput.value = searchQuery;
  searchInput.addEventListener("input", (event) => {
    searchQuery = (event.currentTarget as HTMLInputElement).value;
    render();
  });

  const categoryFilterSelect = element("select");
  categoryFilterSelect.id = "category-filter";
  const allCategoriesOption = element("option");
  allCategoriesOption.value = "all";
  allCategoriesOption.textContent = "All categories";
  categoryFilterSelect.append(allCategoriesOption);
  for (const category of theme.categories) {
    const option = element("option");
    option.value = category;
    option.textContent = category;
    categoryFilterSelect.append(option);
  }
  categoryFilterSelect.value = categoryFilter;
  categoryFilterSelect.addEventListener("change", (event) => {
    categoryFilter = (event.currentTarget as HTMLSelectElement).value;
    render();
  });

  const quickFilterSelect = element("select");
  quickFilterSelect.id = "quick-filter";
  const quickFilterOptions: readonly [string, string][] = [
    ["all", "All tasks"],
    ["overdue", "Overdue"],
    ["due-soon", "Due soon"],
    ["blocked", "Blocked"],
  ];
  for (const [value, label] of quickFilterOptions) {
    const option = element("option");
    option.value = value;
    option.textContent = label;
    quickFilterSelect.append(option);
  }
  quickFilterSelect.value = quickFilter;
  quickFilterSelect.addEventListener("change", (event) => {
    quickFilter = (event.currentTarget as HTMLSelectElement).value as typeof quickFilter;
    render();
  });

  const filterControls = element("div", "filter-group");
  filterControls.append(categoryFilterSelect, quickFilterSelect);
  listTitle.append(listHeading, searchInput, filterControls);
  listPanel.append(listTitle);

  const insight = element("p");
  insight.textContent =
    typeof bottleneck?.title === "string"
      ? `Current bottleneck: ${bottleneck.title}`
      : "No dependency bottleneck.";
  listPanel.append(insight);

  const list = element("div");
  if (filteredEntries.length === 0) {
    const empty = element("div", "empty");
    if (normalizedQuery) {
      empty.textContent = "No matching tasks.";
    } else if (categoryFilter !== "all" || quickFilter !== "all") {
      empty.textContent = "No tasks match the selected filters.";
    } else {
      empty.textContent = "No active tasks.";
    }
    list.append(empty);
  } else {
    for (const entry of filteredEntries) {
      const row = element("article", "record");
      if (entry.isCritical) row.classList.add("critical");
      if (entry.isBlocked) row.classList.add("blocked");
      if (entry.daysUntilDue < 0) row.classList.add("overdue");
      if (entry.item.pinned) row.classList.add("pinned");
      if (selectedId === entry.item.id) row.classList.add("selected");
      if (bottleneckId !== null && entry.item.id === bottleneckId) row.classList.add("critical");

      row.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        if (target.closest("button")) return;
        selectedId = selectedId === entry.item.id ? null : entry.item.id;
        render();
      });

      const body = element("div");
      const itemTitle = element("h3");
      itemTitle.textContent = entry.item.title;
      const itemMeta = element("p");
      const completionSuffix = entry.estimatedCompletionDate
        ? ` · est. complete ${entry.estimatedCompletionDate}`
        : "";
      const blockingRootRaw = entry.isBlocked ? findBlockingRoot(entry.item, itemMap) : null;
      const blockingRoot =
        blockingRootRaw && typeof blockingRootRaw === "object"
          ? (blockingRootRaw as { id?: unknown; title?: unknown })
          : null;
      const rootTitle =
        typeof blockingRootRaw === "string"
          ? records.find((record) => record.id === blockingRootRaw)?.title ?? blockingRootRaw
          : typeof blockingRoot?.title === "string"
            ? blockingRoot.title
            : null;
      const dependencySuffix = entry.isBlocked
        ? rootTitle
          ? ` · blocked by ${rootTitle}`
          : entry.reasons.some((reason) => reason.includes("circular"))
            ? " · circular dependency"
            : " · blocked"
        : "";
      const bottleneckSuffix =
        bottleneckId !== null && entry.item.id === bottleneckId ? " · bottleneck" : "";
      const pinnedSuffix = entry.item.pinned ? " · pinned" : "";
      itemMeta.textContent = `${entry.item.category} · ${entry.item.effort} min · impact ${entry.item.impact} · ${entry.reasons.join(", ")}${completionSuffix}${dependencySuffix}${bottleneckSuffix}${pinnedSuffix}`;
      body.append(itemTitle, itemMeta);

      const controls = element("div", "record-actions");
      const score = element("strong");
      score.textContent = entry.score.toFixed(1);

      const editButton = element("button", "ghost");
      editButton.type = "button";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", (event) => {
        event.stopPropagation();
        editingId = entry.item.id;
        selectedId = entry.item.id;
        render();
      });

      const doneButton = element("button", "ghost");
      doneButton.type = "button";
      doneButton.textContent = "Done";
      doneButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const now = new Date().toISOString();
        store.upsert({ ...entry.item, status: "done", updatedAt: now });
      });

      const removeButton = element("button", "ghost");
      removeButton.type = "button";
      removeButton.textContent = "Delete";
      removeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (editingId === entry.item.id) editingId = null;
        if (selectedId === entry.item.id) selectedId = null;
        store.remove(entry.item.id);
      });

      controls.append(score, editButton, doneButton, removeButton);
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

  if (activeId) {
    const next = document.getElementById(activeId);
    if (next) {
      next.focus();
      if (
        (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) &&
        selectionStart !== null
      ) {
        try {
          next.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
        } catch {
          // Some input types do not support text selection; focus is still restored.
        }
      }
    }
  }
}
