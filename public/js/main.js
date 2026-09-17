(function () {
  'use strict';

  const tokenKey = 'cocClanTrackerToken';
  const viewPrefsKey = 'cocViewPrefs';
  const roleOptions = ['all', 'leader', 'co-leader', 'elder', 'member'];
  const memberSortKeys = ['nameAsc', 'nameDesc', 'townHallAsc', 'townHallDesc'];
  const sortModes = ['name', 'status', 'attacks'];
  const defaultView = {
    memberView: { role: 'all', sort: 'nameAsc' },
    attendanceView: { war: { role: 'all' }, capital: { role: 'all' } },
    sort: { war: { mode: 'name', descending: false }, capital: { mode: 'name', descending: false } }
  };

  // Restore the last used role filters and sort order so the roster looks the same after a reload.
  function readViewPrefs() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(viewPrefsKey) || '{}') || {}; } catch (error) { saved = {}; }
    const pickRole = (value) => (roleOptions.includes(value) ? value : 'all');
    const pickSort = (type) => {
      const fallback = defaultView.sort[type];
      const value = saved.sort ? saved.sort[type] : null;
      if (!value || typeof value !== 'object') return { mode: fallback.mode, descending: fallback.descending };
      return { mode: sortModes.includes(value.mode) ? value.mode : fallback.mode, descending: Boolean(value.descending) };
    };
    const attendance = saved.attendanceView || {};
    const memberSort = saved.memberView && memberSortKeys.includes(saved.memberView.sort) ? saved.memberView.sort : defaultView.memberView.sort;
    return {
      memberView: { role: saved.memberView ? pickRole(saved.memberView.role) : 'all', sort: memberSort },
      attendanceView: { war: { role: pickRole((attendance.war || {}).role) }, capital: { role: pickRole((attendance.capital || {}).role) } },
      sort: { war: pickSort('war'), capital: pickSort('capital') }
    };
  }

  const state = Object.assign({
    token: localStorage.getItem(tokenKey),
    user: null,
    users: [],
    members: [],
    attendance: new Map(),
    sessions: { war: null, capital: null },
    sessionLists: { war: [], capital: [] },
    history: JSON.parse(localStorage.getItem('cocSessionHistory') || '{"war":[],"capital":[]}')
  }, readViewPrefs());

  const $ = (selector) => document.querySelector(selector);
  const all = (selector) => Array.from(document.querySelectorAll(selector));

  function showNotice(message, error) {
    const target = $('#notice');
    if (!target) return;
    target.textContent = message;
    target.className = `notice show${error ? ' error' : ''}`;
  }

  async function api(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const response = await fetch('/api' + path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Request failed.');
    return payload;
  }

  function isAdmin() {
    return Boolean(state.user && state.user.role === 'admin');
  }

  // Read-only accounts still see every value; only the editing controls are omitted.
  function adminOnly(markup) {
    return isAdmin() ? markup : '';
  }

  function renderAccountPanel() {
    const account = state.user;
    const emailCell = $('#account-email');
    if (emailCell) emailCell.textContent = account ? account.email : '—';
    const roleCell = $('#account-role');
    if (roleCell) {
      roleCell.textContent = !account
        ? 'Not signed in'
        : (account.role === 'admin' ? 'Administrator (full edit access)' : 'Read-only user');
    }
    const badge = $('#account-role-badge');
    if (badge) {
      const role = account ? account.role : 'guest';
      badge.textContent = role;
      badge.className = `role-badge role-${role}`;
    }
    const note = $('#account-note');
    if (note) {
      note.textContent = isAdmin()
        ? 'You are an administrator: you can edit the roster, log activity, manage accounts, and change the background.'
        : 'Read-only accounts can view the roster, war, and Clan Capital data. Only administrators can change it.';
    }
  }

  function setAuthState() {
    const loggedIn = Boolean(state.user);
    document.body.classList.toggle('is-signed-in', loggedIn);
    document.body.classList.toggle('is-admin', loggedIn && isAdmin());
    all('.auth-required').forEach((element) => { element.style.display = loggedIn ? '' : 'none'; });
    all('.admin-required').forEach((element) => { element.style.display = isAdmin() ? '' : 'none'; });
    const loginLink = $('#login-link');
    const logout = $('#logout-button');
    if (loginLink) loginLink.classList.toggle('hidden', loggedIn);
    if (logout) logout.classList.toggle('hidden', !loggedIn);
    const label = $('#user-label');
    if (label) {
      label.textContent = loggedIn ? `${state.user.email} · ${isAdmin() ? 'Administrator' : 'Read-only'}` : '';
    }
    const banner = $('#auth-banner');
    if (banner) {
      banner.textContent = !loggedIn
        ? 'Log in to view clan activity.'
        : (isAdmin() ? 'Administrator mode active — you can edit everything.' : 'Read-only access — ask an administrator to make changes.');
    }
    const title = $('#home-access-title');
    if (title) title.textContent = loggedIn ? (isAdmin() ? 'Administrator access' : 'Read-only access') : 'Signed in';
    const accessNote = $('#home-access-note');
    if (accessNote) {
      accessNote.textContent = isAdmin()
        ? 'You can add and edit members, log war and Capital activity, manage accounts, and set the background image.'
        : 'You can view the roster, war, and Clan Capital data. Editing is limited to administrators.';
    }
    renderAccountPanel();
  }

  // A stale or expired token must never leave the interface pretending to be signed in.
  async function loadSession() {
    if (!state.token) {
      state.user = null;
      setAuthState();
      return;
    }
    try {
      const result = await api('/auth/me');
      state.user = result.data;
    } catch (error) {
      state.token = null;
      state.user = null;
      localStorage.removeItem(tokenKey);
    }
    setAuthState();
    if (!state.token) return;
    try {
      await Promise.all([loadMembers(), loadActivity(), loadSessionList('war'), loadSessionList('capital')]);
      if (isAdmin()) await loadUsers();
    } catch (error) {
      showNotice(error.message, true);
    }
  }

  // Deep links such as #admin are refused here and enforced again on the server.
  function tabAllowed(tab) {
    if (tab === 'admin') return isAdmin();
    if (tab === 'account') return Boolean(state.user);
    return true;
  }

  function bindTabs() {
    const buttons = all('.tab-button');
    buttons.forEach((button) => button.addEventListener('click', () => {
      const tab = button.dataset.tab;
      if (!tabAllowed(tab)) {
        showNotice(tab === 'admin' ? 'Administrator access is required.' : 'Sign in to use that tab.', true);
        return;
      }
      buttons.forEach((item) => item.classList.toggle('active', item === button));
      all('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab));
      history.replaceState(null, '', `#${tab}`);
      if (tab === 'war' || tab === 'capital') renderAttendance(tab);
    }));
    const requested = window.location.hash.slice(1);
    const button = buttons.find((item) => item.dataset.tab === requested && tabAllowed(item.dataset.tab));
    if (button) button.click();
  }

  function persistViewPrefs() {
    try {
      localStorage.setItem(viewPrefsKey, JSON.stringify({ memberView: state.memberView, attendanceView: state.attendanceView, sort: state.sort }));
    } catch (error) {
      // Private browsing or a full quota should never block the roster.
    }
  }

  // Shared A-Z comparison so the roster, war, and Capital lists always agree on order.
  function nameCompare(left, right) {
    const byName = String(left.playerName || '').localeCompare(String(right.playerName || ''), undefined, { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return Number(right.townHallLevel || 0) - Number(left.townHallLevel || 0);
  }

  function filteredMembers(role) {
    return state.members.filter((member) => role === 'all' || member.role === role);
  }

  function roleCounts() {
    const counts = { all: state.members.length, leader: 0, 'co-leader': 0, elder: 0, member: 0 };
    state.members.forEach((member) => { if (counts[member.role] !== undefined) counts[member.role] += 1; });
    return counts;
  }

  function renderRoleTabCounts() {
    const counts = roleCounts();
    all('.member-tab').forEach((tab) => {
      const badge = tab.querySelector('.tab-count');
      if (badge) badge.textContent = counts[tab.dataset.roleFilter] || 0;
    });
  }

  function roleFor(scope) {
    if (scope === 'roster') return state.memberView.role;
    return state.attendanceView[scope] ? state.attendanceView[scope].role : 'all';
  }

  function setRoleFilter(scope, role) {
    const next = roleOptions.includes(role) ? role : 'all';
    if (scope === 'roster') state.memberView.role = next;
    else if (state.attendanceView[scope]) state.attendanceView[scope].role = next;
    all(`.member-tab[data-scope="${scope}"]`).forEach((tab) => {
      const active = tab.dataset.roleFilter === next;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    persistViewPrefs();
  }

  function syncSortButtons(type) {
    const sortState = state.sort[type];
    const mode = sortState.mode;
    const nameButton = $(`.sort-name[data-type="${type}"]`);
    const statusButton = $(`.sort-status[data-type="${type}"]`);
    const attacksButton = $(`.sort-attacks[data-type="${type}"]`);
    if (nameButton) {
      nameButton.textContent = `Name: ${mode === 'name' && sortState.descending ? 'Z-A' : 'A-Z'}`;
      nameButton.classList.toggle('sort-active', mode === 'name');
    }
    if (statusButton) {
      statusButton.textContent = `Status: ${mode === 'status' && !sortState.descending ? 'absent first' : 'present first'}`;
      statusButton.classList.toggle('sort-active', mode === 'status');
    }
    if (attacksButton) {
      attacksButton.textContent = `Attacks: ${mode === 'attacks' && !sortState.descending ? 'low to high' : 'high to low'}`;
      attacksButton.classList.toggle('sort-active', mode === 'attacks');
    }
  }

  function syncMemberSortUi() {
    const select = $('#member-sort');
    if (select) select.value = state.memberView.sort;
    const toggle = $('#member-sort-direction');
    if (!toggle) return;
    const descending = state.memberView.sort === 'nameDesc';
    toggle.textContent = `Name: ${descending ? 'Z-A' : 'A-Z'}`;
    toggle.classList.toggle('sort-active', state.memberView.sort === 'nameAsc' || descending);
    toggle.setAttribute('aria-pressed', String(descending));
  }

  function restoreViewPrefs() {
    syncMemberSortUi();
    ['war', 'capital'].forEach((type) => syncSortButtons(type));
    ['roster', 'war', 'capital'].forEach((scope) => {
      const role = roleFor(scope);
      all(`.member-tab[data-scope="${scope}"]`).forEach((tab) => {
        const active = tab.dataset.roleFilter === role;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
      });
    });
    renderRoleTabCounts();
  }

  function memberOptions() {
    all('.member-options').forEach((select) => {
      const current = select.value;
      select.innerHTML = '<option value="">Choose member…</option>' + state.members.map((member) =>
        `<option value="${member.id}">${escapeHtml(member.playerName)} (${escapeHtml(member.playerTag || 'N/A')})</option>`).join('');
      select.value = current;
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
  }

  function renderMemberList() {
    const target = $('#member-list');
    if (!target) return;
    const { role, sort } = state.memberView;
    const members = filteredMembers(role).sort((left, right) => {
      if (sort === 'nameAsc' || sort === 'nameDesc') {
        const difference = nameCompare(left, right);
        return sort === 'nameDesc' ? -difference : difference;
      }
      const levelDifference = Number(left.townHallLevel) - Number(right.townHallLevel);
      if (levelDifference !== 0) return sort === 'townHallDesc' ? -levelDifference : levelDifference;
      return nameCompare(left, right);
    });
    const panelCount = $('#member-count-panel');
    if (panelCount) panelCount.textContent = role === 'all'
      ? `${members.length} member${members.length === 1 ? '' : 's'}`
      : `${members.length} of ${state.members.length} members`;
    renderRoleTabCounts();
    target.innerHTML = members.length ? `<table class="data-table"><thead><tr><th>#</th><th>Player</th><th>Tag</th><th>Town Hall</th><th>Role</th><th></th></tr></thead><tbody>${members.map((member, index) =>
      `<tr><td class="roster-number">${index + 1}.</td><td><strong>${escapeHtml(member.playerName)}</strong></td><td><small>${escapeHtml(member.playerTag || 'N/A')}</small></td><td>TH${member.townHallLevel}</td><td><span class="role-badge role-${escapeHtml(member.role)}">${escapeHtml(member.role)}</span></td><td>${adminOnly(`<button class="secondary edit-member" data-id="${member.id}">Edit</button> <button class="secondary delete-member" data-id="${member.id}">Remove</button>`)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No members match this role.</div>';
  }

  async function loadMembers() {
    if (!state.token) return;
    const result = await api('/members');
    state.members = result.data;
    const count = $('#member-count');
    if (count) count.textContent = `${state.members.length} member${state.members.length === 1 ? '' : 's'}`;
    renderMemberList();
    memberOptions();
    renderAttendance('war');
  }

  function formObject(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  async function loadActivity() {
    if (!state.token) return;
    const [wars, capital] = await Promise.all([api('/wars'), api('/capital')]);
    state.wars = wars.data;
    const warTarget = $('#war-list');
    if (warTarget) warTarget.innerHTML = wars.data.length ? wars.data.map((item) =>
      `<div class="activity-item"><div><strong>${escapeHtml(item.playerName)}</strong> <small>${escapeHtml(item.warDate)}</small><br><small>${item.attacksUsed}/2 attacks · ${item.missedAttack ? 'missed' : 'complete'}</small></div>${adminOnly(`<button class="secondary delete-war" data-id="${item.id}">Delete</button>`)}</div>`).join('') : '<div class="empty">No war activity logged.</div>';
    const capitalTarget = $('#capital-list');
    if (capitalTarget) capitalTarget.innerHTML = capital.data.length ? capital.data.map((item) =>
      `<div class="activity-item"><div><strong>${escapeHtml(item.playerName)}</strong> <small>${escapeHtml(item.raidWeekendDate)}</small><br><small>${item.attacksUsed}/6 attacks · ${item.capitalGoldLooted.toLocaleString()} gold</small></div>${adminOnly(`<button class="secondary delete-capital" data-id="${item.id}">Delete</button>`)}</div>`).join('') : '<div class="empty">No Capital activity logged.</div>';
  }

  function renderAttendance(type) {
    const target = type === 'capital' ? $('#capital-attendance-grid') : $('#attendance-grid');
    if (!target) return;
    if (!state.token) {
      target.innerHTML = '<div class="empty">Log in to manage attendance.</div>';
      return;
    }
    const session = state.sessions[type];
    const members = filteredMembers(roleFor(type)).sort((left, right) => {
      const sortState = state.sort[type];
      if (sortState.mode === 'name') {
        const nameDifference = nameCompare(left, right);
        return sortState.descending ? -nameDifference : nameDifference;
      }
      const leftStatus = session ? session.attendance[left.id] || 'unmarked' : 'unmarked';
      const rightStatus = session ? session.attendance[right.id] || 'unmarked' : 'unmarked';
      const statusRank = { present: 3, unmarked: 2, absent: 1 };
      const leftAttacks = session ? Number(session.attacks[left.id] || 0) : 0;
      const rightAttacks = session ? Number(session.attacks[right.id] || 0) : 0;
      const difference = sortState.mode === 'attacks'
        ? rightAttacks - leftAttacks
        : statusRank[rightStatus] - statusRank[leftStatus];
      if (difference !== 0) return sortState.descending ? difference : -difference;
      return nameCompare(left, right);
    });
    target.innerHTML = members.length ? members.map((member, index) => {
      const selected = session && session.members.includes(member.id);
      const status = session ? session.attendance[member.id] || 'unmarked' : 'unmarked';
      const finished = session && session.status === 'finished';
      // Read-only accounts may review attendance but cannot mark it.
      const locked = finished || !isAdmin();
      const maxAttacks = type === 'war' ? 2 : 6;
      const attacks = session ? Math.min(maxAttacks, Math.max(0, Number(session.attacks[member.id] || 0))) : 0;
      return `<div class="attendance-row ${selected ? '' : 'not-selected'}"><span class="roster-number">${index + 1}.</span><div class="member-summary"><strong>${escapeHtml(member.playerName)}</strong><small>${escapeHtml(member.playerTag || 'N/A')} · <span class="role-badge role-${escapeHtml(member.role)}">${escapeHtml(member.role)}</span></small></div><div class="attendance-actions">${selected ? `<label class="attack-count">Attacks <input class="attacks-input" data-id="${member.id}" type="number" min="0" max="${maxAttacks}" value="${attacks}" aria-label="Attacks used by ${escapeHtml(member.playerName)}" ${locked ? 'disabled' : ''}></label><button class="attendance-toggle present ${status === 'present' ? 'selected' : ''}" data-id="${member.id}" data-status="present" aria-label="Mark ${escapeHtml(member.playerName)} present" ${locked ? 'disabled' : ''}>✓</button><button class="attendance-toggle absent ${status === 'absent' ? 'selected' : ''}" data-id="${member.id}" data-status="absent" aria-label="Mark ${escapeHtml(member.playerName)} absent" ${locked ? 'disabled' : ''}>X</button>` : (locked ? '<span class="muted">Not selected</span>' : `<button class="participant-toggle secondary" data-id="${member.id}">Add</button>`)}</div></div>`;
    }).join('') : `<div class="empty">${state.members.length ? 'No members match this role filter.' : 'Select members for this session.'}</div>`;
    const count = $('#attendance-count');
    if (count) count.textContent = state.sessions[type] ? Object.keys(state.sessions[type].attendance).length : 0;
  }

  function renderSession(type) {
    const session = state.sessions[type];
    const label = $(`#${type}-session-label`);
    if (label) label.innerHTML = session ? `${session.status === 'finished' ? '<span class="finished-badge">✓ Finished</span> ' : ''}${escapeHtml(session.title)}${session.date ? ` · ${escapeHtml(session.date)}` : ''}` : `No active ${type === 'war' ? 'war' : 'Capital'} session.`;
    const workspace = $(`#${type}-workspace`);
    if (workspace) workspace.classList.toggle('hidden', !session);
    all(`.finish-session[data-type="${type}"], .save-session[data-type="${type}"], .select-all[data-type="${type}"], .deselect-all[data-type="${type}"]`).forEach((button) => {
      button.disabled = Boolean(session && session.status === 'finished');
    });
    renderAttendance(type);
  }

  async function syncSession(type) {
    const session = state.sessions[type];
    if (!session || !session.id) return;
    const attendance = state.members.map((member) => ({
      memberId: member.id,
      selected: session.members.includes(member.id),
      status: session.attendance[member.id] || 'unmarked',
      attacksUsed: Number(session.attacks[member.id] || 0)
    }));
    await api(`/sessions/${type}/${session.id}/attendance`, {
      method: 'PUT',
      body: JSON.stringify({ attendance })
    });
  }

  async function loadSessionList(type) {
    const result = await api(`/sessions/${type}`);
    const select = $(`.session-select[data-type="${type}"]`);
    state.sessionLists[type] = result.data;
    renderHistory(type);
    if (!select) return;
    select.innerHTML = '<option value="">Choose a saved session...</option>' +
      result.data.map((item) => `<option value="${item.id}">${item.status === 'finished' ? '✓ ' : ''}${escapeHtml(item.name)} · ${escapeHtml(item.date)} · ${escapeHtml(item.status)}</option>`).join('');
  }

  async function activateSession(type, id) {
    if (!id) {
      state.sessions[type] = null;
      renderSession(type);
      return;
    }
    const result = await api(`/sessions/${type}/${id}`);
    const data = result.data;
    state.sessions[type] = {
      id: data.id,
      title: data.name,
      date: data.date,
      status: data.status,
      members: data.attendance.filter((item) => item.selected).map((item) => item.memberId),
      attendance: Object.fromEntries(data.attendance.map((item) => [item.memberId, item.status])),
      attacks: Object.fromEntries(data.attendance.map((item) => [item.memberId, item.attacksUsed]))
    };
    renderSession(type);
  }

  async function finishSession(type) {
    const session = state.sessions[type];
    if (!session) return showNotice('Choose or create a session first.', true);
    try {
      await syncSession(type);
      await api(`/sessions/${type}/${session.id}/finish`, { method: 'POST' });
      session.status = 'finished';
      renderSession(type);
      await loadSessionList(type);
      showNotice('Session finished and saved to the database.');
    } catch (error) {
      showNotice(error.message, true);
    }

  }

  async function saveSession(type) {
    if (!state.sessions[type]) return showNotice('Choose or create a session first.', true);
    try {
      await syncSession(type);
      showNotice('Session saved.');
    } catch (error) {
      showNotice(error.message, true);
    }
  }

  async function deleteSession(type, sessionId) {
      const session = state.sessions[type];
      const id = sessionId || (session && session.id);
      if (!id) return showNotice('Choose a session first.', true);
      const saved = state.sessionLists[type].find((item) => item.id === id);
      if (!window.confirm(`Delete "${saved ? saved.name : session.title}" permanently?`)) return;
      try {
        await api(`/sessions/${type}/${id}`, { method: 'DELETE' });
        if (state.sessions[type] && state.sessions[type].id === id) {
          state.sessions[type] = null;
          renderSession(type);
        }
        await loadSessionList(type);
        showNotice('Session deleted.');
      } catch (error) {
        showNotice(error.message, true);
    }
  }

  function renderHistory(type) {
    const target = $(`#${type}-history`);
    if (!target) return;
    const query = ($(`.history-search[data-type="${type}"]`) || {}).value || '';
    const entries = state.sessionLists[type].filter((item) => `${item.name} ${item.date}`.toLowerCase().includes(query.toLowerCase()));
    target.innerHTML = entries.length ? entries.map((item) => {
      return `<div class="history-item"><strong>${item.status === 'finished' ? '<span class="finished-badge">✓ Finished</span> ' : ''}${escapeHtml(item.name)}</strong><small>${escapeHtml(item.date)} · ${escapeHtml(item.status)} ${adminOnly(`<button type="button" class="secondary delete-history-session" data-type="${type}" data-id="${item.id}">Delete</button>`)}</small></div>`;
    }).join('') : '<div class="empty">No saved sessions found.</div>';
  }

  function applyBackground(url) {
    if (!url) {
      document.body.style.removeProperty('--bg-image');
      document.body.classList.remove('has-background');
      return;
    }
    document.body.style.setProperty('--bg-image', `url("${url}")`);
    document.body.classList.add('has-background');
  }

  // Confirms the address really loads as an image, so a typo cannot silently "succeed".
  function imageLoads(url) {
    return new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve(true);
      probe.onerror = () => resolve(false);
      probe.src = url;
    });
  }

  async function loadSettings() {
    const result = await api('/settings');
    const url = result.data.bgImageUrl || '';
    applyBackground(url);
    const input = $('#settings-form') && $('#settings-form').bgImageUrl;
    if (input) input.value = url;
    const status = $('#background-status');
    if (status) status.textContent = url ? `Background image is active: ${url}` : 'No background image is set.';
  }

  async function loadUsers() {
    if (!isAdmin()) return;
    const result = await api('/admin/users');
    state.users = result.data;
    const count = $('#user-count-panel');
    if (count) count.textContent = `${state.users.length} account${state.users.length === 1 ? '' : 's'}`;
    const target = $('#user-list');
    if (!target) return;
    target.innerHTML = state.users.length ? `<table class="data-table"><thead><tr><th>Email</th><th>Access</th><th>Status</th><th></th></tr></thead><tbody>${state.users.map((account) => {
      const roleLabel = account.role === 'admin' ? 'administrator' : 'read-only';
      return `<tr><td><strong>${escapeHtml(account.email)}</strong></td><td><span class="role-badge role-${account.role === 'admin' ? 'admin' : 'user'}">${roleLabel}</span></td><td>${account.isConfirmed ? 'Confirmed' : 'Pending confirmation'}</td><td class="user-actions"><select class="user-role-select" data-id="${account.id}" aria-label="Access level for ${escapeHtml(account.email)}"><option value="user"${account.role === 'user' ? ' selected' : ''}>Read-only</option><option value="admin"${account.role === 'admin' ? ' selected' : ''}>Administrator</option></select><button type="button" class="secondary reset-user-password" data-id="${account.id}">Set password</button><button type="button" class="secondary delete-user" data-id="${account.id}">Remove</button></td></tr>`;
    }).join('')}</tbody></table>` : '<div class="empty">No accounts yet.</div>';
  }

  function bindDashboard() {
    if (!$('#member-form')) return;
    setAuthState();
    bindTabs();
    restoreViewPrefs();
    all('.session-date').forEach((input) => {
      input.addEventListener('click', () => {
        if (typeof input.showPicker === 'function') input.showPicker();
      });
    });
    ['war', 'capital'].forEach((type) => {
      const form = $(`#${type}-session-form`);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const data = formObject(event.target);
          if (!data.date || !data.title.trim()) return showNotice('Session title and date are required.', true);
          api(`/sessions/${type}`, {
            method: 'POST',
            body: JSON.stringify({ name: data.title.trim(), date: data.date })
          }).then(async (result) => {
            form.classList.add('hidden');
            await loadSessionList(type);
            const select = $(`.session-select[data-type="${type}"]`);
            select.value = result.data.id;
            await activateSession(type, result.data.id);
          }).catch((error) => showNotice(error.message, true));
      });
      const grid = type === 'war' ? $('#attendance-grid') : $('#capital-attendance-grid');
      grid.addEventListener('click', (event) => {
        if (event.target.matches('.participant-toggle')) {
          const session = state.sessions[type];
          if (session) session.members.push(Number(event.target.dataset.id));
          syncSession(type).catch((error) => showNotice(error.message, true));
          renderAttendance(type);
          return;
        }
        if (!event.target.matches('.attendance-toggle')) return;
        const session = state.sessions[type];
        session.attendance[event.target.dataset.id] = event.target.dataset.status;
        if (event.target.dataset.status === 'present') {
          session.attacks[event.target.dataset.id] = type === 'war' ? 2 : 6;
        }
        syncSession(type).catch((error) => showNotice(error.message, true));
        renderAttendance(type);
      });
      grid.addEventListener('change', (event) => {
        if (!event.target.matches('.attacks-input')) return;
        const session = state.sessions[type];
        if (!session) return;
        const maxAttacks = type === 'war' ? 2 : 6;
        const attacks = Number(event.target.value);
        if (!Number.isInteger(attacks) || attacks < 0 || attacks > maxAttacks) {
          showNotice(`Attacks must be between 0 and ${maxAttacks}.`, true);
          renderAttendance(type);
          return;
        }
        session.attacks[event.target.dataset.id] = attacks;
        syncSession(type).catch((error) => showNotice(error.message, true));
      });
    });
    all('.select-all').forEach((button) => button.addEventListener('click', () => { const session = state.sessions[button.dataset.type]; if (!session) return showNotice('Choose or create a session first.', true); session.members = state.members.map((member) => member.id); syncSession(button.dataset.type).catch((error) => showNotice(error.message, true)); renderAttendance(button.dataset.type); }));
    all('.deselect-all').forEach((button) => button.addEventListener('click', () => { const session = state.sessions[button.dataset.type]; if (!session) return; session.members = []; syncSession(button.dataset.type).catch((error) => showNotice(error.message, true)); renderAttendance(button.dataset.type); }));
    all('.finish-session').forEach((button) => button.addEventListener('click', () => finishSession(button.dataset.type)));
    all('.save-session').forEach((button) => button.addEventListener('click', () => saveSession(button.dataset.type)));
    all('.sort-name').forEach((button) => button.addEventListener('click', () => {
      const type = button.dataset.type;
      const sortState = state.sort[type];
      if (sortState.mode === 'name') sortState.descending = !sortState.descending;
      else sortState.descending = false;
      sortState.mode = 'name';
      syncSortButtons(type);
      persistViewPrefs();
      renderAttendance(type);
    }));
    all('.sort-status').forEach((button) => button.addEventListener('click', () => {
      const type = button.dataset.type;
      const sortState = state.sort[type];
      if (sortState.mode === 'status') sortState.descending = !sortState.descending;
      else sortState.descending = true;
      sortState.mode = 'status';
      syncSortButtons(type);
      persistViewPrefs();
      renderAttendance(type);
    }));
    all('.sort-attacks').forEach((button) => button.addEventListener('click', () => {
      const type = button.dataset.type;
      const sortState = state.sort[type];
      if (sortState.mode === 'attacks') sortState.descending = !sortState.descending;
      else sortState.descending = true;
      sortState.mode = 'attacks';
      syncSortButtons(type);
      persistViewPrefs();
      renderAttendance(type);
    }));
    all('.delete-session').forEach((button) => button.addEventListener('click', () => deleteSession(button.dataset.type)));
    all('.create-session').forEach((button) => button.addEventListener('click', () => {
      $(`#${button.dataset.type}-session-form`).classList.remove('hidden');
    }));
    all('.session-select').forEach((select) => select.addEventListener('change', () => activateSession(select.dataset.type, select.value).catch((error) => showNotice(error.message, true))));
    all('.history-search').forEach((input) => input.addEventListener('input', () => renderHistory(input.dataset.type)));
    all('.history-block').forEach((block) => block.addEventListener('click', (event) => {
      if (!event.target.matches('.delete-history-session')) return;
      deleteSession(event.target.dataset.type, Number(event.target.dataset.id));
    }));
    renderHistory('war'); renderHistory('capital');
    loadSettings().catch((error) => showNotice(error.message, true));
    loadSession();
    $('#logout-button').addEventListener('click', async () => {
      try { await api('/auth/logout', { method: 'POST' }); } catch (error) { showNotice(error.message, true); }
      state.token = null; state.user = null; localStorage.removeItem(tokenKey); setAuthState(); showNotice('Logged out.');
    });
    const userForm = $('#user-form');
    if (userForm) userForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('/admin/users', { method: 'POST', body: JSON.stringify(formObject(event.target)) });
        event.target.reset();
        await loadUsers();
        showNotice('Account created.');
      } catch (error) { showNotice(error.message, true); }
    });
    const userList = $('#user-list');
    if (userList) {
      userList.addEventListener('change', async (event) => {
        if (!event.target.matches('.user-role-select')) return;
        try {
          await api(`/admin/users/${event.target.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ role: event.target.value }) });
          await loadUsers();
          showNotice('Access level updated.');
        } catch (error) {
          showNotice(error.message, true);
          await loadUsers().catch(() => {});
        }
      });
      userList.addEventListener('click', async (event) => {
        if (event.target.matches('.reset-user-password')) {
          const password = window.prompt('New password for this account (8+ characters)');
          if (password === null) return;
          try {
            await api(`/admin/users/${event.target.dataset.id}/password`, { method: 'POST', body: JSON.stringify({ password }) });
            showNotice('Password updated for that account.');
          } catch (error) { showNotice(error.message, true); }
          return;
        }
        if (!event.target.matches('.delete-user') || !window.confirm('Delete this account?')) return;
        try {
          await api(`/admin/users/${event.target.dataset.id}`, { method: 'DELETE' });
          await loadUsers();
          showNotice('Account deleted.');
        } catch (error) { showNotice(error.message, true); }
      });
    }
    const changePasswordForm = $('#change-password-form');
    if (changePasswordForm) changePasswordForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('/auth/change-password', { method: 'POST', body: JSON.stringify(formObject(event.target)) });
        event.target.reset();
        showNotice('Password updated.');
      } catch (error) { showNotice(error.message, true); }
    });
    $('#member-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const data = formObject(event.target);
        data.playerTag = data.playerTag.trim() || 'N/A';
        await api('/members', { method: 'POST', body: JSON.stringify(data) });
        event.target.reset();
        await loadMembers();
        showNotice('Member added.');
      } catch (error) { showNotice(error.message, true); }
    });
    all('.member-tab').forEach((button) => button.addEventListener('click', () => {
      const scope = button.dataset.scope || 'roster';
      setRoleFilter(scope, button.dataset.roleFilter);
      if (scope === 'roster') renderMemberList();
      else renderAttendance(scope);
    }));
    const memberSort = $('#member-sort');
    if (memberSort) memberSort.addEventListener('change', (event) => {
      state.memberView.sort = event.target.value;
      syncMemberSortUi();
      persistViewPrefs();
      renderMemberList();
    });
    const memberSortDirection = $('#member-sort-direction');
    if (memberSortDirection) memberSortDirection.addEventListener('click', () => {
      state.memberView.sort = state.memberView.sort === 'nameAsc' ? 'nameDesc' : 'nameAsc';
      syncMemberSortUi();
      persistViewPrefs();
      renderMemberList();
    });
    $('#member-list').addEventListener('click', async (event) => {
      if (event.target.matches('.edit-member')) {
        const member = state.members.find((item) => String(item.id) === event.target.dataset.id);
        if (!member) return;
        const playerName = window.prompt('Player name', member.playerName);
        if (playerName === null) return;
        const playerTag = window.prompt('Player tag (leave blank for N/A)', member.playerTag || 'N/A');
        if (playerTag === null) return;
        const townHallLevel = window.prompt('Town Hall level (1-18)', member.townHallLevel);
        if (townHallLevel === null) return;
        const role = window.prompt('Role (leader, co-leader, elder, member)', member.role);
        if (role === null) return;
        try {
          await api(`/members/${member.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              playerName,
              playerTag: playerTag.trim() || 'N/A',
              townHallLevel: Number(townHallLevel),
              role
            })
          });
          await loadMembers();
          showNotice('Member updated.');
        } catch (error) { showNotice(error.message, true); }
        return;
      }
      if (!event.target.matches('.delete-member') || !window.confirm('Remove this member and their logs?')) return;
      try { await api(`/members/${event.target.dataset.id}`, { method: 'DELETE' }); await Promise.all([loadMembers(), loadActivity()]); showNotice('Member removed.'); } catch (error) { showNotice(error.message, true); }
    });
    const warForm = $('#war-form');
    if (warForm) warForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = formObject(event.target);
      data.memberId = Number(data.memberId);
      data.attacksUsed = Number(data.attacksUsed);
      data.missedAttack = event.target.missedAttack.checked;
      try { await api('/wars', { method: 'POST', body: JSON.stringify(data) }); await loadActivity(); showNotice('War activity saved.'); } catch (error) { showNotice(error.message, true); }
    });
    const capitalForm = $('#capital-form');
    if (capitalForm) capitalForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = formObject(event.target);
      data.memberId = Number(data.memberId);
      data.attacksUsed = Number(data.attacksUsed);
      data.capitalGoldLooted = Number(data.capitalGoldLooted);
      try { await api('/capital', { method: 'POST', body: JSON.stringify(data) }); await loadActivity(); showNotice('Capital activity saved.'); } catch (error) { showNotice(error.message, true); }
    });
    const warList = $('#war-list');
    if (warList) warList.addEventListener('click', (event) => deleteActivity(event, 'delete-war', '/wars'));
    const capitalList = $('#capital-list');
    if (capitalList) capitalList.addEventListener('click', (event) => deleteActivity(event, 'delete-capital', '/capital'));
    const settingsForm = $('#settings-form');
    if (settingsForm) settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = event.target.bgImageUrl.value.trim();
      try {
        if (value && !(await imageLoads(value))) {
          throw new Error('That URL did not load as an image. Check the link and try again.');
        }
        await api('/settings', { method: 'PUT', body: JSON.stringify({ bgImageUrl: value || null }) });
        await loadSettings();
        showNotice(value ? 'Background updated.' : 'Background cleared.');
      } catch (error) { showNotice(error.message, true); }
    });
    const clearBackground = $('#clear-background');
    if (clearBackground) clearBackground.addEventListener('click', async () => {
      try {
        await api('/settings', { method: 'PUT', body: JSON.stringify({ bgImageUrl: null }) });
        await loadSettings();
        showNotice('Background cleared.');
      } catch (error) { showNotice(error.message, true); }
    });
  }

  async function deleteActivity(event, className, path) {
    if (!event.target.matches(`.${className}`) || !window.confirm('Delete this activity log?')) return;
    try { await api(`${path}/${event.target.dataset.id}`, { method: 'DELETE' }); await loadActivity(); showNotice('Activity deleted.'); } catch (error) { showNotice(error.message, true); }
  }

  bindDashboard();
}());
