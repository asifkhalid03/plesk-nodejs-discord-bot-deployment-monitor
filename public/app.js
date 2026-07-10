const state = {
  watchers: [],
  groups: [],
  pendingJobs: [],
  discordStatus: null,
  activeLogWatcherId: null,
  activeLogRemoteLoaded: false,
  logPollTimer: null
};

const els = {
  addWatcherBtn: document.querySelector('#addWatcherBtn'),
  restartSetupBtn: document.querySelector('#restartSetupBtn'),
  logoutBtn: document.querySelector('#logoutBtn'),
  refreshBtn: document.querySelector('#refreshBtn'),
  reportBotStartBtn: document.querySelector('#reportBotStartBtn'),
  reportBotStopBtn: document.querySelector('#reportBotStopBtn'),
  reportBotSummary: document.querySelector('#reportBotSummary'),
  discordSummary: document.querySelector('#discordSummary'),
  discordBadge: document.querySelector('#discordBadge'),
  pendingWebhooksSummary: document.querySelector('#pendingWebhooksSummary'),
  pendingWebhooksEmpty: document.querySelector('#pendingWebhooksEmpty'),
  pendingWebhooksList: document.querySelector('#pendingWebhooksList'),
  groupsSummary: document.querySelector('#groupsSummary'),
  groupNameInput: document.querySelector('#groupNameInput'),
  addGroupBtn: document.querySelector('#addGroupBtn'),
  groupsList: document.querySelector('#groupsList'),
  watchersBody: document.querySelector('#watchersBody'),
  emptyState: document.querySelector('#emptyState'),
  summary: document.querySelector('#summary'),
  dialog: document.querySelector('#watcherDialog'),
  form: document.querySelector('#watcherForm'),
  dialogTitle: document.querySelector('#dialogTitle'),
  closeDialogBtn: document.querySelector('#closeDialogBtn'),
  cancelBtn: document.querySelector('#cancelBtn'),
  logDialog: document.querySelector('#logDialog'),
  logDialogTitle: document.querySelector('#logDialogTitle'),
  logDialogSummary: document.querySelector('#logDialogSummary'),
  closeLogDialogBtn: document.querySelector('#closeLogDialogBtn'),
  loadRemoteLogBtn: document.querySelector('#loadRemoteLogBtn'),
  liveLogBlock: document.querySelector('#liveLogBlock'),
  commandDialog: document.querySelector('#commandDialog'),
  commandDialogTitle: document.querySelector('#commandDialogTitle'),
  closeCommandDialogBtn: document.querySelector('#closeCommandDialogBtn'),
  commandNodeBin: document.querySelector('#commandNodeBin'),
  commandLogPath: document.querySelector('#commandLogPath'),
  commandSteps: document.querySelector('#commandSteps'),
  commandOutput: document.querySelector('#commandOutput'),
  copyCommandBtn: document.querySelector('#copyCommandBtn'),
  formError: document.querySelector('#formError'),
  toast: document.querySelector('#toast'),
  statTotal: document.querySelector('#statTotal'),
  statActive: document.querySelector('#statActive'),
  statErrors: document.querySelector('#statErrors'),
  statStopped: document.querySelector('#statStopped')
};

const fields = {
  id: document.querySelector('#watcherId'),
  name: document.querySelector('#name'),
  groupId: document.querySelector('#groupId'),
  protocol: document.querySelector('#protocol'),
  host: document.querySelector('#host'),
  port: document.querySelector('#port'),
  username: document.querySelector('#username'),
  password: document.querySelector('#password'),
  privateKey: document.querySelector('#privateKey'),
  remotePath: document.querySelector('#remotePath'),
  serverDeployWebhookUrl: document.querySelector('#serverDeployWebhookUrl'),
  githubBranchFilter: document.querySelector('#githubBranchFilter'),
  deploymentTimeoutSeconds: document.querySelector('#deploymentTimeoutSeconds'),
  deployWebhookRetryCount: document.querySelector('#deployWebhookRetryCount'),
  discordChannel: document.querySelector('#discordChannel'),
  discordEnabled: document.querySelector('#discordEnabled'),
  pollIntervalSeconds: document.querySelector('#pollIntervalSeconds'),
  autoClearEnabled: document.querySelector('#autoClearEnabled'),
  autoClearTime: document.querySelector('#autoClearTime'),
  autoClearLimit: document.querySelector('#autoClearLimit'),
  enabled: document.querySelector('#enabled')
};

/* ---- SVG icon helpers for action buttons ---- */
const icons = {
  play: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  stop: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  eye: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  edit: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  connection: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  terminal: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  discord: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.79 19.79 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.618-1.25.077.077 0 00-.079-.037A19.74 19.74 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.11 13.11 0 01-1.872-.892.077.077 0 01-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 01.078-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.009c.12.099.246.198.373.292a.077.077 0 01-.006.127 12.3 12.3 0 01-1.873.892.076.076 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.84 19.84 0 006.002-3.03.077.077 0 00.031-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.028z"/></svg>',
  copy: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  refresh: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  trash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  clear: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>'
};

function icon(name) {
  return `<span style="display:inline-flex;align-items:center;margin-right:4px;vertical-align:-1px">${icons[name] || ''}</span>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });

  if (response.status === 401) {
    window.location.replace('/login');
    throw new Error('Login required.');
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function ensureAuthenticated() {
  const response = await fetch('/api/auth/status', {
    headers: { Accept: 'application/json' }
  });

  if (response.status === 401) {
    window.location.replace('/login');
    return false;
  }

  if (!response.ok) throw new Error(`Auth check failed: ${response.status}`);
  const status = await response.json();
  if (status.authConfigured && !status.authenticated) {
    window.location.replace('/login');
    return false;
  }

  return true;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char];
  });
}

function formatDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString();
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.add('hidden'), 3800);
}

function statusClass(stateName) {
  return `state-${String(stateName || 'stopped').toLowerCase()}`;
}

function webhookUrl(watcher) {
  return watcher.webhookToken ? `${location.origin}/hooks/${watcher.webhookToken}` : '';
}

function formatJobSummary(summary) {
  const queuedCount = summary?.queuedCount || 0;
  const runningJob = summary?.runningJob;
  const latestJob = summary?.latestJob;

  if (runningJob) {
    return `Job #${runningJob.id} running · ${queuedCount} queued`;
  }

  if (latestJob) {
    const branch = latestJob.githubBranch ? ` · ${latestJob.githubBranch}` : '';
    return `Latest job #${latestJob.id}: ${latestJob.status}${branch} · ${queuedCount} queued`;
  }

  return `No queued jobs`;
}

function formatLatestJobError(summary) {
  const latestJob = summary?.latestJob;
  if (!latestJob?.errorMessage) return '';
  return latestJob.errorMessage;
}

function shortSha(value) {
  return value ? String(value).slice(0, 7) : '';
}

function renderPendingWebhooks() {
  const jobs = state.pendingJobs || [];
  els.pendingWebhooksEmpty.classList.toggle('hidden', jobs.length > 0);
  els.pendingWebhooksList.innerHTML = '';
  els.pendingWebhooksSummary.textContent = `${jobs.length} pending webhook job${jobs.length === 1 ? '' : 's'}`;

  for (const job of jobs) {
    const item = document.createElement('div');
    item.className = 'pendingJob';
    const branch = job.githubBranch || job.githubRef || 'all branches';
    const sha = shortSha(job.commitSha);
    const message = job.commitMessage || 'No commit message';
    const startedOrQueued = job.status === 'running' ? job.startedAt : job.queuedAt;

    item.innerHTML = `
      <div class="pendingJobMain">
        <div>
          <div class="pendingTitle">
            <span class="status ${statusClass(job.status)}"><span class="dot"></span>${escapeHtml(job.status)}</span>
            <strong>#${escapeHtml(job.id)} ${escapeHtml(job.watcherName || `Watcher ${job.watcherId}`)}</strong>
          </div>
          <div class="subtle">${escapeHtml(branch)}${sha ? ` - ${escapeHtml(sha)}` : ''} - ${escapeHtml(message)}</div>
          <div class="subtle">${escapeHtml(job.groupName || 'Default')} - ${escapeHtml(job.watcherHost || '')}${job.watcherRemotePath ? ` - ${escapeHtml(job.watcherRemotePath)}` : ''}</div>
        </div>
        <div class="pendingMeta">
          <div>${escapeHtml(formatDate(startedOrQueued))}</div>
          <div class="subtle">${escapeHtml(job.githubDeliveryId || 'No delivery id')}</div>
        </div>
      </div>
      <div class="pendingActions">
        <button data-action="view-log" data-id="${job.watcherId}">${icon('eye')}View log</button>
        <button data-action="cancel-job" data-id="${job.watcherId}" data-job-id="${job.id}" ${job.status === 'queued' ? '' : 'disabled'}>Cancel</button>
      </div>
    `;
    els.pendingWebhooksList.appendChild(item);
  }
}

function renderGroups() {
  const groups = state.groups || [];
  els.groupsSummary.textContent = `${groups.length} group${groups.length === 1 ? '' : 's'} - each group has its own queue`;
  els.groupsList.innerHTML = '';

  for (const group of groups) {
    const item = document.createElement('div');
    item.className = 'groupItem';
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(group.name)}</strong>
        <span class="subtle">${group.isDefault ? 'Default - ' : ''}${escapeHtml(group.watcherCount || 0)} watcher${group.watcherCount === 1 ? '' : 's'}</span>
      </div>
      <div class="pendingActions">
        <button data-group-action="rename" data-id="${group.id}" ${group.isDefault ? 'disabled' : ''}>Rename</button>
        <button class="danger" data-group-action="delete" data-id="${group.id}" ${group.isDefault ? 'disabled' : ''}>Delete</button>
      </div>
    `;
    els.groupsList.appendChild(item);
  }
}

function renderGroupOptions(selectedGroupId) {
  fields.groupId.innerHTML = '';
  for (const group of state.groups || []) {
    const option = document.createElement('option');
    option.value = group.id;
    option.textContent = group.isDefault ? `${group.name} (default)` : group.name;
    fields.groupId.appendChild(option);
  }
  if (selectedGroupId) fields.groupId.value = String(selectedGroupId);
  if (!fields.groupId.value && fields.groupId.options.length > 0) {
    fields.groupId.value = fields.groupId.options[0].value;
  }
}

function renderStats() {
  const watchers = state.watchers;
  const total = watchers.length;
  const active = watchers.filter((w) => {
    const s = (w.status?.state || '').toLowerCase();
    return s === 'polling' || s === 'connected' || s === 'starting' || s === 'reconnecting';
  }).length;
  const errors = watchers.filter((w) => (w.status?.state || '').toLowerCase() === 'error').length;
  const stopped = total - active - errors;

  if (els.statTotal) els.statTotal.textContent = total;
  if (els.statActive) els.statActive.textContent = active;
  if (els.statErrors) els.statErrors.textContent = errors;
  if (els.statStopped) els.statStopped.textContent = Math.max(0, stopped);
}

function render() {
  els.watchersBody.innerHTML = '';
  els.emptyState.classList.toggle('hidden', state.watchers.length > 0);

  const running = state.watchers.filter((watcher) => watcher.status?.state !== 'stopped' && watcher.enabled).length;
  els.summary.textContent = `${state.watchers.length} watcher${state.watchers.length === 1 ? '' : 's'} · ${running} enabled`;

  renderStats();
  renderPendingWebhooks();
  renderGroups();

  for (const watcher of state.watchers) {
    const status = watcher.status || {};
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="nameCell">
        <strong>${escapeHtml(watcher.name)}</strong>
        <span class="subtle">Group: ${escapeHtml(watcher.groupName || 'Default')}</span>
        <span class="subtle">${escapeHtml(watcher.protocol.toUpperCase())} · every ${escapeHtml(watcher.pollIntervalSeconds)}s</span>
      </td>
      <td>
        <div>${escapeHtml(watcher.username)}@${escapeHtml(watcher.host)}:${escapeHtml(watcher.port)}</div>
        <div class="subtle">${escapeHtml(watcher.remotePath)}</div>
        <div class="subtle webhookUrl">${watcher.webhookToken ? `GitHub hook: ${escapeHtml(webhookUrl(watcher))}` : 'GitHub hook: restart app or reset webhook'}</div>
      </td>
      <td>
        <div>${escapeHtml(watcher.discordEnabled ? 'Enabled' : 'Disabled')}</div>
        <div class="subtle">${escapeHtml(watcher.discordChannel || 'No channel')}</div>
      </td>
      <td>
        <div class="status ${statusClass(status.state)}"><span class="dot"></span>${escapeHtml(status.state || 'stopped')}</div>
        <div class="subtle">${escapeHtml(status.message || '')}</div>
        <div class="subtle">${escapeHtml(formatJobSummary(watcher.jobSummary))}</div>
        ${formatLatestJobError(watcher.jobSummary) ? `<div class="subtle errorText">${escapeHtml(formatLatestJobError(watcher.jobSummary))}</div>` : ''}
        <div class="subtle">${watcher.autoClearEnabled ? `Auto clear ${escapeHtml(watcher.autoClearLimit)} at ${escapeHtml(watcher.autoClearTime)}` : 'Auto clear off'}</div>
      </td>
      <td>
        <div>${escapeHtml(formatDate(status.lastUpdateAt))}</div>
        <div class="subtle">offset ${escapeHtml(status.lastOffset ?? watcher.lastOffset ?? 0)}</div>
      </td>
      <td>
        <div class="actions">
          <button data-action="start" data-id="${watcher.id}">${icon('play')}Start</button>
          <button data-action="stop" data-id="${watcher.id}">${icon('stop')}Stop</button>
          <button data-action="view-log" data-id="${watcher.id}">${icon('eye')}View log</button>
          <button data-action="deploy-command" data-id="${watcher.id}">${icon('terminal')}Deploy cmd</button>
          <button data-action="edit" data-id="${watcher.id}">${icon('edit')}Edit</button>
          <button data-action="test-connection" data-id="${watcher.id}">${icon('connection')}Test FTP/SFTP</button>
          <button data-action="test-discord" data-id="${watcher.id}" ${watcher.discordEnabled ? '' : 'disabled'}>${icon('discord')}Test Discord</button>
          <button data-action="copy-webhook" data-id="${watcher.id}">${icon('copy')}Copy trigger</button>
          <button data-action="reset-webhook" data-id="${watcher.id}">${icon('refresh')}Reset webhook</button>
          <button class="danger" data-action="clear-channel" data-id="${watcher.id}" ${watcher.discordEnabled ? '' : 'disabled'}>${icon('clear')}Clear channel</button>
          <button class="danger" data-action="delete" data-id="${watcher.id}">${icon('trash')}Delete</button>
        </div>
      </td>
    `;
    els.watchersBody.appendChild(tr);
  }
}

async function loadWatchers() {
  const data = await api('/api/watchers');
  state.watchers = data.watchers;
  state.groups = data.groups || state.groups;
  render();
}

async function loadGroups() {
  const data = await api('/api/groups');
  state.groups = data.groups || [];
  renderGroups();
}

async function loadPendingWebhooks() {
  const data = await api('/api/jobs/pending');
  state.pendingJobs = data.jobs || [];
  renderPendingWebhooks();
}

async function loadDiscordStatus() {
  const data = await api('/api/discord/status');
  state.discordStatus = data.status;
  renderDiscordStatus(data.status);
}

function renderDiscordStatus(status) {
  els.discordBadge.classList.remove('ok', 'warn', 'error');

  if (status.ready) {
    els.discordBadge.textContent = 'Connected';
    els.discordBadge.classList.add('ok');
    els.discordSummary.textContent = 'Discord token is configured and the bot is connected.';
    return;
  }

  if (status.configured) {
    els.discordBadge.textContent = status.loginInProgress ? 'Connecting' : 'Configured';
    els.discordBadge.classList.add('warn');
    els.discordSummary.textContent = 'Discord token is configured, but the bot is not connected yet.';
    return;
  }

  els.discordBadge.textContent = 'Disabled';
  els.discordSummary.textContent = 'Discord token is not configured. Watchers can still poll logs without Discord delivery.';
}

async function loadReportBotStatus() {
  const data = await api('/api/report-bot/status');
  renderReportBotStatus(data.status);
}

function renderReportBotStatus(status) {
  const parts = [
    status.enabled ? 'running' : 'stopped',
    status.commandsRegistered ? 'commands registered' : 'commands not registered'
  ];
  if (!status.configured) parts.push('missing env config');
  if (status.lastError) parts.push(`last error: ${status.lastError}`);
  els.reportBotSummary.textContent = parts.join(' · ');
}

function openForm(watcher = null) {
  els.form.reset();
  els.formError.classList.add('hidden');
  fields.id.value = watcher?.id || '';
  fields.name.value = watcher?.name || '';
  renderGroupOptions(watcher?.groupId);
  fields.protocol.value = watcher?.protocol || 'sftp';
  fields.host.value = watcher?.host || '';
  fields.port.value = watcher?.port || 22;
  fields.username.value = watcher?.username || '';
  fields.password.value = '';
  fields.privateKey.value = '';
  fields.remotePath.value = watcher?.remotePath || '';
  fields.serverDeployWebhookUrl.value = watcher?.serverDeployWebhookUrl || '';
  fields.githubBranchFilter.value = watcher?.githubBranchFilter || '';
  fields.deploymentTimeoutSeconds.value = watcher?.deploymentTimeoutSeconds || 1800;
  fields.deployWebhookRetryCount.value = watcher?.deployWebhookRetryCount ?? 3;
  fields.discordChannel.value = watcher?.discordChannel || '';
  fields.discordEnabled.checked = Boolean(watcher?.discordEnabled);
  fields.pollIntervalSeconds.value = watcher?.pollIntervalSeconds || 5;
  fields.autoClearEnabled.checked = Boolean(watcher?.autoClearEnabled);
  fields.autoClearTime.value = watcher?.autoClearTime || '00:00';
  fields.autoClearLimit.value = watcher?.autoClearLimit || '100';
  fields.enabled.checked = Boolean(watcher?.enabled);
  els.dialogTitle.textContent = watcher ? `Edit ${watcher.name}` : 'Add watcher';
  els.dialog.showModal();
}

function formPayload() {
  const payload = {
    name: fields.name.value.trim(),
    groupId: Number(fields.groupId.value),
    protocol: fields.protocol.value,
    host: fields.host.value.trim(),
    port: Number(fields.port.value),
    username: fields.username.value.trim(),
    remotePath: fields.remotePath.value.trim(),
    serverDeployWebhookUrl: fields.serverDeployWebhookUrl.value.trim(),
    githubBranchFilter: fields.githubBranchFilter.value.trim(),
    deploymentTimeoutSeconds: Number(fields.deploymentTimeoutSeconds.value),
    deployWebhookRetryCount: Number(fields.deployWebhookRetryCount.value),
    discordChannel: fields.discordChannel.value.trim(),
    discordEnabled: fields.discordEnabled.checked,
    pollIntervalSeconds: Number(fields.pollIntervalSeconds.value),
    autoClearEnabled: fields.autoClearEnabled.checked,
    autoClearTime: fields.autoClearTime.value || '00:00',
    autoClearLimit: fields.autoClearLimit.value.trim() || '100',
    enabled: fields.enabled.checked
  };

  if (fields.password.value) payload.password = fields.password.value;
  if (fields.privateKey.value) payload.privateKey = fields.privateKey.value;
  return payload;
}

function formatLogLines(lines) {
  if (!lines.length) return 'No log lines captured yet.';
  return lines.map((entry) => entry.line).join('\n');
}

function dirname(pathValue) {
  const normalized = String(pathValue || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return index === 0 ? '/' : '';
  return normalized.slice(0, index);
}

function commandStepList(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function defaultCommandLogPath(watcher) {
  const remotePath = String(watcher?.remotePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!remotePath || remotePath === 'deploy.log') return 'deployment/deploy.log';
  return remotePath;
}

function buildDeploymentCommand() {
  const nodeBin = els.commandNodeBin.value.trim() || '/opt/plesk/node/25/bin';
  const logPath = els.commandLogPath.value.trim() || 'deployment/deploy.log';
  const logDir = dirname(logPath);
  const steps = commandStepList(els.commandSteps.value);
  return [
    `export PATH=${nodeBin}:$PATH`,
    logDir ? `mkdir -p ${logDir}` : '',
    `{ echo "Deployment started: $(date)"; ${steps.join('; ')}; echo "Deployment finished: $(date)"; } 2>&1 | tee ${logPath}`
  ].filter(Boolean).join('; ');
}

function updateDeploymentCommand() {
  els.commandOutput.textContent = buildDeploymentCommand();
}

function openDeploymentCommand(watcher) {
  const name = watcher?.name || `Watcher ${watcher?.id || ''}`.trim();
  els.commandDialogTitle.textContent = `${name} deployment command`;
  els.commandNodeBin.value = '/opt/plesk/node/25/bin';
  els.commandLogPath.value = defaultCommandLogPath(watcher);
  els.commandSteps.value = 'node -v\nnpm --version\nsleep 5';
  updateDeploymentCommand();
  els.commandDialog.showModal();
}

async function loadLiveLog() {
  if (!state.activeLogWatcherId) return;
  const data = await api(`/api/watchers/${state.activeLogWatcherId}/logs`);
  const watcher = state.watchers.find((item) => String(item.id) === String(state.activeLogWatcherId));
  const wasAtBottom =
    els.liveLogBlock.scrollTop + els.liveLogBlock.clientHeight >= els.liveLogBlock.scrollHeight - 24;

  const count = data.lines?.length || 0;
  if (count === 0 && state.activeLogRemoteLoaded) return 0;

  els.liveLogBlock.textContent = formatLogLines(data.lines || []);
  const stateName = data.status?.state || watcher?.status?.state || 'stopped';
  els.logDialogSummary.textContent = `${count} captured line${count === 1 ? '' : 's'} - ${stateName}${data.truncated ? ` - showing latest ${data.maxLines}` : ''}`;

  if (wasAtBottom) {
    els.liveLogBlock.scrollTop = els.liveLogBlock.scrollHeight;
  }

  return count;
}

async function loadRemoteLogTail() {
  if (!state.activeLogWatcherId) return 0;
  state.activeLogRemoteLoaded = true;
  els.logDialogSummary.textContent = 'Loading remote log file...';

  try {
    const data = await api(`/api/watchers/${state.activeLogWatcherId}/logs?remote=1`);
    els.liveLogBlock.textContent = formatLogLines(data.lines || []);
    const count = data.lines?.length || 0;
    const stateName = data.status?.state || 'stopped';
    const remoteText = data.remote
      ? ` - ${data.remote.resolvedPath} - ${data.remote.size} bytes`
      : '';
    els.logDialogSummary.textContent = `${count} remote line${count === 1 ? '' : 's'} - ${stateName}${remoteText}${data.truncated ? ' - tail view' : ''}`;
    els.liveLogBlock.scrollTop = els.liveLogBlock.scrollHeight;
    return count;
  } catch (error) {
    if (error.message === 'Login required.') throw error;
    els.liveLogBlock.textContent = `Unable to read remote log: ${error.message}`;
    els.logDialogSummary.textContent = 'Remote log read failed';
    return 0;
  }
}

function closeLiveLog() {
  clearInterval(state.logPollTimer);
  state.logPollTimer = null;
  state.activeLogWatcherId = null;
  state.activeLogRemoteLoaded = false;
  els.logDialog.close();
}

async function openLiveLog(watcher) {
  state.activeLogWatcherId = watcher.id;
  els.logDialogTitle.textContent = `${watcher.name || `Watcher ${watcher.id}`} live log`;
  els.logDialogSummary.textContent = 'Loading log lines...';
  els.liveLogBlock.textContent = 'Loading...';
  els.logDialog.showModal();
  clearInterval(state.logPollTimer);
  state.activeLogRemoteLoaded = false;
  const capturedCount = await loadLiveLog();
  if (!capturedCount && !state.activeLogRemoteLoaded) {
    await loadRemoteLogTail();
  }
  els.liveLogBlock.scrollTop = els.liveLogBlock.scrollHeight;
  state.logPollTimer = setInterval(() => {
    loadLiveLog().catch((error) => showToast(error.message));
  }, 1500);
}

async function saveForm(event) {
  event.preventDefault();
  els.formError.classList.add('hidden');

  try {
    const id = fields.id.value;
    const payload = formPayload();
    if (id) {
      await api(`/api/watchers/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Watcher updated.');
    } else {
      await api('/api/watchers', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Watcher added.');
    }
    els.dialog.close();
    await loadWatchers();
  } catch (error) {
    els.formError.textContent = error.message;
    els.formError.classList.remove('hidden');
  }
}

async function addGroup() {
  const name = els.groupNameInput.value.trim();
  if (!name) {
    showToast('Group name is required.');
    return;
  }
  await api('/api/groups', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
  els.groupNameInput.value = '';
  showToast('Group added.');
  await loadWatchers();
}

async function restartSetup() {
  const confirmed = window.confirm(
    'This will remove the current admin login and session secret, then open first-time setup again. Existing watcher secrets stay encrypted with the current encryption key. Continue?'
  );
  if (!confirmed) return;

  const typed = window.prompt('Type RESET SETUP to confirm.');
  if (typed !== 'RESET SETUP') {
    showToast('Setup reset cancelled.');
    return;
  }

  const data = await api('/api/setup/restart', { method: 'POST' });
  window.location.href = data.redirectTo || '/setup';
}

async function handleGroupAction(event) {
  const button = event.target.closest('button[data-group-action]');
  if (!button) return;
  const groupId = button.dataset.id;
  const group = state.groups.find((item) => String(item.id) === String(groupId));
  if (!group) return;

  try {
    button.disabled = true;
    if (button.dataset.groupAction === 'rename') {
      const name = prompt('Rename group', group.name);
      if (!name || !name.trim()) return;
      await api(`/api/groups/${groupId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: name.trim() })
      });
      showToast('Group renamed.');
    }

    if (button.dataset.groupAction === 'delete') {
      if (!confirm(`Delete group "${group.name}"? Its watchers will move to Default.`)) return;
      await api(`/api/groups/${groupId}`, { method: 'DELETE' });
      showToast('Group deleted.');
    }

    await loadWatchers();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function handleAction(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  const watcher = state.watchers.find((item) => String(item.id) === String(id));

  try {
    button.disabled = true;
    if (action === 'edit') {
      openForm(watcher);
      return;
    }

    if (action === 'view-log') {
      await openLiveLog(watcher || { id });
      return;
    }

    if (action === 'deploy-command') {
      openDeploymentCommand(watcher || { id });
      return;
    }

    if (action === 'cancel-job') {
      const jobId = button.dataset.jobId;
      if (!confirm(`Cancel queued webhook job #${jobId}?`)) return;
      await api(`/api/watchers/${id}/jobs/${jobId}/cancel`, { method: 'POST' });
      showToast('Webhook job cancelled.');
      await loadPendingWebhooks();
    }

    if (action === 'delete') {
      if (!confirm(`Delete watcher "${watcher.name}"?`)) return;
      await api(`/api/watchers/${id}`, { method: 'DELETE' });
      showToast('Watcher deleted.');
    }

    if (action === 'start') {
      await api(`/api/watchers/${id}/start`, { method: 'POST' });
      showToast('Watcher started.');
    }

    if (action === 'stop') {
      await api(`/api/watchers/${id}/stop`, { method: 'POST' });
      showToast('Watcher stopped.');
    }

    if (action === 'test-connection') {
      const result = await api(`/api/watchers/${id}/test-connection`, { method: 'POST' });
      showToast(`Connection OK. Latest file: ${result.resolvedPath || watcher.remotePath} (${result.size} bytes).`);
    }

    if (action === 'test-discord') {
      await api(`/api/watchers/${id}/test-discord`, { method: 'POST' });
      showToast('Discord test message sent.');
    }

    if (action === 'copy-webhook') {
      if (!watcher.webhookToken) {
        showToast('Webhook token is missing. Reset webhook or restart the app.');
        return;
      }
      const url = webhookUrl(watcher);
      await navigator.clipboard.writeText(url);
      showToast('GitHub webhook URL copied.');
    }

    if (action === 'reset-webhook') {
      if (!confirm(`Reset GitHub webhook URL for "${watcher.name}"? Existing GitHub webhook settings using it will stop working.`)) return;
      await api(`/api/watchers/${id}/reset-webhook`, { method: 'POST' });
      showToast('GitHub webhook URL reset.');
    }

    if (action === 'clear-channel') {
      const limit = prompt(
        `Clear recent messages from "${watcher.discordChannel}"?\n\nEnter number of recent messages, or "all". Discord cannot bulk-delete messages older than 14 days.`,
        '100'
      );
      if (!limit) return;
      if (!confirm(`Delete recent messages from channel "${watcher.discordChannel}"?`)) return;
      const result = await api(`/api/watchers/${id}/clear-channel`, {
        method: 'POST',
        body: JSON.stringify({ limit: limit.trim() })
      });
      showToast(`Deleted ${result.deleted} recent message(s).`);
    }

    await loadWatchers();
    await loadPendingWebhooks();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

fields.protocol.addEventListener('change', () => {
  fields.port.value = fields.protocol.value === 'sftp' ? 22 : 21;
});
els.addWatcherBtn.addEventListener('click', () => openForm());
els.restartSetupBtn.addEventListener('click', () => {
  restartSetup().catch((error) => showToast(error.message));
});
els.addGroupBtn.addEventListener('click', () => {
  addGroup().catch((error) => showToast(error.message));
});
els.groupNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addGroup().catch((error) => showToast(error.message));
  }
});
els.logoutBtn.addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/login';
});
els.refreshBtn.addEventListener('click', loadWatchers);
els.reportBotStartBtn.addEventListener('click', async () => {
  try {
    const data = await api('/api/report-bot/start', { method: 'POST' });
    renderReportBotStatus(data.status);
    showToast('Report bot started.');
  } catch (error) {
    showToast(error.message);
  }
});
els.reportBotStopBtn.addEventListener('click', async () => {
  try {
    const data = await api('/api/report-bot/stop', { method: 'POST' });
    renderReportBotStatus(data.status);
    showToast('Report bot stopped.');
  } catch (error) {
    showToast(error.message);
  }
});
els.closeDialogBtn.addEventListener('click', () => els.dialog.close());
els.cancelBtn.addEventListener('click', () => els.dialog.close());
els.closeLogDialogBtn.addEventListener('click', closeLiveLog);
els.loadRemoteLogBtn.addEventListener('click', () => {
  loadRemoteLogTail().catch((error) => showToast(error.message));
});
els.closeCommandDialogBtn.addEventListener('click', () => els.commandDialog.close());
els.commandNodeBin.addEventListener('input', updateDeploymentCommand);
els.commandLogPath.addEventListener('input', updateDeploymentCommand);
els.commandSteps.addEventListener('input', updateDeploymentCommand);
els.copyCommandBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(buildDeploymentCommand());
  showToast('Deployment command copied.');
});
els.logDialog.addEventListener('close', () => {
  clearInterval(state.logPollTimer);
  state.logPollTimer = null;
  state.activeLogWatcherId = null;
  state.activeLogRemoteLoaded = false;
});
els.form.addEventListener('submit', saveForm);
els.watchersBody.addEventListener('click', handleAction);
els.groupsList.addEventListener('click', handleGroupAction);

async function init() {
  const authenticated = await ensureAuthenticated();
  if (!authenticated) return;
  document.body.classList.remove('authPending');

  loadWatchers().catch((error) => showToast(error.message));
  loadGroups().catch((error) => showToast(error.message));
  loadPendingWebhooks().catch((error) => showToast(error.message));
  loadDiscordStatus().catch((error) => showToast(error.message));
  loadReportBotStatus().catch((error) => showToast(error.message));
  setInterval(() => {
    loadWatchers().catch(() => {});
    loadPendingWebhooks().catch(() => {});
  }, 5000);
  setInterval(() => loadDiscordStatus().catch(() => {}), 10000);
  setInterval(() => loadReportBotStatus().catch(() => {}), 10000);
}

init().catch((error) => showToast(error.message));

window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    ensureAuthenticated().catch(() => {
      window.location.replace('/login');
    });
  }
});
