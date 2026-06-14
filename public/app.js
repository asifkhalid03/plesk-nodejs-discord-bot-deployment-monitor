const state = {
  watchers: []
};

const els = {
  addWatcherBtn: document.querySelector('#addWatcherBtn'),
  logoutBtn: document.querySelector('#logoutBtn'),
  refreshBtn: document.querySelector('#refreshBtn'),
  watchersBody: document.querySelector('#watchersBody'),
  emptyState: document.querySelector('#emptyState'),
  summary: document.querySelector('#summary'),
  dialog: document.querySelector('#watcherDialog'),
  form: document.querySelector('#watcherForm'),
  dialogTitle: document.querySelector('#dialogTitle'),
  closeDialogBtn: document.querySelector('#closeDialogBtn'),
  cancelBtn: document.querySelector('#cancelBtn'),
  formError: document.querySelector('#formError'),
  toast: document.querySelector('#toast')
};

const fields = {
  id: document.querySelector('#watcherId'),
  name: document.querySelector('#name'),
  protocol: document.querySelector('#protocol'),
  host: document.querySelector('#host'),
  port: document.querySelector('#port'),
  username: document.querySelector('#username'),
  password: document.querySelector('#password'),
  privateKey: document.querySelector('#privateKey'),
  remotePath: document.querySelector('#remotePath'),
  discordChannel: document.querySelector('#discordChannel'),
  pollIntervalSeconds: document.querySelector('#pollIntervalSeconds'),
  autoClearEnabled: document.querySelector('#autoClearEnabled'),
  autoClearTime: document.querySelector('#autoClearTime'),
  autoClearLimit: document.querySelector('#autoClearLimit'),
  enabled: document.querySelector('#enabled')
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
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

function render() {
  els.watchersBody.innerHTML = '';
  els.emptyState.classList.toggle('hidden', state.watchers.length > 0);

  const running = state.watchers.filter((watcher) => watcher.status?.state !== 'stopped' && watcher.enabled).length;
  els.summary.textContent = `${state.watchers.length} watcher${state.watchers.length === 1 ? '' : 's'} · ${running} enabled`;

  for (const watcher of state.watchers) {
    const status = watcher.status || {};
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="nameCell">
        <strong>${escapeHtml(watcher.name)}</strong>
        <span class="subtle">${escapeHtml(watcher.protocol.toUpperCase())} · every ${escapeHtml(watcher.pollIntervalSeconds)}s</span>
      </td>
      <td>
        <div>${escapeHtml(watcher.username)}@${escapeHtml(watcher.host)}:${escapeHtml(watcher.port)}</div>
        <div class="subtle">${escapeHtml(watcher.remotePath)}</div>
        <div class="subtle webhookUrl">${watcher.webhookToken ? `Trigger: ${escapeHtml(webhookUrl(watcher))}` : 'Trigger: restart app or reset webhook'}</div>
      </td>
      <td>${escapeHtml(watcher.discordChannel)}</td>
      <td>
        <div class="status ${statusClass(status.state)}"><span class="dot"></span>${escapeHtml(status.state || 'stopped')}</div>
        <div class="subtle">${escapeHtml(status.message || '')}</div>
        <div class="subtle">${watcher.autoClearEnabled ? `Auto clear ${escapeHtml(watcher.autoClearLimit)} at ${escapeHtml(watcher.autoClearTime)}` : 'Auto clear off'}</div>
      </td>
      <td>
        <div>${escapeHtml(formatDate(status.lastUpdateAt))}</div>
        <div class="subtle">offset ${escapeHtml(status.lastOffset ?? watcher.lastOffset ?? 0)}</div>
      </td>
      <td>
        <div class="actions">
          <button data-action="start" data-id="${watcher.id}">Start</button>
          <button data-action="stop" data-id="${watcher.id}">Stop</button>
          <button data-action="edit" data-id="${watcher.id}">Edit</button>
          <button data-action="test-connection" data-id="${watcher.id}">Test FTP/SFTP</button>
          <button data-action="test-discord" data-id="${watcher.id}">Test Discord</button>
          <button data-action="copy-webhook" data-id="${watcher.id}">Copy trigger</button>
          <button data-action="reset-webhook" data-id="${watcher.id}">Reset webhook</button>
          <button class="danger" data-action="clear-channel" data-id="${watcher.id}">Clear channel</button>
          <button class="danger" data-action="delete" data-id="${watcher.id}">Delete</button>
        </div>
      </td>
    `;
    els.watchersBody.appendChild(tr);
  }
}

async function loadWatchers() {
  const data = await api('/api/watchers');
  state.watchers = data.watchers;
  render();
}

function openForm(watcher = null) {
  els.form.reset();
  els.formError.classList.add('hidden');
  fields.id.value = watcher?.id || '';
  fields.name.value = watcher?.name || '';
  fields.protocol.value = watcher?.protocol || 'sftp';
  fields.host.value = watcher?.host || '';
  fields.port.value = watcher?.port || 22;
  fields.username.value = watcher?.username || '';
  fields.password.value = '';
  fields.privateKey.value = '';
  fields.remotePath.value = watcher?.remotePath || '';
  fields.discordChannel.value = watcher?.discordChannel || '';
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
    protocol: fields.protocol.value,
    host: fields.host.value.trim(),
    port: Number(fields.port.value),
    username: fields.username.value.trim(),
    remotePath: fields.remotePath.value.trim(),
    discordChannel: fields.discordChannel.value.trim(),
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
      showToast('Trigger webhook URL copied.');
    }

    if (action === 'reset-webhook') {
      if (!confirm(`Reset trigger webhook URL for "${watcher.name}"? Old deploy scripts using it will stop working.`)) return;
      await api(`/api/watchers/${id}/reset-webhook`, { method: 'POST' });
      showToast('Trigger webhook URL reset.');
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
els.logoutBtn.addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/login';
});
els.refreshBtn.addEventListener('click', loadWatchers);
els.closeDialogBtn.addEventListener('click', () => els.dialog.close());
els.cancelBtn.addEventListener('click', () => els.dialog.close());
els.form.addEventListener('submit', saveForm);
els.watchersBody.addEventListener('click', handleAction);

loadWatchers().catch((error) => showToast(error.message));
setInterval(() => loadWatchers().catch(() => {}), 5000);
