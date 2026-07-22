const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { Session } = require('./session');

/**
 * Gerencia o conjunto de sessões (números). Persiste a lista de IDs em
 * sessions.json para restaurar automaticamente após reiniciar o processo.
 *
 * Reemite os eventos de cada sessão com o id embutido:
 *   'qr'      ({ id, qr })
 *   'status'  ({ id, status, number })
 *   'message' ({ id, from, text })
 *   'sent'    ({ id, to, text })
 */
class SessionManager extends EventEmitter {
  constructor({ authRoot, sessionsFile, typingCfg }) {
    super();
    this.authRoot = authRoot;
    this.sessionsFile = sessionsFile;
    this.typingCfg = typingCfg;
    this.warmupFile = path.join(path.dirname(sessionsFile), 'warmup.json');
    this.sessions = new Map(); // id -> Session
    this.warmup = this._loadWarmup(); // id -> timestamp de início do aquecimento
    fs.mkdirSync(authRoot, { recursive: true });
  }

  _persistIds() {
    const ids = [...this.sessions.keys()];
    fs.writeFileSync(this.sessionsFile, JSON.stringify(ids, null, 2));
  }

  _loadWarmup() {
    try {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(this.warmupFile, 'utf8'))));
    } catch (_) {
      return new Map();
    }
  }

  _persistWarmup() {
    fs.writeFileSync(this.warmupFile, JSON.stringify(Object.fromEntries(this.warmup), null, 2));
  }

  /** Timestamp (ms) em que o número começou a aquecer, para a rampa progressiva. */
  warmupStart(id) {
    return this.warmup.get(id) || null;
  }

  _loadIds() {
    try {
      return JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
    } catch (_) {
      return [];
    }
  }

  /** Restaura sessões salvas anteriormente. */
  async restore() {
    for (const id of this._loadIds()) {
      await this.addSession(id, { persist: false, silentIfExists: true });
    }
    this._persistIds();
  }

  async addSession(id, { persist = true, silentIfExists = false } = {}) {
    id = String(id).trim();
    if (!id) throw new Error('id vazio');
    if (this.sessions.has(id)) {
      if (silentIfExists) return this.sessions.get(id);
      throw new Error(`Sessão "${id}" já existe`);
    }

    const session = new Session(id, this.authRoot, this.typingCfg);
    session.on('qr', (qr) => this.emit('qr', { id, qr }));
    session.on('status', (status) =>
      this.emit('status', {
        id,
        status,
        number: session.number,
        lastDisconnect: session.lastDisconnect,
      })
    );
    session.on('message', ({ from, text }) =>
      this.emit('message', { id, from, text })
    );
    session.on('sent', ({ to, text }) => this.emit('sent', { id, to, text }));
    session.on('receipt', (r) => this.emit('receipt', { id, ...r }));
    session.on('disconnect', (info) => this.emit('disconnect', { id, ...info }));
    session.on('log', (entry) => this.emit('log', { id, ...entry }));
    session.on('error', (err) => this.emit('sessionError', { id, err }));

    this.sessions.set(id, session);
    if (persist) this._persistIds();

    // marca o início do aquecimento (só na primeira vez; nunca sobrescreve)
    if (!this.warmup.has(id)) {
      this.warmup.set(id, Date.now());
      this._persistWarmup();
    }

    await session.start();
    return session;
  }

  /**
   * Reconecta uma sessão existente na MESMA instância (mesmo apelido).
   * - Se foi apenas desconectada, reaproveita as credenciais e reconecta.
   * - Se foi deslogada (removida pelo celular), limpa as credenciais e gera
   *   um novo QR code no mesmo card.
   */
  async reconnect(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Sessão "${id}" não existe`);

    const wasLoggedOut = session.status === 'logged_out';
    await session.stop();
    if (wasLoggedOut) {
      fs.rmSync(path.join(this.authRoot, id), { recursive: true, force: true });
    }
    await session.start();
    return session;
  }

  async removeSession(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    await session.stop();
    this.sessions.delete(id);
    this._persistIds();
    // reinicia a rampa: se readicionar, o número volta a aquecer do zero
    this.warmup.delete(id);
    this._persistWarmup();
    // remove credenciais do disco
    fs.rmSync(path.join(this.authRoot, id), { recursive: true, force: true });
    this.emit('removed', { id });
  }

  get(id) {
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()].map((s) => s.toJSON());
  }

  connected() {
    return [...this.sessions.values()].filter(
      (s) => s.status === 'connected' && s.number
    );
  }

  /** Todos os números próprios atualmente conectados. */
  connectedNumbers() {
    return new Set(this.connected().map((s) => s.number));
  }

  /** Encontra a sessão dona de um número (ex.: para saber quem recebeu). */
  byNumber(number) {
    return this.connected().find((s) => s.number === number);
  }
}

module.exports = { SessionManager };
