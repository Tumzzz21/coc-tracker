// CoC Attack Tracker - frontend logic (vanilla JS)
'use strict';

const notice = document.querySelector('#notice');
const syncButton = document.querySelector('#sync-button');

const showNotice = (message, isError) => {
  if (!notice) return;
  notice.textContent = message;
  notice.classList.remove('hidden');
  notice.classList.toggle('error', Boolean(isError));
};

const esc = (value) => {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
};

// Daily records are bucketed in the *server's* zone (APP_UTC_OFFSET, else the
// server clock). /api/status hands us that offset; formatting shifts the
// timestamp and renders it in UTC, so the labels always match the data instead
// of assuming every reader is in Asia/Manila.
let APP_OFFSET_MIN = 8 * 60;
let APP_LABEL = 'PH';
let APP_TZ_SOURCE = 'default UTC+08:00';

const shift = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime())
    ? null
    : new Date(d.getTime() + APP_OFFSET_MIN * 60000);
};

const PH_TIME = () => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', hour: '2-digit', minute: '2-digit',
});
const PH_DAY = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' });
const PH_STAMP = () => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});

function setAppTz(offset, source) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(String(offset || '').trim());
  if (!match) return false;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  APP_OFFSET_MIN = match[1] === '-' ? -minutes : minutes;
  APP_LABEL = APP_OFFSET_MIN === 480 ? 'PH' : `UTC${match[1]}${match[2]}:${match[3]}`;
  APP_TZ_SOURCE = source || '';
  return true;
}

const fmtDate = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  const s = shift(d);
  return s ? PH_DAY().format(s) : String(value);
};

const fmtStamp = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  const s = shift(d);
  return s ? PH_STAMP().format(s) : String(value);
};

const fmtNum = (value) => Number(value || 0).toLocaleString();

const fmtDateTime = (value) => (value ? fmtStamp(value) : '—');

const stars = (n) => '⭐'.repeat(n || 0) || '—';

// ---- PH clock indicator ----
function tickPhClock() {
  const el = document.querySelector('#ph-clock');
  if (!el || el.dataset.state === 'warn') return;
  const now = shift(new Date());
  el.textContent = `${APP_LABEL} ${PH_TIME().format(now)} · ${PH_DAY().format(now).slice(5)}`;
}

function setPhClockWarning(offset, tzEnv) {
  const el = document.querySelector('#ph-clock');
  if (!el) return;
  setAppTz(offset);
  if (offset && offset !== '+08:00') {
    el.dataset.state = 'warn';
    el.classList.add('warn');
    el.textContent = `⚠ server UTC${offset} — not +08:00`;
    el.title = `Daily records are bucketed on the server clock (UTC${offset}), not the `
      + 'PH clock the labels assume. Set APP_UTC_OFFSET=+08:00 (or TZ=Asia/Manila) '
      + 'in the server environment so days flip at PH midnight.'
      + (tzEnv ? ` Current TZ=${tzEnv}.` : ' No TZ is set.');
  } else {
    delete el.dataset.state;
    el.classList.remove('warn');
    el.title = `${APP_LABEL} (${APP_TZ_SOURCE}) — the clock daily records are bucketed by`;
    tickPhClock();
  }
}

// ---- In-page tabs (Panels + hash so a tab can be linked) ----
const loadedTabs = new Set();

function activateTab(target) {
  const tabs = Array.from(document.querySelectorAll('.page-tab'));
  const panels = Array.from(document.querySelectorAll('.tab-panel'));
  if (!tabs.length) return;
  const chosen = tabs.some((t) => t.dataset.target === target)
    ? target
    : tabs[0].dataset.target;
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.target === chosen));
  panels.forEach((p) => p.classList.toggle('active', p.id === chosen));
  if (!loadedTabs.has(chosen)) {
    loadedTabs.add(chosen);
    document.dispatchEvent(new CustomEvent('tabshown', { detail: { target: chosen } }));
  }
}

function setupPageTabs() {
  const tabs = Array.from(document.querySelectorAll('.page-tab'));
  if (!tabs.length) return;
  activateTab(window.location.hash.replace('#', ''));
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.target;
      history.replaceState(null, '', `#${target}`);
      activateTab(target);
    });
  });
}

// Pages with tabs load their data when the tab is first shown.
document.addEventListener('tabshown', (event) => {
  const target = event.detail.target;
  if (target === 'tab-participation') loadParticipation();
  if (target === 'tab-history') loadCapital();
  if (target === 'tab-donations') loadContributions();
  if (target === 'tab-wars') loadWars();
  if (target === 'tab-leaderboard') loadWarLeaderboard();
  if (target === 'tab-leaderboards') loadCapitalLeaderboard();
  if (target === 'tab-current-war') loadCurrentWar();
  if (target === 'tab-inactivity') loadInactivity();
});

// ---- Auto-sync status (header) ----
async function loadStatus() {
  const el = document.querySelector('#sync-status');
  if (!el) return;
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const parts = [];
    if (data.auto_sync_enabled) {
      parts.push(`auto-sync every ${data.auto_sync_minutes}m`);
      el.classList.add('live');
    } else if (data.cron_enabled) {
      parts.push('auto-sync by Vercel Cron');
      el.classList.add('live');
    } else {
      parts.push('auto-sync off');
    }
    if (data.last_sync && data.last_sync.created_at) {
      parts.push(`last: ${fmtDateTime(data.last_sync.created_at)} (${data.last_sync.status})`);
    }
    if (data.last_attempt && data.last_attempt.ok === false) {
      parts.push('last attempt failed');
    }
    el.textContent = parts.join(' · ');
    setAppTz(data.server_utc_offset, data.server_tz_source);
    setPhClockWarning(data.server_utc_offset, data.server_tz_env);
  } catch (err) {
    el.textContent = '';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setupPageTabs();
  loadStatus();
  tickPhClock();
  setInterval(tickPhClock, 1000);

  // Mirror the desktop header into a mobile bottom tab bar + status line.
  setupMobileMenu();

  // Start the 5-minute auto-refresh (only after the status line has loaded).
  ensureAutoRefreshStarted();

  // Keep the header status and the live war card fresh while the page is open.
  setInterval(() => {
    loadStatus();
    if (document.querySelector('#current-war')) loadCurrentWar();
  }, 60000);
});

// ---- Auto-refresh every 5 minutes (reads from own cached API, never CoC API) ----
const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 minutes
let autoRefreshTimer = null;
let lastAutoRefreshAt = 0;

function startAutoRefresh() {
  stopAutoRefresh(); // avoid stacking
  autoRefreshTimer = setInterval(() => {
    // Only refresh if the tab is visible and we are not mid-refresh.
    if (document.hidden) return;
    if (performance.now() - lastAutoRefreshAt < 30000) return; // avoid rapid loops
    lastAutoRefreshAt = performance.now();
    autoRefreshNow(false);
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

async function autoRefreshNow(silent) {
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.status === 'ok') {
      lastAutoRefreshAt = performance.now();
      // Update the header status line (last synced time).
      loadStatus();
      // Refresh the live bits in place.
      refreshVisibleData();
      if (!silent) {
        showNotice('Auto-refreshed — data is up to date.', false);
      }
      renderSetupCheck(true);
    }
  } catch (err) {
    // Silently ignore; the next interval will retry. Don't spam the user.
    if (!silent) {
      // Only show if the user is looking.
      if (!document.hidden) showNotice('Auto-refresh failed: ' + err.message, true);
    }
  }
}

// Pause when the tab is hidden; refresh immediately when it becomes visible again.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAutoRefresh();
  } else {
    // Refresh immediately on return so the user sees fresh data.
    autoRefreshNow(true);
    startAutoRefresh();
  }
});

// Clean up on unload so the interval doesn't stack if the page is re-visited in the same process.
window.addEventListener('pagehide', stopAutoRefresh);
window.addEventListener('beforeunload', stopAutoRefresh);

// Kick off after the page has painted once and the status line has loaded.
let autoRefreshStarted = false;
async function ensureAutoRefreshStarted() {
  if (autoRefreshStarted) return;
  autoRefreshStarted = true;
  try {
    // Prime the status line first so the interval can update it.
    await loadStatus();
  } catch (e) { /* ignore */ }
  startAutoRefresh();
}

// ---- Mobile menu: bottom tab bar + compact status line ----
const MOBILE_BP = 820;
let mobileMenuBuilt = false;

function setupMobileMenu() {
  if (mobileMenuBuilt) return;
  mobileMenuBuilt = true;

  const nav = document.querySelector('#tab-nav');
  const mobileTabs = document.querySelector('#mobile-tabs');
  const mobileStatus = document.querySelector('#mobile-status');
  if (!nav || !mobileTabs) return;

  // Clone nav buttons into the mobile tab bar.
  nav.querySelectorAll('.tab-button').forEach((btn) => {
    const clone = btn.cloneNode(true);
    clone.addEventListener('click', () => {
      window.location.href = btn.getAttribute('href');
    });
    mobileTabs.appendChild(clone);
  });

  // On mobile, show the bottom menu. On wide screens, hide it.
  const headerActions = document.querySelector('.header-actions');
  const mobileMenu = document.querySelector('#mobile-menu');

  function applyVisibility() {
    const wide = window.matchMedia(`(min-width: ${MOBILE_BP + 1}px)`).matches;
    if (wide) {
      if (mobileMenu) mobileMenu.classList.add('hidden');
      if (headerActions) headerActions.style.display = '';
    } else {
      if (mobileMenu) mobileMenu.classList.remove('hidden');
      if (headerActions) headerActions.style.display = 'none';
      // Refresh the mobile status line immediately.
      updateMobileStatus();
    }
  }

  applyVisibility();
  window.matchMedia(`(min-width: ${MOBILE_BP + 1}px)`).addEventListener('change', applyVisibility);
  window.addEventListener('resize', applyVisibility);
  applyVisibility();
}

function updateMobileStatus() {
  const statusEl = document.querySelector('#sync-status');
  const mobileStatus = document.querySelector('#mobile-status');
  if (!statusEl || !mobileStatus) return;
  const text = statusEl.textContent || '';
  const live = statusEl.classList.contains('live');
  let html = '';
  if (text) html += `<span class="sync-status${live ? ' live' : ''}">${esc(text)}</span>`;
  html += '<span class="sync-mini">';
  html += '<span class="ph-clock" id="ph-clock">';
  html += document.querySelector('#ph-clock') ? document.querySelector('#ph-clock').textContent : '';
  html += '</span></span>';
  mobileStatus.innerHTML = html;
}

// ---- Refresh button ----
// Viewers: hit the public /api/refresh (cached data, no key, server-side cooldown).
// Owners: if an admin key is stored, pressing and holding (or shift-click) triggers
// a real sync via /api/sync. The label changes so a visitor is never confused.
if (syncButton) {
  syncButton.addEventListener('click', async (e) => {
    const doRealSync = e.shiftKey || e.metaKey || e.ctrlKey;
    if (doRealSync) {
      // Real sync still needs the admin key.
      if (!(await ensureAdmin())) {
        showNotice('Real sync needs the admin key (ADMIN_KEY in .env).', true);
        return;
      }
      syncButton.disabled = true;
      syncButton.textContent = 'Syncing…';
      try {
        const res = await apiFetch('/api/sync', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
          showNotice(`Sync failed: ${data.error || res.status}`, true);
        } else {
          showNotice('Sync complete: ' + formatSyncSummary(data.synced));
          refreshVisibleData();
          loadStatus();
          renderSetupCheck(true);
        }
      } catch (err) {
        showNotice('Sync failed: ' + err.message, true);
      } finally {
        syncButton.disabled = false;
        syncButton.textContent = 'Refresh now';
      }
      return;
    }

    // Viewer path: public refresh (cached data, no key needed).
    syncButton.disabled = true;
    syncButton.textContent = 'Refreshing…';
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showNotice(`Refresh failed: ${data.error || res.status}`, true);
      } else {
        const replayLabel = data.replay
          ? ' (shown from cache — fresh shortly)'
          : ' (cache is stale — owner sync needed for fresher figures)';
        showNotice('Data refreshed' + replayLabel + '.', false);
        // Update the live bits without a full reload.
        refreshVisibleData();
        loadStatus();
        renderSetupCheck(true);
      }
    } catch (err) {
      showNotice('Refresh failed: ' + err.message, true);
    } finally {
      syncButton.disabled = false;
      syncButton.textContent = 'Refresh now';
    }
  });
}

// ---- Current war (dashboard) ----
// Attack lists are grouped per member on purpose: a flat 50-row table makes you
// scan for a name, while one row per member answers "did they use both attacks,
// and what did they hit?" at a glance. Each member row expands to their own
// attacks, so the list stays short until you ask for detail.
function groupAttacksByMember(attacks) {
  const groups = new Map();
  (attacks || []).forEach((a) => {
    const key = a.attacker_tag || a.attacker_name || '?';
    if (!groups.has(key)) {
      groups.set(key, {
        tag: key,
        name: a.attacker_name || a.attacker_tag || '?',
        attacks: [],
        stars: 0,
        destruction: 0,
        perfect: 0,
      });
    }
    const group = groups.get(key);
    group.attacks.push(a);
    group.stars += Number(a.stars) || 0;
    group.destruction += Number(a.destruction) || 0;
    if (Number(a.stars) === 3) group.perfect += 1;
    if (a.attacker_name) group.name = a.attacker_name;
  });
  return [...groups.values()].map((g) => ({
    ...g,
    avgDestruction: g.attacks.length ? g.destruction / g.attacks.length : 0,
  }));
}

// Ways of ordering the per-member rows inside one war's attack list. "Who got a
// perfect attack?" is usually the question, so stars and perfect lead the list.
const MEMBER_SORT_OPTIONS = [
  ['stars', 'Stars earned'],
  ['perfect', 'Perfect attacks (3★)'],
  ['used', 'Attacks used'],
  ['unused', 'Unused attacks first'],
  ['destruction', 'Avg destruction'],
  ['name', 'Name A→Z'],
];

// Order member groups for display. `expected` (2, or 1 in CWL) is what makes
// "unused attacks first" meaningful: it compares attacks used against the cap.
function sortMemberGroups(groups, mode, expected) {
  const cap = expected || 0;
  const unusedOf = (g) => (cap ? Math.max(0, cap - g.attacks.length) : 0);
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const sorted = [...groups];
  switch (mode) {
    case 'perfect':
      sorted.sort((a, b) => b.perfect - a.perfect || b.stars - a.stars || byName(a, b));
      break;
    case 'used':
      sorted.sort((a, b) => b.attacks.length - a.attacks.length || b.stars - a.stars || byName(a, b));
      break;
    case 'unused':
      sorted.sort((a, b) => unusedOf(b) - unusedOf(a) || b.stars - a.stars || byName(a, b));
      break;
    case 'destruction':
      sorted.sort((a, b) => b.avgDestruction - a.avgDestruction || b.stars - a.stars || byName(a, b));
      break;
    case 'name':
      sorted.sort(byName);
      break;
    default:
      sorted.sort((a, b) => b.stars - a.stars || b.avgDestruction - a.avgDestruction || byName(a, b));
  }
  return sorted;
}

// One expandable row per member. `expected` is how many attacks the war format
// allows (2 in a normal war, 1 in CWL), used to flag unused attacks up front.
function renderSideAttacks(attacks, side, expected, sortMode) {
  const groups = sortMemberGroups(groupAttacksByMember(attacks), sortMode, expected);
  if (!groups.length) {
    return `<p class="muted">No attacks recorded.</p>`;
  }
  let html = `<div class="member-attack-list ${side === 'enemy' ? 'attacks-enemy' : ''}">`;
  groups.forEach((g, gi) => {
    const used = g.attacks.length;
    const unused = expected ? Math.max(0, expected - used) : 0;
    const perfect = g.perfect ? ` · ${g.perfect} perfect` : '';
    html += `<details class="member-attack">`
      + '<summary>'
      + `<span class="row-index ma-rank">#${gi + 1}</span>`
      + `<span class="ma-name">${esc(g.name)}</span>`
      + `<span class="ma-stats">${used}${expected ? ` / ${expected}` : ''} attack${used === 1 ? '' : 's'}`
      + ` · ${g.stars}★${perfect} · ${g.avgDestruction.toFixed(1)}%</span>`
      + (unused ? `<span class="badge badge-missed">${unused} unused</span>` : '')
      + '</summary>'
      + '<div class="table-scroll"><table class="data-table"><thead><tr>'
      + '<th>#</th><th>Order</th><th>Defender</th><th>Stars</th><th>Destr.</th><th>Duration</th>'
      + '</tr></thead><tbody>';
    g.attacks.forEach((a, i) => {
      html += `<tr><td>${i + 1}</td>`
        + `<td>${esc(a.order == null ? '—' : a.order)}</td>`
        + `<td>${esc(a.defender_name || a.defender_tag)}</td>`
        + `<td>${stars(a.stars)}</td>`
        + `<td>${Number(a.destruction || 0).toFixed(1)}%</td>`
        + `<td>${a.duration ? `${a.duration}s` : '—'}</td></tr>`;
    });
    html += '</tbody></table></div></details>';
  });
  return html + '</div>';
}

// How many attacks each member may use in this war (CWL gives one).
function expectedAttacks(war) {
  return war && war.is_cwl ? 1 : 2;
}

// Render a war's attack detail (both sides) plus a "sort members by" control.
// The container is reused across re-sorts, so changing the select only re-renders
// the rows we already have — no refetch.
function renderAttackDetail(container, war, data, sortMode) {
  const clanAttacks = data.clan_attacks || (data.attacks || []).filter((a) => a.side === 'clan');
  const enemyAttacks = data.enemy_attacks || (data.attacks || []).filter((a) => a.side !== 'clan');
  const mode = sortMode || container.dataset.sortMode || 'stars';
  container.dataset.sortMode = mode;
  if (!clanAttacks.length && !enemyAttacks.length) {
    container.innerHTML = '<p class="muted">No attacks recorded for this war.</p>';
    return;
  }
  const expected = expectedAttacks(war);
  const options = MEMBER_SORT_OPTIONS.map(([value, label]) =>
    `<option value="${esc(value)}"${value === mode ? ' selected' : ''}>${esc(label)}</option>`
  ).join('');
  let html = '<div class="sort-controls attack-sort">'
    + '<label class="field-inline"><span class="muted">Sort members by</span>'
    + `<select class="filter-select attack-sort-select">${options}</select></label>`
    + '</div>'
    + `<h3 class="side-heading side-clan">⚔ Our attacks (${clanAttacks.length})`
    + ' <span class="muted">— click a member to see their hits</span></h3>'
    + renderSideAttacks(clanAttacks, 'clan', expected, mode)
    + `<h3 class="side-heading side-enemy">🛡 Enemy attacks (${enemyAttacks.length})</h3>`
    + renderSideAttacks(enemyAttacks, 'enemy', expected, mode);
  container.innerHTML = html;
  const select = container.querySelector('.attack-sort-select');
  if (select) {
    select.addEventListener('change', () => renderAttackDetail(container, war, data, select.value));
  }
}

async function loadCurrentWar() {
  const container = document.querySelector('#current-war');
  if (!container) return;
  try {
    const res = await fetch('/api/current-war');
    const data = await res.json();
    if (!data.in_war) {
      container.textContent = 'Not in a war right now — click Refresh now once one starts.';
      return;
    }
    const war = data.war;
    let html =
      `<p><strong>vs ${esc(war.opponent_name)}</strong> · ` +
      `<span class="badge badge-${esc(war.result || 'pending')}">${esc(war.result)}</span> · ` +
      `${esc(war.stars_for)}★ – ${esc(war.stars_against)}★ · ` +
      `${Number(war.destruction_for || 0).toFixed(1)}% destroyed` +
      ` · team size ${esc(war.team_size || '—')}</p>`;
    const clanAttacks = data.clan_attacks || (data.attacks || []).filter((a) => a.side === 'clan');
    const enemyAttacks = data.enemy_attacks || (data.attacks || []).filter((a) => a.side !== 'clan');
    if (clanAttacks.length || enemyAttacks.length) {
      html += '<div class="attack-detail"></div>';
    } else {
      html += '<p class="muted">No attacks yet this war.</p>';
    }
    container.innerHTML = html;
    const detail = container.querySelector('.attack-detail');
    if (detail) renderAttackDetail(detail, war, data);
  } catch (err) {
    container.textContent = 'Failed to load current war: ' + err.message;
  }
}

// ---- Capital participation ----
let raidOptionsLoaded = false;

async function loadRaidOptions() {
  const select = document.querySelector('#participation-raid');
  if (!select || raidOptionsLoaded) return;
  raidOptionsLoaded = true;  // set first: never register two change listeners
  try {
    const res = await fetch('/api/capital');
    const raids = await res.json();
    if (!Array.isArray(raids) || !raids.length) return;
    select.innerHTML = raids.map((r) =>
      `<option value="${esc(r.id)}">${fmtDate(r.start_time)} → ${fmtDate(r.end_time)}</option>`
    ).join('');
    raidOptionsLoaded = true;
    select.addEventListener('change', () => loadParticipation());
  } catch (err) {
    select.innerHTML = '';
    raidOptionsLoaded = false;  // allow a retry on the next tab visit
  }
}

async function loadParticipation() {
  const container = document.querySelector('#participation-container');
  if (!container) return;
  const select = document.querySelector('#participation-raid');
  if (!raidOptionsLoaded && select && !select.options.length) await loadRaidOptions();
  const raidId = select && select.value ? `?raid_id=${encodeURIComponent(select.value)}` : '';
  container.classList.add('muted');
  container.textContent = 'Loading participation…';
  try {
    const res = await fetch(`/api/capital/participation${raidId}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      container.textContent = data.error || `Failed to load participation (${res.status})`;
      return;
    }
    const attacked = data.attacked || [];
    const notAttacked = data.not_attacked || [];
    const raid = data.raid || {};
    let html = `<p class="muted">Weekend ${fmtDate(raid.start_time)} → ${fmtDate(raid.end_time)} · ` +
      `<strong>${attacked.length}</strong> attacked · <strong>${notAttacked.length}</strong> did not attack</p>`;
    html += '<h3>✅ Attacked</h3><div class="table-scroll"><table class="data-table"><thead><tr>' +
      '<th>#</th><th>Member</th><th>Attacks</th><th>Districts</th><th>Capital gold</th></tr></thead><tbody>';
    attacked.forEach((r, i) => {
      html += `<tr><td>${i + 1}</td><td>${esc(r.member_name || r.member_tag)}</td>` +
        `<td>${esc(r.attacks)}</td><td>${esc(r.districts_destroyed)}</td>` +
        `<td>${fmtNum(r.capital_gold)}</td></tr>`;
    });
    html += '</tbody></table></div>';
    html += `<h3>❌ Didn't attack (${notAttacked.length})</h3>`;
    if (notAttacked.length) {
      html += '<div class="table-scroll"><table class="data-table"><thead><tr><th>Member</th><th>Tag</th></tr></thead><tbody>';
      notAttacked.forEach((m) => {
        html += `<tr><td>${esc(m.name)}</td><td class="muted">${esc(m.tag)}</td></tr>`;
      });
      html += '</tbody></table></div>';
    } else {
      html += '<p class="muted">Everyone attacked. 🎉</p>';
    }
    container.classList.remove('muted');
    container.innerHTML = html;
  } catch (err) {
    container.textContent = 'Failed to load participation: ' + err.message;
  }
}

// ---- Daily capital coin donations ----
function renderClanDaily(data) {
  const container = document.querySelector('#contributions-daily');
  if (!container) return;
  const rows = data.clan_daily || [];
  if (!rows.length) {
    container.classList.add('muted');
    container.textContent = 'No completed day yet — a day is scored once the next '
      + "day's first reading has been captured.";
    return;
  }
  let html = '<div class="table-scroll"><table class="data-table"><thead><tr>' +
    `<th>Day (${APP_LABEL})</th><th>Coins donated</th><th>Members who donated</th></tr></thead><tbody>`;
  rows.forEach((r) => {
    html += `<tr><td>${esc(r.day)}</td><td>${fmtNum(r.donated)}</td>` +
      `<td>${esc(r.donors)}</td></tr>`;
  });
  container.classList.remove('muted');
  container.innerHTML = html + '</tbody></table></div>';
}

function renderTodaySoFar(data) {
  const container = document.querySelector('#contrib-today');
  if (!container) return;
  const label = document.querySelector('#contrib-today-label');
  if (label) label.textContent = `(${data.today} ${APP_LABEL})`;
  const cadenceEl = document.querySelector('#contrib-cadence');
  const cadence = (data.tz && data.tz.contrib_snapshot_hours) || 0;
  if (cadenceEl) cadenceEl.textContent = cadence || '0 (daily baseline only)';

  const rows = (data.today_so_far || []).filter((r) => r.donated > 0);
  if (!rows.length) {
    container.classList.add('muted');
    container.textContent = 'No donations recorded yet today.';
    return;
  }
  let html = '<div class="table-scroll"><table class="data-table"><thead><tr>' +
    '<th>Member</th><th>Donated so far</th><th>Last reading</th></tr></thead><tbody>';
  rows.forEach((r) => {
    html += `<tr><td>${esc(r.name)}</td><td>${fmtNum(r.donated)}</td>` +
      `<td class="muted">${fmtStamp(r.latest_at)}</td></tr>`;
  });
  container.classList.remove('muted');
  container.innerHTML = html + '</tbody></table></div>';
}

function renderContribDay(data) {
  const container = document.querySelector('#contributions-container');
  const windowEl = document.querySelector('#contrib-window');
  const summaryEl = document.querySelector('#contrib-summary');
  const picker = document.querySelector('#contrib-day');
  const tzNote = document.querySelector('#contrib-tz-note');
  if (!container) return;

  if (tzNote) {
    const tz = data.tz || {};
    tzNote.textContent =
      `Recorded on the server clock: ${tz.tz_name || '—'} (UTC${tz.utc_offset || ''}, `
      + `${tz.source || 'server local time'}). Today is ${data.today} ${APP_LABEL}.`;
  }

  const dayList = data.day_list || (data.days || []).map((d) => ({
    day: d, state: 'scored', donated: null, donors: null,
  }));
  if (picker) {
    picker.innerHTML = dayList
      .map((d) => {
        const label = d.state === 'open'
          ? `${d.day} (in progress)`
          : `${d.day}`;
        const suffix = d.state === 'scored' && d.donated != null
          ? ` – ${fmtNum(d.donated)}`
          : '';
        return `<option value="${esc(d.day)}">${esc(label)}${esc(suffix)}</option>`;
      })
      .join('');
    if (data.selected_day) picker.value = data.selected_day;
  }

  renderCoverage(data);

  if (!data.selected_day) {
    if (windowEl) windowEl.textContent = '';
    if (summaryEl) summaryEl.innerHTML = '';
    container.classList.add('muted');
    container.textContent =
      'No readings recorded yet. The CoC API is asked for one lifetime-contribution '
      + 'reading per member per sync; two readings on different days are needed '
      + 'before any day can be scored.';
    return;
  }

  const isOpen = data.is_open || data.selected_state === 'open';
  const w = data.window || {};
  if (windowEl) {
    windowEl.textContent = w.from && w.to
      ? (isOpen
        ? `In progress since ${fmtStamp(w.from)} ${APP_LABEL}`
        : `Measured window: ${fmtStamp(w.from)} → ${fmtStamp(w.to)} ${APP_LABEL}`)
        + (w.span_hours ? ` · ${w.span_hours}h` : '')
      : '';
  }
  if (summaryEl) {
    summaryEl.innerHTML =
      `<span class="summary-chip">Day <strong>${esc(data.selected_day)}</strong> ${APP_LABEL}</span>`
      + (isOpen
        ? `<span class="summary-chip warn">in progress · not final</span>`
        : '')
      + `<span class="summary-chip">${isOpen ? 'Donated so far' : 'Donated'} <strong>${fmtNum(data.total_donated)}</strong></span>`
      + `<span class="summary-chip">Donors <strong>${esc(data.donor_count)}</strong></span>`
      + `<span class="summary-chip">Didn't donate <strong>${esc((data.not_donated || []).length)}</strong></span>`;
  }

  const donors = data.donors || [];
  const notDonated = data.not_donated || [];
  let html = `<h3>✅ Donated (${donors.length})</h3>`;
  if (donors.length) {
    html += '<div class="table-scroll"><table class="data-table"><thead><tr>'
      + '<th>#</th><th>Member</th><th>Coins donated</th>'
      + '<th>Total at day start</th></tr></thead><tbody>';
    donors.forEach((d, i) => {
      html += `<tr><td>${i + 1}</td><td>${esc(d.name)}`
        + `${d.departed ? ' <span class="badge badge-departed">left</span>' : ''}</td>`
        + `<td>${fmtNum(d.donated)}</td>`
        + `<td class="muted">${fmtNum(d.baseline)}</td></tr>`;
    });
    html += '</tbody></table></div>';
  } else {
    html += '<p class="muted">Nobody donated on this day.</p>';
  }

  html += `<h3>❌ Didn't donate (${notDonated.length})</h3>`;
  if (notDonated.length) {
    html += '<div class="table-scroll"><table class="data-table"><thead><tr>'
      + '<th>Member</th><th>Tag</th><th></th></tr></thead><tbody>';
    notDonated.forEach((m) => {
      html += `<tr><td>${esc(m.name)}`
        + `${m.departed ? ' <span class="badge badge-departed">left</span>' : ''}</td>`
        + `<td class="muted">${esc(m.tag)}</td>`
        + `<td>${m.reset ? '<span class="badge badge-reset">reset / rejoined</span>' : ''}</td></tr>`;
    });
    html += '</tbody></table></div>';
  } else {
    html += '<p class="muted">Everyone donated. 🎉</p>';
  }

  container.classList.remove('muted');
  container.innerHTML = html;
}

// Coverage tells the user whether the numbers above can be trusted, and gives
// the exact command to run when they cannot (a stale baseline means the CoC API
// key stopped working, not that nobody donated).
function renderCoverage(data) {
  const el = document.querySelector('#contrib-coverage');
  if (!el) return;
  const c = data.coverage || {};
  const parts = [];
  if (c.days_recorded != null) {
    parts.push(`${c.days_recorded} day${c.days_recorded === 1 ? '' : 's'} recorded`);
  }
  if (c.days_scored != null) parts.push(`${c.days_scored} scored`);
  if (c.days_open) parts.push(`${c.days_open} in progress`);
  if (c.first_day) parts.push(`${c.first_day} → ${c.last_day}`);

  let html = parts.join(' · ');

  // Not enough readings to score anything yet.
  if (c.days_recorded === 1 && !c.days_scored) {
    html += '<br><strong>One more day of readings is needed</strong> before any day '
      + 'can be scored — a day is measured between two baselines.';
  }
  // Readings stopped: the sync is not running.
  if (c.days_stale != null && c.days_stale >= 2) {
    html += `<br><span class="warn-text">No new readings for ${c.days_stale} days — `
      + 'the API key is most likely rejected. Fix it, then press Refresh now:</span>'
      + '<br><code>python scripts/refresh_key.py</code>';
  }
  el.innerHTML = html;
  el.classList.toggle('warn', (c.days_stale != null && c.days_stale >= 2)
    || (c.days_recorded === 1 && !c.days_scored));
}

async function loadContributions() {
  const container = document.querySelector('#contributions-container');
  if (!container) return;
  const picker = document.querySelector('#contrib-day');
  const requested = picker && picker.value
    ? `?day=${encodeURIComponent(picker.value)}`
    : '';
  container.classList.add('muted');
  try {
    const res = await fetch(`/api/contributions${requested}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      container.textContent = data.error || `Failed to load donations (${res.status})`;
      return;
    }
    renderContribDay(data);
    renderTodaySoFar(data);
    renderClanDaily(data);
  } catch (err) {
    container.textContent = 'Failed to load donations: ' + err.message;
  }
}

// The day picker re-scopes only this section (no full page reload).
document.addEventListener('DOMContentLoaded', () => {
  const picker = document.querySelector('#contrib-day');
  if (picker) picker.addEventListener('change', () => loadContributions());
});

// ---- Members page ----
// The CoC API returns roles as leader / coLeader / admin / member. In the
// game's UI "admin" is displayed as **Elder**, so map it there - collapsing it
// into co-leader (as an earlier version did) mislabels every elder in the clan.
const ROLE_RANK = { leader: 0, coLeader: 1, admin: 2, elder: 2, member: 3 };
const ROLE_LABEL = {
  leader: 'Leader', coLeader: 'Co-leader', admin: 'Elder',
  elder: 'Elder', member: 'Member',
};

let membersSort = 'name_asc';
let membersCache = null;

async function loadMembers() {
  const container = document.querySelector('#members-container');
  if (!container) return;
  try {
    const res = await fetch('/api/members');
    const members = await res.json();
    if (!Array.isArray(members) || members.length === 0) {
      container.textContent = 'No members synced yet — click Refresh now.';
      return;
    }
    const sorted = members.slice();
    if (membersSort === 'name_asc') {
      sorted.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    } else if (membersSort === 'name_desc') {
      sorted.sort((a, b) => String(b.name).localeCompare(String(a.name)));
    } else if (membersSort === 'role') {
      sorted.sort((a, b) =>
        (ROLE_RANK[a.role] ?? 99) - (ROLE_RANK[b.role] ?? 99) ||
        String(a.name).localeCompare(String(b.name)));
    } else if (membersSort === 'role_desc') {
      sorted.sort((a, b) =>
        (ROLE_RANK[b.role] ?? 99) - (ROLE_RANK[a.role] ?? 99) ||
        String(a.name).localeCompare(String(b.name)));
    } else if (membersSort === 'trophies') {
      sorted.sort((a, b) => (b.trophies || 0) - (a.trophies || 0));
    } else if (membersSort === 'trophies_asc') {
      sorted.sort((a, b) => (a.trophies || 0) - (b.trophies || 0));
    } else if (membersSort === 'town_hall') {
      sorted.sort((a, b) => (b.town_hall || 0) - (a.town_hall || 0) ||
        String(a.name).localeCompare(String(b.name)));
    }
    let html = '<div class="table-scroll"><table class="data-table"><thead><tr>'
      + '<th>#</th><th>Name</th><th>Role</th><th>TH</th><th>Trophies</th></tr></thead><tbody>';
    sorted.forEach((m, i) => {
      const role = m.role || '';
      html += `<tr><td class="muted">${i + 1}</td><td>${esc(m.name)}</td>` +
        `<td><span class="role-badge role-${esc(role)}">${esc(ROLE_LABEL[role] || role || '—')}</span></td>` +
        `<td>${esc(m.town_hall || '—')}</td><td>${esc(m.trophies || '—')}</td></tr>`;
      // Expandable profile row: the member's whole tracked history, loaded on
      // first open so browsing the roster stays a single request.
      html += `<tr class="profile-row"><td colspan="5" style="padding:0">`
        + `<details class="member-profile" data-tag="${esc(m.tag)}">`
        + '<summary><span class="muted">Profile</span>'
        + '<span class="muted profile-hint">wars · stars · perfects · capital loot</span></summary>'
        + '<div class="profile-body muted">Loading profile…</div></details></td></tr>';
    });
    container.innerHTML = html + '</tbody></table></div>';
    container.querySelectorAll('details.member-profile').forEach((details) => {
      details.addEventListener('toggle', () => {
        if (!details.open || details.dataset.loaded === '1') return;
        details.dataset.loaded = '1';
        loadMemberProfile(details);
      });
    });
  } catch (err) {
    container.textContent = 'Failed to load members: ' + err.message;
  }
}

// One member's whole tracked history, for the expandable row on the Members page.
async function loadMemberProfile(details) {
  const body = details.querySelector('.profile-body');
  try {
    const params = new URLSearchParams({ tag: details.dataset.tag });
    const res = await fetch(`/api/members/profile?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const p = await res.json();
    const w = p.wars || {};
    const c = p.capital || {};
    const chips = [
      `Wars played: <strong>${esc(w.played ?? 0)}</strong>`,
      `Attacks used: <strong>${esc(w.attacks_used ?? 0)}</strong>`,
      `Missed: <strong>${esc(w.attacks_missed ?? 0)}</strong>`,
      `Stars: <strong>${esc(w.stars ?? 0)}</strong>`,
      `Perfect (3★): <strong>${esc(w.perfects ?? 0)}</strong>`,
      `Avg destruction: <strong>${w.avg_destruction != null ? esc(w.avg_destruction) + '%' : '—'}</strong>`,
      `Raid weekends: <strong>${esc(c.weekends ?? 0)}</strong>`,
      `Capital gold: <strong>${Number(c.capital_gold || 0).toLocaleString()}</strong>`,
      `Raid medals: <strong>${Number(c.raid_medals || 0).toLocaleString()}</strong>`,
    ].map((chip) => `<span class="summary-chip">${chip}</span>`).join('');
    let detail = '';
    if ((w.detail || []).length) {
      detail = '<div class="table-scroll"><table class="data-table"><thead><tr>'
        + '<th>War</th><th>Result</th><th>Attacks</th><th>Stars</th><th>Perfects</th><th>Avg destr.</th><th>Ended</th>'
        + '</tr></thead><tbody>'
        + w.detail.map((d) => `<tr><td>${esc(d.opponent_name || '—')}</td>`
          + `<td><span class="badge badge-${esc(d.result || 'pending')}">${esc(d.result || '—')}</span></td>`
          + `<td>${esc(d.attacks ?? '—')}${d.is_cwl ? ' <em class="muted">(CWL)</em>' : ''}</td>`
          + `<td>${esc(d.stars ?? '—')}</td><td>${esc(d.perfects ?? '—')}</td>`
          + `<td>${d.avg_destruction != null ? esc(Number(d.avg_destruction).toFixed(1)) + '%' : '—'}</td>`
          + `<td>${fmtDate(d.end_time)}</td></tr>`).join('')
        + '</tbody></table></div>';
    } else {
      detail = '<p class="muted">No tracked war attacks yet — only wars synced while live carry per-attack data.</p>';
    }
    body.innerHTML = `<div class="war-summary">${chips}</div>` + detail;
    body.classList.remove('muted');
  } catch (err) {
    body.textContent = 'Failed to load profile: ' + err.message;
  }
}

const membersSortSelect = document.querySelector('#members-sort');
if (membersSortSelect) {
  membersSortSelect.addEventListener('change', () => {
    membersSort = membersSortSelect.value;
    loadMembers();
  });
}

// ---- Wars page ----
// The list is numbered and sortable. Sorting reorders the wars already loaded
// (no refetch), and rows are renumbered so "#1" always means the top row.
let warsCache = null;
let warsSort = 'newest';

const WAR_RESULT_RANK = { win: 0, tie: 1, lose: 2 };

function warTime(war) {
  const value = war.end_time || war.start_time;
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortWars(wars, mode) {
  const rows = wars.slice();
  if (mode === 'oldest') {
    rows.sort((a, b) => warTime(a) - warTime(b));
  } else if (mode === 'result') {
    rows.sort((a, b) => (WAR_RESULT_RANK[a.result] ?? 9) - (WAR_RESULT_RANK[b.result] ?? 9)
      || warTime(b) - warTime(a));
  } else if (mode === 'stars') {
    rows.sort((a, b) => (b.stars_for || 0) - (a.stars_for || 0) || warTime(b) - warTime(a));
  } else if (mode === 'destruction') {
    rows.sort((a, b) => (b.destruction_for || 0) - (a.destruction_for || 0)
      || warTime(b) - warTime(a));
  } else if (mode === 'opponent') {
    rows.sort((a, b) => String(a.opponent_name || '')
      .localeCompare(String(b.opponent_name || '')));
  } else {
    rows.sort((a, b) => warTime(b) - warTime(a));
  }
  return rows;
}

function renderWarsList() {
  const container = document.querySelector('#wars-container');
  if (!container || !warsCache) return;
  container.innerHTML = '';
  sortWars(warsCache, warsSort).forEach((war, index) => {
    const details = document.createElement('details');
    details.className = 'war-item';
    const summary = document.createElement('summary');
    summary.innerHTML =
      `<span class="row-index">#${index + 1}</span>` +
      `<strong>${esc(war.opponent_name)}</strong> · ` +
      `<span class="badge badge-${esc(war.result || 'pending')}">${esc(war.result || '—')}</span> ` +
      `${esc(war.stars_for)}★ – ${esc(war.stars_against)}★ · ` +
      `${Number(war.destruction_for || 0).toFixed(1)}% · ${fmtDate(war.end_time || war.start_time)}` +
      (war.is_cwl ? ' · <em>CWL</em>' : '') +
      (war.notes ? ` · 📝 ${esc(war.notes)}` : '');
    const body = document.createElement('div');
    body.className = 'details-body';
    body.innerHTML =
      `<p class="muted">Team size: ${esc(war.team_size || '—')} · ` +
      `Ended: ${fmtDate(war.end_time)}</p>` +
      `<p class="war-note-row"><button type="button" class="sort-button note-button"` +
      ` data-war-id="${esc(war.id)}" data-notes="${esc(war.notes || '')}">` +
      `📝 ${war.notes ? 'Edit note' : 'Add note'}</button></p>` +
      '<div class="attack-list muted">Loading attacks…</div>';
    // Load the attack list lazily, the first time the war is opened.
    details.addEventListener('toggle', async () => {
      if (!details.open || details.dataset.loaded === '1') return;
      details.dataset.loaded = '1';
      const list = body.querySelector('.attack-list');
      try {
        const ares = await fetch(`/api/wars/${encodeURIComponent(war.id)}/attacks`);
        const adata = await ares.json();
        const all = adata.attacks || [];
        if (!all.length) {
          list.textContent = 'No attacks recorded for this war.';
          return;
        }
        list.classList.remove('muted');
        renderAttackDetail(list, war, adata);
      } catch (err) {
        list.textContent = 'Failed to load attacks: ' + err.message;
      }
    });
    details.append(summary, body);
    container.append(details);
  });
}

async function loadWars() {
  const container = document.querySelector('#wars-container');
  if (!container) return;
  try {
    const res = await fetch('/api/wars');
    const wars = await res.json();
    if (!Array.isArray(wars) || wars.length === 0) {
      container.textContent = 'No wars synced yet — click Refresh now.';
      return;
    }
    warsCache = wars;
    renderWarsList();
    const sortSelect = document.querySelector('#wars-sort');
    if (sortSelect && !sortSelect.dataset.bound) {
      sortSelect.dataset.bound = '1';
      sortSelect.addEventListener('change', () => {
        warsSort = sortSelect.value;
        renderWarsList();
      });
    }
  } catch (err) {
    container.textContent = 'Failed to load wars: ' + err.message;
  }
}

// ---- War notes ----
// The button lives inside each expanded war row; one delegated listener covers
// every row, present and future, without rebinding after re-sorts.
document.addEventListener('click', (event) => {
  const button = event.target.closest('.note-button');
  if (!button) return;
  openNoteEditor(button);
});

function openNoteEditor(button) {
  const existing = document.querySelector('#note-dialog');
  if (existing) existing.remove();
  const warId = button.dataset.warId;
  const dialog = document.createElement('dialog');
  dialog.id = 'note-dialog';
  dialog.className = 'note-dialog';
  dialog.innerHTML =
    '<form method="dialog">'
    + '<h3>War note</h3>'
    + '<textarea class="note-textarea" rows="3" maxlength="500" '
    + 'placeholder="e.g. missed attacks, close call, CWL prep">'
    + esc(button.dataset.notes || '') + '</textarea>'
    + '<div class="note-actions">'
    + '<button type="button" class="sort-button note-cancel">Cancel</button>'
    + '<button type="submit" class="sort-button note-save">Save note</button>'
    + '</div></form>';
  document.body.append(dialog);
  dialog.querySelector('.note-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const notes = dialog.querySelector('.note-textarea').value.trim();
    const saveButton = dialog.querySelector('.note-save');
    saveButton.disabled = true;
    saveButton.textContent = 'Saving';
    try {
      await apiFetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'war', id: warId, notes }),
      });
      dialog.close();
      const war = (warsCache || []).find((w) => String(w.id) === String(warId));
      if (war) {
        war.notes = notes || null;
        renderWarsList();  // re-render so the summary line shows the note
      }
    } catch (err) {
      saveButton.disabled = false;
      saveButton.textContent = 'Save note';
      let msg = dialog.querySelector('.note-error');
      if (!msg) {
        msg = document.createElement('p');
        msg.className = 'note-error';
        dialog.querySelector('form').append(msg);
      }
      msg.textContent = err.message;
    }
  });
  if (typeof dialog.showModal === 'function') dialog.showModal();
}


// ---- Leaderboards ----
// War stars live on the Wars page; Clan Capital loot lives on the Capital page.
// Each page stays self-contained instead of mixing the two domains.
function leaderboardTable(rows, columns, emptyMessage) {
  if (!rows || !rows.length) return `<p class="muted">${esc(emptyMessage)}</p>`;
  let html = '<div class="table-scroll"><table class="data-table"><thead><tr><th>#</th>';
  columns.forEach((c) => { html += `<th>${esc(c.label)}</th>`; });
  html += '</tr></thead><tbody>';
  rows.forEach((row, i) => {
    html += `<tr><td>${i + 1}</td>`;
    columns.forEach((c) => {
      html += `<td>${c.format ? c.format(row) : esc(row[c.key])}</td>`;
    });
    html += '</tr>';
  });
  return html + '</tbody></table></div>';
}

const WAR_STAR_COLUMNS = [
  { key: 'attacker_name', label: 'Attacker' },
  { key: 'stars', label: 'Stars', format: (r) => fmtNum(r.stars) },
  { key: 'attacks', label: 'Attacks', format: (r) => esc(r.attacks) },
  {
    key: 'avg_destruction',
    label: 'Avg destruction',
    format: (r) => `${Number(r.avg_destruction || 0).toFixed(1)}%`,
  },
];

// Sort helper for cached leaderboard rows (numeric desc by default).
function sortRows(rows, key, direction = 'desc') {
  const sorted = (rows || []).slice();
  const sign = direction === 'asc' ? 1 : -1;
  sorted.sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    if (typeof va === 'string' || typeof vb === 'string') {
      return sign * String(va ?? '').localeCompare(String(vb ?? ''));
    }
    return sign * ((Number(va) || 0) - (Number(vb) || 0));
  });
  return sorted;
}

let perWarStarsCache = null;

function renderPerWarTable() {
  const perWarBox = document.querySelector('#leaderboard-per-war');
  if (!perWarBox || !perWarStarsCache) return;
  const sortSel = document.querySelector('#leaderboard-per-war-sort');
  const key = sortSel ? sortSel.value : 'stars';
  const dir = key.endsWith('_asc') ? 'asc' : 'desc';
  const cleanKey = key.replace('_asc', '');
  perWarBox.classList.remove('muted');
  perWarBox.innerHTML = leaderboardTable(
    sortRows(perWarStarsCache, cleanKey, dir),
    WAR_STAR_COLUMNS,
    'No per-attack data for this war. The API only provides attacks for a war '
    + 'that is live or just ended.'
  );
}

// The board is scoped to one war at a time, so the war picker is the single
// source of truth: it drives both the summary line and the table below it.
let warsForPicker = null;

function renderWarSummary(picker) {
  const box = document.querySelector('#leaderboard-war-summary');
  if (!box) return;
  const war = (warsForPicker || []).find((w) => String(w.id) === String(picker.value));
  if (!war) {
    box.innerHTML = '';
    return;
  }
  const enemy = document.querySelector('#leaderboard-include-enemy');
  const showingEnemy = Boolean(enemy && enemy.checked);
  box.innerHTML =
    `<span class="summary-chip">${esc(war.opponent_name || 'Unknown')}</span>`
    + `<span class="summary-chip">`
    + `<span class="badge badge-${esc(war.result || 'pending')}">${esc(war.result || '—')}</span></span>`
    + `<span class="summary-chip">Stars <strong>${esc(war.stars_for)} – ${esc(war.stars_against)}</strong></span>`
    + `<span class="summary-chip">Destruction <strong>${Number(war.destruction_for || 0).toFixed(1)}%</strong></span>`
    + `<span class="summary-chip">${esc(fmtDate(war.end_time || war.start_time))}</span>`
    + (war.is_cwl ? '<span class="summary-chip">CWL</span>' : '')
    + (showingEnemy ? '<span class="summary-chip warn">showing enemy side</span>' : '');
}

async function loadWarLeaderboard() {
  const perWarBox = document.querySelector('#leaderboard-per-war');
  const picker = document.querySelector('#leaderboard-war-select');
  if (!picker || !perWarBox) return;
  try {
    // Populate once; re-selecting only re-scopes the summary and the table.
    if (!picker.options.length) {
      const warsRes = await fetch('/api/wars');
      if (!warsRes.ok) throw new Error(`HTTP ${warsRes.status}`);
      warsForPicker = await warsRes.json();
      warsForPicker.forEach((w) => {
        const option = document.createElement('option');
        option.value = w.id;
        option.textContent = `${w.opponent_name || 'Unknown'} - ${w.result || 'unknown'}`;
        picker.appendChild(option);
      });
      picker.addEventListener('change', () => {
        renderWarSummary(picker);
        loadPerWarLeaderboard();
      });
      const perWarSort = document.querySelector('#leaderboard-per-war-sort');
      if (perWarSort) perWarSort.addEventListener('change', renderPerWarTable);
      const enemyToggle = document.querySelector('#leaderboard-include-enemy');
      if (enemyToggle) {
        enemyToggle.addEventListener('change', () => {
          renderWarSummary(picker);
          loadPerWarLeaderboard();
        });
      }
    }
    renderWarSummary(picker);
    await loadPerWarLeaderboard();
  } catch (err) {
    perWarBox.textContent = 'Failed to load leaderboard: ' + err.message;
  }
}

async function loadPerWarLeaderboard() {
  const perWarBox = document.querySelector('#leaderboard-per-war');
  const picker = document.querySelector('#leaderboard-war-select');
  const enemyToggle = document.querySelector('#leaderboard-include-enemy');
  if (!perWarBox || !picker || !picker.value) return;
  const side = enemyToggle && enemyToggle.checked ? 'enemy' : 'clan';
  try {
    const wres = await fetch(`/api/wars/${encodeURIComponent(picker.value)}/leaderboard?side=${side}`);
    if (!wres.ok) {
      const error = await wres.json().catch(() => ({}));
      perWarStarsCache = null;
      perWarBox.classList.add('muted');
      perWarBox.textContent = error.error || `Could not load that war (HTTP ${wres.status}).`;
      return;
    }
    const wdata = await wres.json();
    perWarStarsCache = wdata.stars || [];
    renderPerWarTable();
  } catch (err) {
    perWarBox.textContent = 'Failed to load leaderboard: ' + err.message;
  }
}

let capitalLootCache = null;

function renderCapitalLeaderboard() {
  const box = document.querySelector('#capital-leaderboard');
  if (!box || !capitalLootCache) return;
  const sortSel = document.querySelector('#capital-leaderboard-sort');
  const key = sortSel ? sortSel.value : 'capital_gold';
  box.classList.remove('muted');
  box.innerHTML = leaderboardTable(
    sortRows(capitalLootCache, key, 'desc'),
    [
      { key: 'member_name', label: 'Member' },
      { key: 'capital_gold', label: 'Capital gold', format: (r) => fmtNum(r.capital_gold) },
      { key: 'attacks', label: 'Attacks', format: (r) => esc(r.attacks) },
      { key: 'districts', label: 'Districts', format: (r) => esc(r.districts) },
      { key: 'weekends', label: 'Weekends', format: (r) => esc(r.weekends) },
    ],
    'No raid weekends synced yet - click Refresh now.'
  );
}

async function loadCapitalLeaderboard() {
  const box = document.querySelector('#capital-leaderboard');
  if (!box) return;
  try {
    const res = await fetch('/api/capital/leaderboard');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    capitalLootCache = data.raid_loot || [];
    renderCapitalLeaderboard();
    const sortSel = document.querySelector('#capital-leaderboard-sort');
    if (sortSel && !sortSel.dataset.bound) {
      sortSel.dataset.bound = '1';
      sortSel.addEventListener('change', renderCapitalLeaderboard);
    }
    const noteEl = document.querySelector('#capital-leaderboard-note');
    const cov = data.coverage || {};
    if (noteEl && cov.weekends_with_data != null) {
      noteEl.innerHTML = `<p class="muted">${esc(cov.weekends_with_data)} of `
        + `${esc(cov.weekends_total)} raid weekend(s) have per-member data - `
        + `${fmtNum(cov.total_gold)} gold from ${esc(cov.raiders)} raiders. `
        + `${esc(cov.note)}</p>`;
    }
  } catch (err) {
    box.classList.add('muted');
    box.textContent = 'Failed to load leaderboard: ' + err.message;
  }
}


// ---- Capital page: raid weekend history (expandable) ----
async function loadCapital() {
  const container = document.querySelector('#capital-container');
  if (!container) return;
  try {
    const res = await fetch('/api/capital');
    const raids = await res.json();
    if (!Array.isArray(raids) || raids.length === 0) {
      container.textContent = 'No raid weekends synced yet — click Refresh now.';
      return;
    }
    container.innerHTML = '';
    raids.forEach((raid) => {
      const details = document.createElement('details');
      details.className = 'raid-item';
      const summary = document.createElement('summary');
      summary.innerHTML =
        `<strong>${fmtDate(raid.start_time)} → ${fmtDate(raid.end_time)}</strong> · ` +
        `${esc(raid.raids_completed)} raiders · ${esc(raid.total_attacks)} attacks · ` +
        `${esc(raid.districts_destroyed)} districts · ${fmtNum(raid.total_capital_gold)} gold` +
        (raid.notes ? ` · 📝 ${esc(raid.notes)}` : '');
      const body = document.createElement('div');
      body.className = 'details-body';
      body.innerHTML = '<div class="raider-list muted">Loading members…</div>';
      details.addEventListener('toggle', async () => {
        if (!details.open || details.dataset.loaded === '1') return;
        details.dataset.loaded = '1';
        const list = body.querySelector('.raider-list');
        try {
          const rres = await fetch(`/api/capital/${encodeURIComponent(raid.id)}/raiders`);
          const rdata = await rres.json();
          const raiders = rdata.raiders || [];
          if (!raiders.length) {
            list.textContent = 'No member breakdown stored for this weekend.';
            return;
          }
          let rows = '<div class="table-scroll"><table class="data-table"><thead><tr>' +
            '<th>#</th><th>Member</th><th>Attacks</th><th>Districts</th>' +
            '<th>Capital gold</th></tr></thead><tbody>';
          raiders.forEach((r, i) => {
            rows += `<tr><td>${i + 1}</td><td>${esc(r.member_name || r.member_tag)}</td>` +
              `<td>${esc(r.attacks)}</td><td>${esc(r.districts_destroyed)}</td>` +
              `<td>${fmtNum(r.capital_gold)}</td></tr>`;
          });
          list.classList.remove('muted');
          list.innerHTML = rows + '</tbody></table></div>';
        } catch (err) {
          list.textContent = 'Failed to load members: ' + err.message;
        }
      });
      details.append(summary, body);
      container.append(details);
    });
  } catch (err) {
    container.textContent = 'Failed to load raid weekends: ' + err.message;
  }
}

// ---- Inactivity alerts (dashboard) ----
async function loadInactivity() {
  const container = document.querySelector('#inactivity-container');
  if (!container) return;
  container.textContent = 'Loading inactivity report…';
  try {
    const res = await fetch('/api/inactivity');
    const data = await res.json();
    if (!res.ok || data.error) {
      container.classList.remove('muted');
      container.textContent = data.error || `Failed to load report (${res.status})`;
      return;
    }
    renderInactivity(data, container);
  } catch (err) {
    container.classList.remove('muted');
    container.textContent = 'Failed to load inactivity report: ' + err.message;
  }
}

let inactivityCache = null;

function severityOf(m) {
  const warRatio = m.wars_checked ? m.wars_missed / m.wars_checked : 0;
  return (warRatio >= 0.5 || m.raids_missed >= 2) ? 'sev-high'
    : (warRatio > 0 || m.raids_missed > 0 || m.no_donation_days >= 3) ? 'sev-med' : 'sev-low';
}

function renderInactivityTable() {
  const container = document.querySelector('#inactivity-container');
  if (!container || !inactivityCache) return;
  const data = inactivityCache;
  const rollup = data.rollup || [];
  let html = `<p class="muted">Checked <strong>${esc(data.members_checked)}</strong> members · `
    + `${esc(data.params.wars)} recent war(s) · `
    + `${esc(data.params.raids)} recent raid weekend(s) · `
    + `${esc(data.params.donation_days)} recent scored donation day(s)`
    + (data.donation_days_scored && data.donation_days_scored.length
      ? ` (${esc(data.donation_days_scored[0])} → ${esc(data.donation_days_scored[data.donation_days_scored.length - 1])})`
      : '') + '</p>';

  if (!rollup.length) {
    html += '<p>✅ No inactivity found — everyone pulled their weight.</p>';
    container.classList.remove('muted');
    container.innerHTML = html;
    return;
  }

  const sortSel = document.querySelector('#inactivity-sort');
  const mode = sortSel ? sortSel.value : 'severity';
  const rows = rollup.slice();
  if (mode === 'name') {
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } else if (mode === 'wars') {
    rows.sort((a, b) => b.wars_missed - a.wars_missed || b.attacks_missed - a.attacks_missed);
  } else if (mode === 'attacks') {
    rows.sort((a, b) => b.attacks_missed - a.attacks_missed);
  } else if (mode === 'raids') {
    rows.sort((a, b) => b.raids_missed - a.raids_missed || String(a.name).localeCompare(String(b.name)));
  } else if (mode === 'donations') {
    rows.sort((a, b) => b.no_donation_days - a.no_donation_days);
  } else {
    rows.sort((a, b) => -(a.wars_missed + a.raids_missed + a.no_donation_days / 2)
      + (b.wars_missed + b.raids_missed + b.no_donation_days / 2));
  }

  html += '<div class="table-scroll"><table class="data-table"><thead><tr>'
    + '<th>#</th><th>Member</th><th>Role</th><th>Wars missed</th>'
    + '<th>Attacks missed</th><th>Raid weekends missed</th>'
    + '<th>Days without donations</th></tr></thead><tbody>';
  rows.forEach((m, i) => {
    html += `<tr class="${severityOf(m)}"><td>${i + 1}</td><td>${esc(m.name)}</td>`
      + `<td>${esc(ROLE_LABEL[m.role] || m.role || '—')}</td>`
      + `<td>${esc(m.wars_missed)} / ${esc(m.wars_checked)}</td>`
      + `<td>${esc(m.attacks_missed)}</td>`
      + `<td>${esc(m.raids_missed)} / ${esc(m.raids_checked)}</td>`
      + `<td>${esc(m.no_donation_days)}${m.no_donation_days ? ` / ${esc(m.donation_days_checked)}` : ''}</td></tr>`;
  });
  html += '</tbody></table></div>';

  // Detail: why each recent war flagged someone
  const wars = (data.wars || []).filter((w) => (w.missed || []).length);
  if (wars.length) {
    html += '<h3>Per war</h3>';
    wars.forEach((w) => {
      html += `<details class="war-item"><summary><strong>vs ${esc(w.opponent_name || '?')}</strong> `
        + `${fmtDate(w.end_time || w.start_time)} · `
        + `<span class="badge badge-departed">${esc(w.missed.length)} didn't use all attacks</span></summary>`
        + '<div class="details-body"><table class="data-table"><thead><tr>'
        + '<th>Member</th><th>Attacks used</th><th>Missed</th></tr></thead><tbody>';
      w.missed.forEach((m) => {
        html += `<tr><td>${esc(m.name)}</td><td>${esc(m.attacks_used)}</td><td>${esc(m.missed)}</td></tr>`;
      });
      html += '</tbody></table></div></details>';
    });
  }

  // Detail: absent raiders per weekend
  const raids = (data.raids || []).filter((r) => (r.missing || []).length);
  if (raids.length) {
    html += '<h3>Raid weekends</h3>';
    raids.forEach((r) => {
      html += `<details class="raid-item"><summary><strong>${fmtDate(r.start_time)} → ${fmtDate(r.end_time)}</strong> · `
        + `<span class="badge badge-departed">${esc(r.missing.length)} didn't raid</span></summary>`
        + '<div class="details-body"><p class="muted">'
        + r.missing.map((m) => esc(m.name)).join(', ') + '</p></div></details>';
    });
  }

  container.classList.remove('muted');
  container.innerHTML = html;
}

function renderInactivity(data, container) {
  inactivityCache = data;
  renderInactivityTable();
  const sortSel = document.querySelector('#inactivity-sort');
  if (sortSel && !sortSel.dataset.bound) {
    sortSel.dataset.bound = '1';
    sortSel.addEventListener('change', renderInactivityTable);
  }
}

// ---- Admin key: stored in this browser only, never embedded in the page ----

const ADMIN_KEY_STORAGE = 'cocAdminKey';
const adminKeyValue = () => localStorage.getItem(ADMIN_KEY_STORAGE) || '';

async function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  const key = adminKeyValue();
  if (key) headers['X-Admin-Key'] = key;
  const res = await fetch(path, Object.assign({}, options, { headers }));
  if (res.ok) return res;
  let detail = null;
  try {
    detail = (await res.clone().json()).error;
  } catch (err) {
    detail = null;
  }
  if (res.status === 401) {
    throw new Error('Wrong admin key — open ⚙ settings and paste ADMIN_KEY from .env.');
  }
  if (res.status === 403) {
    throw new Error('Not allowed (403).');
  }
  throw new Error(detail || `Request failed (${res.status})`);
}

async function checkAdmin() {
  try {
    const res = await apiFetch('/api/admin/verify', { method: 'POST' });
    return (await res.json()).admin === true;
  } catch (err) {
    return false;
  }
}

function setAdminMessage(text, isError) {
  const el = document.querySelector('#admin-key-message');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('error', Boolean(isError));
}

// Returns true when the action may proceed; otherwise opens the key dialog.
async function ensureAdmin() {
  if (await checkAdmin()) return true;
  const dialog = document.querySelector('#admin-dialog');
  if (dialog && typeof dialog.showModal === 'function') {
    setAdminMessage('This action needs ADMIN_KEY from .env.', true);
    dialog.showModal();
  } else {
    showNotice('This action needs the admin key (ADMIN_KEY in .env).', true);
  }
  return false;
}

function setupAdminDialog() {
  const dialog = document.querySelector('#admin-dialog');
  const input = document.querySelector('#admin-key-input');
  const openButton = document.querySelector('#admin-button');
  const saveButton = document.querySelector('#admin-save');
  const forgetButton = document.querySelector('#admin-forget');
  const closeButton = document.querySelector('#admin-close');
  if (!dialog || !input) return;
  if (openButton) {
    openButton.addEventListener('click', () => {
      input.value = adminKeyValue();
      setAdminMessage(adminKeyValue()
        ? 'A key is stored in this browser.'
        : 'No key stored — local requests are trusted automatically.');
      if (typeof dialog.showModal === 'function') dialog.showModal();
    });
  }
  if (closeButton) closeButton.addEventListener('click', () => dialog.close());
  if (forgetButton) {
    forgetButton.addEventListener('click', () => {
      localStorage.removeItem(ADMIN_KEY_STORAGE);
      input.value = '';
      setAdminMessage('Key forgotten.');
    });
  }
  if (saveButton) {
    saveButton.addEventListener('click', async () => {
      const value = input.value.trim();
      if (!value) {
        setAdminMessage('Enter the admin key first.', true);
        return;
      }
      localStorage.setItem(ADMIN_KEY_STORAGE, value);
      setAdminMessage('Checking…');
      if (await checkAdmin()) {
        setAdminMessage('Key accepted.');
        dialog.close();
        showNotice('Admin key saved for this browser.');
      } else {
        setAdminMessage('That key was rejected (401).', true);
      }
    });
  }
}

function formatSyncSummary(synced) {
  if (!synced || typeof synced !== 'object') return String(synced || 'ok');
  return Object.keys(synced).map((key) => `${key}: ${synced[key]}`).join(', ');
}

function refreshVisibleData() {
  if (document.querySelector('#current-war')) loadCurrentWar();
  if (document.querySelector('#wars-container')) loadWars();
  if (document.querySelector('#leaderboard-per-war')) loadWarLeaderboard();
  if (document.querySelector('#capital-leaderboard')) loadCapitalLeaderboard();
  if (document.querySelector('#members-container')) loadMembers();
  if (document.querySelector('#participation-container')) loadParticipation();
  if (document.querySelector('#capital-container')) loadCapital();
  if (document.querySelector('#contributions-container')) loadContributions();
}

document.addEventListener('DOMContentLoaded', () => {
  setupAdminDialog();
  renderSetupCheck();
});

// ---- Setup check card (renders even when the dashboard has no data) ----
async function renderSetupCheck(force) {
  const box = document.querySelector('#setup-check');
  if (!box) return;
  try {
    const res = await fetch(`/api/diagnostics${force ? '?fresh=1' : ''}`);
    const data = await res.json();
    if (data.ok) {
      const live = data.api.live || {};
      box.className = 'setup-check ok';
      box.innerHTML = '<strong>✓ Setup check passed</strong>'
        + (live.name
          ? ` — ${esc(live.name)} (${esc(live.tag)}) · ${esc(live.members)} members`
          : '');
      return;
    }
    let html = '<strong>⚠ Sync cannot work until these are fixed</strong><ul>';
    (data.problems || []).forEach((problem) => {
      html += `<li><span class="setup-code">${esc(problem.code)}</span> `
        + `${esc(problem.message || '')}`;
      if (problem.fix) html += `<br><code>${esc(problem.fix)}</code>`;
      html += '</li>';
    });
    html += '</ul>';
    if (data.api.portal) {
      html += '<p class="muted">Developer portal: '
        + `<a href="${esc(data.api.portal)}" target="_blank" rel="noopener">${esc(data.api.portal)}</a>`
        + ' &middot; full report: '
        + '<a href="/api/diagnostics?fresh=1" target="_blank" rel="noopener">/api/diagnostics</a></p>';
    }
    box.className = 'setup-check error';
    box.innerHTML = html;
  } catch (err) {
    box.className = 'setup-check error';
    box.textContent = 'Setup check failed: ' + err.message;
  }
}
