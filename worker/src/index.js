/* ==========================================================================
   J.W. Cleaning — intake Worker

   This is the always-up front door. The site posts here; submissions land in
   D1 immediately with status 'unsent'. The Worker then tries to push straight
   to the home dashboard in Toledo. If that fails — box off, tunnel down,
   power cut — the row simply stays 'unsent' and nothing is lost.

   The home server pulls the backlog when it comes back:
     GET  /pending   -> rows still marked unsent
     POST /ack       -> marks the given ids sent

   Both are protected by SYNC_TOKEN, which lives in Worker secrets and never
   touches the repo or the browser.
   ========================================================================== */

const CORS = {
  'Access-Control-Allow-Origin': '*',      // tighten to your domain at launch
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

function authorised(request, env) {
  const header = request.headers.get('Authorization') || '';
  return header === `Bearer ${env.SYNC_TOKEN}`;
}

/* Reject junk before it reaches the database. */
function validate(body) {
  if (!body || typeof body !== 'object') return 'Malformed request body.';
  if (body.company_website) return 'Rejected.';           // honeypot tripped
  const kind = body.kind === 'review' ? 'review' : 'bid';
  if (!body.name || String(body.name).length > 120) return 'Name is required.';
  if (!body.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) return 'A valid email is required.';
  if (kind === 'bid' && !body.property) return 'Property name is required.';
  if (kind === 'review' && !body.body) return 'Review text is required.';
  if (JSON.stringify(body).length > 20000) return 'Submission too large.';
  return null;
}

/* Try the home dashboard. Never let a failure here fail the request. */
async function forward(row, env) {
  if (!env.HOME_ENDPOINT) return false;
  try {
    const res = await fetch(env.HOME_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SYNC_TOKEN}`,
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    /* ---- public intake ------------------------------------------------- */
    if (url.pathname === '/submit' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (err) {
        return json({ error: 'Could not read the submission.' }, 400);
      }

      const problem = validate(body);
      if (problem) return json({ error: problem }, 400);

      const kind = body.kind === 'review' ? 'review' : 'bid';
      const id = crypto.randomUUID();
      const received_at = new Date().toISOString();

      await env.DB.prepare(
        `INSERT INTO submissions (id, kind, status, received_at, payload, source_ip)
         VALUES (?, ?, 'unsent', ?, ?, ?)`
      ).bind(
        id,
        kind,
        received_at,
        JSON.stringify(body),
        request.headers.get('CF-Connecting-IP') || ''
      ).run();

      const row = { id, kind, received_at, payload: body };
      const delivered = await forward(row, env);

      if (delivered) {
        await env.DB.prepare(
          `UPDATE submissions SET status = 'sent', sent_at = ? WHERE id = ?`
        ).bind(new Date().toISOString(), id).run();
      }

      // The visitor gets a success either way. The queue is our problem.
      return json({ ok: true, id, delivered });
    }

    /* ---- home dashboard pulls the backlog ------------------------------ */
    if (url.pathname === '/pending' && request.method === 'GET') {
      if (!authorised(request, env)) return json({ error: 'Unauthorised.' }, 401);

      const { results } = await env.DB.prepare(
        `SELECT id, kind, received_at, payload
           FROM submissions
          WHERE status = 'unsent'
          ORDER BY received_at ASC
          LIMIT 200`
      ).all();

      return json({
        count: results.length,
        items: results.map((r) => ({ ...r, payload: JSON.parse(r.payload) })),
      });
    }

    /* ---- home dashboard confirms receipt ------------------------------- */
    if (url.pathname === '/ack' && request.method === 'POST') {
      if (!authorised(request, env)) return json({ error: 'Unauthorised.' }, 401);

      const { ids } = await request.json();
      if (!Array.isArray(ids) || !ids.length) {
        return json({ error: 'Send an array of ids.' }, 400);
      }

      const now = new Date().toISOString();
      const marks = ids.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE submissions SET status = 'sent', sent_at = ?
          WHERE id IN (${marks})`
      ).bind(now, ...ids).run();

      return json({ ok: true, acked: ids.length });
    }

    /* ---- read-only view, for when the home box is the thing that died --- */
    if (url.pathname === '/all' && request.method === 'GET') {
      if (!authorised(request, env)) return json({ error: 'Unauthorised.' }, 401);

      const { results } = await env.DB.prepare(
        `SELECT id, kind, status, received_at, sent_at, payload
           FROM submissions ORDER BY received_at DESC LIMIT 500`
      ).all();

      return json({
        count: results.length,
        items: results.map((r) => ({ ...r, payload: JSON.parse(r.payload) })),
      });
    }

    if (url.pathname === '/health') {
      return json({ ok: true, time: new Date().toISOString() });
    }

    return json({ error: 'Not found.' }, 404);
  },

  /* Retry anything still stranded, every 5 minutes. Set the cron in
     wrangler.toml. This is what makes the home box's downtime invisible. */
  async scheduled(event, env, ctx) {
    const { results } = await env.DB.prepare(
      `SELECT id, kind, received_at, payload
         FROM submissions WHERE status = 'unsent'
        ORDER BY received_at ASC LIMIT 50`
    ).all();

    for (const r of results) {
      const delivered = await forward(
        { id: r.id, kind: r.kind, received_at: r.received_at, payload: JSON.parse(r.payload) },
        env
      );
      if (delivered) {
        await env.DB.prepare(
          `UPDATE submissions SET status = 'sent', sent_at = ? WHERE id = ?`
        ).bind(new Date().toISOString(), r.id).run();
      }
    }
  },
};
