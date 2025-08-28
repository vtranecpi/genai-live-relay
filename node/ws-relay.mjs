import http from 'node:http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

const PORT       = process.env.PORT || process.env.RELAY_PORT || 8788;
const LIVE_MODEL = process.env.LIVE_MODEL || 'gemini-2.0-flash-live-001';
const CONNECT_TIMEOUT_MS = 12000;

function send(ws, obj){ try{ ws.send(JSON.stringify(obj)); }catch{} }
function log(...a){ console.log('[relay]', ...a); }

const server = http.createServer((_,res)=>{ res.writeHead(200); res.end('relay'); });
const wss = new WebSocketServer({ server });

wss.on('connection', async (client) => {
  log('client connected');
  let ai, live, liveReady = false, closed = false;
  const pending = [];

  const shutdown = (why) => {
    if (closed) return; closed = true;
    try { live?.close?.(); } catch {}
    try { client?.close?.(); } catch {}
    log('end', why || '');
  };

  const forward = (m) => {
    if (!liveReady) { pending.push(m); return; }
    if (m.type === 'setup' && m.systemInstruction) { live.send?.({ setup:{ systemInstruction:m.systemInstruction } }); return; }
    if (m.type === 'text'  && typeof m.text === 'string') { live.send?.({ input:{ text:m.text } }); return; }
    if (m.type === 'end') { shutdown('client requested end'); return; }
  };

  client.on('close', ()=> shutdown('client closed'));
  client.on('error', e=> log('client err', e?.message || e));
  client.on('message', raw => { try { forward(JSON.parse(raw.toString())); } catch (e) { send(client,{type:'error',message:String(e)}); } });

  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) { send(client,{type:'error',message:'GEMINI_API_KEY missing on relay'}); return shutdown('no key'); }
    log('using GEMINI_API_KEY');

    log('connecting live…', LIVE_MODEL);
    const timer = setTimeout(() => {
      if (!liveReady) { send(client, { type:'error', message:'Live connect timed out (12s) on relay' }); shutdown('connect timeout'); }
    }, CONNECT_TIMEOUT_MS);

    ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    live = await ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO, Modality.TEXT],
        inputAudioFormat:  { encoding:'LINEAR16', sampleRateHertz:16000 },
        outputAudioFormat: { encoding:'MP3', sampleRateHertz:24000 },
        sessionResumption: {},
        proactivity: { disabled: true },
      },
      callbacks: {
        onOpen: () => {
          clearTimeout(timer);
          log('live open');
          liveReady = true;
          send(client, { type:'status', value:'open' });
          for (const m of pending.splice(0)) forward(m);
        },
        onClose: () => { log('live closed'); send(client,{type:'status',value:'closed'}); shutdown('live closed'); },
        onError: (e) => { log('live err', e?.message || e); send(client,{type:'error',message:String(e?.message||e)}); },
        onResponse: (evt) => {
          try {
            const text =
              evt?.text ??
              evt?.response?.output?.[0]?.content?.parts?.map(p=>p.text).join(' ') ??
              evt?.response?.candidates?.[0]?.content?.parts?.map(p=>p.text).join(' ');
            if (text) send(client, { type:'text', text });
            if (evt?.audio?.data) {
              const b64 = (evt.audio.data instanceof ArrayBuffer)
                ? Buffer.from(evt.audio.data).toString('base64')
                : (typeof evt.audio.data === 'string' ? evt.audio.data : null);
              if (b64) send(client, { type:'audio', encoding:'mp3/base64', data:b64 });
            }
          } catch (e) { send(client,{type:'error',message:String(e)}); }
        }
      }
    });

  } catch (e) {
    log('setup err', e?.message || e);
    send(client, { type:'error', message:String(e?.message||e) });
    shutdown('setup error');
  }
});

// Bind public for cloud platforms
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => log(`ws relay on ws://${HOST}:${PORT}`));
