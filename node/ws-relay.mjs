// ... keep your current imports and existing code above

import dns from 'node:dns/promises';
import https from 'node:https';
import { WebSocket } from 'ws';

// add this small helper
async function httpsPing(url) {
  return await new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', timeout: 8000 }, (res) => {
      resolve({ ok: true, status: res.statusCode });
      res.resume();
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok:false, error:'timeout' }); });
    req.on('error',   (e) => resolve({ ok:false, error:String(e) }));
    req.end();
  });
}

async function wsEchoTest() {
  return await new Promise((resolve) => {
    const ws = new WebSocket('wss://echo.websocket.events');
    const timer = setTimeout(() => { try{ws.close();}catch{}; resolve({ ok:false, error:'timeout' }); }, 8000);
    ws.on('open', () => { clearTimeout(timer); ws.close(); resolve({ ok:true }); });
    ws.on('error', e => { clearTimeout(timer); resolve({ ok:false, error:String(e) }); });
  });
}

// replace your HTTP server handler with this block:
const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/healthz')) {
    const body = JSON.stringify({
      ok: true,
      node: process.version,
      model: LIVE_MODEL,
      hasKey: !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim())
    });
    res.writeHead(200, {'content-type':'application/json'}); res.end(body); return;
  }

  if (req.url?.startsWith('/selftest')) {
    const key = (process.env.GEMINI_API_KEY || '').trim();
    if (!key) { res.writeHead(500, {'content-type':'application/json'}); return res.end(JSON.stringify({ ok:false, error:'GEMINI_API_KEY missing' })); }
    const result = await selftestLive(key);  // your existing selftestLive()
    res.writeHead(result.ok?200:500, {'content-type':'application/json'}); res.end(JSON.stringify(result)); return;
  }

  // NEW: deep diagnostics
  if (req.url?.startsWith('/diag')) {
    const out = {};
    try { out.dns = await dns.lookup('generativelanguage.googleapis.com', { all: true }); } catch(e) { out.dns = { error: String(e) }; }
    out.https = await httpsPing('https://generativelanguage.googleapis.com/$discovery/rest?version=v1');
    out.echo  = await wsEchoTest();
    // try selftest too (reuses your Live connect)
    const key = (process.env.GEMINI_API_KEY || '').trim();
    out.live  = key ? await selftestLive(key) : { ok:false, error:'no key' };
    res.writeHead((out.live.ok || out.echo.ok || out.https.ok) ? 200 : 500, {'content-type':'application/json'});
    res.end(JSON.stringify(out));
    return;
  }

  res.writeHead(200, {'content-type':'text/plain'}); res.end('relay');
});
