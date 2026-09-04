(function () {
  'use strict';

  const tokenKey = 'cocClanTrackerToken';
  const state = { token: localStorage.getItem(tokenKey), members: [] };
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

  function memberOptions() {
    all('.member-options').forEach((select) => {
      const current = select.value;
      select.innerHTML = '<option value="">Choose member…</option>' + state.members.map((member) =>
        `<option value="${member.id}">${escapeHtml(member.playerName)} (${escapeHtml(member.playerTag)})</option>`).join('');
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
    const target = $('#member-list');
    if (target) target.innerHTML = state.members.length ? `<table class="data-table"><thead><tr><th>Player</th><th>Town Hall</th><th>Role</th><th></th></tr></thead><tbody>${state.members.map((member) =>
      `<tr><td><strong>${escapeHtml(member.playerName)}</strong><br><small>${escapeHtml(member.playerTag)}</small></td><td>TH${member.townHallLevel}</td><td>${escapeHtml(member.role)}</td><td><button class="secondary edit-member" data-id="${member.id}">Edit</button> <button class="secondary delete-member" data-id="${member.id}">Remove</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No members yet. Add the first clan member above.</div>';
    memberOptions();
  }

  function formObject(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  async function loadActivity() {
    if (!state.token) return;
    const [wars, capital] = await Promise.all([api('/wars'), api('/capital')]);
    const warTarget = $('#war-list');
    if (warTarget) warTarget.innerHTML = wars.data.length ? wars.data.map((item) =>
      `<div class="activity-item"><div><strong>${escapeHtml(item.playerName)}</strong> <small>${escapeHtml(item.warDate)}</small><br><small>${item.attacksUsed}/2 attacks · ${item.missedAttack ? 'missed' : 'complete'}</small></div><button class="secondary delete-war" data-id="${item.id}">Delete</button></div>`).join('') : '<div class="empty">No war activity logged.</div>';
    const capitalTarget = $('#capital-list');
    if (capitalTarget) capitalTarget.innerHTML = capital.data.length ? capital.data.map((item) =>
      `<div class="activity-item"><div><strong>${escapeHtml(item.playerName)}</strong> <small>${escapeHtml(item.raidWeekendDate)}</small><br><small>${item.attacksUsed}/6 attacks · ${item.capitalGoldLooted.toLocaleString()} gold</small></div><button class="secondary delete-capital" data-id="${item.id}">Delete</button></div>`).join('') : '<div class="empty">No Capital activity logged.</div>';
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
    $('#war-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = formObject(event.target);
      data.memberId = Number(data.memberId);
      data.attacksUsed = Number(data.attacksUsed);
      data.missedAttack = event.target.missedAttack.checked;
      try { await api('/wars', { method: 'POST', body: JSON.stringify(data) }); await loadActivity(); showNotice('War activity saved.'); } catch (error) { showNotice(error.message, true); }
    });
    $('#capital-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = formObject(event.target);
      data.memberId = Number(data.memberId);
      data.attacksUsed = Number(data.attacksUsed);
      data.capitalGoldLooted = Number(data.capitalGoldLooted);
      try { await api('/capital', { method: 'POST', body: JSON.stringify(data) }); await loadActivity(); showNotice('Capital activity saved.'); } catch (error) { showNotice(error.message, true); }
    });
    $('#war-list').addEventListener('click', (event) => deleteActivity(event, 'delete-war', '/wars'));
    $('#capital-list').addEventListener('click', (event) => deleteActivity(event, 'delete-capital', '/capital'));
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

  function bindLogin() {
    const login = $('#login-form');
    if (!login) return;
    $('#register-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try { const result = await api('/auth/register', { method: 'POST', body: JSON.stringify(formObject(event.target)) }); showNotice(`Confirmation code (simulated email): ${result.simulatedEmail.code}`); } catch (error) { showNotice(error.message, true); }
    });
    $('#confirm-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try { await api('/auth/confirm', { method: 'POST', body: JSON.stringify(formObject(event.target)) }); showNotice('Email confirmed. You can now log in.'); } catch (error) { showNotice(error.message, true); }
    });
    login.addEventListener('submit', async (event) => {
      event.preventDefault();
      try { const result = await api('/auth/login', { method: 'POST', body: JSON.stringify(formObject(event.target)) }); state.token = result.data.token; localStorage.setItem(tokenKey, state.token); window.location.href = '/'; } catch (error) { showNotice(error.message, true); }
    });
  }

  bindLogin();
  bindDashboard();
}());
