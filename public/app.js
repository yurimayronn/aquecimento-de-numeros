const socket = io();

// se a sessão expirar / não autenticado, volta para o login
socket.on('connect_error', (err) => {
  if (err && err.message === 'unauthorized') location.href = '/login';
});

const sessionsEl = document.getElementById('sessions');
const activityEl = document.getElementById('activity');
const engineStatusEl = document.getElementById('engine-status');

// estado local
const sessions = new Map(); // id -> { id, status, number, qr, nextFireAt }
let engineRunning = false;
let rampDays = 14;

const STATUS_LABEL = {
  connected: 'Conectado',
  qr: 'Escaneie o QR',
  connecting: 'Conectando…',
  reconnecting: 'Reconectando…',
  disconnected: 'Desconectado',
  logged_out: 'Deslogado',
  error: 'Erro',
};

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('pt-BR');

function countdownText(nextFireAt) {
  if (!engineRunning) return 'Motor parado';
  if (!nextFireAt) return 'aguardando…';
  const secs = Math.round((nextFireAt - Date.now()) / 1000);
  if (secs <= 0) return 'disparando…';
  if (secs < 60) return `em ${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `em ${m}m ${String(s).padStart(2, '0')}s`;
}

// ---------- resumo geral (topo) ----------
const summaryEl = document.getElementById('summary');

function renderSummary() {
  const all = [...sessions.values()];
  const connected = all.filter((s) => s.status === 'connected');
  const healthy = connected.filter((s) => s.healthy !== false);
  const bad = connected.filter((s) => s.healthy === false);
  const warming = connected.filter((s) => s.warmupDay && s.warmupDay < rampDays);
  const mature = connected.filter((s) => s.warmupDay && s.warmupDay >= rampDays);
  const offline = all.filter((s) => s.status !== 'connected');

  const tiles = [
    { label: 'Total', value: all.length, cls: '' },
    { label: 'Saudáveis', value: healthy.length, cls: 't-green' },
    { label: 'Com erro', value: bad.length, cls: 't-red' },
    { label: 'Aquecendo', value: warming.length, cls: 't-orange' },
    { label: 'Maduros', value: mature.length, cls: 't-blue' },
    { label: 'Offline', value: offline.length, cls: 't-muted' },
  ];

  const warn =
    engineRunning && healthy.length < 2
      ? `<div class="summary-warn">⚠ Menos de 2 números saudáveis — o aquecimento está pausado (precisa de pelo menos 2).</div>`
      : '';

  summaryEl.innerHTML =
    `<div class="tiles">` +
    tiles
      .map(
        (t) =>
          `<div class="tile ${t.cls}"><div class="tile-v">${t.value}</div><div class="tile-l">${t.label}</div></div>`
      )
      .join('') +
    `</div>${warn}`;
}

// ---------- render ----------
function renderSessions() {
  renderSummary();
  if (sessions.size === 0) {
    sessionsEl.innerHTML =
      '<p class="empty">Nenhum número ainda. Adicione um acima e escaneie o QR code no WhatsApp &gt; Aparelhos conectados.</p>';
    return;
  }
  sessionsEl.innerHTML = '';
  for (const s of sessions.values()) {
    const card = document.createElement('div');
    card.className = 'card';

    const showQr = s.status === 'qr' && s.qr;
    const canReconnect =
      s.status === 'disconnected' ||
      s.status === 'logged_out' ||
      s.status === 'error';
    const showNext = s.status === 'connected';
    const ld = s.lastDisconnect;
    const showReason = ld && s.status !== 'connected' && s.status !== 'qr';

    card.innerHTML = `
      <div class="top">
        <div>
          <div class="name">${s.id}</div>
          <div class="num">${s.number ? '+' + s.number : '—'}</div>
        </div>
        <button class="remove" title="Remover" data-id="${s.id}">✕</button>
      </div>
      <div class="status s-${s.status}"><span class="dot"></span>${STATUS_LABEL[s.status] || s.status}${s.status === 'connected' && s.healthy === false ? ' <span class="unhealthy">⚠ com erro de envio</span>' : ''}</div>
      ${showReason ? `<div class="reason">Última queda: código ${ld.code ?? '?'} — ${escapeHtml(ld.reason)}</div>` : ''}
      ${showNext ? `<div class="next">Próximo disparo: <b id="cd-${s.id}">${countdownText(s.nextFireAt)}</b>${s.multiplier > 1 ? ` <span class="rate">ritmo ${s.multiplier}x mais lento</span>` : ''}</div>` : ''}
      ${showNext && s.warmupDay ? `<div class="warmup">🔥 aquecimento: dia ${s.warmupDay}/${rampDays} · até ${s.dailyCap} msgs/dia</div>` : ''}
      ${canReconnect ? `<button class="reconnect" data-id="${s.id}">Reconectar</button>` : ''}
      ${showQr ? `<div class="qr"><img src="${s.qr}" alt="QR"/><small>Abra o WhatsApp &gt; Aparelhos conectados &gt; Conectar aparelho</small></div>` : ''}
    `;
    sessionsEl.appendChild(card);
  }

  sessionsEl.querySelectorAll('.remove').forEach((btn) =>
    btn.addEventListener('click', () => removeSession(btn.dataset.id))
  );
  sessionsEl.querySelectorAll('.reconnect').forEach((btn) =>
    btn.addEventListener('click', () => reconnectSession(btn.dataset.id))
  );
}

// atualiza só os contadores, sem re-renderizar tudo
setInterval(() => {
  for (const s of sessions.values()) {
    if (s.status !== 'connected') continue;
    const el = document.getElementById('cd-' + s.id);
    if (el) el.textContent = countdownText(s.nextFireAt);
  }
}, 1000);

const RECEIPT = {
  sent: { label: '✓ enviado', cls: 'r-sent' },
  delivered: { label: '✓✓ entregue', cls: 'r-delivered' },
  read: { label: '✓✓ lido', cls: 'r-read' },
  undelivered: { label: '✗ não entregue', cls: 'r-fail' },
  error: { label: '✗ erro', cls: 'r-fail' },
};

function addActivity({ type, from, to, text, time, msgId }) {
  const wrap = document.createElement('div');
  wrap.className = 'msg' + (type === 'closing' ? ' closing' : '');
  const badge = msgId
    ? `<span class="receipt r-pending" id="r-${msgId}">enviando…</span>`
    : '';
  wrap.innerHTML = `
    <div class="meta">${fmtTime(time)} · +${from} → +${to} · ${type} ${badge}</div>
    <div>${escapeHtml(text)}</div>`;
  activityEl.prepend(wrap);
  trimActivity();
}

function updateReceipt({ msgId, status }) {
  if (!msgId) return;
  const el = document.getElementById('r-' + msgId);
  if (!el) return;
  const r = RECEIPT[status];
  if (!r) return;
  el.textContent = r.label;
  el.className = 'receipt ' + r.cls;
}

function addLog({ time, text, level }) {
  const wrap = document.createElement('div');
  wrap.className = 'msg log ' + (level || 'info');
  wrap.innerHTML = `<div class="meta">${fmtTime(time)} · ${level || 'info'}</div><div>${escapeHtml(text)}</div>`;
  activityEl.prepend(wrap);
  trimActivity();
}

function trimActivity() {
  while (activityEl.children.length > 200) activityEl.lastChild.remove();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function setEngine(running) {
  engineRunning = running;
  engineStatusEl.textContent = running ? 'Motor: rodando' : 'Motor: parado';
  engineStatusEl.className = 'badge ' + (running ? 'on' : 'off');
}

function setField(id, v) {
  const el = document.getElementById(id);
  if (!el || v == null) return;
  if (el.type === 'checkbox') el.checked = !!v;
  else el.value = v;
}

function fillConfig(cfg) {
  if (!cfg) return;
  setField('cfg-minIntervalSec', cfg.minIntervalSec);
  setField('cfg-maxIntervalSec', cfg.maxIntervalSec);
  setField('cfg-minTurns', cfg.minTurns);
  setField('cfg-maxTurns', cfg.maxTurns);
  setField('cfg-replyProbability', cfg.replyProbability);
  setField('cfg-conversationTtlSec', cfg.conversationTtlSec);
  setField('cfg-dailyCapPerNumber', cfg.dailyCapPerNumber);
  setField('cfg-hstart', cfg.activeHours && cfg.activeHours.start);
  setField('cfg-hend', cfg.activeHours && cfg.activeHours.end);
  if (cfg.warmup) {
    setField('cfg-warmupEnabled', cfg.warmup.enabled);
    setField('cfg-rampDays', cfg.warmup.rampDays);
    setField('cfg-startDailyCap', cfg.warmup.startDailyCap);
    setField('cfg-startIntervalMult', cfg.warmup.startIntervalMult);
  }
  setField('cfg-unhealthyAfterFails', cfg.unhealthyAfterFails);
  setField('cfg-backoffFactor', cfg.backoffFactor);
  setField('cfg-maxBackoff', cfg.maxBackoff);
  if (cfg.typing) {
    setField('cfg-baseMs', cfg.typing.baseMs);
    setField('cfg-perCharMs', cfg.typing.perCharMs);
    setField('cfg-maxMs', cfg.typing.maxMs);
    setField('cfg-readDelayMs', cfg.typing.readDelayMs);
  }
}

// ---------- ações ----------
async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    return res;
  }
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    alert('Erro: ' + (error || res.statusText));
  }
  return res;
}

const addSession = (id) => post('/api/sessions', { id });
const reconnectSession = (id) => post(`/api/sessions/${encodeURIComponent(id)}/reconnect`);

async function removeSession(id) {
  if (!confirm(`Remover o número "${id}"? Isso desconecta e apaga a sessão.`)) return;
  await fetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
  sessions.delete(id);
  renderSessions();
}

document.getElementById('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('add-id');
  const id = input.value.trim();
  if (id) addSession(id);
  input.value = '';
});

const numField = (id) => {
  const el = document.getElementById(id);
  return el && el.value !== '' ? +el.value : undefined;
};
const chkField = (id) => {
  const el = document.getElementById(id);
  return el ? el.checked : undefined;
};

document.getElementById('config-form').addEventListener('submit', (e) => {
  e.preventDefault();
  post('/api/config', {
    minIntervalSec: numField('cfg-minIntervalSec'),
    maxIntervalSec: numField('cfg-maxIntervalSec'),
    minTurns: numField('cfg-minTurns'),
    maxTurns: numField('cfg-maxTurns'),
    replyProbability: numField('cfg-replyProbability'),
    conversationTtlSec: numField('cfg-conversationTtlSec'),
    dailyCapPerNumber: numField('cfg-dailyCapPerNumber'),
    activeHours: { start: numField('cfg-hstart'), end: numField('cfg-hend') },
    warmup: {
      enabled: chkField('cfg-warmupEnabled'),
      rampDays: numField('cfg-rampDays'),
      startDailyCap: numField('cfg-startDailyCap'),
      startIntervalMult: numField('cfg-startIntervalMult'),
    },
    unhealthyAfterFails: numField('cfg-unhealthyAfterFails'),
    backoffFactor: numField('cfg-backoffFactor'),
    maxBackoff: numField('cfg-maxBackoff'),
    typing: {
      baseMs: numField('cfg-baseMs'),
      perCharMs: numField('cfg-perCharMs'),
      maxMs: numField('cfg-maxMs'),
      readDelayMs: numField('cfg-readDelayMs'),
    },
  }).then((res) => {
    if (res && res.ok) flashSaved();
  });
});

// recolher/expandir a aba de configurações
document.getElementById('settings-toggle').addEventListener('click', () => {
  const body = document.getElementById('settings-body');
  body.hidden = !body.hidden;
  document.getElementById('settings-chev').textContent = body.hidden ? '▸' : '▾';
});

function flashSaved() {
  const btn = document.querySelector('#config-form button[type="submit"]');
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = '✓ Salvo';
  btn.classList.add('saved');
  setTimeout(() => {
    btn.textContent = orig;
    btn.classList.remove('saved');
  }, 1500);
}

document.getElementById('btn-start').addEventListener('click', () => post('/api/engine/start'));
document.getElementById('btn-stop').addEventListener('click', () => post('/api/engine/stop'));
document.getElementById('btn-logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

// ---------- eventos do servidor ----------
socket.on('state', ({ sessions: list, engine }) => {
  sessions.clear();
  for (const s of list) sessions.set(s.id, { ...s, qr: null });
  setEngine(engine.running);
  fillConfig(engine.config);
  if (engine.config?.warmup?.rampDays) rampDays = engine.config.warmup.rampDays;
  renderSessions();
});

socket.on('session', ({ id, status, number, lastDisconnect }) => {
  const prev = sessions.get(id) || { id };
  sessions.set(id, {
    ...prev,
    status,
    number: number || prev.number,
    lastDisconnect: lastDisconnect || prev.lastDisconnect,
    qr: status === 'qr' ? prev.qr : null,
    nextFireAt: status === 'connected' ? prev.nextFireAt : null,
  });
  renderSessions();
});

socket.on('qr', ({ id, dataUrl }) => {
  const prev = sessions.get(id) || { id, status: 'qr' };
  sessions.set(id, { ...prev, status: 'qr', qr: dataUrl });
  renderSessions();
});

socket.on('schedule', ({ id, nextFireAt, multiplier, warmupDay, dailyCap }) => {
  const prev = sessions.get(id);
  if (!prev) return;
  prev.nextFireAt = nextFireAt;
  const changed =
    (multiplier != null && multiplier !== prev.multiplier) ||
    (warmupDay != null && warmupDay !== prev.warmupDay) ||
    (dailyCap != null && dailyCap !== prev.dailyCap);
  if (multiplier != null) prev.multiplier = multiplier;
  if (warmupDay != null) prev.warmupDay = warmupDay;
  if (dailyCap != null) prev.dailyCap = dailyCap;
  const el = document.getElementById('cd-' + id);
  if (el && !changed) el.textContent = countdownText(nextFireAt);
  else renderSessions();
});

socket.on('backoff', ({ id, multiplier }) => {
  const prev = sessions.get(id);
  if (!prev) return;
  prev.multiplier = multiplier;
  renderSessions();
});

socket.on('health', ({ id, healthy }) => {
  const prev = sessions.get(id);
  if (!prev) return;
  prev.healthy = healthy;
  renderSessions();
});

socket.on('removed', ({ id }) => {
  sessions.delete(id);
  renderSessions();
});

socket.on('engine', ({ running }) => {
  setEngine(running);
  renderSessions();
});
socket.on('config', (cfg) => fillConfig(cfg));
socket.on('activity', addActivity);
socket.on('receipt', updateReceipt);
socket.on('log', addLog);
