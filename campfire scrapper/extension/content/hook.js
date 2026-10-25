// =============================================================
// Runs in the page's own JS world (MAIN) at document_start.
//  1. Observes the GraphQL traffic Campfire makes and forwards each
//     request/response pair to content.js (which harvests events from it).
//     It also learns *how* the app calls the API (endpoint, headers,
//     credentials mode) so our own requests look the same.
//  2. Executes GraphQL requests on behalf of content.js, from the page
//     origin with the page's session.
//  Everything notable is sent to content.js as a 'log' message.
// =============================================================
(() => {
  const DEFAULT_ENDPOINT = 'https://niantic-social-api.nianticlabs.com/graphql';
  const GQL_URL_RE = /\/graphql(\/|\?|$)/i;
  const HOOK = 'cf-hook';
  const EXT = 'cf-ext';

  const origFetch = window.fetch;

  // What we've learned from the app's own requests
  const page = {
    endpoint: null,
    headers: {},        // extra headers (e.g. authorization), reused for our requests
    credentials: null,  // 'include' | 'same-origin' | 'omit' as used by the app
    seen: 0,
  };

  const post = (msg) => window.postMessage({ src: HOOK, ...msg }, '*');
  const log = (level, msg, data) => post({ type: 'log', level, msg, data });

  const redact = (headers) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [
    k, /auth|token|cookie|session|key/i.test(k) ? `${String(v).slice(0, 10)}… (${String(v).length} chars)` : v,
  ]));

  function headerEntries(h) {
    if (!h) return [];
    if (h instanceof Headers) return [...h.entries()];
    if (Array.isArray(h)) return h;
    return Object.entries(h);
  }

  function learn(url, headers, credentials) {
    page.seen++;
    const first = !page.endpoint;
    const changed = page.endpoint && page.endpoint !== url;
    page.endpoint = url.split('?')[0];
    // fetch() defaults to 'same-origin', i.e. no cookies for this cross-origin API
    page.credentials = credentials || page.credentials || 'same-origin';
    let newHeader = false;
    for (const [k, v] of headerEntries(headers)) {
      const key = k.toLowerCase();
      if (key === 'content-type' || key === 'content-length' || key === 'accept') continue;
      if (page.headers[key] !== v) newHeader = true;
      page.headers[key] = v;
    }
    if (first || changed || newHeader) {
      log('info', first ? 'Learned API settings from the page' : 'Page API settings updated', publicPageInfo());
    }
  }

  const publicPageInfo = () => ({
    endpoint: page.endpoint,
    credentials: page.credentials || '(no page request seen yet)',
    headers: redact(page.headers),
    pageRequestsSeen: page.seen,
  });

  function report(reqBody, resBody) {
    const reqs = Array.isArray(reqBody) ? reqBody : [reqBody];
    const ress = Array.isArray(resBody) ? resBody : [resBody];
    reqs.forEach((req, i) => {
      const res = ress[i];
      if (!req || !res || !res.data) return;
      post({
        type: 'gql',
        request: {
          operationName: req.operationName,
          query: req.query,
          variables: req.variables,
          extensions: req.extensions,
        },
        data: res.data,
      });
    });
  }

  window.fetch = async function (input, init) {
    let url = '';
    let bodyPromise = null;
    try {
      if (input instanceof Request) {
        url = input.url;
        if (GQL_URL_RE.test(url)) {
          learn(url, (init && init.headers) || input.headers, (init && init.credentials) || input.credentials);
          bodyPromise = typeof (init && init.body) === 'string' ? Promise.resolve(init.body) : input.clone().text();
        }
      } else {
        url = String(input);
        if (GQL_URL_RE.test(url)) {
          learn(url, init && init.headers, init && init.credentials);
          if (init && typeof init.body === 'string') bodyPromise = Promise.resolve(init.body);
        }
      }
    } catch (_) { /* never break the app */ }

    const res = await origFetch.apply(this, arguments);
    if (bodyPromise) {
      Promise.all([bodyPromise, res.clone().json()])
        .then(([body, json]) => report(JSON.parse(body), json))
        .catch(() => {});
    }
    return res;
  };

  const xOpen = XMLHttpRequest.prototype.open;
  const xSend = XMLHttpRequest.prototype.send;
  const xSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cfUrl = String(url);
    return xOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    (this.__cfHeaders = this.__cfHeaders || {})[k] = v;
    return xSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__cfUrl && GQL_URL_RE.test(this.__cfUrl) && typeof body === 'string') {
      try { learn(this.__cfUrl, this.__cfHeaders, this.withCredentials ? 'include' : 'same-origin'); } catch (_) {}
      this.addEventListener('load', () => {
        try {
          const json = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
          report(JSON.parse(body), json);
        } catch (_) {}
      });
    }
    return xSend.apply(this, arguments);
  };

  // ---------------------------------------------------------------
  // Requests from content.js. Tries the page's own settings first,
  // then fallbacks, and returns a record of every attempt.
  // ---------------------------------------------------------------
  function attemptPlan() {
    const endpoint = page.endpoint || DEFAULT_ENDPOINT;
    const plan = [];
    const add = (label, ep, credentials, headers) => {
      if (!plan.some((p) => p.ep === ep && p.credentials === credentials && JSON.stringify(p.headers) === JSON.stringify(headers))) {
        plan.push({ label, ep, credentials, headers });
      }
    };
    add('page settings', endpoint, page.credentials || 'include', page.headers);
    add('cookies, no extra headers', endpoint, 'include', {});
    add('page headers, no cookies', endpoint, 'omit', page.headers);
    if (endpoint !== DEFAULT_ENDPOINT) add('default endpoint', DEFAULT_ENDPOINT, 'include', {});
    return plan;
  }

  async function runRequest(body) {
    const attempts = [];
    let authFailure = null;
    for (const a of attemptPlan()) {
      const started = performance.now();
      const rec = { label: a.label, endpoint: a.ep, credentials: a.credentials, headers: redact(a.headers) };
      attempts.push(rec);
      try {
        const res = await origFetch(a.ep, {
          method: 'POST',
          credentials: a.credentials,
          headers: { ...a.headers, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
        rec.ms = Math.round(performance.now() - started);
        rec.status = res.status;
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        if (!json) {
          rec.error = `HTTP ${res.status}, non-JSON response`;
          rec.bodySnippet = text.slice(0, 500);
          continue;
        }
        // A GraphQL error body (e.g. 422 validation errors) is a real answer, not a
        // transport failure - return it so callers see the messages.
        if (res.status === 401 || res.status === 403) {
          rec.error = `HTTP ${res.status}`;
          rec.bodySnippet = text.slice(0, 500);
          authFailure = json;
          continue;
        }
        if (!res.ok && !json.data && !Array.isArray(json.errors)) {
          rec.error = `HTTP ${res.status}`;
          rec.bodySnippet = text.slice(0, 500);
          continue;
        }
        return { json, attempts };
      } catch (err) {
        rec.ms = Math.round(performance.now() - started);
        rec.error = `${err.name}: ${err.message}`;
        if (err.message === 'Failed to fetch') {
          rec.hint = 'Network/CORS block - the browser hides the reason from scripts. See the DevTools console (red CORS line) for details.';
        }
      }
    }
    if (authFailure && Array.isArray(authFailure.errors)) return { json: authFailure, attempts };
    return { error: attempts[attempts.length - 1].error, attempts };
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.src !== EXT) return;
    if (e.data.type === 'request') {
      const { reqId, body } = e.data;
      const result = await runRequest(body);
      post({ type: 'response', reqId, ...result, page: publicPageInfo() });
    } else if (e.data.type === 'diagnose') {
      post({ type: 'diagnose-result', page: publicPageInfo() });
    }
  });
})();
