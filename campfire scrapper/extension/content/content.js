// =============================================================
// Campfire Meetup Tracker - panel UI (isolated content-script world)
//
// Events get into the list three ways:
//   - automatically, from any Campfire page you browse (club pages,
//     meetup lists, a meetup itself) - see hook.js
//   - "Refresh", which re-runs the list queries captured above
//   - pasting meetup URLs / IDs
// Then select events -> "Fetch attendance" -> Results tab -> export CSV.
// =============================================================
(() => {
  if (window.__cfTrackerLoaded) return;
  window.__cfTrackerLoaded = true;

  const HOOK = 'cf-hook';
  const EXT = 'cf-ext';
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const MAX_SOURCES = 25;
  const CONCURRENCY = 3;
  const meetupUrl = (id) => `https://campfire.scopely.com/discover/meetup/${id}`;

  const GET_EVENT_QUERY = `query GetEvent($eventId: ID!) {
    event(id: $eventId) {
      id
      name
      address
      eventTime
      eventEndTime
      checkedInMembersCount
      game
      club { id name }
      creator { id displayName username }
      members {
        totalCount
        edges { node { id displayName } }
      }
      rsvpStatuses { userId rsvpStatus }
    }
  }`;

  // ---------------------------------------------------------------
  // State + persistence
  // ---------------------------------------------------------------
  const state = {
    events: {},    // id -> { id, name, eventTime, eventEndTime, address, club, checkedIn, going }
    details: {},   // id -> { attendees: [{id,name,status}], totalGoing, host, partial, fetchedAt }
    sources: {},   // key -> { operationName, query, variables, extensions, lastSeen, lastCount }
    selected: new Set(),
    tab: 'events',
    filter: { q: '', club: '', from: '', to: '', loadedOnly: false },
    status: '',
    busy: false,
    open: false,
  };

  let saveTimer = null;
  let loaded = false;
  function persist() {
    if (!loaded) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({
        cf_events: state.events,
        cf_details: state.details,
        cf_sources: state.sources,
        cf_selected: [...state.selected],
        cf_logs: state.logs,
        cf_errors: state.errors,
        cf_full: state.full,
        cf_logsSeenAt: state.logsSeenAt,
        cf_ops: state.ops,
        cf_memberStrategy: state.memberStrategy,
      });
    }, 300);
  }

  async function loadState() {
    const s = await chrome.storage.local.get(['cf_events', 'cf_details', 'cf_sources', 'cf_selected', 'cf_logs', 'cf_errors', 'cf_full', 'cf_logsSeenAt', 'cf_ops', 'cf_memberStrategy']);
    state.events = s.cf_events || {};
    state.details = s.cf_details || {};
    state.sources = s.cf_sources || {};
    state.selected = new Set(s.cf_selected || []);
    state.logs = [...(s.cf_logs || []), ...state.logs].slice(-MAX_LOGS);
    state.errors = { ...(s.cf_errors || {}), ...state.errors };
    state.full = !!s.cf_full;
    state.logsSeenAt = s.cf_logsSeenAt || 0;
    state.ops = { ...(s.cf_ops || {}), ...state.ops };
    state.memberStrategy = s.cf_memberStrategy || null;
  }

  // ---------------------------------------------------------------
  // Bridge to hook.js (page world)
  // ---------------------------------------------------------------
  let reqSeq = 0;
  const pending = new Map();

  function gql(body, label) {
    return new Promise((resolve, reject) => {
      const reqId = `${Date.now()}-${++reqSeq}`;
      const started = Date.now();
      pending.set(reqId, { resolve, reject, body, label, started });
      window.postMessage({ src: EXT, type: 'request', reqId, body }, '*');
      setTimeout(() => {
        if (pending.delete(reqId)) {
          addLog('error', `${label || body.operationName}: timed out after 60s`, {
            hint: 'hook.js did not answer. Reload the Campfire tab (the extension may have been reloaded since the page loaded).',
            variables: body.variables,
          });
          reject(new Error('Request timed out'));
        }
      }, 60000);
    });
  }

  function onResponse(msg) {
    const p = pending.get(msg.reqId);
    if (!p) return;
    pending.delete(msg.reqId);
    const name = p.label || p.body.operationName;
    const details = {
      variables: p.body.variables,
      ms: Date.now() - p.started,
      attempts: msg.attempts,
      pageApiSettings: msg.page,
    };
    if (msg.error) {
      addLog('error', `${name}: ${msg.error}`, details);
      return p.reject(new Error(msg.error));
    }
    const gqlErrors = msg.json.errors;
    if (gqlErrors && gqlErrors.length) {
      addLog(name.startsWith('Probe') ? 'info' : msg.json.data ? 'warn' : 'error', `${name}: GraphQL error - ${gqlErrors[0].message}`, { ...details, errors: gqlErrors });
    } else {
      const ok = msg.attempts[msg.attempts.length - 1];
      addLog('ok', `${name}: OK (HTTP ${ok.status}, ${ok.ms}ms${msg.attempts.length > 1 ? `, succeeded on attempt "${ok.label}"` : ''})`, details);
    }
    p.resolve(msg.json);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.src !== HOOK) return;
    const msg = e.data;
    if (msg.type === 'response') onResponse(msg);
    else if (msg.type === 'gql') onCaptured(msg.request, msg.data);
    else if (msg.type === 'log') addLog(msg.level, msg.msg, msg.data);
    else if (msg.type === 'diagnose-result') addLog('info', 'Current API settings learned from the page', msg.page);
  });

  // ---------------------------------------------------------------
  // Logs (shown on the Logs tab, last MAX_LOGS kept in storage)
  // ---------------------------------------------------------------
  const MAX_LOGS = 300;
  state.logs = [];
  state.errors = {}; // event id -> last fetch error
  state.ops = {};    // operationName -> last request seen from the page
  state.schema = null;
  state.probe = null;
  const MAX_OPS = 150;

  function addLog(level, msg, data) {
    state.logs.push({ t: Date.now(), level, msg, data });
    if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
    if (level === 'error') console.warn('[Campfire Tracker]', msg, data);
    persist();
    if (root && state.open && state.tab === 'logs') renderTab();
    else if (root) updateCounts();
  }

  // ---------------------------------------------------------------
  // Harvesting events out of arbitrary GraphQL responses
  // ---------------------------------------------------------------
  function looksLikeEvent(node) {
    return typeof node.id === 'string'
      && /^[0-9a-f-]{36}$/i.test(node.id)
      && typeof node.name === 'string'
      && (node.eventTime || node.__typename === 'Event');
  }

  function findEvents(node, out, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 30) return out;
    if (Array.isArray(node)) {
      for (const n of node) findEvents(n, out, depth + 1);
      return out;
    }
    if (looksLikeEvent(node)) out.push(node);
    for (const k in node) findEvents(node[k], out, depth + 1);
    return out;
  }

  function mergeEvent(node) {
    const prev = state.events[node.id] || {};
    state.events[node.id] = {
      ...prev,
      id: node.id,
      name: node.name ?? prev.name,
      eventTime: node.eventTime ?? prev.eventTime,
      eventEndTime: node.eventEndTime ?? prev.eventEndTime,
      address: node.address ?? prev.address,
      club: node.club?.name ?? prev.club,
      clubId: node.club?.id ?? prev.clubId,
      checkedIn: node.checkedInMembersCount ?? prev.checkedIn,
      going: node.members?.totalCount ?? prev.going,
    };
  }

  // Returns how many events were found in `data`.
  function harvest(data) {
    const found = findEvents(data, []);
    found.forEach(mergeEvent);
    return new Set(found.map((f) => f.id)).size;
  }

  function saveDetail(ev) {
    mergeEvent(ev);
    const statusMap = new Map((ev.rsvpStatuses || []).map((s) => [s.userId, s.rsvpStatus]));
    const members = (ev.members?.edges || []).map((e) => e.node).filter(Boolean);
    const attendees = members.map((m) => ({
      id: m.id,
      name: m.displayName,
      status: statusMap.get(m.id) || 'UNKNOWN',
    }));
    const seen = new Set(attendees.map((a) => a.id));
    for (const [id, status] of statusMap) {
      if (!seen.has(id)) attendees.push({ id, name: '(unknown)', status });
    }
    const totalGoing = ev.members?.totalCount ?? attendees.length;
    state.details[ev.id] = {
      attendees,
      totalGoing,
      host: ev.creator?.displayName,
      partial: members.length < totalGoing,
      fetchedAt: Date.now(),
    };
  }

  function recordOp(request, data) {
    const name = request?.operationName || '(anonymous)';
    const prev = state.ops[name];
    state.ops[name] = {
      operationName: name,
      query: request?.query,
      variables: request?.variables,
      extensions: request?.extensions,
      topLevelFields: Object.keys(data || {}),
      count: (prev?.count || 0) + 1,
      lastSeen: Date.now(),
    };
    if (!prev) {
      const keys = Object.keys(state.ops);
      if (keys.length > MAX_OPS) {
        keys.sort((a, b) => state.ops[a].lastSeen - state.ops[b].lastSeen)
          .slice(0, keys.length - MAX_OPS).forEach((k) => delete state.ops[k]);
      }
      persist();
    }
  }

  // Since this page load - shown on the Sources tab to tell "not capturing" from "nothing to capture"
  const capture = { responses: 0, withEvents: 0, lastAt: 0, lastOp: '' };

  function onCaptured(request, data) {
    if (!data) return;
    capture.responses++;
    capture.lastAt = Date.now();
    capture.lastOp = request?.operationName || '(anonymous)';
    recordOp(request, data);
    // The page's own GetEvent (you opened a meetup) already has the attendee list
    if (data.event && data.event.members && data.event.rsvpStatuses) saveDetail(data.event);

    const before = Object.keys(state.events).length;
    const count = harvest(data);
    if (!count) return refresh();
    capture.withEvents++;
    const added = Object.keys(state.events).length - before;
    if (added) addLog('info', `Captured ${added} new event(s) from page request ${request?.operationName || '(anonymous)'}`, { variables: request?.variables });

    if (request && request.operationName !== 'GetEvent' && (request.query || request.extensions)) {
      const key = `${request.operationName || 'anon'}|${JSON.stringify(request.variables || {})}`;
      state.sources[key] = {
        operationName: request.operationName,
        query: request.query,
        variables: request.variables,
        extensions: request.extensions,
        lastSeen: Date.now(),
        lastCount: count,
      };
      const keys = Object.keys(state.sources);
      if (keys.length > MAX_SOURCES) {
        keys.sort((a, b) => state.sources[a].lastSeen - state.sources[b].lastSeen)
          .slice(0, keys.length - MAX_SOURCES)
          .forEach((k) => delete state.sources[k]);
      }
    }
    persist();
    refresh();
  }

  // ---------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------
  function setStatus(msg) {
    state.status = msg;
    const el = root && root.getElementById('status');
    if (el) el.textContent = msg;
  }

  async function refreshSources(keys = Object.keys(state.sources)) {
    if (state.busy) return;
    if (!keys.length) {
      setStatus('No captured sources yet - browse a club page or your meetups list first.');
      return;
    }
    state.busy = true;
    const before = Object.keys(state.events).length;
    let failed = 0;
    for (let i = 0; i < keys.length; i++) {
      const src = state.sources[keys[i]];
      setStatus(`Refreshing source ${i + 1}/${keys.length}...`);
      try {
        const json = await gql({
          operationName: src.operationName,
          query: src.query,
          variables: src.variables,
          extensions: src.extensions,
        }, `Source ${src.operationName || '(anonymous)'}`);
        if (json.errors && !json.data) throw new Error(json.errors[0]?.message);
        src.lastCount = harvest(json.data);
        src.lastRun = Date.now();
        delete src.lastError;
      } catch (err) {
        failed++;
        src.lastError = String(err.message || err);
      }
    }
    state.busy = false;
    const added = Object.keys(state.events).length - before;
    setStatus(`Refreshed ${keys.length} source(s): ${added} new event(s)${failed ? `, ${failed} failed - see Logs tab` : ''}.`);
    persist();
    renderTab();
  }

  async function fetchSelected(force) {
    if (state.busy) return;
    const ids = [...state.selected].filter((id) => force || !state.details[id]);
    if (!ids.length) {
      setStatus('Everything selected is already loaded. Use "Re-fetch all" to update.');
      return;
    }
    state.busy = true;
    const queue = [...ids];
    const failed = [];
    let done = 0;
    setStatus(`Fetching 0/${ids.length}...`);

    async function worker() {
      while (queue.length) {
        const id = queue.shift();
        const label = `GetEvent "${state.events[id]?.name || id}"`;
        try {
          const json = await gql({ operationName: 'GetEvent', query: GET_EVENT_QUERY, variables: { eventId: id } }, label);
          if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
          if (!json.data || !json.data.event) {
            addLog('error', `${label}: API returned no event`, { eventId: id, hint: 'Wrong ID, deleted meetup, or no access with this account.' });
            throw new Error('Event not found');
          }
          saveDetail(json.data.event);
          if (state.details[id].partial) await completeMembers(id);
          delete state.errors[id];
        } catch (err) {
          state.errors[id] = String(err.message || err);
          failed.push(id);
        }
        done++;
        setStatus(`Fetching ${done}/${ids.length}...`);
        refresh();
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    state.busy = false;
    persist();
    setStatus(failed.length
      ? `Loaded ${ids.length - failed.length}/${ids.length}. ${failed.length} failed - see Logs tab.`
      : `Loaded ${ids.length} event(s). See the Results tab.`);
    refresh();
  }

  // ---------------------------------------------------------------
  // Member pagination. GetEvent returns at most 50 members; rsvpStatuses
  // has everyone, so counts are right but names are missing. We don't know
  // the paging args, so try common ones and remember what works.
  // ---------------------------------------------------------------
  const MEMBER_FIELDS = 'totalCount edges { cursor node { id displayName } } pageInfo { hasNextPage endCursor }';
  const MEMBER_FIELDS_NO_PAGEINFO = 'totalCount edges { node { id displayName } }';
  const MEMBER_STRATEGIES = [
    { name: 'cursor first/after', paged: true, args: 'first: 50, after: $after' },
    { name: 'cursor after', paged: true, args: 'after: $after' },
    { name: 'first: 1000', args: 'first: 1000' },
    { name: 'limit: 1000', args: 'limit: 1000' },
    { name: 'pageSize: 1000', args: 'pageSize: 1000' },
    { name: 'offset', offset: true, args: 'offset: $offset' },
    { name: 'skip', offset: true, args: 'skip: $offset' },
  ];

  function memberQuery(st) {
    const vars = st.paged ? ', $after: String' : st.offset ? ', $offset: Int' : '';
    return `query CfMembers($id: ID!${vars}) { event(id: $id) { members(${st.args}) { ${st.paged ? MEMBER_FIELDS : MEMBER_FIELDS_NO_PAGEINFO} } } }`;
  }

  // Returns Map(id -> displayName) or null if the strategy doesn't work.
  async function runMemberStrategy(st, eventId, known) {
    const names = new Map();
    let after = null;
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const variables = { id: eventId };
      if (st.paged) variables.after = after;
      if (st.offset) variables.offset = offset;
      const json = await gql({ operationName: 'CfMembers', query: memberQuery(st), variables }, `Probe members (${st.name}) page ${page + 1}`);
      if (json.errors && json.errors.length) {
        if (page === 0) return { ok: false, reason: json.errors[0].message };
        break;
      }
      const conn = json.data?.event?.members;
      const nodes = (conn?.edges || []).map((e) => e.node).filter(Boolean);
      const before = names.size;
      nodes.forEach((n) => names.set(n.id, n.displayName));
      const gotNew = names.size > before;
      if (!st.paged && !st.offset) break;
      if (!gotNew) break;
      if (st.paged) {
        const info = conn.pageInfo;
        after = info?.endCursor || conn.edges[conn.edges.length - 1]?.cursor;
        if (!info?.hasNextPage || !after) break;
      } else {
        offset = names.size;
      }
    }
    if (names.size <= known) return { ok: false, reason: `returned ${names.size} names, no more than the first page` };
    return { ok: true, names };
  }

  let membersUnsupported = false; // this page load only; retried after a refresh

  async function completeMembers(eventId) {
    const d = state.details[eventId];
    if (!d || membersUnsupported) return;
    const known = d.attendees.filter((a) => a.name !== '(unknown)').length;
    const order = state.memberStrategy
      ? [MEMBER_STRATEGIES.find((x) => x.name === state.memberStrategy), ...MEMBER_STRATEGIES.filter((x) => x.name !== state.memberStrategy)].filter(Boolean)
      : MEMBER_STRATEGIES;
    const tried = [];
    for (const st of order) {
      let res;
      try {
        res = await runMemberStrategy(st, eventId, known);
      } catch (err) {
        res = { ok: false, reason: String(err.message || err) };
      }
      if (!res.ok) {
        tried.push(`${st.name}: ${res.reason}`);
        continue;
      }
      for (const [id, name] of res.names) {
        const a = d.attendees.find((x) => x.id === id);
        if (a) a.name = name;
        else d.attendees.push({ id, name, status: 'UNKNOWN' });
      }
      const named = d.attendees.filter((a) => a.name !== '(unknown)').length;
      d.partial = named < d.totalGoing;
      if (state.memberStrategy !== st.name) {
        state.memberStrategy = st.name;
        addLog('ok', `Member paging works with "${st.name}" - names for ${named}/${d.totalGoing} attendees`, { eventId, tried });
      }
      return;
    }
    state.memberStrategy = null;
    membersUnsupported = true;
    addLog('info', `"${state.events[eventId]?.name || eventId}": names available for ${known} of ${d.totalGoing} attendees (Campfire sends 50 names). Check-in and RSVP counts are complete.`, { eventId, tried });
  }

  function addFromText(text) {
    const ids = [...new Set((text.match(UUID_RE) || []).map((s) => s.toLowerCase()))];
    ids.forEach((id) => {
      if (!state.events[id]) state.events[id] = { id, name: '(not loaded yet)' };
      state.selected.add(id);
    });
    persist();
    setStatus(ids.length ? `Added ${ids.length} meetup(s) and selected them. Click "Fetch attendance".` : 'No meetup IDs found in that text.');
    return ids.length;
  }

  // ---------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------
  const byTimeDesc = (a, b) => (b.eventTime || '').localeCompare(a.eventTime || '');

  function filteredEvents() {
    const { q, club, from, to, loadedOnly } = state.filter;
    const fromT = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
    const toT = to ? new Date(`${to}T23:59:59`).getTime() : Infinity;
    const needle = q.trim().toLowerCase();
    return Object.values(state.events).filter((ev) => {
      if (club && ev.club !== club) return false;
      if (loadedOnly && !state.details[ev.id]) return false;
      if (needle && !`${ev.name} ${ev.address || ''} ${ev.club || ''}`.toLowerCase().includes(needle)) return false;
      if (ev.eventTime) {
        const t = new Date(ev.eventTime).getTime();
        if (t < fromT || t > toT) return false;
      } else if (from || to) {
        return false;
      }
      return true;
    }).sort(byTimeDesc);
  }

  function selectedLoaded() {
    return [...state.selected]
      .filter((id) => state.details[id])
      .map((id) => ({ ...state.events[id], id, detail: state.details[id] }))
      .sort((a, b) => (a.eventTime || '').localeCompare(b.eventTime || ''));
  }

  function summarize(ev) {
    const a = ev.detail.attendees;
    return {
      checkedIn: a.filter((x) => x.status === 'CHECKED_IN').length,
      rsvpOnly: a.filter((x) => x.status === 'ACCEPTED').length,
      going: ev.detail.totalGoing,
    };
  }

  function aggregateAttendees(evs) {
    const people = new Map();
    for (const ev of evs) {
      for (const a of ev.detail.attendees) {
        let p = people.get(a.id);
        if (!p) {
          p = { id: a.id, name: a.name, checkedIn: 0, rsvpOnly: 0, per: {} };
          people.set(a.id, p);
        }
        if (a.name && a.name !== '(unknown)') p.name = a.name;
        p.per[ev.id] = a.status;
        if (a.status === 'CHECKED_IN') p.checkedIn++;
        else if (a.status === 'ACCEPTED') p.rsvpOnly++;
      }
    }
    return [...people.values()].sort((x, y) => y.checkedIn - x.checkedIn || y.rsvpOnly - x.rsvpOnly
      || (x.name || '').localeCompare(y.name || ''));
  }

  // ---------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------
  const csvCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const toTsv = (rows) => rows.map((r) => r.map((v) => String(v ?? '').replace(/[\t\n\r]/g, ' ')).join('\t')).join('\n');
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  const STATUS_MARK = { CHECKED_IN: 'Checked in', ACCEPTED: 'RSVP only' };

  function summaryRows(evs) {
    return [
      ['Event', 'Date', 'Group', 'Host', 'Address', 'Going', 'Checked In', 'RSVP Only', 'URL'],
      ...evs.map((ev) => {
        const s = summarize(ev);
        return [ev.name, fmtDate(ev.eventTime), ev.club, ev.detail.host, ev.address, s.going, s.checkedIn, s.rsvpOnly, meetupUrl(ev.id)];
      }),
    ];
  }

  function attendanceRows(evs) {
    const rows = [['Event', 'Date', 'Group', 'Name', 'User ID', 'Status', 'Event ID', 'Start (UTC)']];
    for (const ev of evs) {
      for (const a of ev.detail.attendees) {
        rows.push([ev.name, fmtDate(ev.eventTime), ev.club, a.name, a.id, a.status, ev.id, ev.eventTime]);
      }
    }
    return rows;
  }

  function matrixRows(evs) {
    const people = aggregateAttendees(evs);
    return [
      ['Name', 'User ID', 'Times Checked In', 'Times RSVP Only', ...evs.map((ev) => `${fmtDay(ev.eventTime)} - ${ev.name}`)],
      ...people.map((p) => [p.name, p.id, p.checkedIn, p.rsvpOnly, ...evs.map((ev) => STATUS_MARK[p.per[ev.id]] || p.per[ev.id] || '')]),
    ];
  }

  function saveFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function download(name, rows) {
    // BOM so Excel reads names with emoji/accents correctly
    saveFile(`campfire-${name}-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + toCsv(rows), 'text/csv;charset=utf-8');
  }

  // Everything on the Results tab in one machine-friendly file.
  // Times are ISO 8601 UTC; unknown names are null; statuses are Campfire's raw values.
  function exportData(evs) {
    const nameOrNull = (n) => (n && n !== '(unknown)' ? n : null);
    const events = evs.map((ev) => {
      const s = summarize(ev);
      return {
        id: ev.id,
        url: meetupUrl(ev.id),
        name: ev.name,
        group: { id: ev.clubId || null, name: ev.club || null },
        host: ev.detail.host || null,
        address: ev.address || null,
        startTime: ev.eventTime || null,
        endTime: ev.eventEndTime || null,
        counts: { going: s.going, checkedIn: s.checkedIn, rsvpOnly: s.rsvpOnly },
        fetchedAt: new Date(ev.detail.fetchedAt).toISOString(),
        attendees: ev.detail.attendees.map((a) => ({ userId: a.id, name: nameOrNull(a.name), status: a.status })),
      };
    });
    const people = aggregateAttendees(evs).map((p) => ({
      userId: p.id,
      name: nameOrNull(p.name),
      checkedInCount: p.checkedIn,
      rsvpOnlyCount: p.rsvpOnly,
      events: evs.filter((ev) => p.per[ev.id]).map((ev) => ({ eventId: ev.id, status: p.per[ev.id] })),
    }));
    return {
      schemaVersion: 1,
      source: 'campfire-meetup-tracker',
      exportedAt: new Date().toISOString(),
      statusValues: { CHECKED_IN: 'checked in at the event', ACCEPTED: 'RSVP going, did not check in', DECLINED: 'RSVP declined' },
      totals: {
        events: events.length,
        checkIns: events.reduce((n, e) => n + e.counts.checkedIn, 0),
        rsvpOnly: events.reduce((n, e) => n + e.counts.rsvpOnly, 0),
        uniquePeopleCheckedIn: people.filter((p) => p.checkedInCount > 0).length,
        uniquePeople: people.length,
      },
      events,
      people,
    };
  }

  function downloadJson(evs) {
    saveFile(`campfire-export-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(exportData(evs), null, 2), 'application/json');
  }

  async function copyRows(rows, label) {
    try {
      await navigator.clipboard.writeText(toTsv(rows));
      setStatus(`Copied ${label} - paste straight into Sheets/Excel.`);
    } catch (err) {
      setStatus(`Copy failed: ${err.message || err}`);
    }
  }

  // ---------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .fab {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
      width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
      background: #ff6d00; color: #fff; font-size: 24px; box-shadow: 0 4px 14px rgba(0,0,0,.35);
    }
    .fab .badge {
      position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px;
      border-radius: 10px; background: #222; color: #fff; font: 600 11px/20px system-ui, sans-serif;
    }
    .panel {
      position: fixed; top: 0; right: 0; z-index: 2147483647; width: min(820px, 100vw); height: 100vh;
      display: flex; flex-direction: column; background: #16181d; color: #e6e6e6;
      font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; box-shadow: -6px 0 24px rgba(0,0,0,.45);
    }
    .panel[hidden] { display: none; }
    header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #2a2e36; }
    header h1 { font-size: 16px; margin: 0; flex: 1; }
    .tabs { display: flex; gap: 4px; padding: 8px 16px 0; border-bottom: 1px solid #2a2e36; }
    .tab { background: none; border: none; color: #9aa0aa; padding: 8px 12px; cursor: pointer; font: inherit;
      border-bottom: 2px solid transparent; }
    .tab.active { color: #fff; border-bottom-color: #ff6d00; }
    .body { flex: 1; overflow: auto; padding: 12px 16px; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
    input, select, textarea {
      background: #0f1115; color: #e6e6e6; border: 1px solid #353a44; border-radius: 6px;
      padding: 6px 8px; font: inherit;
    }
    input[type=search] { flex: 1; min-width: 180px; }
    textarea { width: 100%; min-height: 70px; resize: vertical; }
    button.btn {
      background: #2a2e36; color: #e6e6e6; border: 1px solid #3a3f4a; border-radius: 6px;
      padding: 6px 12px; cursor: pointer; font: inherit; white-space: nowrap;
    }
    button.btn:hover { background: #343944; }
    button.btn.primary { background: #ff6d00; border-color: #ff6d00; color: #fff; }
    button.btn.primary:hover { background: #ff8124; }
    button.btn.danger { color: #ff8a80; }
    button.btn:disabled { opacity: .5; cursor: default; }
    button.icon { background: none; border: none; color: #9aa0aa; font-size: 20px; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #252931; vertical-align: top; }
    th { position: sticky; top: 0; background: #1d2027; color: #9aa0aa; font-weight: 600; font-size: 12px; z-index: 1; }
    tr.sel td { background: rgba(255,109,0,.08); }
    td.num, th.num { text-align: right; white-space: nowrap; }
    td.nowrap { white-space: nowrap; }
    a { color: #ffab66; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .muted { color: #8a909a; }
    .pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; background: #23402a; color: #8fe39f; }
    .pill.warn { background: #4a3a18; color: #ffd27a; }
    .empty { padding: 28px 12px; text-align: center; color: #8a909a; }
    .empty b { color: #e6e6e6; }
    footer { display: flex; gap: 8px; align-items: center; padding: 10px 16px; border-top: 1px solid #2a2e36; flex-wrap: wrap; }
    #status { flex: 1; color: #9aa0aa; min-width: 200px; }
    h2 { font-size: 13px; margin: 16px 0 8px; color: #c8ccd3; }
    .scroll-x { overflow-x: auto; }
    .ck { color: #8fe39f; } .rs { color: #ffd27a; }
    label.inline { display: inline-flex; gap: 6px; align-items: center; color: #9aa0aa; }
    .panel.full { width: 100vw; box-shadow: none; }
    .panel.full .body, .panel.full .tabs, .panel.full header, .panel.full footer { padding-left: max(16px, calc((100vw - 1400px) / 2)); padding-right: max(16px, calc((100vw - 1400px) / 2)); }
    .tab .dot { display: inline-block; min-width: 16px; padding: 0 4px; margin-left: 4px; border-radius: 8px; background: #c62828; color: #fff; font-size: 10px; line-height: 16px; }
    .pill.err { background: #4a1f1f; color: #ff8a80; }
    .log { border-bottom: 1px solid #252931; padding: 6px 0; }
    .log summary { cursor: pointer; list-style: none; display: flex; gap: 8px; align-items: baseline; }
    .log summary::-webkit-details-marker { display: none; }
    .log .time { color: #6f7580; font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .log .lvl { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; }
    .lvl.error { background: #4a1f1f; color: #ff8a80; } .lvl.warn { background: #4a3a18; color: #ffd27a; }
    .lvl.ok { background: #23402a; color: #8fe39f; } .lvl.info { background: #1f3247; color: #8cc4ff; }
    .log pre { margin: 6px 0 0; padding: 8px; background: #0f1115; border-radius: 6px; overflow: auto; max-height: 360px;
      font: 11px/1.45 ui-monospace, Consolas, monospace; color: #c8ccd3; white-space: pre-wrap; word-break: break-word; }
  `;

  let root = null;

  function mount() {
    const host = document.createElement('div');
    host.id = 'cf-tracker-host';
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <button class="fab" data-action="toggle" title="Campfire Meetup Tracker">🔥<span class="badge" id="fab-badge"></span></button>
      <div class="panel" hidden>
        <header>
          <h1>🔥 Campfire Meetup Tracker</h1>
          <button class="btn" data-action="new-tab" title="Open the tracker full-screen in its own tab">↗ New tab</button>
          <button class="btn" data-action="full" id="full-btn" title="Toggle full-screen">⛶ Full screen</button>
          <button class="icon" data-action="toggle" title="Close">×</button>
        </header>
        <div class="tabs">
          <button class="tab" data-tab="events">Events</button>
          <button class="tab" data-tab="results">Results</button>
          <button class="tab" data-tab="sources">Sources</button>
          <button class="tab" data-tab="logs">Logs<span class="dot" id="err-dot"></span></button>
        </div>
        <div class="body" id="body"></div>
        <footer>
          <span id="status"></span>
          <span id="sel-count" class="muted"></span>
          <button class="btn primary" data-action="fetch">Fetch attendance</button>
        </footer>
      </div>`;

    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);
    renderTab();
  }

  function togglePanel(force) {
    state.open = force ?? !state.open;
    root.querySelector('.panel').hidden = !state.open;
    root.querySelector('.fab').style.display = state.open ? 'none' : '';
    applyFull();
    if (state.open) renderTab();
  }

  function applyFull() {
    root.querySelector('.panel').classList.toggle('full', !!state.full);
    root.getElementById('full-btn').textContent = state.full ? '⇥ Side panel' : '⛶ Full screen';
  }

  function updateCounts() {
    const total = Object.keys(state.events).length;
    const badge = root.getElementById('fab-badge');
    badge.textContent = total || '';
    badge.style.display = total ? '' : 'none';
    const loaded = [...state.selected].filter((id) => state.details[id]).length;
    root.getElementById('sel-count').textContent = `${state.selected.size} selected · ${loaded} loaded`;
    root.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
    root.getElementById('status').textContent = state.status;
    const unseen = state.logs.filter((l) => l.level === 'error' && l.t > (state.logsSeenAt || 0)).length;
    const dot = root.getElementById('err-dot');
    dot.textContent = unseen || '';
    dot.style.display = unseen && state.tab !== 'logs' ? '' : 'none';
  }

  // Cheap re-render after data changes; keeps focus in the Events filters.
  function refresh() {
    if (!root) return;
    if (!state.open) return updateCounts();
    if (state.tab === 'events' && root.getElementById('list')) {
      renderList();
      updateCounts();
    } else {
      renderTab();
    }
  }

  function renderTab() {
    if (!root) return;
    const body = root.getElementById('body');
    if (state.tab === 'events') body.innerHTML = eventsTabHtml();
    else if (state.tab === 'results') body.innerHTML = resultsTabHtml();
    else if (state.tab === 'logs') {
      state.logsSeenAt = Date.now();
      persist();
      body.innerHTML = logsTabHtml();
    } else body.innerHTML = sourcesTabHtml();
    if (state.tab === 'events') renderList();
    updateCounts();
  }

  function eventsTabHtml() {
    const f = state.filter;
    const clubs = [...new Set(Object.values(state.events).map((e) => e.club).filter(Boolean))].sort();
    return `
      <div class="row">
        <button class="btn" data-action="refresh-sources" title="Re-run the event list queries captured while browsing">↻ Refresh events</button>
        <button class="btn" data-action="toggle-add">+ Add by URL</button>
        <span class="muted">${Object.keys(state.sources).length} saved source(s)</span>
      </div>
      <div class="row" id="add-box" hidden>
        <textarea id="add-text" placeholder="Paste one or more meetup URLs or IDs (any separator)"></textarea>
        <button class="btn primary" data-action="add">Add &amp; select</button>
      </div>
      <div class="row">
        <input type="search" data-filter="q" placeholder="Search name, address, group..." value="${esc(f.q)}">
        <select data-filter="club">
          <option value="">All groups</option>
          ${clubs.map((c) => `<option ${c === f.club ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <label class="inline">From <input type="date" data-filter="from" value="${esc(f.from)}"></label>
        <label class="inline">To <input type="date" data-filter="to" value="${esc(f.to)}"></label>
        <label class="inline"><input type="checkbox" data-filter="loadedOnly" ${f.loadedOnly ? 'checked' : ''}> Loaded only</label>
        <span style="flex:1"></span>
        <button class="btn" data-action="select-visible">Select shown</button>
        <button class="btn" data-action="select-none">Clear selection</button>
      </div>
      <div id="list"></div>`;
  }

  function renderList() {
    const list = root.getElementById('list');
    if (!list) return;
    const evs = filteredEvents();
    if (!Object.keys(state.events).length) {
      list.innerHTML = `<div class="empty">
        <p><b>No events yet.</b></p>
        <p>Leave this panel open and browse Campfire: open your <b>club / group pages</b>, your meetups list,
        or any meetup. Every event Campfire loads shows up here automatically.</p>
        <p>The list queries get saved as "sources", so next time a single <b>↻ Refresh events</b> reloads them.</p>
        <p>You can also paste meetup links with <b>+ Add by URL</b>.</p></div>`;
      return;
    }
    if (!evs.length) {
      list.innerHTML = '<div class="empty">No events match these filters.</div>';
      return;
    }
    const allSel = evs.every((e) => state.selected.has(e.id));
    list.innerHTML = `<table>
      <thead><tr>
        <th><input type="checkbox" data-action="select-all-shown" ${allSel ? 'checked' : ''}></th>
        <th>Date</th><th>Event</th><th>Group</th><th class="num">Checked in</th><th></th>
      </tr></thead>
      <tbody>${evs.map((ev) => {
        const d = state.details[ev.id];
        const sel = state.selected.has(ev.id);
        const ck = d ? summarize({ detail: d }).checkedIn : ev.checkedIn;
        return `<tr class="${sel ? 'sel' : ''}">
          <td><input type="checkbox" data-select="${esc(ev.id)}" ${sel ? 'checked' : ''}></td>
          <td class="nowrap">${esc(fmtDate(ev.eventTime)) || '<span class="muted">?</span>'}</td>
          <td><a href="${meetupUrl(ev.id)}" target="_blank" rel="noopener">${esc(ev.name)}</a>
            ${ev.address ? `<div class="muted">${esc(ev.address)}</div>` : ''}</td>
          <td>${esc(ev.club || '')}</td>
          <td class="num">${ck ?? ''}${d ? `<span class="muted"> / ${d.totalGoing}</span>` : ''}</td>
          <td class="nowrap">${d ? `<span class="pill" title="Fetched ${esc(new Date(d.fetchedAt).toLocaleString())}">loaded</span>` : ''}
            ${state.errors[ev.id] ? `<span class="pill err" data-tab="logs" style="cursor:pointer" title="${esc(state.errors[ev.id])} - click for logs">failed</span>` : ''}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  }

  function resultsTabHtml() {
    const evs = selectedLoaded();
    if (!evs.length) {
      return `<div class="empty"><p><b>Nothing to show yet.</b></p>
        <p>Select events on the Events tab and click <b>Fetch attendance</b>.</p></div>`;
    }
    const missing = state.selected.size - evs.length;
    const people = aggregateAttendees(evs);
    const tot = evs.reduce((acc, ev) => {
      const s = summarize(ev);
      acc.going += s.going; acc.checkedIn += s.checkedIn; acc.rsvpOnly += s.rsvpOnly;
      return acc;
    }, { going: 0, checkedIn: 0, rsvpOnly: 0 });
    const uniqueCk = people.filter((p) => p.checkedIn > 0).length;

    return `
      ${missing ? `<p class="pill warn">${missing} selected event(s) not loaded yet - click Fetch attendance.</p>` : ''}
      <div class="row">
        <button class="btn" data-action="export-summary">⬇ Summary CSV</button>
        <button class="btn" data-action="export-attendance">⬇ Attendance CSV</button>
        <button class="btn" data-action="export-matrix">⬇ Attendee matrix CSV</button>
        <button class="btn primary" data-action="export-json" title="Events, counts, attendees and per-person totals in one file">⬇ All data (JSON)</button>
        <button class="btn" data-action="copy-summary">Copy summary</button>
        <button class="btn" data-action="copy-matrix">Copy matrix</button>
        <button class="btn" data-action="refetch">Re-fetch all</button>
      </div>
      <p class="muted">${evs.length} event(s) · ${tot.checkedIn} check-ins · ${tot.rsvpOnly} RSVP-only ·
        ${uniqueCk} unique people checked in · ${people.length} unique people total</p>

      <h2>Events</h2>
      <div class="scroll-x"><table>
        <thead><tr><th>Date</th><th>Event</th><th>Host</th><th class="num">Going</th><th class="num">Checked in</th><th class="num">RSVP only</th></tr></thead>
        <tbody>${evs.map((ev) => {
          const s = summarize(ev);
          return `<tr>
            <td class="nowrap">${esc(fmtDate(ev.eventTime))}</td>
            <td><a href="${meetupUrl(ev.id)}" target="_blank" rel="noopener">${esc(ev.name)}</a></td>
            <td>${esc(ev.detail.host || '')}</td>
            <td class="num">${s.going}</td><td class="num ck">${s.checkedIn}</td><td class="num rs">${s.rsvpOnly}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>

      <h2>Attendees</h2>
      <div class="scroll-x"><table>
        <thead><tr><th>Name</th><th class="num">Checked in</th><th class="num">RSVP only</th>
          ${evs.length <= 12 ? evs.map((ev) => `<th title="${esc(ev.name)}">${esc(fmtDay(ev.eventTime))}</th>`).join('') : ''}</tr></thead>
        <tbody>${people.map((p) => `<tr>
          <td>${esc(p.name)}</td>
          <td class="num ck">${p.checkedIn}</td><td class="num rs">${p.rsvpOnly}</td>
          ${evs.length <= 12 ? evs.map((ev) => {
            const st = p.per[ev.id];
            return `<td>${st === 'CHECKED_IN' ? '<span class="ck">✓</span>' : st === 'ACCEPTED' ? '<span class="rs">RSVP</span>' : st ? esc(st) : ''}</td>`;
          }).join('') : ''}
        </tr>`).join('')}</tbody>
      </table></div>
      ${evs.length > 12 ? '<p class="muted">Per-event columns are hidden for more than 12 events - they are in the matrix CSV.</p>' : ''}`;
  }

  function sourcesTabHtml() {
    const keys = Object.keys(state.sources).sort((a, b) => state.sources[b].lastSeen - state.sources[a].lastSeen);
    return `
      <p class="pill ${capture.responses ? '' : 'warn'}">This page load: ${capture.responses} Campfire API response(s) captured,
        ${capture.withEvents} contained events${capture.responses ? ` · last: ${esc(capture.lastOp)} at ${esc(new Date(capture.lastAt).toLocaleTimeString())}` : ' - if Campfire is loaded, refresh this tab'}</p>
      <p class="muted">Sources are the GraphQL list queries Campfire ran while you browsed, the ones that returned events.
        "Refresh events" re-runs all of them. Browse more pages to add more.</p>
      ${keys.length ? `<table>
        <thead><tr><th>Operation</th><th>Variables</th><th class="num">Events</th><th>Last seen</th><th></th></tr></thead>
        <tbody>${keys.map((k) => {
          const s = state.sources[k];
          return `<tr>
            <td>${esc(s.operationName || '(anonymous)')}${s.lastError ? `<div class="pill warn" title="${esc(s.lastError)}">last run failed</div>` : ''}</td>
            <td><code class="muted">${esc(JSON.stringify(s.variables || {})).slice(0, 160)}</code></td>
            <td class="num">${s.lastCount ?? ''}</td>
            <td class="nowrap">${esc(new Date(s.lastRun || s.lastSeen).toLocaleString())}</td>
            <td class="nowrap">
              <button class="btn" data-run-source="${esc(k)}">Run</button>
              <button class="btn danger" data-del-source="${esc(k)}">✕</button>
            </td></tr>`;
        }).join('')}</tbody></table>` : '<div class="empty">No sources captured yet.</div>'}
      <h2>All operations seen (${Object.keys(state.ops).length})</h2>
      <p class="muted">Every GraphQL call Campfire made while you browsed. Use the group search and the group page,
        then click <b>Copy all operations</b> and send the result to get group search built in.</p>
      <div class="row"><button class="btn" data-action="copy-ops">Copy all operations</button></div>
      ${Object.keys(state.ops).length ? `<table>
        <thead><tr><th>Operation</th><th>Returns</th><th>Variables</th><th class="num">Seen</th><th></th></tr></thead>
        <tbody>${Object.values(state.ops).sort((a, b) => b.lastSeen - a.lastSeen).map((o) => `<tr>
          <td>${esc(o.operationName)}</td>
          <td class="muted">${esc((o.topLevelFields || []).join(', '))}</td>
          <td><code class="muted">${esc(JSON.stringify(o.variables || {}).slice(0, 120))}</code></td>
          <td class="num">${o.count}</td>
          <td><button class="btn" data-copy-op="${esc(o.operationName)}">Copy</button></td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">None yet - browse Campfire with the extension loaded.</div>'}
      <h2>Data</h2>
      <div class="row">
        <span class="muted">${Object.keys(state.events).length} events, ${Object.keys(state.details).length} with attendance stored in this browser.</span>
      </div>
      <div class="row">
        <button class="btn danger" data-action="clear-details">Clear attendance cache</button>
        <button class="btn danger" data-action="clear-all">Clear everything</button>
      </div>`;
  }

  function logsTabHtml() {
    const logs = [...state.logs].reverse();
    return `
      <div class="row">
        <button class="btn primary" data-action="test-connection" title="Runs a tiny 'who am I' query">Test connection</button>
        <button class="btn" data-action="diagnose">Show API settings</button>
        <button class="btn" data-action="discover" title="Ask the API to describe itself (GraphQL introspection)">Discover API</button>
        <button class="btn" data-action="copy-schema">Copy schema summary</button>
      </div>
      <div class="row">
        <input type="search" id="probe-input" placeholder="Group join link or group ID (optional: a meetup link too)" style="flex:1">
        <button class="btn primary" data-action="probe">Probe group API</button>
        <button class="btn" data-action="copy-probe">Copy probe results</button>
        <button class="btn" data-action="copy-logs">Copy logs</button>
        <button class="btn danger" data-action="clear-logs">Clear logs</button>
        <span class="muted">${state.logs.length} entries · click an entry for details</span>
      </div>
      ${logs.length ? logs.map((l, i) => `
        <details class="log" ${i === 0 && l.level === 'error' ? 'open' : ''}>
          <summary>
            <span class="time">${esc(new Date(l.t).toLocaleTimeString())}</span>
            <span class="lvl ${esc(l.level)}">${esc(l.level)}</span>
            <span>${esc(l.msg)}</span>
          </summary>
          ${l.data !== undefined ? `<pre>${esc(JSON.stringify(l.data, null, 2))}</pre>` : ''}
        </details>`).join('') : '<div class="empty">No log entries yet.</div>'}`;
  }

  async function testConnection() {
    setStatus('Testing connection...');
    try {
      const json = await gql({ operationName: 'CfTrackerMe', query: 'query CfTrackerMe { me { id displayName } }', variables: {} }, 'Test connection');
      const me = json.data && json.data.me;
      setStatus(me ? `Connected as ${me.displayName}.` : 'Connected, but not logged in (me is empty).');
      if (!me) addLog('warn', 'API answered but returned no user - are you logged in to Campfire?', json);
    } catch (err) {
      setStatus(`Connection failed: ${err.message || err} - see Logs.`);
    }
  }

  // ---------------------------------------------------------------
  // API discovery (GraphQL introspection). Used to find the queries for
  // group search / group events; may be disabled on the server.
  // ---------------------------------------------------------------
  const INTROSPECT_QUERY = `query CfTrackerIntrospect {
    __schema {
      queryType { name }
      types {
        name kind
        fields(includeDeprecated: true) {
          name
          args { name type { ...T } }
          type { ...T }
        }
        inputFields { name type { ...T } }
        enumValues { name }
      }
    }
  }
  fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }`;

  const typeStr = (t) => (!t ? '?' : t.kind === 'NON_NULL' ? `${typeStr(t.ofType)}!` : t.kind === 'LIST' ? `[${typeStr(t.ofType)}]` : t.name);
  const INTERESTING = /club|event|group|meetup|search|member|rsvp|connection|edge|page|filter|time|date/i;

  async function discoverSchema() {
    setStatus('Asking the API to describe itself...');
    let json;
    try {
      json = await gql({ operationName: 'CfTrackerIntrospect', query: INTROSPECT_QUERY, variables: {} }, 'Discover API');
    } catch (err) {
      return setStatus(`Discovery failed: ${err.message} - see Logs.`);
    }
    const schema = json.data && json.data.__schema;
    if (!schema) {
      addLog('warn', 'Introspection is disabled on this API. Use the Sources tab "All operations seen" instead.', json.errors);
      return setStatus('Introspection is disabled - browse group search/pages, then use "Copy all operations" on the Sources tab.');
    }
    const types = schema.types.filter((t) => !t.name.startsWith('__'));
    const queryName = schema.queryType.name;
    const lines = [];
    const describe = (t) => {
      lines.push(`${t.kind === 'INPUT_OBJECT' ? 'input' : t.kind === 'ENUM' ? 'enum' : 'type'} ${t.name} {`);
      (t.fields || []).forEach((f) => lines.push(
        `  ${f.name}${f.args.length ? `(${f.args.map((a) => `${a.name}: ${typeStr(a.type)}`).join(', ')})` : ''}: ${typeStr(f.type)}`));
      (t.inputFields || []).forEach((f) => lines.push(`  ${f.name}: ${typeStr(f.type)}`));
      (t.enumValues || []).forEach((v) => lines.push(`  ${v.name}`));
      lines.push('}');
    };
    types.filter((t) => t.name === queryName).forEach(describe);
    types.filter((t) => t.name !== queryName && INTERESTING.test(t.name)).forEach(describe);
    state.schema = lines.join('\n');
    addLog('ok', `Discovered API: ${types.length} types (${lines.length} lines kept). Click "Copy schema summary".`, { summary: state.schema });
    setStatus('API described - click "Copy schema summary" and send it over.');
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`Copied ${label} to clipboard.`);
    } catch (err) {
      setStatus(`Copy failed: ${err.message || err}`);
    }
  }

  // ---------------------------------------------------------------
  // API probe. Without introspection, GraphQL validation errors still
  // name real fields ("Cannot query field X on type Club. Did you mean Y?").
  // Each probe is its own request, since one bad field fails the whole query.
  // ---------------------------------------------------------------
  const CLUB_EVENT_FIELDS = ['events', 'meetups', 'upcomingEvents', 'pastEvents', 'upcomingMeetups', 'pastMeetups',
    'clubEvents', 'eventsConnection', 'scheduledEvents', 'allEvents'];

  async function probeApi(text) {
    if (state.busy) return;
    const uuids = (text.match(UUID_RE) || []).map((x) => x.toLowerCase());
    const clubId = uuids[0];
    const eventId = uuids[1] || Object.keys(state.details).find((id) => state.details[id].partial) || Object.keys(state.events)[0];
    const probes = [];
    const add = (name, query, variables = {}) => probes.push({ name, query, variables });

    // Root-level and Me-level suggestions
    add('root suggestions: club', 'query P { clubz }');
    add('root suggestions: event', 'query P { eventz }');
    add('root suggestions: search', 'query P { searchz }');
    add('me suggestions: clubs', 'query P { me { clubz } }');
    add('me suggestions: meetups', 'query P { me { meetupz } }');
    add('me suggestions: rsvped', 'query P { me { pastRsvpedMeetupz } }');
    const knownClubs = [...new Map(Object.values(state.events).filter((e) => e.clubId).map((e) => [e.clubId, e.club])).entries()]
      .filter(([id]) => id !== clubId).slice(0, 3);
    for (const [id, name] of knownClubs) {
      add(`club basic (known: ${name})`, 'query P($id: ID!) { club(id: $id) { id name visibility amIMember } }', { id });
    }
    if (clubId) {
      add('club basic', 'query P($id: ID!) { club(id: $id) { id name visibility amIMember } }', { id: clubId });
      add('club suggestions: events', 'query P($id: ID!) { club(id: $id) { eventz } }', { id: clubId });
      add('club suggestions: meetups', 'query P($id: ID!) { club(id: $id) { meetupz } }', { id: clubId });
      add('club suggestions: members', 'query P($id: ID!) { club(id: $id) { memberz } }', { id: clubId });
      for (const f of CLUB_EVENT_FIELDS) {
        add(`club.${f}`, `query P($id: ID!) { club(id: $id) { ${f} { __typename } } }`, { id: clubId });
      }
      add('club.events(first) args', 'query P($id: ID!) { club(id: $id) { events(first: 5, bogusArg: 1) { __typename } } }', { id: clubId });
    } else if (text.trim()) {
      addLog('warn', 'No group ID found in that text - running root/me probes only. Paste a link that contains the group UUID.', { text });
    }
    if (eventId) {
      add('event.members(first: 200)', 'query P($id: ID!) { event(id: $id) { members(first: 200) { totalCount edges { node { id } } } } }', { id: eventId });
      add('event.members bad arg (arg suggestions)', 'query P($id: ID!) { event(id: $id) { members(bogusArg: 1) { totalCount } } }', { id: eventId });
      add('event.members pageInfo', 'query P($id: ID!) { event(id: $id) { members { pageInfo { __typename } } } }', { id: eventId });
    }

    state.busy = true;
    const results = [];
    for (let i = 0; i < probes.length; i++) {
      const pr = probes[i];
      setStatus(`Probing ${i + 1}/${probes.length}: ${pr.name}...`);
      try {
        const json = await gql({ operationName: 'P', query: pr.query, variables: pr.variables }, `Probe ${pr.name}`);
        results.push({
          probe: pr.name,
          query: pr.query,
          errors: (json.errors || []).map((er) => er.message),
          data: summarizeProbeData(json.data),
        });
      } catch (err) {
        results.push({ probe: pr.name, query: pr.query, requestFailed: String(err.message || err) });
      }
    }
    state.busy = false;
    state.probe = { clubId, eventId, ranAt: new Date().toISOString(), results };
    addLog('ok', `Probe finished: ${results.length} probes. Click "Copy probe results" and send them over.`, state.probe);
    setStatus('Probe done - click "Copy probe results".');
  }

  // Keep probe output small: counts instead of long lists.
  function summarizeProbeData(d) {
    return JSON.parse(JSON.stringify(d ?? null, (k, v) => {
      if (Array.isArray(v) && v.length > 3) return [`(${v.length} items)`, v[0]];
      return v;
    }));
  }

  function onInput(e) {
    const t = e.target;
    if (t.dataset.filter) {
      state.filter[t.dataset.filter] = t.type === 'checkbox' ? t.checked : t.value;
      renderList();
      return;
    }
    if (e.type === 'change' && t.dataset.select) {
      if (t.checked) state.selected.add(t.dataset.select);
      else state.selected.delete(t.dataset.select);
      t.closest('tr').classList.toggle('sel', t.checked);
      persist();
      updateCounts();
    }
  }

  function onClick(e) {
    const t = e.target.closest('[data-action],[data-tab],[data-run-source],[data-del-source],[data-copy-op]');
    if (!t) return;
    if (t.dataset.tab) {
      state.tab = t.dataset.tab;
      renderTab();
      return;
    }
    if (t.dataset.runSource) return refreshSources([t.dataset.runSource]);
    if (t.dataset.copyOp) return copyText(JSON.stringify(state.ops[t.dataset.copyOp], null, 2), t.dataset.copyOp);
    if (t.dataset.delSource) {
      delete state.sources[t.dataset.delSource];
      persist();
      return renderTab();
    }

    const evs = () => selectedLoaded();
    switch (t.dataset.action) {
      case 'toggle': return togglePanel();
      case 'full':
        state.full = !state.full;
        persist();
        return applyFull();
      case 'new-tab': return window.open('https://campfire.scopely.com/#cf-tracker', '_blank');
      case 'test-connection': return testConnection();
      case 'diagnose': return window.postMessage({ src: EXT, type: 'diagnose' }, '*');
      case 'copy-logs':
        return navigator.clipboard.writeText(JSON.stringify(state.logs, null, 2))
          .then(() => setStatus('Logs copied to clipboard.'), (err) => setStatus(`Copy failed: ${err.message}`));
      case 'discover': return discoverSchema();
      case 'probe': return probeApi(root.getElementById('probe-input').value);
      case 'copy-probe':
        return state.probe ? copyText(JSON.stringify(state.probe, null, 2), 'probe results') : setStatus('Run "Probe group API" first.');
      case 'copy-ops':
        return copyText(JSON.stringify(Object.values(state.ops), null, 2), 'all operations');
      case 'copy-schema':
        return state.schema ? copyText(state.schema, 'schema summary') : setStatus('Run "Discover API" first.');
      case 'clear-logs':
        state.logs = [];
        persist();
        return renderTab();
      case 'fetch': return fetchSelected(false);
      case 'refetch': return fetchSelected(true);
      case 'refresh-sources': return refreshSources();
      case 'toggle-add': {
        const box = root.getElementById('add-box');
        box.hidden = !box.hidden;
        if (!box.hidden) root.getElementById('add-text').focus();
        return;
      }
      case 'add': {
        const ta = root.getElementById('add-text');
        if (addFromText(ta.value)) {
          ta.value = '';
          root.getElementById('add-box').hidden = true;
          renderList();
          updateCounts();
        }
        return;
      }
      case 'select-all-shown':
      case 'select-visible': {
        const shown = filteredEvents();
        const on = t.dataset.action === 'select-visible' ? true : t.checked;
        shown.forEach((ev) => (on ? state.selected.add(ev.id) : state.selected.delete(ev.id)));
        persist();
        renderList();
        return updateCounts();
      }
      case 'select-none':
        state.selected.clear();
        persist();
        renderList();
        return updateCounts();
      case 'export-summary': return download('summary', summaryRows(evs()));
      case 'export-attendance': return download('attendance', attendanceRows(evs()));
      case 'export-matrix': return download('attendee-matrix', matrixRows(evs()));
      case 'export-json': return downloadJson(evs());
      case 'copy-summary': return copyRows(summaryRows(evs()), 'summary');
      case 'copy-matrix': return copyRows(matrixRows(evs()), 'attendee matrix');
      case 'clear-details':
        if (!confirm('Clear all fetched attendance data?')) return;
        state.details = {};
        persist();
        return renderTab();
      case 'clear-all':
        if (!confirm('Clear all events, sources and attendance data?')) return;
        state.events = {}; state.details = {}; state.sources = {}; state.selected.clear();
        persist();
        return renderTab();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'toggle') togglePanel();
  });

  // Captured traffic can arrive before storage loads; merge rather than overwrite.
  const early = { events: state.events, details: state.details, sources: state.sources };
  loadState().then(() => {
    for (const [id, ev] of Object.entries(early.events)) {
      const defined = Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== undefined));
      state.events[id] = { ...state.events[id], ...defined };
    }
    Object.assign(state.details, early.details);
    Object.assign(state.sources, early.sources);
    loaded = true;
    persist();
    mount();
    updateCounts();
    if (location.hash.includes('cf-tracker')) {
      state.full = true;
      togglePanel(true);
    }
  });
})();
