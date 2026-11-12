'use strict';

const state = {
  activeUseCase: null,
  useCases: [],
  dataSources: [],
  rules: [],
  dependencyGraph: null,
  testCases: [],
  latestRun: null,
  runs: [],
  reviews: [],
  auditLogs: [],
  resultRecords: [],
  sortColumn: null,
  sortDirection: 'asc',
  editingRuleExists: false
};

function getActor() {
  const sel = document.getElementById('activeActorInput');
  return sel ? sel.value : 'Kovács Anna (Üzleti Szabálygazda)';
}

function showToast(message, type = 'info') {
  const banner = document.getElementById('toastBanner');
  if (!banner) return;
  banner.textContent = message;
  banner.className = `toast-banner ${type === 'error' ? 'toast-error' : (type === 'success' ? 'toast-success' : '')}`;
  banner.classList.remove('hidden');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    banner.classList.add('hidden');
  }, 6000);
}

function escapeHtml(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderStatusBadge(status) {
  const st = status || 'Accepted';
  const cls = 'status-' + st.replace(/\s+/g, '-');
  return `<span class="status-badge ${escapeHtml(cls)}">${escapeHtml(st)}</span>`;
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP hiba (${res.status})`);
  }
  return data;
}

async function loadBootstrapState() {
  try {
    const boot = await apiFetch('/api/bootstrap');
    state.activeUseCase = boot.activeUseCase;
    state.useCases = boot.useCases || [];
    state.dataSources = boot.dataSources || [];
    state.rules = boot.rules || [];
    state.dependencyGraph = boot.dependencyGraph || {};
    state.testCases = boot.testCases || [];
    state.latestRun = boot.latestRun;
    state.runs = boot.runs || [];
    state.reviews = boot.reviews || [];
    state.auditLogs = boot.auditLogs || [];

    renderHeaderControls();
    await loadResultGrid();
    renderDataSetupTab();
    renderRuleManagerTab();
    renderDependenciesTab();
    renderTestingTab();
    renderExecutionTab();
    renderHumanReviewTab();
    await loadSelfCheckAndAuditTab();
    updateBuilderLiveJson();
  } catch (err) {
    showToast(`Hiba a rendszerállapot betöltésekor: ${err.message}`, 'error');
  }
}

function renderHeaderControls() {
  const ucSel = document.getElementById('useCaseSelector');
  if (ucSel) {
    ucSel.innerHTML = state.useCases.map(uc =>
      `<option value="${escapeHtml(uc.id)}" ${state.activeUseCase && uc.id === state.activeUseCase.id ? 'selected' : ''}>${escapeHtml(uc.name)} [${escapeHtml(uc.id)}]</option>`
    ).join('');
  }

  document.getElementById('navBadgeSources').textContent = state.dataSources.length;
  document.getElementById('navBadgeRules').textContent = state.rules.length;
  document.getElementById('navBadgeTests').textContent = state.testCases.length;
}

// ============================================================================
// TAB 1: RESULT VIEWER & SECTION 5 SHOWCASE (Section 5 & 12)
// ============================================================================
async function loadResultGrid() {
  const statusFilter = document.getElementById('resultStatusFilter')?.value || 'ALL';
  const searchVal = document.getElementById('resultSearchInput')?.value || '';
  const params = new URLSearchParams();
  if (statusFilter !== 'ALL') params.set('status', statusFilter);
  if (searchVal.trim()) params.set('search', searchVal.trim());

  const res = await apiFetch(`/api/results?${params.toString()}`);
  state.resultRecords = res.records || [];
  if (res.run) {
    state.latestRun = res.run;
  }

  document.getElementById('navBadgeResults').textContent = res.totalCount || state.resultRecords.length;
  document.getElementById('gridCountLabel').textContent = `${state.resultRecords.length} / ${res.totalCount || 0}`;

  const reviewCount = state.resultRecords.filter(r => r.finalStatus !== 'Accepted').length;
  document.getElementById('navBadgeReview').textContent = reviewCount;

  renderResultsKpis(res.run);
  renderSection5Showcase();
  renderMainResultsTable();
}

function renderResultsKpis(run) {
  const strip = document.getElementById('resultsKpiStrip');
  if (!strip) return;
  const counts = (run && run.statusCounts) || {};
  const prodCount = state.rules.filter(r => r.lifecycleStatus === 'Prod').length;

  strip.innerHTML = `
    <div class="kpi-box">
      <span class="kpi-label">Kiértékelt Rekordok</span>
      <span class="kpi-val">${run ? run.recordCount : state.resultRecords.length}</span>
      <span class="kpi-sub">Futtatás: ${run ? escapeHtml(run.runId) : '-'}</span>
    </div>
    <div class="kpi-box">
      <span class="kpi-label">Éles (Prod) Szabályok</span>
      <span class="kpi-val" style="color:var(--primary)">${prodCount} / ${state.rules.length}</span>
      <span class="kpi-sub">Determinisztikus DAG</span>
    </div>
    <div class="kpi-box">
      <span class="kpi-label">Accepted (Megfelel)</span>
      <span class="kpi-val" style="color:var(--success)">${counts['Accepted'] || 0}</span>
      <span class="kpi-sub">Automatikusan feldolgozható</span>
    </div>
    <div class="kpi-box">
      <span class="kpi-label">Requires Review</span>
      <span class="kpi-val" style="color:var(--review)">${counts['Requires Review'] || 0}</span>
      <span class="kpi-sub">Emberi felülvizsgálatra vár</span>
    </div>
    <div class="kpi-box">
      <span class="kpi-label">Warning (Figyelmeztetés)</span>
      <span class="kpi-val" style="color:var(--warning)">${counts['Warning'] || 0}</span>
      <span class="kpi-sub">Nem kritikus eltérés</span>
    </div>
    <div class="kpi-box">
      <span class="kpi-label">Error (Üzleti Hiba)</span>
      <span class="kpi-val" style="color:var(--error)">${counts['Error'] || 0}</span>
      <span class="kpi-sub">Üzleti szabály megsértése</span>
    </div>
    <div class="kpi-box">
      <span class="kpi-label">Execution Failed</span>
      <span class="kpi-val" style="color:var(--tech-fail)">${counts['Execution Failed'] || 0}</span>
      <span class="kpi-sub">Technikai végrehajtási hiba</span>
    </div>
  `;
}

function renderSection5Showcase() {
  const container = document.getElementById('section5MiniTableContainer');
  const card = document.getElementById('specSection5Showcase');
  if (!container || !card) return;

  if (!state.activeUseCase || state.activeUseCase.id !== 'UC-WINDOW-ORDERS') {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  const benchmarkIds = ['1001', '1002', '1003'];
  const rows = state.resultRecords.filter(r => benchmarkIds.includes(String(r.recordId)));
  if (rows.length === 0) {
    container.innerHTML = `<p class="text-muted">Szűrő aktív – állítsa a státuszszűrőt "Minden státusz"-ra az 1001, 1002, 1003 példarekordok együttes megjelenítéséhez.</p>`;
    return;
  }

  container.innerHTML = `
    <table class="data-grid">
      <thead>
        <tr>
          <th>Rendelés</th>
          <th>Termék</th>
          <th>Anyag &amp; Méret</th>
          <th>Gyártható (R-048)</th>
          <th>Címellenőrzés (R-058)</th>
          <th>Státusz (Eredeti Szabályeredmény)</th>
          <th>Emberi Felülbírálat (Section 13)</th>
          <th>Részletes Indoklás (SC-09)</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr onclick="openRecordTraceModal('${escapeHtml(r.recordId)}')">
            <td><strong>#${escapeHtml(r.recordId)}</strong></td>
            <td><strong>${escapeHtml(r.sourceData.termek)}</strong></td>
            <td>${escapeHtml(r.sourceData.anyag)} (${escapeHtml(r.sourceData.szelesseg_mm)}×${escapeHtml(r.sourceData.magassag_mm)} mm)</td>
            <td class="col-enriched"><strong>${escapeHtml(r.enrichedData.gyarthato ?? '-')}</strong></td>
            <td class="col-enriched"><strong>${escapeHtml(r.enrichedData.cimellenorzes ?? '-')}</strong></td>
            <td>${renderStatusBadge(r.finalStatus)}</td>
            <td>${r.humanReview ? `<span class="val-badge val-Passed">✓ ${escapeHtml(r.humanReview.decision)}</span>` : '<span class="text-muted">-</span>'}</td>
            <td>
              <button class="btn btn-xs btn-outline" onclick="event.stopPropagation(); openRecordTraceModal('${escapeHtml(r.recordId)}')">
                🔍 80 Szabály Lépésenkénti Indoklása
              </button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderMainResultsTable() {
  const thead = document.getElementById('mainResultsThead');
  const tbody = document.getElementById('mainResultsTbody');
  if (!thead || !tbody) return;

  const colMode = document.getElementById('resultColumnMode')?.value || 'focused';
  const records = [...state.resultRecords];

  if (records.length === 0) {
    thead.innerHTML = '<tr><th>Nincs megjeleníthető rekord</th></tr>';
    tbody.innerHTML = '<tr><td class="text-muted">Nincs a szűrési feltételeknek megfelelő rekord.</td></tr>';
    return;
  }

  const mappingCols = (state.activeUseCase && state.activeUseCase.mappingConfig && state.activeUseCase.mappingConfig.displayColumns) || [];
  let cols = [];

  if (colMode === 'focused' && mappingCols.length > 0) {
    cols = mappingCols;
  } else {
    const srcKeys = Object.keys(records[0].sourceData || {});
    const enrKeys = Object.keys(records[0].enrichedData || {}).slice(0, 14);
    cols = [
      ...srcKeys.map(k => ({ key: k, header: k, source: 'source' })),
      ...enrKeys.map(k => ({ key: k, header: `[Szabály] ${k}`, source: 'enriched' }))
    ];
  }

  // Sort if active
  if (state.sortColumn) {
    const colKey = state.sortColumn;
    const dir = state.sortDirection === 'asc' ? 1 : -1;
    records.sort((a, b) => {
      const va = colKey === '__status' ? a.finalStatus : (a.enrichedData[colKey] ?? a.sourceData[colKey] ?? '');
      const vb = colKey === '__status' ? b.finalStatus : (b.enrichedData[colKey] ?? b.sourceData[colKey] ?? '');
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  thead.innerHTML = `
    <tr>
      ${cols.map(c => `<th onclick="sortResultGrid('${escapeHtml(c.key)}')">${escapeHtml(c.header)} ${state.sortColumn === c.key ? (state.sortDirection === 'asc' ? '▲' : '▼') : ''}</th>`).join('')}
      <th onclick="sortResultGrid('__status')">Státusz</th>
      <th>Emberi Döntés</th>
      <th>Fő Eltérés / Indoklás</th>
      <th>Vizsgálat</th>
    </tr>
  `;

  tbody.innerHTML = records.map(r => {
    const cellsHtml = cols.map(c => {
      const val = c.source === 'enriched' ? r.enrichedData[c.key] : (r.sourceData[c.key] ?? r.enrichedData[c.key]);
      const cls = c.source === 'enriched' ? 'col-enriched' : '';
      return `<td class="${cls}">${escapeHtml(val ?? '-')}</td>`;
    }).join('');

    return `
      <tr onclick="openRecordTraceModal('${escapeHtml(r.recordId)}')">
        ${cellsHtml}
        <td>${renderStatusBadge(r.finalStatus)}</td>
        <td>
          ${r.humanReview
            ? `<span class="val-badge val-Passed" title="${escapeHtml(r.humanReview.comment)}">${escapeHtml(r.humanReview.decision)}</span>`
            : (r.requiresHumanReview ? '<span class="val-badge val-Stale">Felülvizsgálatra vár</span>' : '<span class="text-muted">Auto OK</span>')}
        </td>
        <td style="max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(r.statusReason)}">
          ${escapeHtml(r.statusReason)}
        </td>
        <td>
          <button class="btn btn-xs btn-outline" onclick="event.stopPropagation(); openRecordTraceModal('${escapeHtml(r.recordId)}')">
            Részletek
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

window.sortResultGrid = function(colKey) {
  if (state.sortColumn === colKey) {
    state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortColumn = colKey;
    state.sortDirection = 'asc';
  }
  renderMainResultsTable();
};

// ============================================================================
// RECORD-LEVEL RULE EXPLANATION MODAL (SC-09 & Section 12 & 13)
// ============================================================================
window.openRecordTraceModal = async function(recordId) {
  try {
    const detail = await apiFetch(`/api/results/${encodeURIComponent(recordId)}`);
    const modal = document.getElementById('recordTraceModal');
    document.getElementById('traceModalTitle').textContent = `Rekordszintű Szabálymagyarázat – Rekord #${detail.recordId}`;
    document.getElementById('traceModalSubtitle').textContent = `Futtatás: ${detail.runId} | Végső szabálystátusz: ${detail.finalStatus} | Lefutott szabályok: ${detail.ruleTraces.length} db`;

    const deviationsHtml = detail.deviations.length > 0
      ? detail.deviations.map(d => `
          <div style="padding:8px 12px; background:#fef2f2; border-left:4px solid var(--error); border-radius:4px; margin-bottom:6px;">
            <strong>[${escapeHtml(d.ruleId)}] ${escapeHtml(d.ruleName)}</strong> (${renderStatusBadge(d.status)}):
            <div>${escapeHtml(d.message)}</div>
          </div>
        `).join('')
      : `<div style="padding:10px; background:#ecfdf5; border:1px solid #6ee7b7; border-radius:6px; color:#065f46; font-weight:600;">
          ✓ Ez a rekord minden éles üzleti szabálynak maradéktalanul megfelelt (0 eltérés).
        </div>`;

    const bodyEl = document.getElementById('traceModalBody');
    bodyEl.innerHTML = `
      <div class="grid-2col">
        <div class="card" style="padding:12px;">
          <h3>1. Sértetlen Forrásadatok (Source Data Snapshot)</h3>
          <pre class="json-preview" style="max-height:180px; margin-top:6px;">${escapeHtml(JSON.stringify(detail.sourceData, null, 2))}</pre>
        </div>
        <div class="card" style="padding:12px;">
          <h3>2. Kapcsolt Referencia- és Számított Eredménymezők</h3>
          <pre class="json-preview" style="max-height:180px; margin-top:6px;">${escapeHtml(JSON.stringify({ ...detail.joinedData, ...detail.enrichedData }, null, 2))}</pre>
        </div>
      </div>

      <div class="card" style="padding:12px;">
        <h3>3. Eltérések és Végső Státusz Indoklása (${renderStatusBadge(detail.finalStatus)})</h3>
        <div style="margin-top:8px;">${deviationsHtml}</div>
      </div>

      <!-- Inline Human Verification Form inside Record Inspector -->
      <div class="card" style="padding:12px; background:#faf5ff; border-color:#c4b5fd;">
        <h3>4. Emberi Ellenőrzés / Naplózott Felülbírálat (Human Verification – Specifikáció 13. fejezet)</h3>
        <p class="text-muted">A felülbírálat külön auditált rétegben tárolódik; az eredeti szabályeredmény (${escapeHtml(detail.finalStatus)}) és a forrásadat változatlan marad.</p>
        <div class="form-row" style="margin-top:8px; align-items:flex-end;">
          <div class="form-field">
            <label>Emberi Döntés</label>
            <select id="modalReviewDecision" class="input-control">
              <option value="Approved Exception">Approved Exception (Kivételként elfogadva / Jóváhagyva)</option>
              <option value="Confirmed Reject">Confirmed Reject (Elutasítás megerősítve)</option>
              <option value="Correction Requested">Correction Requested (Javításra visszaküldve)</option>
            </select>
          </div>
          <div class="form-field" style="flex:2;">
            <label>Kötelező üzleti indoklás / megjegyzés</label>
            <input type="text" id="modalReviewComment" class="input-control" placeholder="Pl. Ügyféllel egyeztetett építési cím, kiszállítás engedélyezve..." />
          </div>
          <button class="btn btn-primary" onclick="submitReviewFromModal('${escapeHtml(detail.recordId)}')">Felülbírálat Rögzítése</button>
        </div>
      </div>

      <div class="card" style="padding:12px;">
        <h3>5. Teljes Lefutott Szabálylánc (${detail.ruleTraces.length} szabály végrehajtási sorrendben – SC-09)</h3>
        <div class="table-scroll-wrapper" style="max-height:320px; margin-top:8px;">
          <table class="data-grid">
            <thead>
              <tr>
                <th>#</th>
                <th>Szabály ID &amp; Név</th>
                <th>Kategória</th>
                <th>Eredménymező = Érték</th>
                <th>Státuszhatás</th>
                <th>Szabálymagyarázat és Feltételértékelés</th>
              </tr>
            </thead>
            <tbody>
              ${detail.ruleTraces.map(t => `
                <tr>
                  <td>${escapeHtml(t.executionOrder)}</td>
                  <td><strong>${escapeHtml(t.ruleId)}</strong> – ${escapeHtml(t.ruleName)} <span class="text-muted">(v${escapeHtml(t.version)})</span></td>
                  <td>${escapeHtml(t.category)}</td>
                  <td class="code-font col-enriched"><strong>${escapeHtml(t.outputField)}</strong> = ${escapeHtml(JSON.stringify(t.outputValue))}</td>
                  <td>${renderStatusBadge(t.statusEffect)}</td>
                  <td>
                    <div>${escapeHtml(t.explanation)}</div>
                    ${t.conditionTraces && t.conditionTraces.length > 0
                      ? `<div class="text-muted code-font" style="font-size:11px; margin-top:2px;">${escapeHtml(t.conditionTraces.map(ct => ct.traceText).join(' | '))}</div>`
                      : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    modal.classList.remove('hidden');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.submitReviewFromModal = async function(recordId) {
  const decision = document.getElementById('modalReviewDecision')?.value;
  const comment = document.getElementById('modalReviewComment')?.value;
  try {
    await apiFetch('/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        recordId,
        decision,
        comment,
        reviewedBy: getActor()
      })
    });
    showToast(`Emberi felülbírálat sikeresen naplózva a(z) #${recordId} rekordhoz!`, 'success');
    document.getElementById('recordTraceModal').classList.add('hidden');
    await loadBootstrapState();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ============================================================================
// TAB 2: DATA SETUP & MAPPING (Section 7)
// ============================================================================
function renderDataSetupTab() {
  const dsContainer = document.getElementById('dataSourcesListContainer');
  if (dsContainer) {
    dsContainer.innerHTML = state.dataSources.map(ds => `
      <div class="card" style="margin-bottom:10px; padding:12px; background:#f8fafc;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div>
            <strong>${escapeHtml(ds.name)}</strong>
            <span class="version-pill">${escapeHtml(ds.id)}</span>
            <span class="lifecycle-badge ${ds.isPrimary ? 'lifecycle-Prod' : 'lifecycle-Test'}">${ds.isPrimary ? 'Fő adathalmaz (Primary)' : escapeHtml(ds.sourceType)}</span>
          </div>
          <span class="val-badge val-Passed" title="SHA-256: ${escapeHtml(ds.sha256Checksum)}">
            🔒 SHA-256 Sértetlen: ${escapeHtml(ds.sha256Checksum.slice(0, 12))}... (${ds.recordCount} rekord)
          </span>
        </div>
        <div class="text-muted" style="margin-top:6px;">
          Mezők (${ds.schemaFields.length}): <code>${escapeHtml(ds.schemaFields.map(f => f.name).join(', '))}</code>
        </div>
      </div>
    `).join('');
  }

  const mapContainer = document.getElementById('dataMappingContainer');
  if (mapContainer && state.activeUseCase) {
    const mc = state.activeUseCase.mappingConfig || {};
    const rels = mc.relationships || [];
    const aggs = mc.crossRecordAggregations || [];

    mapContainer.innerHTML = `
      <div class="grid-2col">
        <div>
          <h3>Adatkapcsolatok (Join Keys &amp; Hiányzó/Többszörös Találat Kezelés)</h3>
          <p class="text-muted" style="margin-bottom:8px;">Elsődleges kulcs (Primary Key): <code>${escapeHtml(mc.primaryKey || 'id')}</code></p>
          <table class="data-grid">
            <thead>
              <tr>
                <th>Kapcsolat Neve</th>
                <th>Fő Mező → Célforrás.Mező</th>
                <th>Hiányzó találat</th>
                <th>Többszörös találat</th>
              </tr>
            </thead>
            <tbody>
              ${rels.map(r => `
                <tr>
                  <td><strong>${escapeHtml(r.name)}</strong></td>
                  <td class="code-font">${escapeHtml(r.sourceKey)} → ${escapeHtml(r.targetSourceId)}.${escapeHtml(r.targetKey)}</td>
                  <td><span class="val-badge val-Untested">${escapeHtml(r.onMissing)}</span></td>
                  <td><span class="val-badge val-Passed">${escapeHtml(r.onMultiple)}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div>
          <h3>Több Rekordot Érintő Aggregációk (Cross-Record Aggregations)</h3>
          <p class="text-muted" style="margin-bottom:8px;">A szabályok ezeket az aggregált mezőket közvetlenül felhasználhatják (pl. R-077 ügyfél hitelkeret vizsgálat).</p>
          <table class="data-grid">
            <thead>
              <tr>
                <th>Aggregáció</th>
                <th>Csoportosítás (Group By)</th>
                <th>Függvény</th>
                <th>Kimeneti Mező</th>
              </tr>
            </thead>
            <tbody>
              ${aggs.map(a => `
                <tr>
                  <td><strong>${escapeHtml(a.name)}</strong></td>
                  <td class="code-font">${escapeHtml(a.groupByField)}</td>
                  <td><span class="lifecycle-badge lifecycle-Test">${escapeHtml(a.fn.toUpperCase())}</span>(${escapeHtml(a.aggregateField)})</td>
                  <td class="code-font col-enriched">${escapeHtml(a.outputField)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
}

// ============================================================================
// TAB 3: RULE MANAGER (Section 9, SC-02)
// ============================================================================
function renderRuleManagerTab() {
  const kpiStrip = document.getElementById('rulesKpiStrip');
  const counts = { Prod: 0, Test: 0, Draft: 0, Retired: 0 };
  const categories = new Set();

  for (const r of state.rules) {
    counts[r.lifecycleStatus] = (counts[r.lifecycleStatus] || 0) + 1;
    if (r.category) categories.add(r.category);
  }

  if (kpiStrip) {
    kpiStrip.innerHTML = `
      <div class="kpi-box">
        <span class="kpi-label">Összes Szabály (SC-02)</span>
        <span class="kpi-val">${state.rules.length}</span>
        <span class="kpi-sub">Minimum elvárás: 80 szabály</span>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">Prod (Éles Szabályok)</span>
        <span class="kpi-val" style="color:var(--success)">${counts.Prod}</span>
        <span class="kpi-sub">Jóváhagyott és aktív</span>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">Test (Teszt Fázisban)</span>
        <span class="kpi-val" style="color:var(--primary)">${counts.Test}</span>
        <span class="kpi-sub">Jóváhagyásra kész</span>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">Draft (Tervezet)</span>
        <span class="kpi-val" style="color:var(--warning)">${counts.Draft}</span>
        <span class="kpi-sub">Szerkesztés alatt</span>
      </div>
      <div class="kpi-box">
        <span class="kpi-label">Retired (Kivont)</span>
        <span class="kpi-val" style="color:var(--text-muted)">${counts.Retired}</span>
        <span class="kpi-sub">Audit célból megőrzött</span>
      </div>
    `;
  }

  // Populate category filter
  const catFilter = document.getElementById('ruleCategoryFilter');
  if (catFilter && catFilter.options.length <= 1) {
    const sortedCats = Array.from(categories).sort();
    catFilter.innerHTML = `<option value="ALL">Minden kategória (${sortedCats.length} réteg)</option>` +
      sortedCats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  }

  renderRulesTableRows();
}

function renderRulesTableRows() {
  const tbody = document.getElementById('rulesTbody');
  if (!tbody) return;

  const q = (document.getElementById('ruleSearchInput')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('ruleStatusFilter')?.value || 'ALL';
  const catFilter = document.getElementById('ruleCategoryFilter')?.value || 'ALL';

  const filtered = state.rules.filter(r => {
    if (statusFilter !== 'ALL' && r.lifecycleStatus !== statusFilter) return false;
    if (catFilter !== 'ALL' && r.category !== catFilter) return false;
    if (q) {
      const hay = `${r.id} ${r.name} ${r.description} ${r.category} ${(r.inputFields || []).join(' ')} ${r.output?.outputField || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  document.getElementById('ruleCountLabel').textContent = `${filtered.length} / ${state.rules.length}`;

  tbody.innerHTML = filtered.map(r => `
    <tr>
      <td><strong>#${escapeHtml(r.executionOrder)}</strong></td>
      <td class="code-font"><strong>${escapeHtml(r.id)}</strong></td>
      <td>
        <div><strong>${escapeHtml(r.name)}</strong></div>
        <div class="text-muted">${escapeHtml(r.category)} – ${escapeHtml(r.description)}</div>
      </td>
      <td><span class="version-pill">${escapeHtml(r.ruleType)}</span></td>
      <td class="code-font" style="max-width:180px;">${escapeHtml((r.inputFields || []).join(', ') || '-')}</td>
      <td class="code-font col-enriched">
        <div><strong>${escapeHtml(r.output?.outputField || '-')}</strong></div>
        <div class="text-muted">Hamis → ${escapeHtml(r.output?.onFalseStatus || 'Accepted')}</div>
      </td>
      <td class="code-font">
        ${r.dependencies && r.dependencies.length > 0
          ? r.dependencies.map(d => `<span class="version-pill">${escapeHtml(d)}</span>`).join(' ')
          : '<span class="text-muted">Alapszabály (L1)</span>'}
      </td>
      <td><span class="lifecycle-badge lifecycle-${escapeHtml(r.lifecycleStatus)}">${escapeHtml(r.lifecycleStatus)}</span></td>
      <td><span class="val-badge val-${escapeHtml(r.validationStatus)}">${escapeHtml(r.validationStatus)}</span></td>
      <td>
        <div><strong>v${escapeHtml(r.version)}</strong></div>
        <div class="text-muted" style="font-size:11px;">${escapeHtml(r.approvedBy || 'Nincs jóváhagyva')}</div>
      </td>
      <td>
        <div style="display:flex; gap:4px; flex-wrap:wrap;">
          <button class="btn btn-xs btn-outline" onclick="loadRuleIntoBuilder('${escapeHtml(r.id)}')">✎ Szerkeszt</button>
          <button class="btn btn-xs btn-outline" onclick="inspectRuleImpact('${escapeHtml(r.id)}')">🔗 Hatás</button>
        </div>
      </td>
    </tr>
  `).join('');
}

// ============================================================================
// TAB 4: RULE BUILDER (AI + Visual + Decision Table + Expression - Section 8)
// ============================================================================
function initRuleBuilderDefaults() {
  const container = document.getElementById('rbConditionRowsContainer');
  if (container && container.children.length === 0) {
    addVisualConditionRow({ field: 'szelesseg_mm', operator: '<=', value: '2400' });
  }
  const dtContainer = document.getElementById('rbDtRowsContainer');
  if (dtContainer && dtContainer.children.length === 0) {
    addDecisionTableRow({ conds: 'Door B | PVC | > 1400', outputValue: 'Nem', statusEffect: 'Error', reason: 'PVC Door B 1400 mm felett nem gyártható' });
    addDecisionTableRow({ conds: '* | * | [400..2400]', outputValue: 'Igen', statusEffect: 'Accepted', reason: 'Megengedett kombináció' });
  }
  const nextNum = (state.rules?.length || 85) + 1;
  const idInput = document.getElementById('rbRuleId');
  if (idInput && !idInput.value) {
    idInput.value = `R-${String(nextNum).padStart(3, '0')}`;
  }
}

function addVisualConditionRow(initial = {}) {
  const container = document.getElementById('rbConditionRowsContainer');
  if (!container) return;

  const div = document.createElement('div');
  div.className = 'condition-row';
  div.innerHTML = `
    <input type="text" class="input-control input-sm cond-field code-font" placeholder="Mező (pl. szelesseg_mm)" value="${escapeHtml(initial.field || 'szelesseg_mm')}" />
    <select class="input-control input-sm cond-op">
      ${['==', '!=', '<=', '>=', '<', '>', 'between', 'in', 'not_in', 'contains', 'not_contains', 'is_not_null', 'is_null', 'equals_field', 'lte_field'].map(op =>
        `<option value="${op}" ${initial.operator === op ? 'selected' : ''}>${op}</option>`
      ).join('')}
    </select>
    <input type="text" class="input-control input-sm cond-val code-font" placeholder="Érték (pl. 2400 vagy 400..2400)" value="${escapeHtml(Array.isArray(initial.value) ? initial.value.join('..') : (initial.value ?? '2400'))}" />
    <button type="button" class="btn btn-xs btn-danger" onclick="this.parentElement.remove(); updateBuilderLiveJson();">✕</button>
  `;
  div.querySelectorAll('input, select').forEach(el => el.addEventListener('input', updateBuilderLiveJson));
  container.appendChild(div);
  updateBuilderLiveJson();
}

function addDecisionTableRow(initial = {}) {
  const container = document.getElementById('rbDtRowsContainer');
  if (!container) return;

  const div = document.createElement('div');
  div.className = 'condition-row';
  div.innerHTML = `
    <input type="text" class="input-control input-sm dt-conds code-font" style="flex:2" placeholder="Feltételek | jellel (pl. Door B | PVC | > 1400)" value="${escapeHtml(initial.conds || '* | * | <= 2400')}" />
    <input type="text" class="input-control input-sm dt-out" placeholder="Kimenet (pl. Nem)" value="${escapeHtml(initial.outputValue ?? 'Igen')}" />
    <select class="input-control input-sm dt-status">
      ${['Accepted', 'Warning', 'Requires Review', 'Error'].map(s => `<option value="${s}" ${initial.statusEffect === s ? 'selected' : ''}>${s}</option>`).join('')}
    </select>
    <input type="text" class="input-control input-sm dt-reason" style="flex:2" placeholder="Indoklás" value="${escapeHtml(initial.reason || '')}" />
    <button type="button" class="btn btn-xs btn-danger" onclick="this.parentElement.remove(); updateBuilderLiveJson();">✕</button>
  `;
  div.querySelectorAll('input, select').forEach(el => el.addEventListener('input', updateBuilderLiveJson));
  container.appendChild(div);
  updateBuilderLiveJson();
}

function buildRuleObjectFromForm() {
  const ruleType = document.getElementById('rbRuleType')?.value || 'visual_condition';
  const id = (document.getElementById('rbRuleId')?.value || 'R-086').trim();
  const name = (document.getElementById('rbRuleName')?.value || 'Új strukturált üzleti szabály').trim();
  const category = (document.getElementById('rbRuleCategory')?.value || 'Általános').trim();
  const description = (document.getElementById('rbRuleDescription')?.value || name).trim();

  let conditions = null;
  let decisionTable = null;
  let expression = null;

  if (ruleType === 'visual_condition') {
    const combinator = document.getElementById('rbCombinator')?.value || 'AND';
    const rowEls = document.querySelectorAll('#rbConditionRowsContainer .condition-row');
    const rulesArr = Array.from(rowEls).map(rEl => {
      const field = rEl.querySelector('.cond-field').value.trim();
      const operator = rEl.querySelector('.cond-op').value;
      const rawVal = rEl.querySelector('.cond-val').value.trim();
      let value = rawVal;
      if (operator === 'between' && rawVal.includes('..')) {
        value = rawVal.split('..').map(x => Number(x.trim()));
      } else if ((operator === 'in' || operator === 'not_in') && rawVal.includes(',')) {
        value = rawVal.split(',').map(x => x.trim());
      } else if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
        value = Number(rawVal);
      } else if (rawVal === 'true') {
        value = true;
      } else if (rawVal === 'false') {
        value = false;
      }
      return { field, operator, value };
    });
    conditions = { combinator, rules: rulesArr };
  } else if (ruleType === 'decision_table') {
    const inputCols = (document.getElementById('rbDtInputs')?.value || 'termek, anyag, szelesseg_mm')
      .split(',').map(s => s.trim()).filter(Boolean);
    const hitPolicy = document.getElementById('rbDtHitPolicy')?.value || 'FIRST';
    const rowEls = document.querySelectorAll('#rbDtRowsContainer .condition-row');
    const rows = Array.from(rowEls).map(rEl => {
      const parts = rEl.querySelector('.dt-conds').value.split('|').map(s => s.trim());
      const condObj = {};
      inputCols.forEach((col, i) => {
        condObj[col] = parts[i] !== undefined ? parts[i] : '*';
      });
      return {
        conditions: condObj,
        outputValue: rEl.querySelector('.dt-out').value.trim(),
        statusEffect: rEl.querySelector('.dt-status').value,
        reason: rEl.querySelector('.dt-reason').value.trim()
      };
    });
    decisionTable = {
      hitPolicy,
      inputs: inputCols.map(f => ({ field: f, label: f })),
      rows,
      defaultOutcome: { outputValue: 'Igen', statusEffect: 'Accepted', reason: 'Alapértelmezett ág' }
    };
  } else if (ruleType === 'expression') {
    expression = (document.getElementById('rbExpressionInput')?.value || '').trim();
  }

  const outputType = document.getElementById('rbOutputType')?.value || 'classification';
  const parseTypedVal = (v) => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  };

  const output = {
    outputField: (document.getElementById('rbOutputField')?.value || 'eredmeny_mezo').trim(),
    outputType,
    expression: ruleType === 'expression' ? expression : undefined,
    trueValue: parseTypedVal(document.getElementById('rbTrueValue')?.value ?? 'Igen'),
    falseValue: parseTypedVal(document.getElementById('rbFalseValue')?.value ?? 'Nem'),
    onTrueStatus: document.getElementById('rbOnTrueStatus')?.value || 'Accepted',
    onFalseStatus: document.getElementById('rbOnFalseStatus')?.value || 'Error',
    passMessage: document.getElementById('rbPassMessage')?.value || '',
    failMessage: document.getElementById('rbFailMessage')?.value || ''
  };

  return {
    id,
    name,
    category,
    description,
    ruleType,
    conditions,
    decisionTable,
    expression,
    output,
    lifecycleStatus: 'Draft'
  };
}

function updateBuilderLiveJson() {
  const preview = document.getElementById('rbLiveJsonPreview');
  if (!preview) return;
  const obj = buildRuleObjectFromForm();
  preview.textContent = JSON.stringify(obj, null, 2);
}

window.loadRuleIntoBuilder = function(ruleId) {
  const rule = state.rules.find(r => r.id === ruleId);
  if (!rule) return;

  state.editingRuleExists = true;
  document.getElementById('builderFormTitle').textContent = `Szabály Szerkesztése: ${rule.id} (v${rule.version}) – Mentéskor a függő szabályok tesztjei frissítendők!`;
  document.getElementById('rbRuleId').value = rule.id;
  document.getElementById('rbRuleName').value = rule.name;
  document.getElementById('rbRuleCategory').value = rule.category || 'Általános';
  document.getElementById('rbRuleDescription').value = rule.description || '';

  switchRuleBuilderMode(rule.ruleType || 'visual_condition');

  if (rule.ruleType === 'visual_condition' && rule.conditions) {
    document.getElementById('rbCombinator').value = rule.conditions.combinator || 'AND';
    const container = document.getElementById('rbConditionRowsContainer');
    container.innerHTML = '';
    (rule.conditions.rules || []).forEach(c => addVisualConditionRow(c));
  } else if (rule.ruleType === 'decision_table' && rule.decisionTable) {
    const inputs = (rule.decisionTable.inputs || []).map(i => typeof i === 'string' ? i : i.field);
    document.getElementById('rbDtInputs').value = inputs.join(', ');
    document.getElementById('rbDtHitPolicy').value = rule.decisionTable.hitPolicy || 'FIRST';
    const dtContainer = document.getElementById('rbDtRowsContainer');
    dtContainer.innerHTML = '';
    (rule.decisionTable.rows || []).forEach(row => {
      const conds = inputs.map(col => row.conditions[col] ?? '*').join(' | ');
      addDecisionTableRow({
        conds,
        outputValue: row.outputValue,
        statusEffect: row.statusEffect,
        reason: row.reason
      });
    });
  } else if (rule.ruleType === 'expression') {
    document.getElementById('rbExpressionInput').value = rule.expression || rule.output?.expression || '';
  }

  if (rule.output) {
    document.getElementById('rbOutputField').value = rule.output.outputField || '';
    document.getElementById('rbOutputType').value = rule.output.outputType || 'classification';
    document.getElementById('rbTrueValue').value = String(rule.output.trueValue ?? 'Igen');
    document.getElementById('rbFalseValue').value = String(rule.output.falseValue ?? 'Nem');
    document.getElementById('rbOnTrueStatus').value = rule.output.onTrueStatus || 'Accepted';
    document.getElementById('rbOnFalseStatus').value = rule.output.onFalseStatus || 'Error';
    document.getElementById('rbPassMessage').value = rule.output.passMessage || '';
    document.getElementById('rbFailMessage').value = rule.output.failMessage || '';
  }

  updateBuilderLiveJson();
  activateTab('rule-builder');
};

function switchRuleBuilderMode(mode) {
  document.getElementById('rbRuleType').value = mode;
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.rbmode === mode);
  });
  document.getElementById('rbVisualEditorPane').classList.toggle('hidden', mode !== 'visual_condition');
  document.getElementById('rbDecisionTablePane').classList.toggle('hidden', mode !== 'decision_table');
  document.getElementById('rbExpressionPane').classList.toggle('hidden', mode !== 'expression');
  updateBuilderLiveJson();
}

// ============================================================================
// TAB 5: RULE DEPENDENCIES & IMPACT ANALYSIS (Section 9 & SC-04)
// ============================================================================
function renderDependenciesTab() {
  const statusBanner = document.getElementById('dependencyStatusBanner');
  const dagContainer = document.getElementById('dagLayersContainer');
  const impactSel = document.getElementById('impactRuleSelector');

  if (impactSel) {
    const currentVal = impactSel.value;
    impactSel.innerHTML = state.rules
      .filter(r => r.lifecycleStatus !== 'Retired')
      .map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.id)} – ${escapeHtml(r.name)} (Kimenet: ${escapeHtml(r.output?.outputField)})</option>`)
      .join('');
    if (currentVal) impactSel.value = currentVal;
    else if (state.rules.some(r => r.id === 'R-011')) impactSel.value = 'R-011';
  }

  if (statusBanner && state.dependencyGraph) {
    const dg = state.dependencyGraph;
    statusBanner.innerHTML = `
      <div style="padding:10px 12px; margin-bottom:12px; border-radius:6px; background:${dg.valid ? '#ecfdf5' : '#fef2f2'}; border:1px solid ${dg.valid ? '#6ee7b7' : '#fca5a5'};">
        <strong>${dg.valid ? '✓ Függőségi Háló Érvényes (Ciklusmentes DAG)' : '✕ Körkörös Függőség Hiba'}</strong>:
        ${dg.edges ? dg.edges.length : 0} felismert adatfüggőségi kapcsolat a szabályok bemeneti és kimeneti mezői között.
      </div>
    `;
  }

  if (dagContainer) {
    // Group rules by category / topological layer
    const byCategory = new Map();
    for (const r of state.rules.filter(r => r.lifecycleStatus !== 'Retired')) {
      const cat = r.category || 'Általános';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(r);
    }

    dagContainer.innerHTML = Array.from(byCategory.entries()).map(([cat, rulesInCat]) => `
      <div class="dag-layer-box">
        <div class="dag-layer-title">${escapeHtml(cat)} (${rulesInCat.length} szabály)</div>
        <div class="dag-nodes-wrap">
          ${rulesInCat.map(r => `
            <div class="dag-node-chip" onclick="inspectRuleImpact('${escapeHtml(r.id)}')" title="Bemenet: ${(r.inputFields || []).join(', ')} -> Kimenet: ${r.output?.outputField}">
              <strong>${escapeHtml(r.id)}</strong>: ${escapeHtml(r.output?.outputField)}
              ${r.dependencies && r.dependencies.length > 0
                ? `<span class="text-muted">← [${escapeHtml(r.dependencies.join(','))}]</span>`
                : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
  }
}

window.inspectRuleImpact = async function(ruleId) {
  activateTab('dependencies');
  const sel = document.getElementById('impactRuleSelector');
  if (sel) sel.value = ruleId;
  await runImpactAnalysisForRule(ruleId);
};

async function runImpactAnalysisForRule(ruleId) {
  const container = document.getElementById('impactAnalysisResultContainer');
  if (!container) return;
  try {
    const impact = await apiFetch(`/api/dependencies/impact/${encodeURIComponent(ruleId)}`);
    const targetRule = state.rules.find(r => r.id === ruleId);

    container.innerHTML = `
      <div style="padding:12px; background:#eff6ff; border:1px solid #93c5fd; border-radius:6px; margin-bottom:12px;">
        <div><strong>Vizsgált Szabály:</strong> ${escapeHtml(ruleId)} – ${escapeHtml(targetRule ? targetRule.name : '')}</div>
        <div><strong>Előállított eredménymező:</strong> <code>${escapeHtml(targetRule?.output?.outputField || '-')}</code></div>
        <div><strong>Közvetlen függő szabályok:</strong> ${impact.directDependents.length} db | <strong>Összes érintett (tranzitív) függő szabály:</strong> <strong>${impact.allAffectedRuleIds.length} db</strong></div>
      </div>

      ${impact.affectedRules.length === 0
        ? `<p class="text-muted">Ettől a szabálytól nem függ másik későbbi szabály (levélszabály).</p>`
        : `
          <div class="table-scroll-wrapper" style="max-height:420px;">
            <table class="data-grid">
              <thead>
                <tr>
                  <th>Távolság</th>
                  <th>Érintett Szabály</th>
                  <th>Életciklus</th>
                  <th>Függőségi Útvonal (Impact Path)</th>
                </tr>
              </thead>
              <tbody>
                ${impact.affectedRules.map(ar => `
                  <tr>
                    <td><span class="version-pill">+${ar.distance}. szint</span></td>
                    <td><strong>${escapeHtml(ar.id)}</strong> – ${escapeHtml(ar.name)}</td>
                    <td><span class="lifecycle-badge lifecycle-${escapeHtml(ar.lifecycleStatus)}">${escapeHtml(ar.lifecycleStatus)}</span></td>
                    <td class="code-font">${escapeHtml(ar.impactPath)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
    `;
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============================================================================
// TAB 6: RULE TESTING & APPROVAL GATE (Section 10, SC-05, SC-06)
// ============================================================================
function renderTestingTab() {
  const container = document.getElementById('testCasesTableContainer');
  if (container) {
    container.innerHTML = `
      <div class="table-scroll-wrapper">
        <table class="data-grid">
          <thead>
            <tr>
              <th>Tesztkód</th>
              <th>Kategória</th>
              <th>Feltétel és Leírás</th>
              <th>Elvárt Eredmény (Felhasználó által rögzített)</th>
              <th>Tényleges Eredmény (Tesztfuttatás)</th>
              <th>Köztes Szabályértékek</th>
              <th>Megfelelőség</th>
            </tr>
          </thead>
          <tbody>
            ${state.testCases.map(tc => `
              <tr>
                <td><strong>${escapeHtml(tc.testCode)}</strong></td>
                <td><span class="version-pill">${escapeHtml(tc.category)}</span></td>
                <td>
                  <div><strong>${escapeHtml(tc.name)}</strong></div>
                  <div class="text-muted">${escapeHtml(tc.description)}</div>
                </td>
                <td>
                  ${renderStatusBadge(tc.expectedStatus)}
                  <div class="code-font text-muted" style="font-size:11px; margin-top:3px;">${escapeHtml(JSON.stringify(tc.expectedOutputs))}</div>
                </td>
                <td>
                  ${tc.lastRunActualStatus ? renderStatusBadge(tc.lastRunActualStatus) : '<span class="text-muted">Még nem futott</span>'}
                </td>
                <td class="code-font" style="font-size:11.5px;">
                  gyarthato=${escapeHtml(tc.lastRunActualOutputs?.gyarthato ?? '-')},
                  cimellenorzes=${escapeHtml(tc.lastRunActualOutputs?.cimellenorzes ?? '-')},
                  felulet=${escapeHtml(tc.lastRunActualOutputs?.felulet_m2 ?? '-')}m²
                </td>
                <td>
                  ${tc.lastRunPassed === true
                    ? '<span class="status-badge status-Accepted">✓ PASSED (Megfelelt)</span>'
                    : (tc.lastRunPassed === false ? '<span class="status-badge status-Error">✕ FAILED (Eltérés)</span>' : '<span class="val-badge val-Untested">Futtatásra vár</span>')}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // Default sample input JSON for new test case form
  const tcInput = document.getElementById('tcInputJson');
  if (tcInput && !tcInput.value) {
    tcInput.value = JSON.stringify({
      rendeles_szam: 'TEST-1007',
      ugyfel_kod: 'CUST-01',
      termek: 'Window A',
      anyag: 'PVC',
      szin: 'Fehér (RAL 9016)',
      uvegezes: '2-rétegű (Ug=1.1)',
      keret_vastagsag_mm: 76,
      szelesseg_mm: 1300,
      magassag_mm: 1400,
      csomagolas: 'Kaloda',
      szallitasi_cim: '1117 Budapest, Irinyi József u. 4.',
      iranyitoszam_zona: 'HU-CENTRAL',
      szallitasi_hatarido_nap: 14,
      kedvezmeny_pct: 18,
      egysegar_eur: 350,
      mennyiseg_db: 1
    }, null, 2);
  }

  // Render Approval Gate for Draft / Test / Stale rules
  const gateContainer = document.getElementById('approvalGateContainer');
  if (gateContainer) {
    const candidateRules = state.rules.filter(r => r.lifecycleStatus !== 'Prod' || r.validationStatus === 'Stale');
    gateContainer.innerHTML = candidateRules.length === 0
      ? `<p class="text-muted">Minden szabály Prod (éles) és jóváhagyott állapotban van.</p>`
      : `
        <table class="data-grid">
          <thead>
            <tr>
              <th>Szabály</th>
              <th>Jelenlegi Állapot</th>
              <th>Validáció</th>
              <th>Életciklus-léptetés &amp; Jóváhagyás (SC-06)</th>
            </tr>
          </thead>
          <tbody>
            ${candidateRules.map(r => `
              <tr>
                <td><strong>${escapeHtml(r.id)}</strong> – ${escapeHtml(r.name)}</td>
                <td><span class="lifecycle-badge lifecycle-${escapeHtml(r.lifecycleStatus)}">${escapeHtml(r.lifecycleStatus)}</span></td>
                <td><span class="val-badge val-${escapeHtml(r.validationStatus)}">${escapeHtml(r.validationStatus)}</span></td>
                <td>
                  <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    ${r.lifecycleStatus === 'Draft'
                      ? `<button class="btn btn-xs btn-secondary" onclick="transitionRuleLifecycle('${escapeHtml(r.id)}', 'Test')">→ Léptetés Test állapotba</button>`
                      : ''}
                    ${r.lifecycleStatus !== 'Retired'
                      ? `<button class="btn btn-xs btn-success" onclick="transitionRuleLifecycle('${escapeHtml(r.id)}', 'Prod')">✓ Jóváhagyás és Élesítés (Prod)</button>`
                      : ''}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
  }
}

window.transitionRuleLifecycle = async function(ruleId, targetStatus) {
  try {
    await apiFetch(`/api/rules/${encodeURIComponent(ruleId)}/lifecycle`, {
      method: 'POST',
      body: JSON.stringify({
        targetStatus,
        approvedBy: getActor(),
        humanConfirmed: true,
        approvalNote: `Felhasználói jóváhagyás (${getActor()})`
      })
    });
    showToast(`A(z) ${ruleId} szabály sikeresen '${targetStatus}' állapotba léptetve!`, 'success');
    await loadBootstrapState();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ============================================================================
// TAB 7: DETERMINISTIC EXECUTION ENGINE (Section 11 & SC-07)
// ============================================================================
function renderExecutionTab() {
  const stepsEl = document.getElementById('pipelineStepsVisualizer');
  const runsEl = document.getElementById('executionRunsHistoryContainer');
  const techBox = document.getElementById('technicalVsBusinessExplanationBox');

  if (stepsEl && state.latestRun) {
    const steps = state.latestRun.pipelineSteps || [];
    stepsEl.innerHTML = steps.map(s => `
      <div class="pipeline-step-card">
        <div class="pipeline-step-num">${escapeHtml(s.step)}. Lépés – ${escapeHtml(s.code)}</div>
        <div class="pipeline-step-title">${escapeHtml(s.name)}</div>
        <div class="pipeline-step-detail">${escapeHtml(s.detail)}</div>
      </div>
    `).join('');
  }

  if (runsEl) {
    runsEl.innerHTML = `
      <table class="data-grid">
        <thead>
          <tr>
            <th>Futtatás ID</th>
            <th>Mód</th>
            <th>Rekord × Szabály</th>
            <th>Forrás SHA-256 Sértetlen</th>
            <th>Determinisztikus Kimeneti Hash (SC-07)</th>
            <th>Idő</th>
          </tr>
        </thead>
        <tbody>
          ${state.runs.map(r => `
            <tr>
              <td><strong>${escapeHtml(r.runId)}</strong></td>
              <td><span class="lifecycle-badge lifecycle-${r.mode === 'prod' ? 'Prod' : 'Test'}">${escapeHtml(r.mode.toUpperCase())}</span></td>
              <td>${r.recordCount} × ${r.executedRuleCount}</td>
              <td>${r.sourceDataUnchanged ? '<span class="val-badge val-Passed">✓ IGEN (100% változatlan)</span>' : '<span class="val-badge val-Failed">Módosult</span>'}</td>
              <td class="code-font">${escapeHtml(r.deterministicOutputHash.slice(0, 18))}...</td>
              <td>${r.durationMs} ms</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  if (techBox) {
    techBox.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:10px;">
        <div style="padding:10px; background:#fee2e2; border-left:4px solid var(--error); border-radius:4px;">
          <strong>Üzleti Szabálysértés (Error / Requires Review / Warning):</strong>
          <div>A szabály sikeresen lefutott, és az üzleti feltétel alapján a rekord nem felel meg (pl. #1002 Door B túl nagy méret: 2650×2450 mm).</div>
        </div>
        <div style="padding:10px; background:#ffe4e6; border-left:4px dashed var(--tech-fail); border-radius:4px;">
          <strong>Technikai Végrehajtási Hiba (Execution Failed):</strong>
          <div>A szabály technikai okból (pl. sérült bemeneti adattípus, nullával való osztás, kapcsolat-időtúllépés) nem tudta kiértékelni a rekordot (pl. #1099 rekord). A rendszer ezt szigorúan elkülöníti az üzleti hibáktól!</div>
        </div>
      </div>
    `;
  }
}

// ============================================================================
// TAB 8: HUMAN VERIFICATION QUEUE (Section 13 & SC-11, SC-12)
// ============================================================================
function renderHumanReviewTab() {
  const container = document.getElementById('humanVerificationQueueContainer');
  if (!container) return;

  const exceptions = state.resultRecords.filter(r => r.finalStatus !== 'Accepted');

  container.innerHTML = `
    <div class="table-scroll-wrapper">
      <table class="data-grid">
        <thead>
          <tr>
            <th>Rekord ID</th>
            <th>Fő Adatok</th>
            <th>Eredeti Determinisztikus Szabálystátusz</th>
            <th>Szabályindoklás / Eltérés oka</th>
            <th>Jelenlegi Emberi Felülbírálat</th>
            <th>Célzott Felülvizsgálat (Section 13)</th>
          </tr>
        </thead>
        <tbody>
          ${exceptions.map(r => `
            <tr>
              <td><strong>#${escapeHtml(r.recordId)}</strong></td>
              <td>
                <strong>${escapeHtml(r.sourceData.termek || r.sourceData.szallitmany_id || r.recordId)}</strong>
                <div class="text-muted">${escapeHtml(r.sourceData.anyag || '')} ${r.sourceData.szelesseg_mm ? `(${r.sourceData.szelesseg_mm}×${r.sourceData.magassag_mm} mm)` : ''}</div>
              </td>
              <td>${renderStatusBadge(r.finalStatus)}</td>
              <td style="max-width:340px;">${escapeHtml(r.statusReason)}</td>
              <td>
                ${r.humanReview
                  ? `<div><span class="val-badge val-Passed">✓ ${escapeHtml(r.humanReview.decision)}</span></div>
                     <div class="text-muted" style="font-size:11.5px; margin-top:2px;">"${escapeHtml(r.humanReview.comment)}" – <em>${escapeHtml(r.humanReview.reviewedBy)}</em></div>`
                  : '<span class="val-badge val-Stale">Döntésre vár</span>'}
              </td>
              <td>
                <button class="btn btn-xs btn-primary" onclick="openRecordTraceModal('${escapeHtml(r.recordId)}')">
                  ⚖ Vizsgálat &amp; Döntés
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ============================================================================
// TAB 9: AUDIT TRAIL & SC-01..SC-12 SELF-VERIFICATION (Section 17 & 20)
// ============================================================================
async function loadSelfCheckAndAuditTab() {
  try {
    const check = await apiFetch('/api/verification/self-check');
    document.getElementById('navBadgeSc').textContent = `${check.passedCount}/${check.totalCriteria}`;

    const matrixEl = document.getElementById('scMatrixContainer');
    if (matrixEl) {
      matrixEl.innerHTML = check.criteria.map(c => `
        <div class="sc-card ${c.passed ? '' : 'sc-fail'}">
          <div class="sc-card-header">
            <span>${escapeHtml(c.code)}: ${escapeHtml(c.title)}</span>
            <span class="status-badge ${c.passed ? 'status-Accepted' : 'status-Error'}">${c.passed ? '✓ TELJESÜL' : '✕ HIBA'}</span>
          </div>
          <div class="text-muted">${escapeHtml(c.evidence)}</div>
        </div>
      `).join('');
    }

    const auditEl = document.getElementById('auditLogTableContainer');
    if (auditEl) {
      auditEl.innerHTML = `
        <div class="table-scroll-wrapper" style="max-height:420px;">
          <table class="data-grid">
            <thead>
              <tr>
                <th>Log ID</th>
                <th>Időpont</th>
                <th>Esemény Típus</th>
                <th>Felhasználó / Szerepkör</th>
                <th>Érintett Entitás</th>
                <th>Naplózott Művelet Összefoglalója</th>
              </tr>
            </thead>
            <tbody>
              ${state.auditLogs.map(a => `
                <tr>
                  <td>#${a.log_id}</td>
                  <td class="code-font">${escapeHtml(a.created_at)}</td>
                  <td><span class="version-pill">${escapeHtml(a.event_type)}</span></td>
                  <td><strong>${escapeHtml(a.actor)}</strong></td>
                  <td class="code-font">${escapeHtml(a.entity_type)}: ${escapeHtml(a.entity_id)}</td>
                  <td>${escapeHtml(a.summary)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  } catch (err) {
    console.error(err);
  }
}

// ============================================================================
// NAVIGATION & EVENT LISTENERS
// ============================================================================
function activateTab(tabName) {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
  if (tabName === 'dependencies') {
    const sel = document.getElementById('impactRuleSelector');
    if (sel && sel.value) runImpactAnalysisForRule(sel.value);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initRuleBuilderDefaults();
  loadBootstrapState();

  // Tab navigation
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  // Use Case selector (SC-01)
  document.getElementById('useCaseSelector')?.addEventListener('change', async (e) => {
    const ucId = e.target.value;
    await apiFetch(`/api/use-cases/${encodeURIComponent(ucId)}/activate`, { method: 'POST' });
    showToast(`Aktív Use Case átváltva: ${ucId}`, 'success');
    await loadBootstrapState();
  });

  // New Use Case modal
  document.getElementById('btnNewUseCaseModal')?.addEventListener('click', () => {
    document.getElementById('newUseCaseModal').classList.remove('hidden');
  });
  document.getElementById('btnCloseNewUcModal')?.addEventListener('click', () => {
    document.getElementById('newUseCaseModal').classList.add('hidden');
  });
  document.getElementById('createUseCaseForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const id = document.getElementById('newUcId').value.trim();
      const name = document.getElementById('newUcName').value.trim();
      const primaryKey = document.getElementById('newUcPrimaryKey').value.trim();
      const csvText = document.getElementById('newUcCsvData').value.trim();

      // Parse initial CSV rows client-side or via import
      const lines = csvText.split(/\r?\n/).filter(Boolean);
      const headers = lines[0].split(',').map(s => s.trim());
      const initialRecords = lines.slice(1).map(l => {
        const vals = l.split(',').map(s => s.trim());
        const obj = {};
        headers.forEach((h, i) => {
          obj[h] = /^-?\d+(\.\d+)?$/.test(vals[i]) ? Number(vals[i]) : vals[i];
        });
        return obj;
      });

      await apiFetch('/api/use-cases', {
        method: 'POST',
        body: JSON.stringify({ id, name, primaryKey, initialRecords, actor: getActor() })
      });
      await apiFetch(`/api/use-cases/${encodeURIComponent(id)}/activate`, { method: 'POST' });
      document.getElementById('newUseCaseModal').classList.add('hidden');
      showToast(`Új Use Case (${name}) létrehozva és aktiválva alkalmazáskód-módosítás nélkül (SC-01)!`, 'success');
      await loadBootstrapState();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Result Viewer filters
  document.getElementById('resultStatusFilter')?.addEventListener('change', loadResultGrid);
  document.getElementById('resultSearchInput')?.addEventListener('input', loadResultGrid);
  document.getElementById('resultColumnMode')?.addEventListener('change', renderMainResultsTable);

  // Close Record Trace Modal
  document.getElementById('btnCloseTraceModal')?.addEventListener('click', () => {
    document.getElementById('recordTraceModal').classList.add('hidden');
  });

  // Rule Manager filters
  document.getElementById('ruleSearchInput')?.addEventListener('input', renderRulesTableRows);
  document.getElementById('ruleStatusFilter')?.addEventListener('change', renderRulesTableRows);
  document.getElementById('ruleCategoryFilter')?.addEventListener('change', renderRulesTableRows);
  document.getElementById('btnGoNewRule')?.addEventListener('click', () => {
    document.getElementById('btnResetBuilderForm')?.click();
    activateTab('rule-builder');
  });

  // Rule Builder Mode Switcher
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => switchRuleBuilderMode(btn.dataset.rbmode));
  });

  document.getElementById('btnAddConditionRow')?.addEventListener('click', () => addVisualConditionRow());
  document.getElementById('btnAddDtRow')?.addEventListener('click', () => addDecisionTableRow());

  document.querySelectorAll('#ruleBuilderForm input, #ruleBuilderForm select').forEach(el => {
    el.addEventListener('input', updateBuilderLiveJson);
  });

  document.getElementById('btnResetBuilderForm')?.addEventListener('click', () => {
    state.editingRuleExists = false;
    const nextNum = (state.rules?.length || 85) + 1;
    document.getElementById('builderFormTitle').textContent = '8.2 & 8.3 Strukturált Szabály Szerkesztő (Új szabály)';
    document.getElementById('rbRuleId').value = `R-${String(nextNum).padStart(3, '0')}`;
    document.getElementById('rbRuleName').value = '';
    document.getElementById('rbRuleDescription').value = '';
    updateBuilderLiveJson();
  });

  // AI Natural Language Prompt Chips & Generator (Section 8.1)
  document.querySelectorAll('.ai-prompt-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('aiNaturalLanguageInput').value = chip.dataset.prompt;
    });
  });

  document.getElementById('btnAiGenerateRule')?.addEventListener('click', async () => {
    const prompt = document.getElementById('aiNaturalLanguageInput').value.trim();
    if (!prompt) {
      return showToast('Kérjük, írja le a szabályt természetes nyelven!', 'error');
    }
    try {
      const res = await apiFetch('/api/rules/ai-propose', {
        method: 'POST',
        body: JSON.stringify({ prompt, actor: getActor() })
      });
      const prop = res.proposedRule;
      const exp = res.aiExplanation;

      // Populate form with AI proposal
      state.editingRuleExists = false;
      document.getElementById('rbRuleId').value = prop.id;
      document.getElementById('rbRuleName').value = prop.name;
      document.getElementById('rbRuleCategory').value = prop.category;
      document.getElementById('rbRuleDescription').value = prop.description;
      switchRuleBuilderMode(prop.ruleType);

      if (prop.ruleType === 'visual_condition' && prop.conditions) {
        document.getElementById('rbCombinator').value = prop.conditions.combinator || 'AND';
        const c = document.getElementById('rbConditionRowsContainer');
        c.innerHTML = '';
        (prop.conditions.rules || []).forEach(r => addVisualConditionRow(r));
      } else if (prop.ruleType === 'decision_table' && prop.decisionTable) {
        const inputs = prop.decisionTable.inputs.map(i => i.field);
        document.getElementById('rbDtInputs').value = inputs.join(', ');
        const dtc = document.getElementById('rbDtRowsContainer');
        dtc.innerHTML = '';
        prop.decisionTable.rows.forEach(row => {
          addDecisionTableRow({
            conds: inputs.map(k => row.conditions[k] ?? '*').join(' | '),
            outputValue: row.outputValue,
            statusEffect: row.statusEffect,
            reason: row.reason
          });
        });
      } else if (prop.ruleType === 'expression') {
        document.getElementById('rbExpressionInput').value = prop.expression || '';
      }

      document.getElementById('rbOutputField').value = prop.output.outputField;
      document.getElementById('rbOutputType').value = prop.output.outputType;
      document.getElementById('rbTrueValue').value = String(prop.output.trueValue ?? 'Igen');
      document.getElementById('rbFalseValue').value = String(prop.output.falseValue ?? 'Nem');
      document.getElementById('rbOnTrueStatus').value = prop.output.onTrueStatus || 'Accepted';
      document.getElementById('rbOnFalseStatus').value = prop.output.onFalseStatus || 'Error';
      document.getElementById('rbPassMessage').value = prop.output.passMessage || '';
      document.getElementById('rbFailMessage').value = prop.output.failMessage || '';
      updateBuilderLiveJson();

      const box = document.getElementById('aiProposalResultBox');
      box.classList.remove('hidden');
      box.innerHTML = `
        <div><strong>✨ ${escapeHtml(exp.summary)}</strong></div>
        <div class="text-muted" style="margin-top:4px;">
          Felismert bemeneti mezők: <code>${escapeHtml(exp.detectedInputFields.join(', ') || '-')}</code> |
          Automatikusan felismert függőségek: <code>${escapeHtml(exp.detectedDependencies.join(', ') || 'Nincs (Alapszabály)')}</code> |
          Kimeneti mező: <code>${escapeHtml(exp.outputField)}</code>
        </div>
        ${exp.contradictions && exp.contradictions.length > 0
          ? `<div style="margin-top:6px; color:#b45309; font-weight:600;">⚠ Észlelt ütközés/átfedés: ${escapeHtml(exp.contradictions.map(c => c.message).join(' | '))}</div>`
          : ''}
        <div class="text-muted" style="margin-top:4px; font-size:11.5px;">🔒 ${escapeHtml(exp.governanceGuardrail)}</div>
      `;
      showToast('AI strukturált szabályjavaslat betöltve a szerkesztőbe! Ellenőrizze és mentse el.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Save Rule Form
  document.getElementById('ruleBuilderForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const ruleObj = buildRuleObjectFromForm();
      ruleObj.actor = getActor();
      const exists = state.rules.some(r => r.id === ruleObj.id);
      const endpoint = exists ? `/api/rules/${encodeURIComponent(ruleObj.id)}` : '/api/rules';
      const method = exists ? 'PUT' : 'POST';

      const res = await apiFetch(endpoint, {
        method,
        body: JSON.stringify(ruleObj)
      });

      const affectedCount = res.impact?.allAffectedRuleIds?.length || 0;
      showToast(
        `Szabály (${res.rule.id} v${res.rule.version}) elmentve Draft állapotban! ${affectedCount > 0 ? `${affectedCount} függő szabály megjelölve újratesztelésre.` : ''}`,
        'success'
      );
      await loadBootstrapState();
      activateTab('rule-manager');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Dependency Graph actions
  document.getElementById('btnApplyRecommendedOrder')?.addEventListener('click', async () => {
    try {
      await apiFetch('/api/dependencies/reorder', {
        method: 'POST',
        body: JSON.stringify({ useRecommended: true, actor: getActor() })
      });
      showToast('Automatikus topologikus végrehajtási sorrend sikeresen alkalmazva!', 'success');
      await loadBootstrapState();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btnSimulateInvalidOrder')?.addEventListener('click', async () => {
    try {
      // Attempt to place R-048 (which depends on R-010, R-022, R-035, R-047) at position #1
      const currentIds = state.rules.filter(r => r.lifecycleStatus !== 'Retired').map(r => r.id);
      const invalidOrder = ['R-048', ...currentIds.filter(id => id !== 'R-048')];
      await apiFetch('/api/dependencies/reorder', {
        method: 'POST',
        body: JSON.stringify({ orderedRuleIds: invalidOrder, actor: getActor() })
      });
    } catch (err) {
      showToast(`SC-04 Védelem Működik – ${err.message}`, 'error');
    }
  });

  document.getElementById('btnRunImpactAnalysis')?.addEventListener('click', () => {
    const ruleId = document.getElementById('impactRuleSelector')?.value;
    if (ruleId) runImpactAnalysisForRule(ruleId);
  });

  // Testing & Validation actions
  document.getElementById('btnRunAllTests')?.addEventListener('click', async () => {
    try {
      const res = await apiFetch('/api/tests/run', {
        method: 'POST',
        body: JSON.stringify({ markRulesValidated: true, actor: getActor() })
      });
      showToast(`Tesztfuttatás kész: ${res.passedCount}/${res.totalTests} teszteset sikeres!`, res.allPassed ? 'success' : 'error');
      await loadBootstrapState();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btnAiSuggestTests')?.addEventListener('click', async () => {
    try {
      const res = await apiFetch('/api/tests/ai-suggest', {
        method: 'POST',
        body: JSON.stringify({ ruleId: 'R-048' })
      });
      const box = document.getElementById('aiTestSuggestionsContainer');
      if (box) {
        box.innerHTML = `
          <h3>✨ AI Által Javasolt Tesztesetek (Az elvárt eredményt a felhasználó erősíti meg – Specifikáció 10.)</h3>
          <div style="display:flex; flex-direction:column; gap:6px; margin-top:8px;">
            ${res.suggestions.map((s, idx) => `
              <div style="padding:8px; background:#f5f3ff; border:1px solid #c4b5fd; border-radius:6px; display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <div>
                  <strong>[${escapeHtml(s.category)}] ${escapeHtml(s.name)}</strong>
                  <div class="text-muted">${escapeHtml(s.description)} | Javasolt várható státusz: ${renderStatusBadge(s.suggestedExpectedStatus)}</div>
                </div>
                <button class="btn btn-xs btn-primary" onclick='confirmAiSuggestedTest(${JSON.stringify(s).replace(/'/g, "&#39;")})'>
                  ✓ Elvárt Eredmény Megerősítése &amp; Mentés
                </button>
              </div>
            `).join('')}
          </div>
        `;
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('newTestCaseForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const testCode = document.getElementById('tcCode').value.trim();
      const name = document.getElementById('tcName').value.trim();
      const expectedStatus = document.getElementById('tcExpectedStatus').value;
      const inputData = JSON.parse(document.getElementById('tcInputJson').value);
      const expectedOutputs = JSON.parse(document.getElementById('tcExpectedOutputsJson').value || '{}');

      await apiFetch('/api/tests', {
        method: 'POST',
        body: JSON.stringify({
          testCode,
          name,
          category: 'Felhasználói teszt',
          description: name,
          inputData,
          expectedStatus,
          expectedOutputs,
          userConfirmed: true,
          actor: getActor()
        })
      });
      showToast(`Felhasználói teszteset (${testCode}) elmentve és megerősítve!`, 'success');
      await loadBootstrapState();
    } catch (err) {
      showToast(`Hiba a teszteset mentésekor: ${err.message}`, 'error');
    }
  });

  // Execution buttons
  const triggerExecution = async (mode) => {
    try {
      const res = await apiFetch('/api/execute', {
        method: 'POST',
        body: JSON.stringify({ mode, actor: getActor() })
      });
      showToast(
        `Determinisztikus végrehajtás (${mode.toUpperCase()}) kész: ${res.recordCount} rekord × ${res.executedRuleCount} szabály (${res.durationMs} ms). SHA-256: ${res.deterministicOutputHash.slice(0, 12)}...`,
        'success'
      );
      await loadBootstrapState();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  document.getElementById('btnQuickExecute')?.addEventListener('click', () => triggerExecution('prod'));
  document.getElementById('btnRunProdExecution')?.addEventListener('click', () => triggerExecution('prod'));
  document.getElementById('btnRunTestExecution')?.addEventListener('click', () => triggerExecution('test'));

  // File / CSV Import form
  document.getElementById('importDataSourceForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const sourceId = document.getElementById('importDsId').value.trim();
      const name = document.getElementById('importDsName').value.trim();
      const sourceType = document.getElementById('importDsType').value;
      const isPrimary = document.getElementById('importDsPrimary').value === 'true';
      const fileInput = document.getElementById('importFileInput');
      const csvText = document.getElementById('importCsvTextarea').value.trim();

      let payload = { sourceId, name, sourceType, isPrimary, actor: getActor() };

      if (fileInput && fileInput.files && fileInput.files.length > 0) {
        const file = fileInput.files[0];
        payload.fileName = file.name;
        if (file.name.toLowerCase().endsWith('.xlsx')) {
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          payload.format = 'xlsx';
          payload.base64Content = btoa(binary);
        } else {
          payload.format = 'csv';
          payload.csvContent = await file.text();
        }
      } else if (csvText) {
        payload.format = 'csv';
        payload.csvContent = csvText;
      } else {
        return showToast('Kérjük, válasszon ki egy .xlsx/.csv fájlt vagy illesszen be CSV tartalmat!', 'error');
      }

      const res = await apiFetch('/api/data-sources/import', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(`Adatforrás (${res.sourceId}) sikeresen betöltve: ${res.recordCount} rekord (SHA-256: ${res.sha256Checksum.slice(0, 12)}...).`, 'success');
      await loadBootstrapState();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btnRefreshSelfCheck')?.addEventListener('click', async () => {
    await loadSelfCheckAndAuditTab();
    showToast('SC-01..SC-12 önellenőrzés sikeresen frissítve!', 'success');
  });
});

window.confirmAiSuggestedTest = async function(s) {
  try {
    await apiFetch('/api/tests', {
      method: 'POST',
      body: JSON.stringify({
        testCode: s.testCode,
        name: s.name,
        category: s.category,
        description: s.description,
        targetRuleId: s.targetRuleId,
        inputData: s.inputData,
        expectedStatus: s.suggestedExpectedStatus,
        expectedOutputs: {},
        userConfirmed: true,
        actor: getActor()
      })
    });
    showToast(`AI teszteset (${s.testCode}) felhasználó által megerősítve és mentve!`, 'success');
    await loadBootstrapState();
  } catch (err) {
    showToast(err.message, 'error');
  }
};
