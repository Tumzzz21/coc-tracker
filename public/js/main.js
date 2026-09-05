(function () {
  'use strict';

  const tokenKey = 'cocClanTrackerToken';
  const state = { token: localStorage.getItem(tokenKey), members: [], attendance: new Map(), sessions: { war: null, capital: null }, history: JSON.parse(localStorage.getItem('cocSessionHistory') || '{"war":[],"capital":[]}') };
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

  function setAuthState() {
    const loggedIn = Boolean(state.token);
    all('.auth-required').forEach((element) => { element.style.display = loggedIn ? '' : 'none'; });
    const loginLink = $('#login-link');
    const logout = $('#logout-button');
    if (loginLink) loginLink.classList.toggle('hidden', loggedIn);
    if (logout) logout.classList.toggle('hidden', !loggedIn);
    const banner = $('#auth-banner');
    if (banner) banner.textContent = loggedIn ? 'Admin mode active — changes are protected by your session.' : 'Log in to manage activity.';
  }

  function bindTabs() {
    const buttons = all('.tab-button');
    buttons.forEach((button) => button.addEventListener('click', () => {
      const tab = button.dataset.tab;
      buttons.forEach((item) => item.classList.toggle('active', item === button));
      all('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab));
      history.replaceState(null, '', `#${tab}`);
      if (tab === 'war' || tab === 'capital') renderAttendance(tab);
    }));
    const requested = window.location.hash.slice(1);
    const button = buttons.find((item) => item.dataset.tab === requested);
    if (button) button.click();
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

  async function loadMembers() {
    if (!state.token) return;
    const result = await api('/members');
    state.members = result.data;
    const count = $('#member-count');
    if (count) count.textContent = `${state.members.length} member${state.members.length === 1 ? '' : 's'}`;
    const panelCount = $('#member-count-panel');
    if (panelCount) panelCount.textContent = `${state.members.length} member${state.members.length === 1 ? '' : 's'}`;
    const target = $('#member-list');
    if (target) target.innerHTML = state.members.length ? `<table class="data-table"><thead><tr><th>Player</th><th>Tag</th><th>Town Hall</th><th>Role</th><th></th></tr></thead><tbody>${state.members.map((member) =>
      `<tr><td><strong>${escapeHtml(member.playerName)}</strong></td><td><small>${escapeHtml(member.playerTag || 'N/A')}</small></td><td>TH${member.townHallLevel}</td><td><span class="role-badge role-${escapeHtml(member.role)}">${escapeHtml(member.role)}</span></td><td><button class="secondary edit-member" data-id="${member.id}">Edit</button> <button class="secondary delete-member" data-id="${member.id}">Remove</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No members yet. Add the first clan member above.</div>';
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
      `<div class="activity-item"><div><strong>${escapeHtml(item.playerName)}</strong> <small>${escapeHtml(item.warDate)}</small><br><small>${item.attacksUsed}/2 attacks · ${item.missedAttack ? 'missed' : 'complete'}</small></div><button class="secondary delete-war" data-id="${item.id}">Delete</button></div>`).join('') : '<div class="empty">No war activity logged.</div>';
    const capitalTarget = $('#capital-list');
    if (capitalTarget) capitalTarget.innerHTML = capital.data.length ? capital.data.map((item) =>
      `<div class="activity-item"><div><strong>${escapeHtml(item.playerName)}</strong> <small>${escapeHtml(item.raidWeekendDate)}</small><br><small>${item.attacksUsed}/6 attacks · ${item.capitalGoldLooted.toLocaleString()} gold</small></div><button class="secondary delete-capital" data-id="${item.id}">Delete</button></div>`).join('') : '<div class="empty">No Capital activity logged.</div>';
  }

  function renderAttendance(type) {
    const target = type === 'capital' ? $('#capital-attendance-grid') : $('#attendance-grid');
    if (!target) return;
    if (!state.token) {
      target.innerHTML = '<div class="empty">Log in to manage attendance.</div>';
      return;
    }
    target.innerHTML = state.members.length ? state.members.map((member) => {
      const session = state.sessions[type];
      const selected = session && session.members.includes(member.id);
      const status = session ? session.attendance[member.id] || 'unmarked' : 'unmarked';
      const maxAttacks = type === 'war' ? 2 : 6;
      const attacks = session ? Math.min(maxAttacks, Math.max(0, Number(session.attacks[member.id] || 0))) : 0;
      return `<div class="attendance-row ${selected ? '' : 'not-selected'}"><div class="member-summary"><strong>${escapeHtml(member.playerName)}</strong><small>${escapeHtml(member.playerTag || 'N/A')} · <span class="role-badge role-${escapeHtml(member.role)}">${escapeHtml(member.role)}</span></small></div><div class="attendance-actions">${selected ? `<label class="attack-count">Attacks <input class="attacks-input" data-id="${member.id}" type="number" min="0" max="${maxAttacks}" value="${attacks}" aria-label="Attacks used by ${escapeHtml(member.playerName)}"></label><button class="attendance-toggle present ${status === 'present' ? 'selected' : ''}" data-id="${member.id}" data-status="present" aria-label="Mark ${escapeHtml(member.playerName)} present">✓</button><button class="attendance-toggle absent ${status === 'absent' ? 'selected' : ''}" data-id="${member.id}" data-status="absent" aria-label="Mark ${escapeHtml(member.playerName)} absent">X</button>` : `<button class="participant-toggle secondary" data-id="${member.id}">Add</button>`}</div></div>`;
    }).join('') : '<div class="empty">Select members for this session.</div>';
    const count = $('#attendance-count');
    if (count) count.textContent = state.sessions[type] ? Object.keys(state.sessions[type].attendance).length : 0;
  }

  function renderSession(type) {
    const session = state.sessions[type];
    const label = $(`#${type}-session-label`);
    if (label) label.textContent = session ? `${session.title}${session.date ? ` · ${session.date}` : ''}` : `No active ${type === 'war' ? 'war' : 'Capital'} session.`;
    renderAttendance(type);
  }

  function finishSession(type) {
    const session = state.sessions[type];
    if (!session) return showNotice('Create a session first.', true);
    state.history[type].unshift({ ...session, id: Date.now(), savedAt: new Date().toISOString() });
    localStorage.setItem('cocSessionHistory', JSON.stringify(state.history));
    state.sessions[type] = null;
    renderSession(type);
    renderHistory(type);
    showNotice('Session saved to history.');
  }

  function renderHistory(type) {
    const target = $(`#${type}-history`);
    if (!target) return;
    const query = ($(`.history-search[data-type="${type}"]`) || {}).value || '';
    const entries = state.history[type].filter((item) => `${item.title} ${item.date}`.toLowerCase().includes(query.toLowerCase()));
    target.innerHTML = entries.length ? entries.map((item) => {
      const present = Object.values(item.attendance).filter((value) => value === 'present').length;
      const absent = Object.values(item.attendance).filter((value) => value === 'absent').length;
      const totalAttacks = Object.values(item.attacks || {}).reduce((total, value) => total + Number(value || 0), 0);
      return `<div class="history-item"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.date || 'Undated')} · ${present} present · ${absent} absent · ${totalAttacks} attacks used · ${item.members.length} selected</small></div>`;
    }).join('') : '<div class="empty">No saved sessions found.</div>';
  }

  async function loadSettings() {
    const result = await api('/settings');
    if (result.data.bgImageUrl) {
      document.body.style.setProperty('--bg-image', `url("${result.data.bgImageUrl}")`);
      document.body.classList.add('has-background');
    }
  }

  function bindDashboard() {
    if (!$('#member-form')) return;
    setAuthState();
    bindTabs();
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
        if (!data.date && !data.title.trim()) {
          showNotice('Enter a session date or title first.', true);
          return;
        }
          state.sessions[type] = { date: data.date, title: data.title || (type === 'war' ? 'Clan War' : 'Clan Capital'), members: [], attendance: {}, attacks: {} };
        renderSession(type);
      });
      const grid = type === 'war' ? $('#attendance-grid') : $('#capital-attendance-grid');
      grid.addEventListener('click', (event) => {
        if (event.target.matches('.participant-toggle')) {
          const session = state.sessions[type];
          if (session) session.members.push(Number(event.target.dataset.id));
          renderAttendance(type);
          return;
        }
        if (!event.target.matches('.attendance-toggle')) return;
        const session = state.sessions[type];
        session.attendance[event.target.dataset.id] = event.target.dataset.status;
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
      });
    });
    all('.select-all').forEach((button) => button.addEventListener('click', () => { const session = state.sessions[button.dataset.type]; if (!session) return showNotice('Create a session first.', true); session.members = state.members.map((member) => member.id); renderAttendance(button.dataset.type); }));
    all('.deselect-all').forEach((button) => button.addEventListener('click', () => { const session = state.sessions[button.dataset.type]; if (!session) return; session.members = []; renderAttendance(button.dataset.type); }));
    all('.finish-session').forEach((button) => button.addEventListener('click', () => finishSession(button.dataset.type)));
    all('.history-search').forEach((input) => input.addEventListener('input', () => renderHistory(input.dataset.type)));
    renderHistory('war'); renderHistory('capital');
    loadSettings().catch((error) => showNotice(error.message, true));
    if (state.token) Promise.all([loadMembers(), loadActivity()]).catch((error) => showNotice(error.message, true));
    $('#logout-button').addEventListener('click', async () => {
      try { await api('/auth/logout', { method: 'POST' }); } catch (error) { showNotice(error.message, true); }
      state.token = null; localStorage.removeItem(tokenKey); setAuthState(); showNotice('Logged out.');
    });
    $('#member-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try { await api('/members', { method: 'POST', body: JSON.stringify(formObject(event.target)) }); event.target.reset(); await loadMembers(); showNotice('Member added.'); } catch (error) { showNotice(error.message, true); }
    });
    $('#member-list').addEventListener('click', async (event) => {
      if (event.target.matches('.edit-member')) {
        const member = state.members.find((item) => String(item.id) === event.target.dataset.id);
        if (!member) return;
        const playerName = window.prompt('Player name', member.playerName);
        if (playerName === null) return;
        const townHallLevel = window.prompt('Town Hall level (1-18)', member.townHallLevel);
        if (townHallLevel === null) return;
        const role = window.prompt('Role (leader, co-leader, elder, member)', member.role);
        if (role === null) return;
        try {
          await api(`/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ playerName, townHallLevel: Number(townHallLevel), role }) });
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
    $('#settings-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = event.target.bgImageUrl.value.trim();
      try { await api('/settings', { method: 'PUT', body: JSON.stringify({ bgImageUrl: value || null }) }); await loadSettings(); showNotice('Background updated.'); } catch (error) { showNotice(error.message, true); }
    });
    $('#clear-background').addEventListener('click', async () => {
      try { await api('/settings', { method: 'PUT', body: JSON.stringify({ bgImageUrl: null }) }); document.body.style.removeProperty('--bg-image'); document.body.classList.remove('has-background'); showNotice('Background cleared.'); } catch (error) { showNotice(error.message, true); }
    });
  }

  async function deleteActivity(event, className, path) {
    if (!event.target.matches(`.${className}`) || !window.confirm('Delete this activity log?')) return;
    try { await api(`${path}/${event.target.dataset.id}`, { method: 'DELETE' }); await loadActivity(); showNotice('Activity deleted.'); } catch (error) { showNotice(error.message, true); }
  }

  bindDashboard();
}());
