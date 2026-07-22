const path = require('path');
const EventEmitter = require('events');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { baileysLogger } = require('../logger');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Tradução dos códigos de desconexão do WhatsApp para algo legível.
const REASONS = {
  [DisconnectReason.loggedOut]: 'deslogado — credenciais inválidas (precisa reparear)',
  [DisconnectReason.restartRequired]: 'reinício necessário (normal após parear)',
  [DisconnectReason.connectionClosed]: 'conexão fechada pelo servidor',
  [DisconnectReason.connectionLost]: 'conexão perdida (rede)',
  [DisconnectReason.connectionReplaced]: 'conexão substituída — o mesmo número abriu outra sessão',
  [DisconnectReason.timedOut]: 'tempo esgotado',
  [DisconnectReason.badSession]: 'sessão corrompida (precisa reparear)',
  [DisconnectReason.multideviceMismatch]: 'incompatibilidade multi-dispositivo (precisa reparear)',
  [DisconnectReason.forbidden]: 'proibido — possível bloqueio/ban do número',
  [DisconnectReason.unavailableService]: 'serviço do WhatsApp indisponível',
};

// Códigos em que NÃO adianta reconectar sozinho (exigem ação do usuário).
const FATAL = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.multideviceMismatch,
  DisconnectReason.forbidden,
  DisconnectReason.connectionReplaced,
]);

const MAX_RECONNECT_ATTEMPTS = 8;

/**
 * Uma conexão de WhatsApp (Baileys). Emite:
 *   'qr'         (qrString)
 *   'status'     (status)
 *   'ready'      ()
 *   'message'    ({ from, text })
 *   'sent'       ({ to, text })
 *   'disconnect' ({ code, reason, willReconnect, attempt, fatal })
 *   'log'        ({ level, text })
 */
class Session extends EventEmitter {
  constructor(id, authRoot, typingCfg) {
    super();
    this.id = id;
    this.authDir = path.join(authRoot, id);
    this.typingCfg = typingCfg;
    this.status = 'disconnected';
    this.qr = null;
    this.number = null;
    this.sock = null;
    this.lastDisconnect = null; // { code, reason, at }
    this._stopping = false;
    this._attempts = 0;
    this._reconnectTimer = null;
    this._presenceTimer = null;
    this._pending = new Map(); // msgId -> { toNumber, timer, gotServerAck }
  }

  async start() {
    this._stopping = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    // encerra socket anterior e seus listeners para não acumular
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      } catch (_) {
        /* noop */
      }
      this.sock = null;
    }

    this.status = 'connecting';
    this.emit('status', this.status);

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false,
      browser: ['Aquecedor', 'Chrome', '1.0.0'],
      markOnlineOnConnect: true, // aparelho aparece online (como aba aberta)
      syncFullHistory: false,
      // --- robustez de conexão (reduz os timeouts 408 em ambiente de datacenter) ---
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 30_000, // ping periódico para manter a sessão viva
      defaultQueryTimeoutMs: undefined, // não derruba por timeout nas init queries
      retryRequestDelayMs: 500,
      emitOwnEvents: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this._onConnectionUpdate(u));
    sock.ev.on('messages.upsert', (m) => this._onMessages(m));
    sock.ev.on('messages.update', (u) => this._onMessagesUpdate(u));
  }

  // mantém o aparelho ativamente online (como uma aba aberta 24/7)
  _startPresence() {
    if (this._presenceTimer) clearInterval(this._presenceTimer);
    const ping = () => {
      try {
        this.sock && this.sock.sendPresenceUpdate('available');
      } catch (_) {
        /* noop */
      }
    };
    ping();
    this._presenceTimer = setInterval(ping, 60000);
  }

  _stopPresence() {
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
  }

  // Rastreia o status de entrega. No timeout distingue:
  //  - chegou ao servidor mas não entregou -> 'pending' (destinatário offline),
  //    NÃO é falha de envio;
  //  - nem chegou ao servidor -> 'undelivered' (recusa/bloqueio real).
  _trackSend(msgId, toNumber) {
    const timer = setTimeout(() => {
      const p = this._pending.get(msgId);
      if (p) {
        this._pending.delete(msgId);
        this.emit('receipt', {
          msgId,
          to: toNumber,
          status: p.gotServerAck ? 'pending' : 'undelivered',
        });
      }
    }, 45000);
    this._pending.set(msgId, { toNumber, timer, gotServerAck: false });
  }

  _onMessagesUpdate(updates) {
    for (const u of updates) {
      const msgId = u.key?.id;
      if (!msgId || !this._pending.has(msgId)) continue;
      const code = u.update?.status;
      if (code == null) continue;
      // WAMessageStatus: 0=erro 1=pendente 2=servidor 3=entregue 4=lido 5=ouvido
      let status = null;
      if (code >= 4) status = 'read';
      else if (code === 3) status = 'delivered';
      else if (code === 2) status = 'sent';
      else if (code === 0) status = 'error';
      if (!status) continue;

      const pending = this._pending.get(msgId);
      if (status === 'sent') pending.gotServerAck = true; // chegou ao servidor
      // status terminais: para de rastrear e limpa o timeout
      if (status === 'delivered' || status === 'read' || status === 'error') {
        clearTimeout(pending.timer);
        this._pending.delete(msgId);
      }
      this.emit('receipt', { msgId, to: pending.toNumber, status });
    }
  }

  _onConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qr = qr;
      this.status = 'qr';
      this.emit('qr', qr);
      this.emit('status', this.status);
    }

    if (connection === 'open') {
      this.qr = null;
      this.status = 'connected';
      this._attempts = 0;
      this.number = jidNormalizedUser(this.sock.user.id).split('@')[0];
      this.emit('status', this.status);
      this.emit('ready');
      this.emit('log', { level: 'info', text: `[${this.id}] conectado (+${this.number})` });
      this._startPresence();
    }

    if (connection === 'close') {
      this._stopPresence();
      this._handleClose(lastDisconnect);
    }
  }

  _handleClose(lastDisconnect) {
    const err = lastDisconnect?.error;
    const code =
      err instanceof Boom ? err.output?.statusCode : err?.output?.statusCode;
    const reason = REASONS[code] || err?.message || 'motivo desconhecido';
    const fatal = code != null && FATAL.has(code);

    this.lastDisconnect = { code: code ?? null, reason, at: Date.now() };

    if (this._stopping) {
      this.status = 'disconnected';
      this.emit('status', this.status);
      return;
    }

    const willReconnect = !fatal && this._attempts < MAX_RECONNECT_ATTEMPTS;

    if (code === DisconnectReason.loggedOut) this.status = 'logged_out';
    else if (fatal) this.status = 'error';
    else this.status = willReconnect ? 'reconnecting' : 'disconnected';

    this.emit('status', this.status);
    this.emit('disconnect', {
      code: code ?? null,
      reason,
      willReconnect,
      attempt: this._attempts,
      fatal,
    });
    this.emit('log', {
      level: fatal ? 'error' : 'warn',
      text: `[${this.id}] caiu — código ${code ?? '?'}: ${reason}${
        willReconnect ? ` · reconectando (tentativa ${this._attempts + 1})` : ''
      }`,
    });

    if (willReconnect) {
      this._attempts += 1;
      // backoff exponencial: 1s, 2s, 4s… até 30s
      const wait = Math.min(30000, 1000 * 2 ** (this._attempts - 1));
      this._reconnectTimer = setTimeout(() => {
        this.start().catch((e) =>
          this.emit('log', { level: 'error', text: `[${this.id}] falha ao reconectar: ${e.message}` })
        );
      }, wait);
    }
  }

  _onMessages({ messages, type }) {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const remoteJid = msg.key.remoteJid || '';
      if (!remoteJid.endsWith('@s.whatsapp.net')) continue;
      const from = remoteJid.split('@')[0];
      const text =
        msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (!text) continue;
      this.emit('message', { from, text });
    }
  }

  async sendHuman(toNumber, text) {
    if (this.status !== 'connected' || !this.sock) {
      throw new Error(`sessão ${this.id} não está conectada`);
    }
    const cfg = this.typingCfg;

    // valida o número e usa o JID canônico devolvido pelo WhatsApp
    // (JID incorreto é causa comum de falha de entrega / ack 463)
    let jid = `${toNumber}@s.whatsapp.net`;
    try {
      const [info] = await this.sock.onWhatsApp(toNumber);
      if (!info?.exists) {
        throw new Error(`${toNumber} não tem WhatsApp`);
      }
      jid = info.jid;
    } catch (e) {
      this.emit('log', { level: 'warn', text: `[${this.id}] onWhatsApp falhou para ${toNumber}: ${e.message}` });
    }

    await this.sock.sendPresenceUpdate('composing', jid);
    const typingMs = Math.min(
      cfg.maxMs,
      cfg.baseMs + text.length * cfg.perCharMs + Math.random() * cfg.readDelayMs
    );
    await delay(typingMs);
    await this.sock.sendPresenceUpdate('paused', jid);
    const sent = await this.sock.sendMessage(jid, { text });
    const msgId = sent?.key?.id || null;
    if (msgId) this._trackSend(msgId, toNumber);
    this.emit('sent', { to: toNumber, text, msgId });
    return msgId;
  }

  async stop() {
    this._stopping = true;
    this._stopPresence();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    for (const { timer } of this._pending.values()) clearTimeout(timer);
    this._pending.clear();
    try {
      if (this.sock) {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      }
    } catch (_) {
      /* noop */
    }
    this.sock = null;
    this.status = 'disconnected';
    this.emit('status', this.status);
  }

  toJSON() {
    return {
      id: this.id,
      status: this.status,
      number: this.number,
      lastDisconnect: this.lastDisconnect,
    };
  }
}

module.exports = { Session };
