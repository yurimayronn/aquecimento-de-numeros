const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { Client, LocalAuth } = require('whatsapp-web.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ACK do whatsapp-web.js -> nosso status de entrega
// -1 erro | 0 pendente | 1 servidor | 2 entregue | 3 lido | 4 ouvido
function ackToStatus(ack) {
  if (ack >= 3) return 'read';
  if (ack === 2) return 'delivered';
  if (ack === 1) return 'sent';
  if (ack === -1) return 'error';
  return null; // 0 = pendente, ainda não confirmou
}

/**
 * Um número de WhatsApp conectado via WhatsApp Web REAL (whatsapp-web.js +
 * Chromium headless). Cada sessão é uma aba do web.whatsapp.com, online 24/7.
 *
 * Mantém a MESMA interface da versão Baileys:
 *   'qr'(qr) 'status'(status) 'ready'() 'message'({from,text})
 *   'sent'({to,text,msgId}) 'receipt'({msgId,to,status})
 *   'disconnect'({code,reason,...}) 'log'({level,text})
 */
class Session extends EventEmitter {
  constructor(id, authRoot, typingCfg) {
    super();
    this.id = id;
    this.authRoot = authRoot;
    this.typingCfg = typingCfg;
    this.status = 'disconnected';
    this.qr = null;
    this.number = null;
    this.client = null;
    this.lastDisconnect = null;
    this._stopping = false;
    this._pending = new Map(); // msgId -> { toNumber, timer, gotServerAck }
    this._presenceTimer = null;
  }

  _authDir() {
    // LocalAuth grava em <authRoot>/session-<id>
    return path.join(this.authRoot, `session-${this.id}`);
  }

  async start() {
    this._stopping = false;
    this.status = 'connecting';
    this.emit('status', this.status);

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: this.id, dataPath: this.authRoot }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--disable-extensions',
        ],
      },
    });
    this.client = client;

    client.on('qr', (qr) => {
      this.qr = qr;
      this.status = 'qr';
      this.emit('qr', qr);
      this.emit('status', this.status);
    });

    client.on('authenticated', () => {
      this.qr = null;
    });

    client.on('auth_failure', (msg) => {
      this.lastDisconnect = { code: 401, reason: 'falha de autenticação (reparear)', at: Date.now() };
      this.status = 'logged_out';
      this.emit('status', this.status);
      this.emit('log', { level: 'error', text: `[${this.id}] falha de autenticação: ${msg}` });
    });

    client.on('ready', () => {
      this.qr = null;
      this.status = 'connected';
      this.number = client.info?.wid?.user || null;
      this.emit('status', this.status);
      this.emit('ready');
      this.emit('log', { level: 'info', text: `[${this.id}] conectado (+${this.number})` });
      this._startPresence();
    });

    client.on('message', (msg) => {
      // só conversa individual, mensagens recebidas
      if (msg.fromMe) return;
      const from = (msg.from || '');
      if (!from.endsWith('@c.us')) return;
      const text = msg.body || '';
      if (!text) return;
      this.emit('message', { from: from.replace('@c.us', ''), text });
    });

    client.on('message_ack', (msg, ack) => {
      const msgId = msg.id?._serialized;
      if (!msgId || !this._pending.has(msgId)) return;
      const status = ackToStatus(ack);
      if (!status) return;
      const pending = this._pending.get(msgId);
      if (status === 'sent') pending.gotServerAck = true;
      if (status === 'delivered' || status === 'read' || status === 'error') {
        clearTimeout(pending.timer);
        this._pending.delete(msgId);
      }
      this.emit('receipt', { msgId, to: pending.toNumber, status });
    });

    client.on('disconnected', (reason) => this._handleDisconnected(reason));

    try {
      await client.initialize();
    } catch (e) {
      this.emit('log', { level: 'error', text: `[${this.id}] erro ao iniciar navegador: ${e.message}` });
      this._handleDisconnected('INIT_ERROR');
    }
  }

  // mantém o aparelho ativamente online (aba aberta)
  _startPresence() {
    if (this._presenceTimer) clearInterval(this._presenceTimer);
    const ping = () => {
      try {
        this.client && this.client.sendPresenceAvailable();
      } catch (_) {
        /* noop */
      }
    };
    ping();
    this._presenceTimer = setInterval(ping, 60000);
  }

  _handleDisconnected(reason) {
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
    const loggedOut = reason === 'LOGOUT' || reason === 'UNPAIRED' || reason === 'UNPAIRED_DEVICE';
    this.lastDisconnect = { code: loggedOut ? 401 : null, reason: String(reason), at: Date.now() };

    if (this._stopping) {
      this.status = 'disconnected';
      this.emit('status', this.status);
      return;
    }

    if (loggedOut) {
      this.status = 'logged_out';
      this.emit('status', this.status);
      this.emit('disconnect', { code: 401, reason: String(reason), willReconnect: false, fatal: true });
      this.emit('log', { level: 'error', text: `[${this.id}] deslogado (${reason}) — precisa reparear` });
      return;
    }

    this.status = 'reconnecting';
    this.emit('status', this.status);
    this.emit('disconnect', { code: null, reason: String(reason), willReconnect: true, fatal: false });
    this.emit('log', { level: 'warn', text: `[${this.id}] caiu (${reason}) — reconectando` });
    // recria o cliente após um instante
    setTimeout(() => {
      if (this._stopping) return;
      this._destroyClient().finally(() =>
        this.start().catch((e) =>
          this.emit('log', { level: 'error', text: `[${this.id}] falha ao reconectar: ${e.message}` })
        )
      );
    }, 4000);
  }

  async _destroyClient() {
    try {
      if (this.client) await this.client.destroy();
    } catch (_) {
      /* noop */
    }
    this.client = null;
  }

  _trackSend(msgId, toNumber) {
    const timer = setTimeout(() => {
      const p = this._pending.get(msgId);
      if (p) {
        this._pending.delete(msgId);
        // chegou ao servidor mas não entregou = destinatário offline ('pending');
        // nem chegou ao servidor = recusa real ('undelivered')
        this.emit('receipt', {
          msgId,
          to: toNumber,
          status: p.gotServerAck ? 'pending' : 'undelivered',
        });
      }
    }, 45000);
    this._pending.set(msgId, { toNumber, timer, gotServerAck: false });
  }

  async sendHuman(toNumber, text) {
    if (this.status !== 'connected' || !this.client) {
      throw new Error(`sessão ${this.id} não está conectada`);
    }
    const chatId = `${toNumber}@c.us`;
    const cfg = this.typingCfg;

    // valida o número
    try {
      const numId = await this.client.getNumberId(toNumber);
      if (!numId) throw new Error(`${toNumber} não tem WhatsApp`);
    } catch (e) {
      this.emit('log', { level: 'warn', text: `[${this.id}] verificação de ${toNumber} falhou: ${e.message}` });
    }

    // simula digitação
    try {
      const chat = await this.client.getChatById(chatId);
      await chat.sendStateTyping();
      const typingMs = Math.min(
        cfg.maxMs,
        cfg.baseMs + text.length * cfg.perCharMs + Math.random() * cfg.readDelayMs
      );
      await delay(typingMs);
      await chat.clearState();
    } catch (_) {
      /* se falhar o "digitando", segue e envia mesmo assim */
    }

    const sent = await this.client.sendMessage(chatId, text);
    const msgId = sent?.id?._serialized || null;
    if (msgId) this._trackSend(msgId, toNumber);
    this.emit('sent', { to: toNumber, text, msgId });
    return msgId;
  }

  async stop() {
    this._stopping = true;
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
    for (const { timer } of this._pending.values()) clearTimeout(timer);
    this._pending.clear();
    await this._destroyClient();
    this.status = 'disconnected';
    this.emit('status', this.status);
  }

  // apaga as credenciais desta sessão (para remover/reparear do zero)
  clearAuth() {
    fs.rmSync(this._authDir(), { recursive: true, force: true });
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
