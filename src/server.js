const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { SessionManager } = require('./warmer/manager');
const { WarmingEngine } = require('./warmer/engine');
const auth = require('./auth');

const ROOT = path.join(__dirname, '..');
// Diretório de dados persistentes (auth/, sessions.json, logs/). Em produção
// aponte DATA_DIR para um volume montado (ex.: /app/data no EasyPanel).
const DATA_DIR = process.env.DATA_DIR || ROOT;
fs.mkdirSync(DATA_DIR, { recursive: true });

// Config: usa a versão persistida no volume (editada pelo painel) se existir;
// senão, os defaults embutidos na imagem.
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'config.json');
const config = JSON.parse(
  fs.readFileSync(fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : DEFAULT_CONFIG_PATH, 'utf8')
);
const phrases = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data', 'phrases.json'), 'utf8')
);

const manager = new SessionManager({
  authRoot: path.join(DATA_DIR, 'auth'),
  sessionsFile: path.join(DATA_DIR, 'sessions.json'),
  typingCfg: config.warming.typing,
});
const engine = new WarmingEngine(manager, phrases, config.warming);

// senha de admin: use a variável de ambiente ADMIN_PASSWORD em produção
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || (config.admin && config.admin.password) || 'admin';

const app = express();
app.use(express.json());

// ---- Autenticação (painel só para administradores) ----
app.post('/api/login', (req, res) => {
  if (!auth.passwordMatches(req.body?.password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'senha incorreta' });
  }
  res.setHeader('Set-Cookie', auth.cookieHeader(auth.issueToken()));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  auth.revoke(req);
  res.setHeader('Set-Cookie', auth.clearCookieHeader());
  res.json({ ok: true });
});

app.get('/login', (req, res) => res.type('html').send(LOGIN_PAGE));

// a partir daqui tudo exige autenticação
app.use((req, res, next) => {
  if (auth.isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'não autenticado' });
  }
  return res.redirect('/login');
});

app.use(express.static(path.join(ROOT, 'public')));

const server = http.createServer(app);
const io = new Server(server);

// Socket.io também exige o cookie de sessão válido
io.use((socket, next) => {
  if (auth.isAuthed(socket.request)) return next();
  next(new Error('unauthorized'));
});

// ---- Estado corrente enviado a quem conecta no painel ----
function snapshot() {
  return {
    sessions: manager.list().map((s) => ({
      ...s,
      nextFireAt: engine.scheduleFor(s.id),
      multiplier: engine.multiplierFor(s.id),
    })),
    engine: engine.status(),
  };
}

function persistConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---- REST API ----
app.get('/api/state', (req, res) => res.json(snapshot()));

app.post('/api/sessions', async (req, res) => {
  try {
    const id = req.body?.id;
    if (!id) return res.status(400).json({ error: 'informe um id/apelido' });
    await manager.addSession(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/sessions/:id/reconnect', async (req, res) => {
  try {
    await manager.reconnect(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await manager.removeSession(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// atualiza os parâmetros de aquecimento (intervalos, trocas, cota, horário…)
app.post('/api/config', (req, res) => {
  try {
    const patch = req.body || {};
    const updated = engine.updateConfig(patch);
    config.warming = updated;
    persistConfig();
    io.emit('config', updated);
    res.json({ ok: true, config: updated });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/engine/start', (req, res) => {
  engine.start();
  res.json({ ok: true });
});

app.post('/api/engine/stop', (req, res) => {
  engine.stop();
  res.json({ ok: true });
});

// ---- Socket.io: eventos em tempo real para o painel ----
io.on('connection', (socket) => {
  socket.emit('state', snapshot());
});

manager.on('qr', async ({ id, qr }) => {
  try {
    const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 260 });
    io.emit('qr', { id, dataUrl });
  } catch (_) {
    /* noop */
  }
});

manager.on('status', ({ id, status, number, lastDisconnect }) => {
  io.emit('session', { id, status, number, lastDisconnect });
});

manager.on('removed', ({ id }) => io.emit('removed', { id }));

manager.on('log', ({ id, level, text }) => {
  console.log(`[${level}] ${text}`);
  io.emit('log', { time: Date.now(), level, text });
});

// obs.: o motivo da queda já é enviado ao painel via evento 'session'
// (campo lastDisconnect). Não usar 'disconnect' aqui — é evento reservado
// no Socket.io e emiti-lo derruba o servidor.

manager.on('sessionError', ({ id, err }) => {
  io.emit('log', {
    time: Date.now(),
    level: 'error',
    text: `[${id}] ${err.message}`,
  });
});

engine.on('state', (s) => io.emit('engine', s));
engine.on('schedule', (s) => io.emit('schedule', s));
engine.on('backoff', ({ id, multiplier, direction }) => {
  const txt =
    direction === 'up'
      ? `[${id}] falha na entrega — ritmo reduzido (${multiplier}x mais lento)`
      : `[${id}] entregando de novo — acelerando (${multiplier}x)`;
  console.log(txt);
  io.emit('backoff', { id, multiplier, direction });
  io.emit('log', { time: Date.now(), level: direction === 'up' ? 'warn' : 'info', text: txt });
});
engine.on('config', (c) => io.emit('config', c));
engine.on('activity', (a) => {
  console.log(`[envio] +${a.from} → +${a.to} (${a.type}): ${a.text}`);
  io.emit('activity', a);
});

// mensagens recebidas de outro número aquecido (prova de que estão conversando)
manager.on('message', ({ id, from, text }) => {
  console.log(`[recebido] ${id} <- +${from}: ${text}`);
});

// status de entrega de cada mensagem enviada (✓ enviado / ✓✓ entregue / ✗ não entregue)
manager.on('receipt', ({ id, msgId, to, status }) => {
  console.log(`[entrega] ${id} → +${to}: ${status}`);
  io.emit('receipt', { id, msgId, to, status });
});
engine.on('error', (e) =>
  io.emit('log', { time: Date.now(), level: 'error', text: e.message })
);

// ---- Página de login (self-contained) ----
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Entrar — Aquecedor</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0f1115;color:#e6e8ee;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
  form{background:#1a1d24;border:1px solid #2b303b;border-radius:12px;padding:28px;width:320px;
    display:flex;flex-direction:column;gap:14px;}
  h1{font-size:19px;margin:0 0 6px;}
  p{margin:0;color:#9aa1b0;font-size:13px;}
  input{background:#232733;border:1px solid #2b303b;color:#e6e8ee;padding:11px 12px;border-radius:8px;font-size:15px;}
  button{background:#25d366;color:#05261a;border:0;padding:11px;border-radius:8px;font-weight:600;font-size:15px;cursor:pointer;}
  .err{color:#fca5a5;font-size:13px;min-height:16px;}
</style></head><body>
<form id="f">
  <h1>🔥 Painel do Aquecedor</h1>
  <p>Área restrita a administradores.</p>
  <input id="p" type="password" placeholder="Senha de admin" autofocus/>
  <div class="err" id="e"></div>
  <button type="submit">Entrar</button>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (ev)=>{
  ev.preventDefault();
  const r = await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({password:document.getElementById('p').value})});
  if(r.ok){ location.href='/'; }
  else { document.getElementById('e').textContent='Senha incorreta.'; }
});
</script></body></html>`;

// ---- Boot ----
const PORT = process.env.PORT || config.server.port || 3000;
server.listen(PORT, async () => {
  console.log(`\n🔥 Aquecedor de números rodando em http://localhost:${PORT}\n`);
  try {
    await manager.restore();
  } catch (e) {
    console.error('Falha ao restaurar sessões:', e.message);
  }
  // reenvia o estado completo: se o painel conectou durante a restauração
  // (ex.: logo após um redeploy), ele recebe a lista já atualizada.
  io.emit('state', snapshot());
});
