/*
 * Campfire check-in bookmarklet. The bookmark from Settings > Campfire Exports opens cfcheck.html, which
 * sends this file back to the Campfire tab to run (Campfire's page blocks scripts loaded from other sites).
 * Tapped on a campfire.scopely.com meetup page, it reads the meetup's attendance with the logged-in
 * Campfire session, shows who checked in, and can send the result to PoGo Code Dist.
 */
(async () => {
  // Every failure ends in a visible message, so tapping the bookmark never seems to do nothing.
  try {
    // cfcheck.html sets the site address before handing this script to the bookmark; meetups are sent there.
    const SITE = window.__pogoCfSite;
    const API = 'https://niantic-social-api.nianticlabs.com/graphql';
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const QUERY = `query GetEvent($eventId: ID!) { event(id: $eventId) { id name address eventTime eventEndTime checkedInMembersCount
      club { id name } creator { displayName username } members { totalCount edges { node { id displayName } } } rsvpStatuses { userId rsvpStatus } } }`;

    if (!/(^|\.)campfire\.scopely\.com$/.test(location.hostname)) {
      alert('Open a meetup on campfire.scopely.com first (logged in), then tap this bookmark again.');
      return;
    }

    document.getElementById('pogo-cf')?.remove();
    const host = document.createElement('div');
    host.id = 'pogo-cf';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    root.innerHTML = `<style>
      .bg{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;padding:12px;overflow:auto;font:15px/1.4 -apple-system,system-ui,sans-serif}
      .card{background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:14px;width:100%;max-width:520px;padding:16px;box-sizing:border-box}
      h2{margin:0 26px 4px 0;font-size:18px} .muted{color:#8b949e;font-size:13px} .x{float:right;background:none;border:0;color:#8b949e;font-size:26px;line-height:1;cursor:pointer}
      .stats{display:flex;gap:8px;margin:12px 0} .stat{flex:1;background:#0d1117;border-radius:10px;padding:8px;text-align:center} .stat b{display:block;font-size:22px}
      input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;font-size:15px;margin-bottom:8px}
      h3{font-size:14px;margin:12px 0 6px} .names{display:flex;flex-wrap:wrap;gap:6px} .names span{background:#21262d;border-radius:999px;padding:3px 10px;font-size:14px}
      .in h3{color:#3fb950} .rsvp h3{color:#d29922} .row{display:flex;gap:8px;margin-top:14px}
      button.b{flex:1;padding:11px;border-radius:8px;border:0;font-size:15px;font-weight:600;cursor:pointer;background:#30363d;color:#e6edf3} button.p{background:#f85149;color:#fff}
      button:disabled{opacity:.6} .err{color:#f85149;white-space:pre-wrap}
    </style><div class="bg"><div class="card"><button class="x" aria-label="Close">×</button><div id="body"><p class="muted">Loading meetup…</p></div></div></div>`;
    const $ = (s) => root.querySelector(s);
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    $('.x').onclick = () => host.remove();
    $('.bg').onclick = (e) => { if (e.target === $('.bg')) host.remove(); };

    let eventId = (location.href.match(/meetup\/([0-9a-f-]{36})/i) || [])[1];
    if (!eventId) {
      const typed = prompt('This page is not a meetup. Paste a Campfire meetup link or ID:');
      eventId = ((typed || '').match(UUID) || [])[0];
      if (!eventId) { host.remove(); return; }
    }
    eventId = eventId.toLowerCase();

    // Campfire may sign API calls with just the login cookie, or with a token the page keeps in storage.
    // Try the cookie first, then any token-looking values, and remember which way worked on this phone.
    const JWT = /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g;
    async function findTokens() {
      const found = new Set();
      for (const store of [localStorage, sessionStorage]) {
        try {
          for (let i = 0; i < store.length; i++) (String(store.getItem(store.key(i))).match(JWT) || []).forEach((t) => found.add(t));
        } catch (_) {}
      }
      // Opening a database that doesn't exist would create an empty one and could break the site's own
      // login storage, so only open it if it's already there.
      // Some browsers never answer these calls, so give up on them after a couple of seconds.
      const within = (p) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error('timed out')), 2000))]);
      try {
        const dbs = indexedDB.databases ? await within(indexedDB.databases()) : [];
        if (dbs.some((d) => d.name === 'firebaseLocalStorageDb')) {
          const db = await within(new Promise((ok, bad) => { const r = indexedDB.open('firebaseLocalStorageDb'); r.onsuccess = () => ok(r.result); r.onerror = bad; }));
          if (db.objectStoreNames.contains('firebaseLocalStorage')) {
            const rows = await within(new Promise((ok, bad) => { const r = db.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').getAll(); r.onsuccess = () => ok(r.result); r.onerror = bad; }));
            (JSON.stringify(rows).match(JWT) || []).forEach((t) => found.add(t));
          }
          db.close();
        }
      } catch (_) {}
      return [...found].slice(0, 6);
    }

    async function ask(headers, credentials) {
      const res = await fetch(API, {
        method: 'POST', credentials,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify({ operationName: 'GetEvent', query: QUERY, variables: { eventId } }),
      });
      let json = null;
      try { json = await res.json(); } catch (_) {}
      return { status: res.status, json };
    }

    async function load() {
      const tried = [];
      const attempts = [{ how: 'login cookie', headers: {} }];
      let searched = false;
      for (let i = 0; i < attempts.length; i++) {
        const a = attempts[i];
        try {
          const { status, json } = await ask(a.headers, 'include');
          const ev = json && json.data && json.data.event;
          if (ev) return { ev, how: a.how };
          const msg = json && json.errors && json.errors[0] && json.errors[0].message;
          tried.push(`${a.how}: ${msg || 'HTTP ' + status}`);
          if (json && json.data && json.data.event === null && !/auth|login|permission|token/i.test(msg || '')) {
            throw new Error('Campfire has no meetup with that ID, or this account cannot see it.');
          }
        } catch (err) {
          if (/no meetup/.test(err.message)) throw err;
          tried.push(`${a.how}: ${err.message}`);
        }
        if (!searched) {
          searched = true;
          (await findTokens()).forEach((t, n) => attempts.push({ how: 'saved token ' + (n + 1), headers: { Authorization: 'Bearer ' + t } }));
        }
      }
      throw new Error('Campfire did not accept any sign-in method. Make sure you are logged in on this page.\n\nTried:\n' + tried.join('\n'));
    }

    function toExport(ev) {
      const status = {};
      (ev.rsvpStatuses || []).forEach((s) => { status[s.userId] = s.rsvpStatus; });
      const named = new Map(((ev.members && ev.members.edges) || []).map((e) => [e.node.id, e.node.displayName]));
      const ids = new Set([...named.keys(), ...Object.keys(status)]);
      const attendees = [...ids].map((id) => ({ userId: id, name: named.get(id) || null, status: status[id] || 'UNKNOWN' }));
      const count = (s) => attendees.filter((a) => a.status === s).length;
      const counts = { going: (ev.members && ev.members.totalCount) || attendees.length, checkedIn: count('CHECKED_IN'), rsvpOnly: count('ACCEPTED') };
      const now = new Date().toISOString();
      return {
        schemaVersion: 1, source: 'campfire-bookmarklet', exportedAt: now,
        statusValues: { CHECKED_IN: 'checked in at the event', ACCEPTED: 'RSVP going, did not check in', DECLINED: 'RSVP declined' },
        totals: { events: 1, checkIns: counts.checkedIn, rsvpOnly: counts.rsvpOnly, uniquePeopleCheckedIn: counts.checkedIn, uniquePeople: attendees.length },
        events: [{
          id: ev.id, url: 'https://campfire.scopely.com/discover/meetup/' + ev.id, name: ev.name,
          group: { id: (ev.club && ev.club.id) || null, name: (ev.club && ev.club.name) || null },
          host: (ev.creator && ev.creator.displayName) || null, address: ev.address || null,
          startTime: ev.eventTime || null, endTime: ev.eventEndTime || null, counts, fetchedAt: now, attendees,
        }],
        people: attendees.map((a) => ({
          userId: a.userId, name: a.name, checkedInCount: a.status === 'CHECKED_IN' ? 1 : 0, rsvpOnlyCount: a.status === 'ACCEPTED' ? 1 : 0,
          events: [{ eventId: ev.id, status: a.status }],
        })),
      };
    }

    function render(data, how) {
      const ev = data.events[0];
      const byName = (a, b) => (!a.name - !b.name) || String(a.name).localeCompare(String(b.name));
      const group = (s) => ev.attendees.filter((a) => a.status === s).sort(byName);
      const named = ev.attendees.filter((a) => a.name).length;
      const when = ev.startTime ? new Date(ev.startTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
      const list = (cls, title, people) => people.length ? `<div class="${cls}"><h3>${title} (${people.length})</h3><div class="names">${people.map((a) =>
        `<span data-n="${esc((a.name || '').toLowerCase())}">${esc(a.name || '(name hidden)')}</span>`).join('')}</div></div>` : '';
      $('#body').innerHTML = `<h2>${esc(ev.name)}</h2><div class="muted">${esc(when)}${ev.group.name ? ' · ' + esc(ev.group.name) : ''}</div>
        <div class="stats"><div class="stat"><b>${ev.counts.checkedIn}</b><span class="muted">checked in</span></div>
        <div class="stat"><b>${ev.counts.rsvpOnly}</b><span class="muted">RSVP only</span></div><div class="stat"><b>${ev.counts.going}</b><span class="muted">going</span></div></div>
        ${named < ev.attendees.length ? `<p class="muted">Campfire only sends the first 50 names; counts are complete.</p>` : ''}
        <input type="search" placeholder="Search names" aria-label="Search names">
        ${list('in', 'Checked in', group('CHECKED_IN'))}${list('rsvp', 'RSVP only', group('ACCEPTED'))}${list('other', 'Other', ev.attendees.filter((a) => a.status !== 'CHECKED_IN' && a.status !== 'ACCEPTED'))}
        <div class="row"><button class="b" id="again">Refresh</button><button class="b p" id="send">Send to PoGo Code Dist</button></div>
        <p class="muted">Signed in with: ${esc(how)}</p>`;
      $('input').oninput = (e) => {
        const q = e.target.value.trim().toLowerCase();
        root.querySelectorAll('.names span').forEach((s) => { s.style.display = !q || s.dataset.n.includes(q) ? '' : 'none'; });
      };
      $('#again').onclick = run;
      $('#send').onclick = () => {
        const url = SITE + '#campfire=' + encodeURIComponent(JSON.stringify(data));
        if (!window.open(url, '_blank')) location.href = url;
      };
    }

    async function run() {
      $('#body').innerHTML = '<p class="muted">Loading meetup…</p>';
      try {
        const { ev, how } = await load();
        render(toExport(ev), how);
      } catch (err) {
        $('#body').innerHTML = `<h2>Couldn't load this meetup</h2><p class="err">${esc(err.message)}</p><div class="row"><button class="b" id="again">Try again</button></div>`;
        $('#again').onclick = run;
      }
    }
    run();
  } catch (err) {
    alert('cfcheck hit an error: ' + (err && err.message || err));
  }
})();
