/**
 * Holcim Egypt Management & Operations Dashboard — External PWA Client (app.js)
 * Fully wired to index.html IDs, Google Charts, PWA Install/SW, CSV Export,
 * Executive Summary Clipboard Copy, Shift Production Logging, and Code.gs /exec bridge.
 */

const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzZidsn99APmSvvmVLTe8isT4uI35ljHUhEUgtUUYrZDu888aTxyzgQ0yvqbg2cNr6icQ/exec';
const PAGE_SIZE = 10;

const state = {
  activeTab: 'overview',
  deptId: 'ALL',
  empPage: 1,
  empTotalPages: 1,
  dashboardCache: new Map(), // unitId -> dashboard payload
  empListCache: null,       // full employee list for instant search/sort/page/export
  empListVersion: null,
  activityCache: null,
  activityVersion: null,
  inFlight: new Set(),
  googleChartsReady: false,
  googleChartsLoading: false,
  deferredPrompt: null,
  swRegistration: null
};

const TAB_TITLES = {
  overview: 'Dashboard Overview',
  employees: 'Employee Directory',
  analytics: 'Analytics & Optimization',
  activity: 'Recent Activity Log'
};

// -------------------- Google Charts Loader --------------------

function ensureGoogleChartsReady(onReady) {
  if (window.google && window.google.charts && window.google.visualization && state.googleChartsReady) {
    if (typeof onReady === 'function') onReady();
    return;
  }

  if (!state.googleChartsLoading) {
    state.googleChartsLoading = true;
    let attempts = 0;

    const timer = setInterval(() => {
      attempts += 1;
      if (window.google && window.google.charts) {
        clearInterval(timer);
        google.charts.load('current', { packages: ['corechart'] });
        google.charts.setOnLoadCallback(() => {
          state.googleChartsReady = true;
          state.googleChartsLoading = false;
          const current = state.dashboardCache.get(state.deptId);
          if (current) drawChartsNow(current);
          if (typeof onReady === 'function') onReady();
        });
      } else if (attempts >= 60) {
        clearInterval(timer);
        state.googleChartsLoading = false;
      }
    }, 150);
  }
}

// -------------------- API Bridge (`doPost`) --------------------

async function callGasApi(action, payload = {}) {
  const res = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, payload }),
    redirect: 'follow'
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while contacting Google Apps Script.`);
  }

  const json = await res.json();
  if (!json || json.ok === false) {
    throw new Error((json && json.error) || `Action failed: ${action}`);
  }
  return json.data;
}

// -------------------- UI Helpers --------------------

function setLoading(isLoading) {
  const bar = document.getElementById('loadingBar');
  if (bar) bar.classList.toggle('hidden', !isLoading);
}

function showAlert(message, isError = true) {
  const banner = document.getElementById('alertBanner');
  if (!banner) return;
  if (!message) {
    banner.classList.add('hidden');
    banner.textContent = '';
    return;
  }
  banner.textContent = message;
  banner.classList.toggle('error', isError);
  banner.classList.toggle('success', !isError);
  banner.classList.remove('hidden');

  if (!isError) {
    clearTimeout(showAlert._timer);
    showAlert._timer = setTimeout(() => banner.classList.add('hidden'), 3200);
  }
}

function updateConnectionStatus() {
  const pill = document.getElementById('connectionPill');
  if (!pill) return;
  const online = navigator.onLine;
  pill.classList.toggle('online', online);
  pill.classList.toggle('offline', !online);
  pill.textContent = online ? '● Live Sheets Sync' : '● Offline Mode';
}

function updateSyncTimestamp() {
  const el = document.getElementById('lastSyncText');
  if (!el) return;
  const now = new Date();
  el.textContent = `• Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function formatCompactEgp(n) {
  const num = Number(n || 0);
  if (Math.abs(num) >= 1e9) return `EGP ${(num / 1e9).toFixed(2)}B`;
  if (Math.abs(num) >= 1e6) return `EGP ${(num / 1e6).toFixed(1)}M`;
  return `EGP ${formatNumber(num)}`;
}

function invalidateClientCaches() {
  state.dashboardCache.clear();
  state.empListCache = null;
  state.empListVersion = null;
  state.activityCache = null;
  state.activityVersion = null;
}

// -------------------- Tab Navigation --------------------

function switchTab(tabName) {
  const target = ['overview', 'employees', 'analytics', 'activity'].includes(tabName)
    ? tabName
    : 'overview';
  state.activeTab = target;

  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('hidden', panel.id !== `tab-${target}`);
  });

  document.querySelectorAll('[data-tab]').forEach(btn => {
    const isActive = btn.getAttribute('data-tab') === target;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-current', isActive ? 'page' : 'false');
  });

  const titleEl = document.getElementById('headerTitle');
  if (titleEl) titleEl.textContent = TAB_TITLES[target] || 'Dashboard Overview';

  if (target === 'employees') {
    loadEmployeesPage(state.empPage);
  } else if (target === 'overview' || target === 'analytics') {
    const current = state.dashboardCache.get(state.deptId);
    if (current) {
      renderAllCharts(current);
      renderProjectsTracker(current);
    }
  } else if (target === 'activity') {
    loadRecentActivity();
  }
}

// -------------------- Filter & Dropdowns --------------------

function populateDepartmentDropdowns(units = [], selectedDept = 'ALL') {
  const deptFilter = document.getElementById('deptFilter');
  if (deptFilter) {
    deptFilter.innerHTML = '<option value="ALL">All Departments &amp; Divisions</option>';
    units.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.unit_id;
      opt.textContent = u.unit_name;
      deptFilter.appendChild(opt);
    });
    deptFilter.value = selectedDept || 'ALL';
  }

  const formDeptId = document.getElementById('formDeptId');
  if (formDeptId) {
    const prev = formDeptId.value;
    formDeptId.innerHTML = '';
    units.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.unit_id;
      opt.textContent = u.unit_name;
      formDeptId.appendChild(opt);
    });
    if (prev && units.some(u => u.unit_id === prev)) {
      formDeptId.value = prev;
    }
  }
}

function handleFilterChange() {
  const deptFilter = document.getElementById('deptFilter');
  state.deptId = (deptFilter && deptFilter.value) || 'ALL';
  state.empPage = 1;
  loadDashboard(false);
}

// -------------------- Dashboard KPIs, Projects & Google Charts --------------------

function applyDashboardData(data, selectedDept) {
  showAlert('');
  updateSyncTimestamp();

  if (data.dbVersion && data.dbVersion !== state.empListVersion) {
    state.empListCache = null;
    state.empListVersion = data.dbVersion;
  }
  if (data.dbVersion && data.dbVersion !== state.activityVersion) {
    state.activityCache = null;
    state.activityVersion = data.dbVersion;
  }

  populateDepartmentDropdowns(data.units || [], selectedDept);

  const kpis = data.kpis || {};
  const setTxt = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };

  setTxt('kpiTotalEmp', formatNumber(kpis.headcount));
  setTxt('kpiActiveEmp', `${formatNumber(kpis.activeEmployees ?? kpis.headcount)} active staff`);
  setTxt('kpiTotalDepts', formatNumber((data.units || []).length || 5));
  setTxt('kpiPayroll', formatNumber(kpis.monthlyPayrollEgp));
  setTxt('kpiAvgScore', `${Number(kpis.avgPerformance || 0).toFixed(2)} / 5.0`);

  setTxt('kpiDispatched', `${formatNumber(kpis.totalDispatchedTons)} t`);
  setTxt('kpiRevenue', formatCompactEgp(kpis.totalRevenueEgp));
  setTxt('kpiCo2', `${formatNumber(kpis.avgCo2)} kg/t`);
  setTxt('kpiProjectPct', `${formatNumber(kpis.avgProjectProgress)}%`);

  renderProjectsTracker(data);
  renderAllCharts(data);
}

function renderProjectsTracker(data) {
  const container = document.getElementById('projectsTrackerList');
  const badge = document.getElementById('projectCountBadge');
  if (!container) return;

  const projects = (data && data.tables && Array.isArray(data.tables.projects))
    ? data.tables.projects
    : [];

  if (badge) badge.textContent = `${projects.length} Initiatives`;

  if (!projects.length) {
    container.innerHTML = '<div class="empty-cell">No active optimization projects for this division.</div>';
    return;
  }

  container.innerHTML = projects.map(p => {
    const pct = Math.min(100, Math.max(0, Number(p.completion_pct || 0)));
    const statusClass =
      String(p.status).toLowerCase().includes('complete') ? 'badge-active' :
      String(p.status).toLowerCase().includes('risk') ? 'badge-leave' : 'badge-info';

    return `
      <div class="project-item">
        <div class="project-top">
          <div>
            <strong>${p.project_name}</strong>
            <div class="project-meta">${p.proj_id} • ${p.unit_name || ''}</div>
          </div>
          <span class="status-badge ${statusClass}">${p.status || 'In Progress'}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${pct}%;"></div>
        </div>
        <div class="project-foot">
          <span>Completion</span>
          <strong>${pct}%</strong>
        </div>
      </div>
    `;
  }).join('');
}

function drawChartsNow(data) {
  if (!window.google || !google.visualization || !data) return;

  const units = data.units || [];
  const employees = (data.tables && data.tables.employees) || [];

  // 1. Overview Chart 1: Headcount by Department
  const hcEl = document.getElementById('chartDeptHeadcount');
  if (hcEl && hcEl.offsetParent !== null) {
    const rows = [['Department', 'Headcount']];
    units.forEach(u => {
      const count = employees.filter(e => e.unit_id === u.unit_id).length;
      if (state.deptId === 'ALL' || state.deptId === u.unit_id) {
        rows.push([u.unit_name, count]);
      }
    });
    if (rows.length === 1) rows.push(['No Data', 0]);

    const chart = new google.visualization.ColumnChart(hcEl);
    chart.draw(google.visualization.arrayToDataTable(rows), {
      legend: { position: 'none' },
      colors: ['#0d9488'],
      chartArea: { left: 45, top: 20, width: '85%', height: '70%' },
      backgroundColor: 'transparent',
      vAxis: { minValue: 0, format: '0' }
    });
  }

  // 2. Overview Chart 2: Workforce Status Breakdown
  const statusEl = document.getElementById('chartStatusPie');
  if (statusEl && statusEl.offsetParent !== null) {
    const counts = {};
    employees.forEach(e => {
      const st = e.status || 'Active';
      counts[st] = (counts[st] || 0) + 1;
    });
    const rows = [['Status', 'Staff']];
    Object.keys(counts).forEach(k => rows.push([k, counts[k]]));
    if (rows.length === 1) rows.push(['Active', 0]);

    const chart = new google.visualization.PieChart(statusEl);
    chart.draw(google.visualization.arrayToDataTable(rows), {
      pieHole: 0.45,
      colors: ['#0d9488', '#0284c7', '#d97706', '#64748b'],
      chartArea: { left: 16, top: 16, width: '92%', height: '82%' },
      backgroundColor: 'transparent'
    });
  }

  // 3. Analytics Chart 1: Department Budget vs. Annualized Payroll
  const budgetEl = document.getElementById('chartBudgetCompare');
  if (budgetEl && budgetEl.offsetParent !== null) {
    const rows = [['Department', 'Annual Budget (EGP)', 'Annualized Payroll (EGP)']];
    units.forEach(u => {
      if (state.deptId === 'ALL' || state.deptId === u.unit_id) {
        const annualPayroll = employees
          .filter(e => e.unit_id === u.unit_id)
          .reduce((s, e) => s + Number(e.monthly_salary_egp || 0) * 12, 0);
        rows.push([u.unit_name, Number(u.annual_budget_egp || 0), annualPayroll]);
      }
    });
    if (rows.length === 1) rows.push(['No Data', 0, 0]);

    const chart = new google.visualization.ColumnChart(budgetEl);
    chart.draw(google.visualization.arrayToDataTable(rows), {
      colors: ['#0f172a', '#0d9488'],
      legend: { position: 'top' },
      chartArea: { left: 65, top: 36, width: '82%', height: '65%' },
      backgroundColor: 'transparent'
    });
  }

  // 4. Analytics Chart 2: Average Performance Score by Division
  const perfEl = document.getElementById('chartPerfCompare');
  if (perfEl && perfEl.offsetParent !== null) {
    const rows = [['Department', 'Avg KPI Score']];
    units.forEach(u => {
      if (state.deptId === 'ALL' || state.deptId === u.unit_id) {
        const uEmps = employees.filter(e => e.unit_id === u.unit_id);
        const avg = uEmps.length
          ? Number((uEmps.reduce((s, e) => s + Number(e.performance_score || 0), 0) / uEmps.length).toFixed(2))
          : 0;
        rows.push([u.unit_name, avg]);
      }
    });
    if (rows.length === 1) rows.push(['No Data', 0]);

    const chart = new google.visualization.BarChart(perfEl);
    chart.draw(google.visualization.arrayToDataTable(rows), {
      colors: ['#0284c7'],
      legend: { position: 'none' },
      hAxis: { minValue: 0, maxValue: 5 },
      chartArea: { left: 130, top: 20, width: '65%', height: '74%' },
      backgroundColor: 'transparent'
    });
  }
}

function renderAllCharts(data) {
  if (!data) return;
  ensureGoogleChartsReady(() => drawChartsNow(data));
}

async function loadDashboard(forceRefresh = false) {
  const selectedDept = state.deptId || 'ALL';

  if (!forceRefresh && state.dashboardCache.has(selectedDept)) {
    applyDashboardData(state.dashboardCache.get(selectedDept), selectedDept);
    if (state.activeTab === 'employees') loadEmployeesPage(state.empPage);
    if (state.activeTab === 'activity') loadRecentActivity();
    return;
  }

  const reqKey = `dash:${selectedDept}`;
  if (state.inFlight.has(reqKey)) return;

  state.inFlight.add(reqKey);
  setLoading(true);

  try {
    const data = await callGasApi('getDashboardData', { unitId: selectedDept });
    state.dashboardCache.set(selectedDept, data);
    applyDashboardData(data, selectedDept);

    if (state.activeTab === 'employees') await loadEmployeesPage(state.empPage, forceRefresh);
    if (state.activeTab === 'activity') await loadRecentActivity(forceRefresh);
  } catch (err) {
    showAlert(err.message || String(err), true);
  } finally {
    state.inFlight.delete(reqKey);
    setLoading(false);
  }
}

function refreshAll(forceRefresh = true) {
  invalidateClientCaches();
  return loadDashboard(forceRefresh);
}

// -------------------- Executive Digest Copy & CSV Export --------------------

async function copyExecutiveSummary() {
  const current = state.dashboardCache.get(state.deptId);
  if (!current || !current.kpis) {
    showAlert('Dashboard data is still loading.', true);
    return;
  }

  const k = current.kpis;
  const deptSelect = document.getElementById('deptFilter');
  const scopeLabel = deptSelect
    ? deptSelect.options[deptSelect.selectedIndex].text
    : 'All Departments & Divisions';

  const summary = [
    `HOLCIM EGYPT — EXECUTIVE KPI BRIEF (${scopeLabel})`,
    `• Headcount: ${formatNumber(k.headcount)} (${formatNumber(k.activeEmployees ?? k.headcount)} active)`,
    `• Monthly Payroll: EGP ${formatNumber(k.monthlyPayrollEgp)}`,
    `• Avg KPI Score: ${Number(k.avgPerformance || 0).toFixed(2)} / 5.0`,
    `• Dispatched Volume: ${formatNumber(k.totalDispatchedTons)} tons`,
    `• Revenue: ${formatCompactEgp(k.totalRevenueEgp)}`,
    `• CO2 Intensity: ${formatNumber(k.avgCo2)} kg/t`,
    `• Optimization Projects Progress: ${formatNumber(k.avgProjectProgress)}%`
  ].join('\n');

  try {
    await navigator.clipboard.writeText(summary);
    showAlert('Executive KPI digest copied to clipboard!', false);
  } catch (_) {
    showAlert('Could not access clipboard on this browser.', true);
  }
}

async function exportEmployeesCsv() {
  if (!Array.isArray(state.empListCache)) {
    await loadEmployeesPage(1, true);
  }
  const filtered = getFilteredSortedEmployees(state.empListCache || [], true).items;
  if (!filtered.length) {
    showAlert('No employees to export for the current filter.', true);
    return;
  }

  const headers = ['Employee ID', 'Full Name', 'Role', 'Department', 'Monthly Salary (EGP)', 'KPI Score', 'Status'];
  const escapeCsv = val => `"${String(val ?? '').replace(/"/g, '""')}"`;
  const lines = [
    headers.join(','),
    ...filtered.map(e => [
      escapeCsv(e.emp_id),
      escapeCsv(e.full_name),
      escapeCsv(e.role),
      escapeCsv(e.unit_name),
      escapeCsv(e.monthly_salary_egp),
      escapeCsv(e.performance_score),
      escapeCsv(e.status)
    ].join(','))
  ];

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Holcim_Egypt_Employees_${state.deptId}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showAlert(`Exported ${filtered.length} employee records to CSV.`, false);
}

// -------------------- Employee Directory (Search, Sort, Pagination, CRUD) --------------------

function getFilteredSortedEmployees(allEmployees, returnAll = false) {
  const searchInput = document.getElementById('searchInput');
  const sortFieldEl = document.getElementById('sortField');
  const sortDirEl = document.getElementById('sortDir');

  const query = String((searchInput && searchInput.value) || '').toLowerCase().trim();
  const sortFieldRaw = (sortFieldEl && sortFieldEl.value) || 'full_name';
  const sortField = sortFieldRaw === 'monthly_salary' ? 'monthly_salary_egp' : sortFieldRaw;
  const sortDir = (sortDirEl && sortDirEl.value) === 'desc' ? -1 : 1;

  let list = allEmployees.slice();

  if (state.deptId && state.deptId !== 'ALL') {
    list = list.filter(e => e.unit_id === state.deptId);
  }

  if (query) {
    list = list.filter(e =>
      String(e.emp_id || '').toLowerCase().includes(query) ||
      String(e.full_name || '').toLowerCase().includes(query) ||
      String(e.role || '').toLowerCase().includes(query) ||
      String(e.unit_name || '').toLowerCase().includes(query)
    );
  }

  list.sort((a, b) => {
    const valA = a[sortField];
    const valB = b[sortField];
    if (typeof valA === 'number' && typeof valB === 'number') {
      return (valA - valB) * sortDir;
    }
    return String(valA || '').localeCompare(String(valB || '')) * sortDir;
  });

  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, state.empPage), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;

  return {
    items: returnAll ? list : list.slice(start, start + PAGE_SIZE),
    page: safePage,
    total,
    totalPages
  };
}

function renderEmployeesTable(pageData) {
  state.empPage = pageData.page;
  state.empTotalPages = pageData.totalPages;

  const tbody = document.getElementById('employeeListBody');
  const indicator = document.getElementById('pageIndicator');
  const prevBtn = document.getElementById('prevPageBtn');
  const nextBtn = document.getElementById('nextPageBtn');

  if (indicator) indicator.textContent = `Page ${pageData.page} of ${pageData.totalPages} (${pageData.total})`;
  if (prevBtn) prevBtn.disabled = pageData.page <= 1;
  if (nextBtn) nextBtn.disabled = pageData.page >= pageData.totalPages;

  if (!tbody) return;

  if (!pageData.items.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No matching employees found.</td></tr>';
    return;
  }

  tbody.innerHTML = pageData.items.map(emp => {
    const statusClass =
      emp.status === 'Active' ? 'badge-active' :
      emp.status === 'On Leave' ? 'badge-leave' : 'badge-inactive';

    return `
      <tr>
        <td data-label="ID"><strong>${emp.emp_id}</strong></td>
        <td data-label="Employee">${emp.full_name}</td>
        <td data-label="Role">${emp.role}</td>
        <td data-label="Department">${emp.unit_name}</td>
        <td data-label="Salary">EGP ${formatNumber(emp.monthly_salary_egp)}</td>
        <td data-label="KPI">${Number(emp.performance_score || 0).toFixed(1)}</td>
        <td data-label="Status"><span class="status-badge ${statusClass}">${emp.status || 'Active'}</span></td>
        <td data-label="Actions" class="action-cell">
          <button type="button" class="btn-sm-edit" onclick="openEmployeeModal('${emp.emp_id}')">Edit</button>
          <button type="button" class="btn-sm-del" onclick="deleteEmployeeRecord('${emp.emp_id}')">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function loadEmployeesPage(page = 1, forceRefresh = false) {
  state.empPage = Math.max(1, Number(page || 1));
  showAlert('');

  if (!forceRefresh && Array.isArray(state.empListCache)) {
    renderEmployeesTable(getFilteredSortedEmployees(state.empListCache));
    return;
  }

  const tbody = document.getElementById('employeeListBody');
  if (tbody && !state.empListCache) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">Loading employees...</td></tr>';
  }

  const reqKey = 'empList';
  if (state.inFlight.has(reqKey)) return;
  state.inFlight.add(reqKey);

  try {
    const all = await callGasApi('getAllEmployees');
    state.empListCache = Array.isArray(all) ? all : [];
    renderEmployeesTable(getFilteredSortedEmployees(state.empListCache));
  } catch (err) {
    showAlert(err.message || String(err), true);
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">Failed to load employees.</td></tr>';
    }
  } finally {
    state.inFlight.delete(reqKey);
  }
}

let searchTimer = null;
function debouncedSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.empPage = 1;
    loadEmployeesPage(1);
  }, 180);
}

function changePage(delta) {
  const next = state.empPage + Number(delta || 0);
  if (next >= 1 && next <= state.empTotalPages) {
    loadEmployeesPage(next);
  }
}

// -------------------- Add / Edit / Delete Employee Modal --------------------

function openEmployeeModal(empId = null) {
  const modal = document.getElementById('employeeModal');
  const title = document.getElementById('modalTitle');
  const form = document.getElementById('employeeForm');
  if (!modal || !form) return;

  form.reset();
  document.getElementById('formEmpId').value = '';

  const dash = state.dashboardCache.get(state.deptId) || state.dashboardCache.values().next().value;
  if (dash && dash.units) {
    populateDepartmentDropdowns(dash.units, state.deptId);
  }

  if (empId) {
    const emp = (state.empListCache || []).find(e => String(e.emp_id) === String(empId));
    if (!emp) {
      showAlert('Loading employee record...', false);
      loadEmployeesPage(state.empPage, true).then(() => openEmployeeModal(empId));
      return;
    }
    if (title) title.textContent = `Edit Employee (${emp.emp_id})`;
    document.getElementById('formEmpId').value = emp.emp_id;
    document.getElementById('formFullName').value = emp.full_name || '';
    document.getElementById('formRole').value = emp.role || '';
    document.getElementById('formDeptId').value = emp.unit_id || '';
    document.getElementById('formSalary').value = emp.monthly_salary_egp || 0;
    document.getElementById('formScore').value = emp.performance_score ?? 4.5;
    document.getElementById('formStatus').value = emp.status || 'Active';
  } else {
    if (title) title.textContent = 'Add Employee';
    document.getElementById('formScore').value = '4.5';
    document.getElementById('formStatus').value = 'Active';
  }

  modal.classList.remove('hidden');
}

function closeEmployeeModal() {
  const modal = document.getElementById('employeeModal');
  if (modal) modal.classList.add('hidden');
}

async function handleSaveEmployee(event) {
  event.preventDefault();
  const saveBtn = document.getElementById('saveEmpBtn');
  if (saveBtn) saveBtn.disabled = true;
  setLoading(true);

  const empId = document.getElementById('formEmpId').value.trim();
  const payload = {
    emp_id: empId || undefined,
    full_name: document.getElementById('formFullName').value.trim(),
    role: document.getElementById('formRole').value.trim(),
    unit_id: document.getElementById('formDeptId').value,
    monthly_salary_egp: Number(document.getElementById('formSalary').value || 0),
    performance_score: Number(document.getElementById('formScore').value || 4.5),
    status: document.getElementById('formStatus').value || 'Active'
  };

  try {
    const action = empId ? 'updateEmployee' : 'addEmployee';
    const msg = await callGasApi(action, payload);
    closeEmployeeModal();
    invalidateClientCaches();
    showAlert(typeof msg === 'string' ? msg : 'Saved successfully.', false);
    await loadDashboard(true);
    await loadEmployeesPage(empId ? state.empPage : 1, true);
  } catch (err) {
    showAlert(err.message || String(err), true);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    setLoading(false);
  }
}

async function deleteEmployeeRecord(empId) {
  if (!confirm(`Delete employee ${empId}?`)) return;
  setLoading(true);
  try {
    const msg = await callGasApi('deleteEmployee', { empId });
    invalidateClientCaches();
    showAlert(typeof msg === 'string' ? msg : 'Employee deleted.', false);
    await loadDashboard(true);
    await loadEmployeesPage(state.empPage, true);
  } catch (err) {
    showAlert(err.message || String(err), true);
  } finally {
    setLoading(false);
  }
}

// -------------------- Quick Shift & Production Log Modal --------------------

function openProductionModal() {
  const modal = document.getElementById('productionModal');
  const form = document.getElementById('productionForm');
  const prodUnitSelect = document.getElementById('prodUnitId');
  if (!modal || !form) return;

  form.reset();
  document.getElementById('prodCo2').value = '580';

  if (prodUnitSelect) {
    const dash = state.dashboardCache.get(state.deptId) || state.dashboardCache.values().next().value;
    const units = (dash && dash.units) || [];
    prodUnitSelect.innerHTML = '';
    units.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.unit_id;
      opt.textContent = u.unit_name;
      prodUnitSelect.appendChild(opt);
    });
    if (state.deptId && state.deptId !== 'ALL' && units.some(u => u.unit_id === state.deptId)) {
      prodUnitSelect.value = state.deptId;
    }
  }

  modal.classList.remove('hidden');
}

function closeProductionModal() {
  const modal = document.getElementById('productionModal');
  if (modal) modal.classList.add('hidden');
}

async function handleSaveProduction(event) {
  event.preventDefault();
  const btn = document.getElementById('saveProdBtn');
  if (btn) btn.disabled = true;
  setLoading(true);

  const payload = {
    unit_id: document.getElementById('prodUnitId').value,
    dispatched_tons: Number(document.getElementById('prodTons').value || 0),
    co2_intensity: Number(document.getElementById('prodCo2').value || 0),
    revenue_egp: Number(document.getElementById('prodRevenue').value || 0),
    shift_note: document.getElementById('prodNote').value.trim(),
    entry_date: new Date().toISOString()
  };

  try {
    const msg = await callGasApi('logProductionUpdate', payload);
    closeProductionModal();
    invalidateClientCaches();
    showAlert(typeof msg === 'string' ? msg : 'Production update logged.', false);
    await loadDashboard(true);
    if (state.activeTab === 'activity') {
      await loadRecentActivity(true);
    }
  } catch (err) {
    showAlert(err.message || String(err), true);
  } finally {
    if (btn) btn.disabled = false;
    setLoading(false);
  }
}

// -------------------- Activity Log --------------------

function renderActivityFeed(logs = []) {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;
  if (!logs.length) {
    feed.innerHTML = '<li class="empty-cell">No activity recorded yet.</li>';
    return;
  }
  feed.innerHTML = logs.map(item => `
    <li class="activity-item">
      <div class="act-top">
        <strong>${item.action}</strong>
        <span class="act-time">${item.timestamp}</span>
      </div>
      <div class="act-detail">${item.details}</div>
    </li>
  `).join('');
}

async function loadRecentActivity(forceRefresh = false) {
  if (!forceRefresh && Array.isArray(state.activityCache)) {
    renderActivityFeed(state.activityCache);
    return;
  }

  try {
    const logs = await callGasApi('getRecentActivity');
    state.activityCache = Array.isArray(logs) ? logs : [];
    renderActivityFeed(state.activityCache);
  } catch (err) {
    showAlert(err.message || String(err), true);
  }
}

// -------------------- PWA Install & Service Worker --------------------

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  state.deferredPrompt = e;
  document.getElementById('installBtnDesktop')?.classList.remove('hidden');
  document.getElementById('installBtnMobile')?.classList.remove('hidden');
});

async function triggerInstallPrompt() {
  if (!state.deferredPrompt) return;
  state.deferredPrompt.prompt();
  await state.deferredPrompt.userChoice;
  state.deferredPrompt = null;
  document.getElementById('installBtnDesktop')?.classList.add('hidden');
  document.getElementById('installBtnMobile')?.classList.add('hidden');
}

function checkIosInstallBanner() {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const dismissed = localStorage.getItem('holcim_ios_banner_dismissed') === '1';
  if (isIos && !isStandalone && !dismissed) {
    document.getElementById('iosInstallBanner')?.classList.remove('hidden');
  }
}

function dismissIosBanner() {
  localStorage.setItem('holcim_ios_banner_dismissed', '1');
  document.getElementById('iosInstallBanner')?.classList.add('hidden');
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./service-worker.js').then(reg => {
    state.swRegistration = reg;
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          document.getElementById('swUpdateBanner')?.classList.remove('hidden');
        }
      });
    });
  }).catch(() => {});
}

function applySwUpdate() {
  if (state.swRegistration && state.swRegistration.waiting) {
    state.swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
  window.location.reload();
}

// Expose all inline HTML handlers on window
window.switchTab = switchTab;
window.refreshAll = refreshAll;
window.openEmployeeModal = openEmployeeModal;
window.closeEmployeeModal = closeEmployeeModal;
window.handleSaveEmployee = handleSaveEmployee;
window.deleteEmployeeRecord = deleteEmployeeRecord;
window.openProductionModal = openProductionModal;
window.closeProductionModal = closeProductionModal;
window.handleSaveProduction = handleSaveProduction;
window.handleFilterChange = handleFilterChange;
window.debouncedSearch = debouncedSearch;
window.loadEmployeesPage = loadEmployeesPage;
window.changePage = changePage;
window.copyExecutiveSummary = copyExecutiveSummary;
window.exportEmployeesCsv = exportEmployeesCsv;
window.triggerInstallPrompt = triggerInstallPrompt;
window.dismissIosBanner = dismissIosBanner;
window.applySwUpdate = applySwUpdate;

// -------------------- Boot --------------------

window.addEventListener('online', updateConnectionStatus);
window.addEventListener('offline', updateConnectionStatus);
window.addEventListener('resize', () => {
  const current = state.dashboardCache.get(state.deptId);
  if (current) renderAllCharts(current);
});

document.addEventListener('DOMContentLoaded', () => {
  updateConnectionStatus();
  checkIosInstallBanner();
  registerServiceWorker();
  ensureGoogleChartsReady();
  switchTab('overview');
  loadDashboard(false);
});