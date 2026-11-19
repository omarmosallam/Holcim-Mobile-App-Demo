/**
 * Replace this URL with your deployed Google Apps Script Web App (/exec) URL.
 * If opened inside script.google.com directly, google.script.run is used automatically.
 */
const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzZidsn99APmSvvmVLTe8isT4uI35ljHUhEUgtUUYrZDu888aTxyzgQ0yvqbg2cNr6icQ/exec';

const state = {
  currentTab: 'overview',
  deptId: 'ALL',
  page: 1,
  pageSize: 10,
  totalPages: 1,
  search: '',
  sortBy: 'full_name',
  sortDir: 'asc',
  employeesCache: [],
  departments: [],
  dashboardData: null,
  inFlightRequests: new Set(),
  deferredInstallPrompt: null,
  waitingWorker: null
};

/* ============================================================================
 * 1. GOOGLE APPS SCRIPT DUAL BRIDGE (Preserves All Backend Signatures)
 * ========================================================================== */
function callGas(action, payload = {}) {
  const requestKey = `${action}:${JSON.stringify(payload)}`;
  if (state.inFlightRequests.has(requestKey)) {
    return Promise.reject(new Error('DUPLICATE_REQUEST'));
  }

  state.inFlightRequests.add(requestKey);
  setLoading(true);

  const cleanup = () => {
    state.inFlightRequests.delete(requestKey);
    if (state.inFlightRequests.size === 0) setLoading(false);
  };

  // Mode A: Running inside Google Apps Script HtmlService
  if (typeof google !== 'undefined' && google.script && google.script.run) {
    return new Promise((resolve, reject) => {
      const runner = google.script.run
        .withSuccessHandler((res) => { cleanup(); resolve(res); })
        .withFailureHandler((err) => { cleanup(); reject(err); });

      switch (action) {
        case 'getDashboardData': runner.getDashboardData(payload.unitId || 'ALL'); break;
        case 'getAllEmployees': runner.getAllEmployees(); break;
        case 'searchEmployeesPage': runner.searchEmployeesPage(payload); break;
        case 'addEmployee': runner.addEmployee(payload); break;
        case 'updateEmployee': runner.updateEmployee(payload); break;
        case 'deleteEmployee': runner.deleteEmployee(payload.empId || payload); break;
        case 'getRecentActivity': runner.getRecentActivity(); break;
        default: cleanup(); reject(new Error('Unknown GAS method: ' + action));
      }
    });
  }

  // Mode B: Running as an Installed HTTPS PWA calling GAS doPost()
  return fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Avoids CORS preflight OPTIONS on GAS
    body: JSON.stringify({ action, payload })
  })
    .then((res) => {
      if (!res.ok) throw new Error('Network response error: ' + res.status);
      return res.json();
    })
    .then((json) => {
      cleanup();
      if (!json.ok) throw new Error(json.error || 'Apps Script error');
      return json.data;
    })
    .catch((err) => {
      cleanup();
      throw err;
    });
}

/* ============================================================================
 * 2. SERVICE WORKER & ANDROID / iOS INSTALLATION EXPERIENCE
 * ========================================================================== */
function initPwa() {
  // Register Service Worker only on compatible HTTPS/localhost origins
  if ('serviceWorker' in navigator && !window.location.hostname.includes('googleusercontent.com')) {
    navigator.serviceWorker.register('./service-worker.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            state.waitingWorker = newWorker;
            document.getElementById('swUpdateBanner').classList.remove('hidden');
          }
        });
      });
    }).catch((err) => console.warn('SW registration skipped:', err));
  }

  // Detect Standalone Mode (already installed)
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  if (isStandalone) return;

  // Android / Desktop Chrome Install Prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    if (!localStorage.getItem('pwa_install_dismissed')) {
      document.getElementById('installBtnDesktop')?.classList.remove('hidden');
      document.getElementById('installBtnMobile')?.classList.remove('hidden');
    }
  });

  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    document.getElementById('installBtnDesktop')?.classList.add('hidden');
    document.getElementById('installBtnMobile')?.classList.add('hidden');
  });

  // iOS Safari Add-to-Home-Screen Detection
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isSafari = /safari/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
  if (isIos && isSafari && !localStorage.getItem('ios_a2hs_dismissed')) {
    document.getElementById('iosInstallBanner').classList.remove('hidden');
  }
}

async function triggerInstallPrompt() {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  const { outcome } = await state.deferredInstallPrompt.userChoice;
  if (outcome === 'dismissed') {
    localStorage.setItem('pwa_install_dismissed', '1');
  }
  state.deferredInstallPrompt = null;
  document.getElementById('installBtnDesktop')?.classList.add('hidden');
  document.getElementById('installBtnMobile')?.classList.add('hidden');
}

function dismissIosBanner() {
  localStorage.setItem('ios_a2hs_dismissed', '1');
  document.getElementById('iosInstallBanner').classList.add('hidden');
}

function applySwUpdate() {
  if (state.waitingWorker) {
    state.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    window.location.reload();
  }
}

/* ============================================================================
 * 3. NAVIGATION, CHARTS & DATA RENDERING
 * ========================================================================== */
const TAB_TITLES = {
  overview: 'Dashboard Overview',
  employees: 'Employee Directory',
  analytics: 'Workforce Analytics',
  activity: 'Activity Log'
};

function switchTab(tab) {
  state.currentTab = tab;
  document.getElementById('headerTitle').textContent = TAB_TITLES[tab] || 'Dashboard';

  document.querySelectorAll('.tab-panel').forEach((el) => el.classList.add('hidden'));
  document.getElementById('tab-' + tab).classList.remove('hidden');

  document.querySelectorAll('.nav-btn, .bottom-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  if (tab === 'employees' && state.employeesCache.length === 0) {
    loadEmployeesPage(1);
  } else if (tab === 'activity') {
    loadActivityLog();
  } else if ((tab === 'overview' || tab === 'analytics') && state.dashboardData) {
    renderCharts(state.dashboardData);
  }
}

function setLoading(isLoading) {
  document.getElementById('loadingBar').classList.toggle('hidden', !isLoading);
}

function showError(msg) {
  if (msg === 'DUPLICATE_REQUEST') return;
  const banner = document.getElementById('alertBanner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
  setTimeout(() => banner.classList.add('hidden'), 6000);
}

function handleFilterChange() {
  state.deptId = document.getElementById('deptFilter').value;
  refreshAll(false);
}

async function refreshAll(forceRefresh) {
  try {
    const dash = await callGas('getDashboardData', { unitId: state.deptId, force: forceRefresh });
    state.dashboardData = dash;
    populateDepartments(dash.units || dash.departments || []);
    renderKpis(dash.kpis || {});
    renderCharts(dash);

    if (state.currentTab === 'employees') await loadEmployeesPage(state.page);
    if (state.currentTab === 'activity') await loadActivityLog();
  } catch (err) {
    showError(err.message || 'Unable to reach Google Sheets backend.');
  }
}

function populateDepartments(depts) {
  if (!depts.length) return;
  state.departments = depts;
  const filterSel = document.getElementById('deptFilter');
  const formSel = document.getElementById('formDeptId');
  const prevVal = filterSel.value;

  filterSel.innerHTML = '<option value="ALL">All Departments &amp; Divisions</option>';
  formSel.innerHTML = '';

  depts.forEach((d) => {
    const id = d.unit_id || d.dept_id;
    const name = d.unit_name || d.dept_name;
    filterSel.insertAdjacentHTML('beforeend', `<option value="${id}">${name}</option>`);
    formSel.insertAdjacentHTML('beforeend', `<option value="${id}">${name}</option>`);
  });

  if (prevVal) filterSel.value = prevVal;
}

function renderKpis(k) {
  document.getElementById('kpiTotalEmp').textContent = k.headcount ?? k.totalHeadcount ?? '0';
  document.getElementById('kpiActiveEmp').textContent = `${k.activeEmployees ?? k.headcount ?? 0} active staff`;
  document.getElementById('kpiTotalDepts').textContent = state.departments.length || '—';
  const payroll = Number(k.monthlyPayrollEgp ?? k.monthlyPayroll ?? 0);
  document.getElementById('kpiPayroll').textContent = payroll ? payroll.toLocaleString() : '0';
  document.getElementById('kpiAvgScore').textContent = `${k.avgPerformance ?? '0.0'} / 5.0`;
}

function renderCharts(dash) {
  if (typeof google === 'undefined' || !google.visualization || !dash.charts) return;

  const isMobile = window.innerWidth < 640;
  const commonOpts = {
    legend: { position: isMobile ? 'bottom' : 'top', textStyle: { fontSize: 11 } },
    chartArea: { width: isMobile ? '84%' : '78%', height: '68%' },
    colors: ['#0b3b75', '#38bdf8', '#16a34a', '#f59e0b']
  };

  if (dash.charts.capexByUnitChart && document.getElementById('chartDeptHeadcount')) {
    const d1 = google.visualization.arrayToDataTable(dash.charts.capexByUnitChart);
    new google.visualization.ColumnChart(document.getElementById('chartDeptHeadcount')).draw(d1, commonOpts);
  }

  if (dash.charts.projectStatusChart && document.getElementById('chartStatusPie')) {
    const d2 = google.visualization.arrayToDataTable(dash.charts.projectStatusChart);
    new google.visualization.PieChart(document.getElementById('chartStatusPie')).draw(d2, {
      ...commonOpts,
      pieHole: 0.45
    });
  }

  if (dash.charts.monthlyTrendChart && document.getElementById('chartBudgetCompare')) {
    const d3 = google.visualization.arrayToDataTable(dash.charts.monthlyTrendChart);
    new google.visualization.ColumnChart(document.getElementById('chartBudgetCompare')).draw(d3, commonOpts);
  }

  if (dash.charts.co2TrendChart && document.getElementById('chartPerfCompare')) {
    const d4 = google.visualization.arrayToDataTable(dash.charts.co2TrendChart);
    new google.visualization.LineChart(document.getElementById('chartPerfCompare')).draw(d4, {
      ...commonOpts,
      pointSize: 5
    });
  }
}

/* ============================================================================
 * 4. EMPLOYEE PAGINATION, SEARCH, SORT & CRUD
 * ========================================================================== */
let searchTimer = null;
function debouncedSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadEmployeesPage(1), 320);
}

async function loadEmployeesPage(page = 1) {
  state.page = page;
  state.search = document.getElementById('searchInput').value.trim();
  state.sortBy = document.getElementById('sortField').value;
  state.sortDir = document.getElementById('sortDir').value;

  try {
    const res = await callGas('searchEmployeesPage', {
      page: state.page,
      pageSize: state.pageSize,
      search: state.search,
      deptId: state.deptId,
      sortBy: state.sortBy,
      sortDir: state.sortDir
    });

    const rows = res.items || res.rows || res.employees || (Array.isArray(res) ? res : []);
    state.employeesCache = rows;
    state.totalPages = res.totalPages || Math.max(1, Math.ceil((res.total || rows.length) / state.pageSize));
    renderEmployeeRows(rows);
    updatePaginationUi();
  } catch (err) {
    showError(err.message);
  }
}

function renderEmployeeRows(rows) {
  const tbody = document.getElementById('employeeListBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No matching employees found.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((emp) => {
    const id = emp.emp_id || emp.id;
    const name = emp.full_name || emp.name;
    const dept = emp.unit_name || emp.dept_name || emp.unit_id || emp.dept_id;
    const salary = Number(emp.monthly_salary_egp || emp.monthly_salary || 0).toLocaleString();
    const kpi = Number(emp.performance_score || 0).toFixed(1);
    const status = emp.status || 'Active';
    const badgeClass = status === 'Active' ? 'badge-active' : 'badge-leave';

    return `
      <tr>
        <td data-label="Employee ID"><strong>${id}</strong></td>
        <td data-label="Full Name">${name}</td>
        <td data-label="Role">${emp.role || ''}</td>
        <td data-label="Department">${dept}</td>
        <td data-label="Salary">${salary}</td>
        <td data-label="KPI Score">${kpi} / 5.0</td>
        <td data-label="Status"><span class="badge ${badgeClass}">${status}</span></td>
        <td>
          <button class="btn-sm-edit" onclick="editEmployee('${id}')">Edit</button>
          <button class="btn-sm-del" onclick="confirmDeleteEmployee('${id}', '${name.replace(/'/g, "\\'")}')">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

function updatePaginationUi() {
  document.getElementById('pageIndicator').textContent = `Page ${state.page} of ${state.totalPages}`;
  document.getElementById('prevPageBtn').disabled = state.page <= 1;
  document.getElementById('nextPageBtn').disabled = state.page >= state.totalPages;
}

function changePage(delta) {
  const next = state.page + delta;
  if (next >= 1 && next <= state.totalPages) {
    loadEmployeesPage(next);
  }
}

function openEmployeeModal(emp = null) {
  document.getElementById('modalTitle').textContent = emp ? 'Update Employee' : 'Add Employee';
  document.getElementById('formEmpId').value = emp ? (emp.emp_id || emp.id) : '';
  document.getElementById('formFullName').value = emp ? (emp.full_name || emp.name) : '';
  document.getElementById('formRole').value = emp ? emp.role : '';
  document.getElementById('formDeptId').value = emp ? (emp.unit_id || emp.dept_id) : (state.departments[0]?.unit_id || '');
  document.getElementById('formSalary').value = emp ? (emp.monthly_salary_egp || emp.monthly_salary) : '';
  document.getElementById('formScore').value = emp ? emp.performance_score : '4.5';
  document.getElementById('formStatus').value = emp ? emp.status : 'Active';
  document.getElementById('employeeModal').classList.remove('hidden');
}

function closeEmployeeModal() {
  document.getElementById('employeeModal').classList.add('hidden');
}

function editEmployee(empId) {
  const emp = state.employeesCache.find((e) => (e.emp_id || e.id) === empId);
  if (emp) openEmployeeModal(emp);
}

async function handleSaveEmployee(event) {
  event.preventDefault();
  const empId = document.getElementById('formEmpId').value;
  const payload = {
    emp_id: empId,
    full_name: document.getElementById('formFullName').value.trim(),
    role: document.getElementById('formRole').value.trim(),
    unit_id: document.getElementById('formDeptId').value,
    dept_id: document.getElementById('formDeptId').value,
    monthly_salary_egp: Number(document.getElementById('formSalary').value),
    monthly_salary: Number(document.getElementById('formSalary').value),
    performance_score: Number(document.getElementById('formScore').value),
    status: document.getElementById('formStatus').value
  };

  closeEmployeeModal();
  try {
    await callGas(empId ? 'updateEmployee' : 'addEmployee', payload);
    await refreshAll(true);
  } catch (err) {
    showError(err.message);
  }
}

async function confirmDeleteEmployee(empId, name) {
  if (!confirm(`Remove ${name} (${empId}) from Google Sheets?`)) return;
  try {
    await callGas('deleteEmployee', { empId });
    await refreshAll(true);
  } catch (err) {
    showError(err.message);
  }
}

async function loadActivityLog() {
  try {
    const logs = await callGas('getRecentActivity');
    const list = document.getElementById('activityFeed');
    if (!logs || !logs.length) {
      list.innerHTML = '<li class="empty-cell">No recent activity recorded.</li>';
      return;
    }
    list.innerHTML = logs.map((item) => `
      <li>
        <strong>${item.action || item.event || 'Update'}</strong> — ${item.details || item.message || ''}
        <span class="activity-time">${item.timestamp || item.date || ''}</span>
      </li>
    `).join('');
  } catch (err) {
    showError(err.message);
  }
}

/* ============================================================================
 * 5. INITIALIZATION & CONNECTIVITY LISTENERS
 * ========================================================================== */
window.addEventListener('online', () => {
  const pill = document.getElementById('connectionPill');
  pill.textContent = '● Live Sheets Sync';
  pill.className = 'status-pill online';
  refreshAll(false);
});

window.addEventListener('offline', () => {
  const pill = document.getElementById('connectionPill');
  pill.textContent = '● Offline (Live Data Paused)';
  pill.className = 'status-pill offline';
});

window.addEventListener('resize', () => {
  if (state.dashboardData) renderCharts(state.dashboardData);
});

document.addEventListener('DOMContentLoaded', () => {
  initPwa();
  if (typeof google !== 'undefined' && google.charts) {
    google.charts.load('current', { packages: ['corechart'] });
    google.charts.setOnLoadCallback(() => refreshAll(false));
  } else {
    refreshAll(false);
  }
});