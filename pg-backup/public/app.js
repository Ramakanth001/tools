/* global EventSource */

const $ = (id) => document.getElementById(id);

function formatBytes(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let v = num;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }
  return `${v.toFixed(v < 10 && idx > 0 ? 2 : 1)} ${units[idx]}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function loadTheme() {
  const stored = localStorage.getItem('pgbackup.theme');
  // default: light
  return stored === 'dark' ? 'dark' : 'light';
}

function setTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  localStorage.setItem('pgbackup.theme', t);
}

function nowISO() {
  return new Date().toISOString();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function api(path, { method = 'GET', body } = {}) {
  const resp = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.ok === false) {
    const msg = json.error ? (typeof json.error === 'string' ? json.error : JSON.stringify(json.error)) : resp.statusText;
    const e = new Error(msg || 'Request failed');
    e.status = resp.status;
    throw e;
  }
  return json;
}

function initTabs() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));

  function activate(name) {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const p of panels) {
      p.hidden = p.dataset.panel !== name;
    }
    localStorage.setItem('pgbackup.tab', name);
  }

  for (const t of tabs) {
    t.addEventListener('click', () => activate(t.dataset.tab));
  }
  activate(localStorage.getItem('pgbackup.tab') || 'run');

  return { activate };
}

function initThemeToggle() {
  const theme = loadTheme();
  setTheme(theme);
  const el = $('themeToggle');
  el.checked = theme === 'dark';
  el.addEventListener('change', () => setTheme(el.checked ? 'dark' : 'light'));
}

function getPoolerForm() {
  return {
    host: $('host').value.trim(),
    port: $('port').value.trim(),
    user: $('user').value.trim(),
    database: $('database').value.trim(),
    password: $('password').value,
  };
}

function buildPoolerConnectionString(pooler) {
  const host = String(pooler.host || '').trim();
  const port = Number(pooler.port || 5432);
  const user = String(pooler.user || '').trim();
  const database = String(pooler.database || '').trim();
  const password = String(pooler.password || '');
  if (!host || !user || !database) return '';
  const encodedUser = encodeURIComponent(user);
  const encodedPass = encodeURIComponent(password);
  const encodedDb = encodeURIComponent(database);
  return `postgresql://${encodedUser}:${encodedPass}@${host}:${port}/${encodedDb}?sslmode=require`;
}

function uiLog(line) {
  const el = $('log');
  el.textContent += `${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function setRunStatus(text, kind = 'muted') {
  const el = $('runStatus');
  el.textContent = text;
  el.className = kind && kind !== 'muted' ? `badge ${kind}` : 'badge';
}

function showAlert(kind, title, detail) {
  const box = $('alertBox');
  box.innerHTML = `
    <div class="alert ${kind}">
      <div style="font-weight:800; margin-bottom:6px">${escapeHtml(title)}</div>
      <div style="color: var(--muted)">${escapeHtml(detail || '')}</div>
    </div>
  `;
}

function clearAlert() {
  $('alertBox').innerHTML = '';
}

async function loadProfiles() {
  const raw = localStorage.getItem('pgbackup.profiles');
  let profiles = [];
  try {
    profiles = raw ? JSON.parse(raw) : [];
  } catch {
    profiles = [];
  }
  return Array.isArray(profiles) ? profiles : [];
}

async function saveProfiles(profiles) {
  localStorage.setItem('pgbackup.profiles', JSON.stringify(profiles));
}

async function refreshProfilesUI() {
  const profiles = await loadProfiles();
  const sel = $('profileSelect');
  sel.innerHTML = '<option value="">— Select profile —</option>';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
}

async function initProfiles() {
  await refreshProfilesUI();

  $('profileSelect').addEventListener('change', async () => {
    const id = $('profileSelect').value;
    if (!id) return;
    const profiles = await loadProfiles();
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    $('host').value = p.host || '';
    $('port').value = String(p.port || '5432');
    $('user').value = p.user || '';
    $('database').value = p.database || '';
    $('conn').value = p.connectionString || '';
  });

  $('saveProfile').addEventListener('click', async () => {
    const name = $('profileName').value.trim();
    if (!name) {
      showAlert('warn', 'Missing profile name', 'Enter a name, then click Save profile.');
      return;
    }
    const profiles = await loadProfiles();
    const id = `p_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
    const pooler = getPoolerForm();
    const item = {
      id,
      name,
      host: pooler.host,
      port: Number(pooler.port || 5432),
      user: pooler.user,
      database: pooler.database,
      connectionString: $('conn').value.trim(),
      createdAt: nowISO(),
    };
    profiles.unshift(item);
    await saveProfiles(profiles.slice(0, 50));
    $('profileName').value = '';
    await refreshProfilesUI();
    $('profileSelect').value = id;
    showAlert('success', 'Profile saved', `Saved “${name}”. Password is never stored.`);
  });

  $('deleteProfile').addEventListener('click', async () => {
    const id = $('profileSelect').value;
    if (!id) return;
    const profiles = await loadProfiles();
    const next = profiles.filter((p) => p.id !== id);
    await saveProfiles(next);
    await refreshProfilesUI();
    $('profileSelect').value = '';
    showAlert('success', 'Profile deleted', 'Removed selected profile.');
  });
}

async function testConnection() {
  clearAlert();
  const cs = ($('conn').value || '').trim() || buildPoolerConnectionString(getPoolerForm());
  if (!cs) {
    showAlert('warn', 'Missing connection details', 'Fill pooler details (and password) or paste a connection string.');
    return;
  }

  $('test').disabled = true;
  $('testStatus').textContent = 'Testing…';
  try {
    await api('/api/test-connection', { method: 'POST', body: { connectionString: cs } });
    $('testStatus').textContent = 'OK';
    showAlert('success', 'Connection OK', 'psql was able to run `select 1;`.');
  } catch (e) {
    $('testStatus').textContent = 'FAILED';
    showAlert('error', 'Connection failed', e.message);
  } finally {
    $('test').disabled = false;
  }
}

function initPasswordToggle() {
  $('togglePw').addEventListener('click', () => {
    const el = $('password');
    el.type = el.type === 'password' ? 'text' : 'password';
    $('togglePw').textContent = el.type === 'password' ? 'Show' : 'Hide';
  });
}

async function startBackup() {
  clearAlert();
  $('log').textContent = '';
  $('download').style.display = 'none';
  $('cancel').style.display = 'none';

  const connectionString = $('conn').value.trim();
  const pooler = getPoolerForm();

  $('run').disabled = true;
  $('test').disabled = true;
  setRunStatus('Starting…');
  const startedAt = Date.now();
  let ev;

  try {
    const body = {
      connectionString,
      pooler: connectionString
        ? undefined
        : {
            host: pooler.host,
            port: pooler.port,
            user: pooler.user,
            database: pooler.database,
            password: pooler.password,
          },
      options: {
        fullDump: $('fullDump').checked,
        schemaOnly: $('schemaOnly').checked,
        inventory: $('inventory').checked,
        plainSql: $('plainSql').checked,
        roles: $('roles').checked,
        schemaInclude: $('schemaInclude').value.trim(),
        schemaExclude: $('schemaExclude').value.trim(),
        tableInclude: $('tableInclude').value.trim(),
        tableExclude: $('tableExclude').value.trim(),
      },
    };

    const resp = await api('/api/backup', { method: 'POST', body });
    const jobId = resp.jobId;
    $('jobId').textContent = jobId;
    $('cancel').style.display = 'inline-flex';
    $('cancel').onclick = async () => {
      try {
        $('cancel').disabled = true;
        await api(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
      } catch (e) {
        showAlert('error', 'Cancel failed', e.message);
      } finally {
        $('cancel').disabled = false;
      }
    };

    uiLog(`[${nowISO()}] Job created: ${jobId}`);
    ev = new EventSource(`/api/jobs/${jobId}/events`);

    ev.addEventListener('log', (e) => {
      const line = JSON.parse(e.data);
      uiLog(line);
    });

    ev.addEventListener('progress', (e) => {
      const p = JSON.parse(e.data);
      const elapsed = Math.max(0, Date.now() - startedAt);
      const seconds = Math.round(elapsed / 1000);
      const pct = typeof p.percent === 'number' ? Math.max(0, Math.min(100, p.percent)) : null;
      const bytes = typeof p.bytes === 'number' ? formatBytes(p.bytes) : null;
      $('progressBar').value = pct ?? 0;
      $('progressMeta').textContent = `${p.phase || 'running'} • ${seconds}s${bytes ? ` • ${bytes}` : ''}`;
      setRunStatus(pct != null ? `${pct}%` : 'Running…');
    });

    ev.addEventListener('status', async (e) => {
      const s = JSON.parse(e.data);
      ev.close();
      $('run').disabled = false;
      $('test').disabled = false;
      $('cancel').style.display = 'none';

      uiLog(`STATUS: ${s.status}`);
      if (s.status === 'done') {
        $('progressBar').className = 'ok';
        $('progressBar').value = 100;
        $('progressMeta').textContent = 'Complete • dumps are ready';
        $('download').href = `/api/jobs/${jobId}/download`;
        $('download').style.display = 'inline-flex';
        setRunStatus('Done', 'success');
        showAlert('success', 'Backup complete', 'Zip is ready to download.');
        await refreshHistory();
      } else if (s.status === 'cancelled') {
        $('progressBar').className = 'warn';
        setRunStatus('Cancelled', 'warn');
        showAlert('warn', 'Backup cancelled', 'The job was cancelled. Partial artifacts may exist.');
        await refreshHistory();
      } else {
        $('progressBar').className = 'bad';
        setRunStatus('Error', 'danger');
        try {
          const st = await api(`/api/jobs/${jobId}`);
          const jb = st.job;
          showAlert('error', 'Backup failed', jb.error || 'Unknown error');
        } catch (e2) {
          showAlert('error', 'Backup failed', e2.message);
        }
        await refreshHistory();
      }
    });
  } catch (e) {
    $('run').disabled = false;
    $('test').disabled = false;
    $('progressBar').className = 'bad';
    setRunStatus('Idle');
    showAlert('error', 'Request failed', e.message);
  }
}

async function copyLogs() {
  const text = $('log').textContent;
  try {
    await navigator.clipboard.writeText(text);
    showAlert('success', 'Copied', 'Logs copied to clipboard.');
  } catch {
    showAlert('warn', 'Copy failed', 'Your browser blocked clipboard access. Select and copy manually.');
  }
}

async function refreshHistory() {
  const q = $('historySearch').value.trim();
  const data = await api(`/api/jobs?limit=50&q=${encodeURIComponent(q)}`);
  const rows = data.jobs || [];
  const tbody = $('historyBody');
  tbody.innerHTML = '';

  for (const j of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${escapeHtml(j.id)}</td>
      <td>${escapeHtml(j.status)}</td>
      <td>${escapeHtml(new Date(j.createdAt).toLocaleString())}</td>
      <td class="right">${j.zipBytes != null ? escapeHtml(formatBytes(j.zipBytes)) : '—'}</td>
      <td class="right">
        <div class="toolbar" style="justify-content:flex-end">
          <a class="btn" href="/api/jobs/${encodeURIComponent(j.id)}/download" ${j.zipReady ? '' : 'style="pointer-events:none; opacity:0.5"'}>Download</a>
          <button class="btn danger" data-del="${escapeHtml(j.id)}">Delete</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-del');
      if (!id) return;
      if (!confirm(`Delete job ${id}? This removes the folder + zip.`)) return;
      try {
        btn.disabled = true;
        await api(`/api/jobs/${encodeURIComponent(id)}/delete`, { method: 'POST' });
        await refreshHistory();
        showAlert('success', 'Deleted', `Removed ${id}.`);
      } catch (e) {
        showAlert('error', 'Delete failed', e.message);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

async function runCleanup() {
  const days = Number($('retentionDays').value || 14);
  const keep = Number($('retentionKeep').value || 50);
  try {
    const r = await api('/api/cleanup', { method: 'POST', body: { days, keep } });
    showAlert('success', 'Cleanup complete', `Deleted ${r.deleted || 0} job(s).`);
    await refreshHistory();
  } catch (e) {
    showAlert('error', 'Cleanup failed', e.message);
  }
}

function initRetentionPresets() {
  const btn = $('maxRetention');
  if (!btn) return;
  btn.addEventListener('click', () => {
    $('retentionDays').value = '36500';
    $('retentionKeep').value = '5000';
    showAlert('success', 'Max retention set', 'Retention updated. Click Cleanup to apply deletion rules.');
  });
}

function initDefaults() {
  $('host').value = 'aws-1-ap-south-1.pooler.supabase.com';
  $('port').value = '5432';
  $('user').value = 'postgres.cughfeafhxhumjbijlpr';
  $('database').value = 'postgres';
}

async function main() {
  initThemeToggle();
  initTabs();
  initDefaults();
  initPasswordToggle();
  await initProfiles();

  $('test').addEventListener('click', testConnection);
  $('run').addEventListener('click', startBackup);
  $('copyLogs').addEventListener('click', copyLogs);
  $('historyRefresh').addEventListener('click', refreshHistory);
  $('historySearch').addEventListener('input', debounce(refreshHistory, 250));
  $('runCleanup').addEventListener('click', runCleanup);
  initRetentionPresets();

  await refreshHistory();
}

main().catch((e) => {
  // last-resort error
  const box = $('alertBox');
  if (box) {
    box.innerHTML = `<div class="alert error"><b>UI init failed</b><div class="mono">${escapeHtml(e?.message || String(e))}</div></div>`;
  }
});
