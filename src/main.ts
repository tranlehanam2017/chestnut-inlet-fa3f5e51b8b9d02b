import { RecordStore } from "./core/store";
import { buildPlan, localDay, summarize, validateRecord, suggestDailyLoad } from "./core/planner";
import { exportJson, exportCsv, importJson, download } from "./core/exchange";
import { theme } from "./theme";
import type { LifeRecord, ItemStatus } from "./types";
import { revisionLedger } from "./generated/revision-ledger";

const store = new RecordStore("departure-canvas-v1", theme.seeds.map(([title, category, effort, impact]) => ({
  id: crypto.randomUUID(),
  title,
  category,
  dueDate: localDay(),
  effort,
  impact,
  status: "planned",
  notes: "",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  dependsOn: [],
})));

const app = document.getElementById("app")!;
let currentEditingId: string | null = null;
let searchQuery = "";
let dailyCapacity = 120;

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function getDayName(dateString: string): string {
  const date = new Date(`${dateString}T00:00:00Z`);
  return date.toLocaleDateString('en-US', { weekday: 'short' });
}

function render() {
  const records = store.all();
  const today = localDay();
  const plan = buildPlan(records, today);
  const summary = summarize(records, today);
  const dailyLoad = suggestDailyLoad(records, dailyCapacity, today);

  app.innerHTML = `
    <div class="hero">
      <div>
        <div class="eyebrow">${theme.product}</div>
        <h1>${theme.product}</h1>
        <p>${theme.tagline}</p>
      </div>
      <div class="revision">
        <span>Revision</span>
        <strong>#${revisionLedger.ordinal}</strong>
        <small>${revisionLedger.day}</small>
      </div>
    </div>

    <div class="summary">
      <article><span>Total Tasks</span><strong>${summary.total}</strong></article>
      <article><span>Completed</span><strong>${summary.completed}</strong></article>
      <article><span>Overdue</span><strong class="text-danger">${summary.overdue}</strong></article>
      <article><span>Focus Effort</span><strong>${summary.effort}m</strong></article>
    </div>

    <div class="layout">
      <div class="panel">
        <div class="panel-title">
          <h2>${theme.itemLabel}s</h2>
          <button id="add-btn">+ New</button>
        </div>

        <div class="filter-group" style="margin-bottom: 1rem">
          <label for="search">Search</label>
          <input type="text" id="search" placeholder="Filter tasks..." value="${searchQuery}">
        </div>

        <div id="records-list">
          ${records
            .filter(r => r.title.toLowerCase().includes(searchQuery.toLowerCase()) || r.notes.toLowerCase().includes(searchQuery.toLowerCase()))
            .map(r => {
              const entry = plan.find(e => e.item.id === r.id);
              const isOverdue = r.status !== "done" && daysBetween(today, r.dueDate) < 0;
              const isSelected = currentEditingId === r.id;
              return `
                <div class="record ${isOverdue ? 'overdue' : ''} ${isSelected ? 'selected' : ''}" data-id="${r.id}">
                  <div>
                    <div class="badge">${r.category}</div>
                    <h3>${r.title}</h3>
                    <p>${r.dueDate} • ${r.effort}m</p>
                  </div>
                  <div class="record-actions">
                    <div class="badge">${r.status}</div>
                    <strong>${entry?.score ?? "-"}</strong>
                  </div>
                </div>
              `;
            }).join("")}
        </div>

        <div class="exchange">
          <button id="export-json" class="ghost">JSON</button>
          <button id="export-csv" class="ghost">CSV</button>
          <label class="file">
            Import <input type="file" id="import-file" accept=".json">
          </label>
        </div>
      </div>

      <div class="panel">
        <div id="editor-container">
          ${currentEditingId 
            ? renderEditor(records.find(r => r.id === currentEditingId)!)
            : `<div class="empty">Select a task to edit or create a new one</div>`}
        </div>

        <div class="week-panel">
          <div class="panel-title" style="margin-top: 2rem">
            <h2 style="font-size: 1.1rem">Suggested 7-Day Load</h2>
            <div style="display: flex; align-items: center; gap: 0.5rem">
              <label style="margin: 0; font-size: 0.7rem">Limit:</label>
              <input type="number" id="capacity-input" value="${dailyCapacity}" style="width: 60px; padding: 0.2rem 0.4rem; font-size: 0.8rem">
              <span style="font-size: 0.7rem">m/day</span>
            </div>
          </div>
          <div class="week">
            ${dailyLoad.map(day => `
              <div class="day ${day.overloaded ? 'over' : ''}">
                <small><strong>${getDayName(day.date)}</strong> ${day.date}</small>
                <strong>${day.used}m</strong>
                <div style="font-size: 0.6rem; margin-top: 0.4rem; opacity: 0.8">
                  ${day.entries.length} task${day.entries.length !== 1 ? 's' : ''}
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    </div>
  `;

  setupListeners();
}

function renderEditor(record: LifeRecord) {
  const others = store.all().filter(r => r.id !== record.id);
  return `
    <div class="panel-title">
      <h2>Edit ${theme.itemLabel}</h2>
      <button id="delete-btn" class="danger">Delete</button>
    </div>
    <form id="task-form">
      <label>Title</label>
      <input type="text" name="title" value="${record.title}">
      
      <div class="form-grid">
        <div>
          <label>${theme.dateLabel}</label>
          <input type="date" name="dueDate" value="${record.dueDate}">
        </div>
        <div>
          <label>Category</label>
          <select name="category">
            ${theme.categories.map(c => `<option value="${c}" ${c === record.category ? 'selected' : ''}>${c}</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="form-grid">
        <div>
          <label>${theme.effortLabel}</label>
          <input type="number" name="effort" value="${record.effort}">
        </div>
        <div>
          <label>${theme.impactLabel} (1-5)</label>
          <input type="number" name="impact" value="${record.impact}">
        </div>
      </div>

      <label>Status</label>
      <select name="status">
        <option value="planned" ${record.status === 'planned' ? 'selected' : ''}>Planned</option>
        <option value="active" ${record.status === 'active' ? 'selected' : ''}>Active</option>
        <option value="done" ${record.status === 'done' ? 'selected' : ''}>Done</option>
      </select>

      <div style="margin-top: 1rem">
        <label>Dependencies (Blocked By)</label>
        <select name="dependsOn" multiple style="height: 100px">
          ${others.map(o => `<option value="${o.id}" ${record.dependsOn?.includes(o.id) ? 'selected' : ''}>${o.title}</option>`).join("")}
        </select>
        <small style="display: block; margin-top: 0.3rem; color: #698078">Hold Ctrl/Cmd to select multiple</small>
      </div>

      <label style="margin-top: 1rem">Notes</label>
      <textarea name="notes" rows="4">${record.notes}</textarea>

      <div id="form-errors" class="errors"></div>

      <div class="form-actions">
        <button type="submit">Save Changes</button>
        <button type="button" id="cancel-btn" class="ghost">Cancel</button>
      </div>
    </form>
  `;
}

function setupListeners() {
  app.onclick = (e) => {
    const target = e.target as HTMLElement;
    
    if (target.id === "add-btn") {
      const id = crypto.randomUUID();
      const newRecord: LifeRecord = {
        id,
        title: "New Task",
        category: theme.categories[0],
        dueDate: localDay(),
        effort: 30,
        impact: 3,
        status: "planned",
        notes: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        dependsOn: [],
      };
      store.upsert(newRecord);
      currentEditingId = id;
      render();
      return;
    }

    const recordDiv = target.closest(".record") as HTMLElement;
    if (recordDiv) {
      currentEditingId = recordDiv.dataset.id || null;
      render();
      return;
    }

    if (target.id === "delete-btn" && currentEditingId) {
      store.remove(currentEditingId);
      currentEditingId = null;
      render();
      return;
    }

    if (target.id === "cancel-btn") {
      currentEditingId = null;
      render();
      return;
    }

    if (target.id === "export-json") {
      download("backup.json", exportJson(store.all()), "application/json");
      return;
    }

    if (target.id === "export-csv") {
      download("export.csv", exportCsv(store.all()), "text/csv");
      return;
    }

    if (target.id === "import-file" && target instanceof HTMLInputElement) {
      const file = target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const records = importJson(e.target?.result as string, theme);
          store.replace(records);
          render();
        } catch (err: any) {
          alert(err.message);
        }
      };
      reader.readAsText(file);
      return;
    }

    const searchInput = app.querySelector("#search") as HTMLInputElement;
    if (searchInput && target === searchInput) {
      searchQuery = searchInput.value;
      render();
    }
  };

  const capacityInput = app.querySelector("#capacity-input") as HTMLInputElement;
  if (capacityInput) {
    capacityInput.oninput = (e) => {
      dailyCapacity = parseInt((e.target as HTMLInputElement).value) || 1;
      render();
    };
  }

  const form = app.querySelector("#task-form") as HTMLFormElement;
  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!currentEditingId) return;

      const formData = new FormData(form);
      const dependsOnSelect = form.querySelector('select[name="dependsOn"]') as HTMLSelectElement;
      const selectedDeps = Array.from(dependsOnSelect.selectedOptions).map(opt => opt.value);

      const updated: Partial<LifeRecord> = {
        title: formData.get("title") as string,
        dueDate: formData.get("dueDate") as string,
        category: formData.get("category") as string,
        effort: parseInt(formData.get("effort") as string) || 0,
        impact: parseInt(formData.get("impact") as string) || 0,
        status: formData.get("status") as ItemStatus,
        notes: formData.get("notes") as string,
        dependsOn: selectedDeps,
      };

      const errors = validateRecord(updated, theme);
      const errorDiv = app.querySelector("#form-errors")!;
      if (errors.length > 0) {
        errorDiv.innerHTML = errors.join("<br>");
        return;
      }

      const record = store.all().find(r => r.id === currentEditingId);
      if (record) {
        store.upsert({
          ...record,
          ...updated,
          updatedAt: new Date().toISOString(),
        });
      }
      render();
    };
  }
}

store.subscribe(render);
render();
