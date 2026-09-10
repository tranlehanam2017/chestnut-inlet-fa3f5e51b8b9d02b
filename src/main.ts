import { RecordStore } from "./core/store";
import { buildPlan, localDay, summarize, suggestDailyLoad, validateRecord } from "./core/planner";
import { exportCsv, exportJson, importJson, download } from "./core/exchange";
import { theme } from "./theme";
import { revisionLedger } from "./generated/revision-ledger";
import type { LifeRecord, ThemeConfig } from "./types";

const STORE_KEY = `departure-canvas-${theme.id}`;

function createId(): string {
  return Math.random().toString(36).slice(2, 15);
}

function renderApp() {
  const root = document.getElementById("app");
  if (!root) return;

  const store = new RecordStore(STORE_KEY, []);
  const initialSeeds: LifeRecord[] = theme.seeds.map(([title, category, effort, impact]) => ({
    id: createId(),
    title,
    category,
    dueDate: localDay(),
    effort,
    impact,
    status: "planned",
    notes: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  if (store.all().length === 0 && theme.seeds.length > 0) {
    store.replace(initialSeeds);
  }

  root.innerHTML = `
    <div class="hero">
      <div>
        <div class="eyebrow">Trip Planner</div>
        <h1>${theme.product}</h1>
        <p>${theme.tagline}</p>
      </div>
      <div class="revision">
        <span>Revision</span>
        <strong>${revisionLedger.ordinal}</strong>
        <small>${revisionLedger.revision.slice(0, 8)}</small>
      </div>
    </div>

    <div class="summary" id="summary-bar"></div>

    <div class="layout">
      <div class="panel">
        <div class="panel-title"><h2>${theme.itemLabel}s</h2></div>
        <form id="record-form">
          <input type="hidden" id="field-id">
          <label>Title
            <input type="text" id="field-title" placeholder="e.g. Book Hotel">
          </label>
          <div class="form-grid">
            <label>Category
              <select id="field-category">
                ${theme.categories.map(c => `<option value="${c}">${c}</option>`).join('')}
              </select>
            </label>
            <label>${theme.dateLabel}
              <input type="date" id="field-dueDate">
            </label>
          </div>
          <div class="form-grid">
            <label>${theme.effortLabel}
              <input type="number" id="field-effort" value="30">
            </label>
            <label>${theme.impactLabel}
              <input type="number" id="field-impact" value="3" min="1" max="5">
            </label>
          </div>
          <label>Notes
            <textarea id="field-notes" rows="3"></textarea>
          </label>
          <div id="form-errors" class="errors"></div>
          <div class="form-actions">
            <button type="submit" id="btn-save">Save</button>
            <button type="button" id="btn-cancel" class="ghost">Cancel</button>
          </div>
        </form>

        <div class="panel-title" style="margin-top: 2rem"><h3>Exchange</h3></div>
        <div class="exchange">
          <button id="btn-export-json" class="ghost">JSON</button>
          <button id="btn-export-csv" class="ghost">CSV</button>
          <label class="file">
            Import
            <input type="file" id="file-import" accept=".json">
          </label>
        </div>
      </div>

      <div>
        <div class="panel">
          <div class="panel-title">
            <h2>Priority Plan</h2>
            <div class="filter-group">
              <label>Search
                <input type="text" id="search" placeholder="Filter tasks...">
              </label>
            </div>
          </div>
          <div id="plan-list"></div>
          <div id="batch-actions" class="form-actions" style="display:none">
            <button id="btn-delete-selected" class="danger">Delete Selected</button>
            <button id="btn-done-selected" class="ghost">Mark Done</button>
          </div>
        </div>

        <div class="panel week-panel">
          <div class="panel-title"><h3>7-Day Forecast</h3></div>
          <div class="week" id="forecast-grid"></div>
        </div>
      </div>
    </div>
  `;

  const els = {
    form: root.querySelector("#record-form") as HTMLFormElement,
    id: root.querySelector("#field-id") as HTMLInputElement,
    title: root.querySelector("#field-title") as HTMLInputElement,
    category: root.querySelector("#field-category") as HTMLSelectElement,
    dueDate: root.querySelector("#field-dueDate") as HTMLInputElement,
    effort: root.querySelector("#field-effort") as HTMLInputElement,
    impact: root.querySelector("#field-impact") as HTMLInputElement,
    notes: root.querySelector("#field-notes") as HTMLTextAreaElement,
    errors: root.querySelector("#form-errors") as HTMLDivElement,
    saveBtn: root.querySelector("#btn-save") as HTMLButtonElement,
    cancelBtn: root.querySelector("#btn-cancel") as HTMLButtonElement,
    summary: root.querySelector("#summary-bar") as HTMLDivElement,
    planList: root.querySelector("#plan-list") as HTMLDivElement,
    search: root.querySelector("#search") as HTMLInputElement,
    batchActions: root.querySelector("#batch-actions") as HTMLDivElement,
    delSelected: root.querySelector("#btn-delete-selected") as HTMLButtonElement,
    doneSelected: root.querySelector("#btn-done-selected") as HTMLButtonElement,
    forecast: root.querySelector("#forecast-grid") as HTMLDivElement,
    exportJson: root.querySelector("#btn-export-json") as HTMLButtonElement,
    exportCsv: root.querySelector("#btn-export-csv") as HTMLButtonElement,
    importFile: root.querySelector("#file-import") as HTMLInputElement,
  };

  let selectedIds = new Set<string>();
  let currentSearch = "";

  const updateUI = (records: readonly LifeRecord[]) => {
    const today = localDay();
    const summary = summarize(records, today);
    
    els.summary.innerHTML = `
      <article><span>Total</span><strong>${summary.total}</strong></article>
      <article><span>Completed</span><strong>${summary.completed}</strong></article>
      <article><span>Overdue</span><strong class="text-danger">${summary.overdue}</strong></article>
      <article><span>Workload</span><strong>${summary.effort}m</strong></article>
    `;

    const plan = buildPlan(records, today).filter(e => 
      e.item.title.toLowerCase().includes(currentSearch.toLowerCase()) ||
      e.item.category.toLowerCase().includes(currentSearch.toLowerCase())
    );

    els.planList.innerHTML = plan.length ? plan.map(e => `
      <div class="record ${e.daysUntilDue < 0 ? 'overdue' : ''} ${selectedIds.has(e.item.id) ? 'selected' : ''}" data-id="${e.item.id}">
        <div>
          <input type="checkbox" ${selectedIds.has(e.item.id) ? 'checked' : ''} class="item-check">
          <div style="display:inline-block; vertical-align:top; margin-left: 0.5rem">
            <h3>${e.item.title} <span class="badge">${e.item.category}</span></h3>
            <p>${e.reasons.join(', ')} | Due: ${e.item.dueDate}</p>
          </div>
        </div>
        <div class="record-actions">
          <button class="ghost btn-edit" style="padding: 0.2rem 0.5rem; font-size: 0.7rem">Edit</button>
          <strong>${e.score}</strong>
        </div>
      </div>
    `).join('') : '<div class="empty">No matching tasks found.</div>';

    const forecast = suggestDailyLoad(records, 120, today);
    els.forecast.innerHTML = forecast.map(d => `
      <div class="day ${d.overloaded ? 'over' : ''}">
        <small>${d.date.slice(5)}</small>
        <strong>${d.used}m</strong>
        <small>${d.entries.length} tasks</small>
      </div>
    `).join('');

    els.batchActions.style.display = selectedIds.size > 0 ? 'flex' : 'none';
  };

  store.subscribe(updateUI);

  els.form.onsubmit = (e) => {
    e.preventDefault();
    const data = {
      id: els.id.value || createId(),
      title: els.title.value,
      category: els.category.value,
      dueDate: els.dueDate.value,
      effort: parseInt(els.effort.value) || 0,
      impact: parseInt(els.impact.value) || 0,
      status: "planned" as any,
      notes: els.notes.value,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const errors = validateRecord(data, theme);
    if (errors.length) {
      els.errors.innerHTML = errors.join('<br>');
      return;
    }

    els.errors.innerHTML = "";
    const existing = store.all().find(r => r.id === data.id);
    if (existing) {
      data.createdAt = existing.createdAt;
      data.status = existing.status;
    }

    store.upsert(data);
    resetForm();
  };

  const resetForm = () => {
    els.id.value = "";
    els.title.value = "";
    els.notes.value = "";
    els.dueDate.value = localDay();
    els.errors.innerHTML = "";
    els.saveBtn.textContent = "Save";
  };

  els.cancelBtn.onclick = resetForm;

  els.planList.onclick = (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('btn-edit')) {
      const record = store.all().find(r => (target.closest('.record')?.dataset.id === r.id));
      if (record) {
        els.id.value = record.id;
        els.title.value = record.title;
        els.category.value = record.category;
        els.dueDate.value = record.dueDate;
        els.effort.value = String(record.effort);
        els.impact.value = String(record.impact);
        els.notes.value = record.notes;
        els.saveBtn.textContent = "Update";
      }
      return;
    }
    if (target.classList.contains('item-check')) {
      const id = (target as HTMLInputElement).closest('.record')?.dataset.id;
      if (id) {
        selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id);
        updateUI(store.all());
      }
    }
  };

  els.search.oninput = () => {
    currentSearch = els.search.value;
    updateUI(store.all());
  };

  els.delSelected.onclick = () => {
    selectedIds.forEach(id => store.remove(id));
    selectedIds.clear();
    updateUI(store.all());
  };

  els.doneSelected.onclick = () => {
    selectedIds.forEach(id => {
      const r = store.all().find(x => x.id === id);
      if (r) store.upsert({ ...r, status: "done", updatedAt: new Date().toISOString() });
    });
    selectedIds.clear();
    updateUI(store.all());
  };

  els.exportJson.onclick = () => {
    const data = exportJson(store.all());
    download("trip-backup.json", data, "application/json");
  };

  els.exportCsv.onclick = () => {
    const data = exportCsv(store.all());
    download("trip-export.csv", data, "text/csv");
  };

  els.importFile.onchange = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const records = importJson(ev.target?.result as string, theme);
        store.replace(records);
      } catch (err: any) {
        alert(`Import failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };
}

document.addEventListener("DOMContentLoaded", renderApp);
