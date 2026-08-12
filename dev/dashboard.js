/* ==========================================================================
   Stand-in for the Toledo dashboard. Dev only — no auth beyond the token,
   no persistence beyond a JSON file, no UI worth looking at.

   Its job is to let you test the queue behaviour before writing the real one:
   kill this process, submit the form a few times, start it again, and watch
   the backlog drain.

     node dev/dashboard.js

   Then in another shell:
     curl localhost:9000/leads
   ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9000;
const WORKER = process.env.WORKER_URL || 'http://localhost:8787';
const TOKEN = process.env.SYNC_TOKEN || 'devtoken';
const STORE = path.join(__dirname, 'leads.json');

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch (e) { return []; }
}

function save(leads) {
  fs.writeFileSync(STORE, JSON.stringify(leads, null, 2));
}

function store(row) {
  const leads = load();
  if (leads.some((l) => l.id === row.id)) return false;   // already have it
  leads.push({ ...row, stored_at: new Date().toISOString() });
  save(leads);
  console.log(`  stored ${row.kind} ${row.id.slice(0, 8)} — ${row.payload.name || 'unnamed'}`);
  return true;
}

/* ---- accept pushes from the Worker ------------------------------------- */
const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.url === '/intake' && req.method === 'POST') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorised' });

    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        // Store BEFORE returning 200. A 200 tells the Worker it can mark the
        // row sent, so returning early would lose the lead on a crash here.
        store(JSON.parse(raw));
        send(200, { ok: true });
      } catch (err) {
        send(400, { error: 'bad payload' });
      }
    });
    return;
  }

  if (req.url === '/leads') {
    return send(200, { count: load().length, leads: load() });
  }

  if (req.url === '/health') return send(200, { ok: true });

  send(404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`dashboard  http://localhost:${PORT}`);
  console.log(`worker     ${WORKER}`);
  console.log(`store      ${STORE}\n`);
});

/* ---- pull anything stranded while we were down ------------------------- */
async function drain() {
  try {
    const res = await fetch(`${WORKER}/pending`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) return;

    const { items } = await res.json();
    if (!items.length) return;

    console.log(`draining ${items.length} stranded submission(s)`);
    const acked = [];
    for (const item of items) {
      store(item);
      acked.push(item.id);
    }

    // Ack only after everything is written to disk.
    await fetch(`${WORKER}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ids: acked }),
    });
    console.log(`acked ${acked.length}\n`);
  } catch (err) {
    // Worker unreachable. Try again next tick.
  }
}

drain();
setInterval(drain, 30000);
