/**
 * Holcim Egypt Management & KPI Dashboard — External PWA Client (app.js)
 * Connects to Google Apps Script Web App (/exec) via JSON POST bridge.
 */

const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzZidsn99APmSvvmVLTe8isT4uI35ljHUhEUgtUUYrZDu888aTxyzgQ0yvqbg2cNr6icQ/exec'; // Replace with https://script.google.com/macros/s/.../exec
const PAGE_SIZE = 10;

const state = {
  activeTab: 'overview',
  unitId: 'ALL',
  empPage: 1,
  empSearch: '',
  empSortBy: 'full_name',
  empSortDir: 'asc',
  dashboardCache: new Map(), // key: unitId -> dashboard response object
  empListCache: null,       // array of all employees for fast instant search/sort/page
  empListVersion: null,     // tracks dbVersion from dashboard response
  activityCache: null,      // cached recent activity rows
  activityVersion: null,
  inFlight: new Set()
};

// -------------------- API Bridge (`doPost`) --------------------

async function callGasApi(action, payload = {}) {
  if (!GAS_WEB_APP_URL || GAS_WEB_APP_URL.includes('YOUR_GAS_WEB_APP_EXEC_URL')) {
    throw new Error('Please set GAS_WEB_APP_URL in app.js to your deployed /exec URL.');
  }

  const res = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    // text/plain avoids CORS preflight issues with Google Apps Script Web Apps
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

function showToast(message, isError = false) {
  let toast = document.getElementById('holcimToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'holcimToast';
    toast.style.cssText = [
      'position:fixed;bottom:76px;left:50%;transform:translateX(-50%);z-index:9999;',
      'padding:10px 16px;border-radius:10px;font-size:13px;font-weight:500;',
      'box-shadow:0 8px 24px rgba(15,23,42,0.22);transition:opacity 0.2s ease;max-width:90vw;'
    ].join('');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.background = isError ? '#dc2626' : '#0f172a';
  toast.style.color = '#ffffff';
  toast.style.opacity = '1';

  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.style.opacity = '0';
  }, 3000);
}

function showErrorBanner(message) {
  let banner = document.getElementById('errorBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'errorBanner';
    banner.style.cssText = [
      'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;',
      'padding:10px 14px;border-radius:10px;margin:10px 0;font-size:13px;display:none;'
    ].join('');
    const main = document.querySelector('main') || document.body;
    main.prepend(banner);
  }
  if (!message) {
    banner.style.display = 'none';
    banner.textContent = '';
    return;
  }
  banner.textContent = message;
  banner.style.display = 'block';
}

function setLoading(isLoading) {
  const loader = document.getElementById('loadingIndicator');
  if (loader) {
    loader.style.display = isLoading ? 'inline-flex' : 'none';
  }
  document.querySelectorAll('[data-refresh-btn]').forEach(btn => {
    btn.disabled = isLoading;
  });
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

// -------------------- Navigation & Filter Events --------------------

function switchTab(tabName) {
  state.activeTab = tabName || 'overview';

  document.querySelectorAll('[data-tab-section]').forEach(el => {
    el.style.display = el.getAttribute('data-tab-section') === state.activeTab ? '' : 'none';
  });

  document.querySelectorAll('[data-nav-tab]').forEach(btn => {
    const isActive = btn.getAttribute('data-nav-tab') === state.activeTab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-current', isActive ? 'page' : 'false');
  });

  if (state.activeTab === 'employees') {
    loadEmployeesPage(state.empPage);
  } else if (state.activeTab === 'activity') {
    loadRecentActivity();
  }
}

function populateUnitSelects(units, selectedUnitId) {
  const selects = document.querySelectorAll('#unitFilter, #deptFilter, [data-unit-select]');
  selects.forEach(select => {
    const isFilter = select.id === 'unitFilter' || select.id === 'deptFilter';
    const currentVal = isFilter ? selectedUnitId : (select.value || (units[0] && units[0].unit_id) || '');
    select.innerHTML = '';

    if (isFilter) {
      const allOpt = document.createElement('option');
      allOpt.value = 'ALL';
      allOpt.textContent = 'All Departments & Divisions';
      select.appendChild(allOpt);
    }

    (units || []).forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.unit_id;
      opt.textContent = u.unit_name;
      select.appendChild(opt);
    });

    if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
      select.value = currentVal;
    }
  });
}

// -------------------- Dashboard Rendering & Caching --------------------

function applyDashboardData(data, selectedUnit) {
  showErrorBanner('');

  // If dbVersion changed on backend, clear stale employee/activity caches
  if (data.dbVersion && data.dbVersion !== state.empListVersion) {
    state.empListCache = null;
    state.empListVersion = data.dbVersion;
  }
  if (data.dbVersion && data.dbVersion !== state.activityVersion) {
    state.activityCache = null;
    state.activityVersion = data.dbVersion;
  }

  const sheetLink = document.getElementById('openSheetLink');
  if (sheetLink && data.sheetUrl) {
    sheetLink.href = data.sheetUrl;
  }

  populateUnitSelects(data.units, selectedUnit);
  renderKpis(data.kpis);
  renderCharts(data.charts);
  renderSummaryTables(data);
}

function renderKpis(kpis = {}) {
  const map = {
    kpiTotalEmployees: formatNumber(kpis.headcount),
    kpiDepartments: formatNumber(5),
    kpiMonthlyPayroll: formatNumber(kpis.monthlyPayrollEgp),
    kpiAvgScore: `${Number(kpis.avgPerformance || 0).toFixed(2)} / 5.0`,
    kpiDispatchedTons: `${formatNumber(kpis.totalDispatchedTons)} t`,
    kpiRevenueEgp: formatCompactEgp(kpis.totalRevenueEgp),
    kpiCo2Intensity: `${formatNumber(kpis.avgCo2)} kg/t`,
    kpiCapexProgress: `${formatNumber(kpis.avgProjectProgress)}%`
  };

  Object.entries(map).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  });
}

function renderCharts(charts = {}) {
  // Lightweight canvas bar chart renderer if a #headcountChart canvas exists
  const canvas = document.getElementById('headcountChart');
  if (!canvas || !canvas.getContext) return;
  const rows = (charts.capexByUnitChart || []).slice(1);
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!rows.length) return;
  const maxVal = Math.max(1, ...rows.flatMap(r => [Number(r[1] || 0), Number(r[2] || 0)]));
  const groupW = w / rows.length;
  const barW = Math.min(22, groupW * 0.28);

  rows.forEach((r, idx) => {
    const xBase = idx * groupW + groupW * 0.2;
    const allocH = (Number(r[1] || 0) / maxVal) * (h - 36);
    const spentH = (Number(r[2] || 0) / maxVal) * (h - 36);

    ctx.fillStyle = '#0f294a';
    ctx.fillRect(xBase, h - 22 - allocH, barW, allocH);

    ctx.fillStyle = '#0ea5e9';
    ctx.fillRect(xBase + barW + 4, h - 22 - spentH, barW, spentH);

    ctx.fillStyle = '#475569';
    ctx.font = '10px sans-serif';
    const label = String(r[0] || '').split(' ')[0];
    ctx.fillText(label, xBase, h - 8);
  });
}

function renderSummaryTables(data) {
  const projBody = document.getElementById('projectsTableBody');
  if (projBody && data.tables && Array.isArray(data.tables.projects)) {
    projBody.innerHTML = data.tables.projects.map(p => `
      <tr>
        <td>${p.proj_id}</td>
        <td>${p.project_name}</td>
        <td>${p.unit_name}</td>
        <td>${p.completion_pct}%</td>
        <td>${p.status}</td>
      </tr>
    `).join('');
  }
}

async function loadDashboard(forceRefresh = false) {
  const selectedUnit = state.unitId || 'ALL';

  // Instant render from client memory when no force refresh is requested
  if (!forceRefresh && state.dashboardCache.has(selectedUnit)) {
    applyDashboardData(state.dashboardCache.get(selectedUnit), selectedUnit);
    if (state.activeTab === 'employees') {
      loadEmployeesPage(state.empPage);
    } else if (state.activeTab === 'activity') {
      loadRecentActivity();
    }
    return;
  }

  const reqKey = `dash:${selectedUnit}`;
  if (state.inFlight.has(reqKey)) return;

  state.inFlight.add(reqKey);
  setLoading(true);

  try {
    const data = await callGasApi('getDashboardData', { unitId: selectedUnit });
    state.dashboardCache.set(selectedUnit, data);
    applyDashboardData(data, selectedUnit);

    if (state.activeTab === 'employees') {
      await loadEmployeesPage(state.empPage, forceRefresh);
    } else if (state.activeTab === 'activity') {
      await loadRecentActivity(forceRefresh);
    }
  } catch (err) {
    showErrorBanner(err.message || String(err));
    showToast(err.message || 'Failed to load dashboard', true);
  } finally {
    state.inFlight.delete(reqKey);
    setLoading(false);
  }
}

// -------------------- Employees Search, Sort, Pagination & CRUD --------------------

function filterAndPaginateLocalEmployees(allEmployees) {
  const search = String(state.empSearch || '').toLowerCase().trim();
  const deptId = state.unitId || 'ALL';
  const sortBy = state.empSortBy || 'full_name';
  const sortDir = state.empSortDir === 'desc' ? -1 : 1;

  let list = allEmployees.slice();

  if (deptId && deptId !== 'ALL') {
    list = list.filter(e => e.unit_id === deptId);
  }
  if (search) {
    list = list.filter(e =>
      String(e.emp_id || '').toLowerCase().includes(search) ||
      String(e.full_name || '').toLowerCase().includes(search) ||
      String(e.role || '').toLowerCase().includes(search) ||
      String(e.unit_name || '').toLowerCase().includes(search)
    );
  }

  list.sort((a, b) => {
    const valA = a[sortBy];
    const valB = b[sortBy];
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
    items: list.slice(start, start + PAGE_SIZE),
    page: safePage,
    pageSize: PAGE_SIZE,
    total,
    totalPages
  };
}

function renderEmployeesPage(pageData) {
  state.empPage = pageData.page;
  const container = document.getElementById('employeesListContainer');
  const pageInfo = document.getElementById('empPageInfo');
  const prevBtn = document.getElementById('empPrevBtn');
  const nextBtn = document.getElementById('empNextBtn');

  if (pageInfo) {
    pageInfo.textContent = `Page ${pageData.page} of ${pageData.totalPages} (${pageData.total})`;
  }
  if (prevBtn) prevBtn.disabled = pageData.page <= 1;
  if (nextBtn) nextBtn.disabled = pageData.page >= pageData.totalPages;

  if (!container) return;

  if (!pageData.items.length) {
    container.innerHTML = '<div class="empty-state">No matching employees found.</div>';
    return;
  }

  container.innerHTML = pageData.items.map(emp => `
    <div class="employee-card" data-emp-id="${emp.emp_id}">
      <div class="emp-main">
        <strong>${emp.full_name}</strong> <span class="emp-id">(${emp.emp_id})</span>
        <div class="emp-role">${emp.role} • ${emp.unit_name}</div>
      </div>
      <div class="emp-meta">
        <span>EGP ${formatNumber(emp.monthly_salary_egp)}/mo</span>
        <span>KPI: ${Number(emp.performance_score || 0).toFixed(1)}</span>
        <span>${emp.status || 'Active'}</span>
      </div>
      <div class="emp-actions">
        <button type="button" onclick="openEditEmployeeModal('${emp.emp_id}')">Edit</button>
        <button type="button" onclick="handleDeleteEmployee('${emp.emp_id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

async function loadEmployeesPage(page = 1, forceRefresh = false) {
  state.empPage = Math.max(1, Number(page || 1));
  showErrorBanner('');

  // Fast instant client-side filtering/sorting/pagination if full list is already cached
  if (!forceRefresh && Array.isArray(state.empListCache)) {
    renderEmployeesPage(filterAndPaginateLocalEmployees(state.empListCache));
    return;
  }

  const container = document.getElementById('employeesListContainer');
  if (container && !state.empListCache) {
    container.innerHTML = '<div class="loading-state">Loading employees...</div>';
  }

  const reqKey = 'empList';
  if (state.inFlight.has(reqKey)) return;
  state.inFlight.add(reqKey);

  try {
    const allEmployees = await callGasApi('getAllEmployees');
    state.empListCache = Array.isArray(allEmployees) ? allEmployees : [];
    renderEmployeesPage(filterAndPaginateLocalEmployees(state.empListCache));
  } catch (err) {
    showErrorBanner(err.message || String(err));
    if (container) {
      container.innerHTML = '<div class="error-state">Could not load employees.</div>';
    }
  } finally {
    state.inFlight.delete(reqKey);
  }
}

function handleEmployeeSearchInput(value) {
  state.empSearch = value || '';
  state.empPage = 1;
  loadEmployeesPage(1);
}

function handleEmployeeSortChange(sortBy, sortDir) {
  if (sortBy) state.empSortBy = sortBy;
  if (sortDir) state.empSortDir = sortDir;
  state.empPage = 1;
  loadEmployeesPage(1);
}

async function handleAddEmployee(payload) {
  setLoading(true);
  try {
    const msg = await callGasApi('addEmployee', payload);
    invalidateClientCaches();
    showToast(typeof msg === 'string' ? msg : 'Employee added.');
    await loadDashboard(true);
    await loadEmployeesPage(1, true);
  } catch (err) {
    showToast(err.message || 'Failed to add employee', true);
  } finally {
    setLoading(false);
  }
}

function openEditEmployeeModal(empId) {
  const emp = (state.empListCache || []).find(e => String(e.emp_id) === String(empId));
  if (!emp) {
    showToast('Employee record not found in memory. Refreshing...', true);
    loadEmployeesPage(state.empPage, true);
    return;
  }
  const modal = document.getElementById('editEmployeeModal');
  if (!modal) return;
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v ?? '';
  };
  setVal('editEmpId', emp.emp_id);
  setVal('editFullName', emp.full_name);
  setVal('editRole', emp.role);
  setVal('editUnitId', emp.unit_id);
  setVal('editSalary', emp.monthly_salary_egp);
  setVal('editShiftType', emp.shift_type || 'Day');
  setVal('editSafetyCert', emp.safety_certified || 'Yes');
  setVal('editPerfScore', emp.performance_score ?? 4.5);
  setVal('editStatus', emp.status || 'Active');
  modal.style.display = 'flex';
}

async function handleUpdateEmployee(payload) {
  setLoading(true);
  try {
    const msg = await callGasApi('updateEmployee', payload);
    invalidateClientCaches();
    showToast(typeof msg === 'string' ? msg : 'Employee updated.');
    const modal = document.getElementById('editEmployeeModal');
    if (modal) modal.style.display = 'none';
    await loadDashboard(true);
    await loadEmployeesPage(state.empPage, true);
  } catch (err) {
    showToast(err.message || 'Failed to update employee', true);
  } finally {
    setLoading(false);
  }
}

async function handleDeleteEmployee(empId) {
  if (!confirm(`Delete employee ${empId}?`)) return;
  setLoading(true);
  try {
    const msg = await callGasApi('deleteEmployee', { empId });
    invalidateClientCaches();
    showToast(typeof msg === 'string' ? msg : 'Employee deleted.');
    await loadDashboard(true);
    await loadEmployeesPage(state.empPage, true);
  } catch (err) {
    showToast(err.message || 'Failed to delete employee', true);
  } finally {
    setLoading(false);
  }
}

// -------------------- Activity Log --------------------

function renderActivityList(logs = []) {
  const container = document.getElementById('activityListContainer');
  if (!container) return;
  if (!logs.length) {
    container.innerHTML = '<div class="empty-state">No recent activity logged.</div>';
    return;
  }
  container.innerHTML = logs.map(item => `
    <div class="activity-item">
      <strong>${item.action}</strong> — <span>${item.details}</span>
      <div class="activity-time">${item.timestamp}</div>
    </div>
  `).join('');
}

async function loadRecentActivity(forceRefresh = false) {
  if (!forceRefresh && Array.isArray(state.activityCache)) {
    renderActivityList(state.activityCache);
    return;
  }

  try {
    const logs = await callGasApi('getRecentActivity');
    state.activityCache = Array.isArray(logs) ? logs : [];
    renderActivityList(state.activityCache);
  } catch (err) {
    showToast(err.message || 'Failed to load activity log', true);
  }
}

// -------------------- Initialization --------------------

function bindEvents() {
  document.querySelectorAll('[data-nav-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-nav-tab')));
  });

  document.querySelectorAll('#unitFilter, #deptFilter').forEach(select => {
    select.addEventListener('change', e => {
      state.unitId = e.target.value || 'ALL';
      state.empPage = 1;
      loadDashboard(false); // Uses cached data if already viewed; fetches once if new unit
    });
  });

  document.querySelectorAll('[data-refresh-btn]').forEach(btn => {
    btn.addEventListener('click', () => {
      invalidateClientCaches();
      loadDashboard(true);
    });
  });

  const searchInput = document.getElementById('empSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', e => handleEmployeeSearchInput(e.target.value));
  }

  const sortBySelect = document.getElementById('empSortBy');
  const sortDirSelect = document.getElementById('empSortDir');
  if (sortBySelect) {
    sortBySelect.addEventListener('change', () => handleEmployeeSortChange(sortBySelect.value, null));
  }
  if (sortDirSelect) {
    sortDirSelect.addEventListener('change', () => handleEmployeeSortChange(null, sortDirSelect.value));
  }

  const prevBtn = document.getElementById('empPrevBtn');
  const nextBtn = document.getElementById('empNextBtn');
  if (prevBtn) prevBtn.addEventListener('click', () => loadEmployeesPage(state.empPage - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => loadEmployeesPage(state.empPage + 1));

  const addForm = document.getElementById('addEmployeeForm');
  if (addForm) {
    addForm.addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(addForm);
      handleAddEmployee({
        full_name: fd.get('full_name'),
        role: fd.get('role'),
        unit_id: fd.get('unit_id'),
        monthly_salary_egp: Number(fd.get('monthly_salary_egp') || 0),
        shift_type: fd.get('shift_type') || 'Day',
        safety_certified: fd.get('safety_certified') || 'Yes',
        performance_score: Number(fd.get('performance_score') || 4.5)
      });
      addForm.reset();
    });
  }

  const editForm = document.getElementById('editEmployeeForm');
  if (editForm) {
    editForm.addEventListener('submit', e => {
      e.preventDefault();
      handleUpdateEmployee({
        emp_id: document.getElementById('editEmpId').value,
        full_name: document.getElementById('editFullName').value,
        role: document.getElementById('editRole').value,
        unit_id: document.getElementById('editUnitId').value,
        monthly_salary_egp: Number(document.getElementById('editSalary').value || 0),
        shift_type: document.getElementById('editShiftType').value,
        safety_certified: document.getElementById('editSafetyCert').value,
        performance_score: Number(document.getElementById('editPerfScore').value || 4.5),
        status: document.getElementById('editStatus').value
      });
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  switchTab(state.activeTab);
  loadDashboard(false);
});