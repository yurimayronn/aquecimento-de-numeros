const EventEmitter = require('events');

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pairKey = (a, b) => [a, b].sort().join('|');

/**
 * Motor de aquecimento. Cada número conectado tem seu PRÓPRIO agendamento:
 * de tempos em tempos ele inicia uma conversa com outro número. Quem recebe
 * responde por algumas trocas.
 *
 * Eventos:
 *   'state'    ({ running })
 *   'schedule' ({ id, nextFireAt })   -> quando um número será disparado (ms epoch)
 *   'activity' ({ type, from, to, text, time })
 *   'config'   (cfg)                  -> configuração de aquecimento alterada
 */
class WarmingEngine extends EventEmitter {
  constructor(manager, phrases, cfg) {
    super();
    this.manager = manager;
    this.phrases = phrases;
    this.cfg = cfg;
    this.running = false;

    this.schedules = new Map(); // id -> { nextFireAt, timer }
    this.conversations = new Map(); // pairKey -> { turnsRemaining }
    this.dailyCount = new Map(); // number -> count
    this.health = new Map(); // id -> { multiplier, fails } (auto-regulação de ritmo)
    this._day = new Date().getDate();

    this.manager.on('message', (evt) => this._onIncoming(evt));
    this.manager.on('status', ({ id, status }) => this._onStatus(id, status));
    this.manager.on('receipt', (evt) => this._onReceipt(evt));
  }

  // Ritmo adaptativo: cada número tem um multiplicador de intervalo.
  // Falha na entrega -> aumenta (dispara mais devagar).
  // Entrega com sucesso -> diminui (volta ao aquecimento normal).
  _health(id) {
    let h = this.health.get(id);
    if (!h) {
      h = { multiplier: 1, fails: 0 };
      this.health.set(id, h);
    }
    return h;
  }

  // Um número é "saudável" enquanto não acumula falhas de entrega demais.
  // Números com erro não são usados como alvo de conversa (nem recebem
  // respostas), e só voltam a ser "bons" quando uma entrega tem sucesso.
  isHealthy(id) {
    const h = this.health.get(id);
    if (!h) return true; // sem histórico = saudável
    return h.fails < (this.cfg.unhealthyAfterFails || 3);
  }

  healthyConnected() {
    return this.manager.connected().filter((s) => this.isHealthy(s.id));
  }

  // avisa (no máx. 1x/min) quando não há números saudáveis suficientes
  _warnNoHealthyPair() {
    const now = Date.now();
    if (this._lastNoPairWarn && now - this._lastNoPairWarn < 60000) return;
    this._lastNoPairWarn = now;
    this.emit('log', {
      level: 'warn',
      text: `aquecimento pausado: são necessários ao menos 2 números saudáveis (há ${this.healthyConnected().length})`,
    });
  }

  _onReceipt({ id, status }) {
    const h = this._health(id);
    const before = h.multiplier;
    const wasHealthy = this.isHealthy(id);
    const factor = this.cfg.backoffFactor || 2;
    const max = this.cfg.maxBackoff || 16;

    if (status === 'delivered' || status === 'read') {
      h.fails = 0;
      if (h.multiplier > 1) h.multiplier = Math.max(1, h.multiplier / factor);
    } else if (status === 'undelivered' || status === 'error') {
      h.fails += 1;
      h.multiplier = Math.min(max, Math.max(factor, h.multiplier * factor));
    } else {
      return; // 'sent' (só chegou no servidor) não altera o ritmo
    }

    if (h.multiplier !== before) {
      this.emit('backoff', {
        id,
        multiplier: h.multiplier,
        direction: h.multiplier > before ? 'up' : 'down',
      });
      if (this.running && this.manager.get(id)?.status === 'connected') {
        this._schedule(id);
      }
    }

    const nowHealthy = this.isHealthy(id);
    if (nowHealthy !== wasHealthy) {
      this.emit('health', { id, healthy: nowHealthy, healthyCount: this.healthyConnected().length });
    }
  }

  // ---------- ciclo de vida ----------
  start() {
    if (this.running) return;
    this.running = true;
    for (const s of this.manager.connected()) this._schedule(s.id);
    this.emit('state', { running: true });
  }

  stop() {
    this.running = false;
    for (const { timer } of this.schedules.values()) clearTimeout(timer);
    this.schedules.clear();
    this.emit('state', { running: false });
  }

  _onStatus(id, status) {
    if (!this.running) return;
    if (status === 'connected') this._schedule(id);
    else this._clear(id);
  }

  /** Atualiza parâmetros em tempo real e reagenda os timers ativos. */
  updateConfig(patch) {
    const numeric = ['minIntervalSec', 'maxIntervalSec', 'minTurns', 'maxTurns', 'dailyCapPerNumber', 'backoffFactor', 'maxBackoff', 'unhealthyAfterFails'];
    for (const k of numeric) {
      if (patch[k] != null) this.cfg[k] = Number(patch[k]);
    }
    if (patch.replyProbability != null) this.cfg.replyProbability = Number(patch.replyProbability);
    if (patch.activeHours) this.cfg.activeHours = patch.activeHours;

    if (this.cfg.maxIntervalSec < this.cfg.minIntervalSec) {
      this.cfg.maxIntervalSec = this.cfg.minIntervalSec;
    }

    if (this.running) {
      for (const id of [...this.schedules.keys()]) this._schedule(id);
    }
    this.emit('config', this.cfg);
    return this.cfg;
  }

  // ---------- agendamento por número ----------
  _clear(id) {
    const sch = this.schedules.get(id);
    if (sch) clearTimeout(sch.timer);
    this.schedules.delete(id);
    this.emit('schedule', { id, nextFireAt: null });
  }

  _schedule(id) {
    const existing = this.schedules.get(id);
    if (existing) clearTimeout(existing.timer);

    // ritmo = o mais lento entre a rampa de aquecimento e o ritmo adaptativo
    const warmupMult = this._warmupMultiplier(id);
    const healthMult = this._health(id).multiplier;
    const multiplier = Math.max(warmupMult, healthMult);
    const base = randInt(this.cfg.minIntervalSec, this.cfg.maxIntervalSec);
    const secs = Math.round(base * multiplier);
    const nextFireAt = Date.now() + secs * 1000;
    const timer = setTimeout(() => this._fire(id), secs * 1000);
    this.schedules.set(id, { nextFireAt, timer });
    this.emit('schedule', {
      id,
      nextFireAt,
      multiplier: +multiplier.toFixed(2),
      warmupDay: this.warmupDay(id),
      dailyCap: this.effectiveDailyCap(id),
    });
  }

  async _fire(id) {
    if (!this.running) return;
    try {
      await this._initiateFrom(id);
    } catch (e) {
      this.emit('error', e);
    } finally {
      const s = this.manager.get(id);
      if (this.running && s && s.status === 'connected') this._schedule(id);
      else this._clear(id);
    }
  }

  // ---------- lógica de conversa ----------
  _resetDailyIfNeeded() {
    const today = new Date().getDate();
    if (today !== this._day) {
      this._day = today;
      this.dailyCount.clear();
    }
  }

  _withinActiveHours() {
    const { start, end } = this.cfg.activeHours;
    const h = new Date().getHours();
    return h >= start && h < end;
  }

  // ---------- rampa progressiva (aquecimento gradual de números novos) ----------
  _warmupProgress(id) {
    const w = this.cfg.warmup;
    if (!w || !w.enabled) return 1;
    const start = this.manager.warmupStart ? this.manager.warmupStart(id) : null;
    if (!start) return 1;
    const days = (Date.now() - start) / 86400000;
    return Math.min(1, days / (w.rampDays || 14));
  }

  warmupDay(id) {
    const start = this.manager.warmupStart ? this.manager.warmupStart(id) : null;
    if (!start) return null;
    return Math.floor((Date.now() - start) / 86400000) + 1; // dia 1 = primeiro dia
  }

  /** Limite diário efetivo: começa baixo e sobe até o máximo ao longo da rampa. */
  effectiveDailyCap(id) {
    const max = this.cfg.dailyCapPerNumber;
    const w = this.cfg.warmup;
    if (!w || !w.enabled) return max;
    const startCap = w.startDailyCap || 8;
    return Math.round(startCap + (max - startCap) * this._warmupProgress(id));
  }

  /** Multiplicador de intervalo por rampa: começa lento (ex.: 3x) e cai até 1x. */
  _warmupMultiplier(id) {
    const w = this.cfg.warmup;
    if (!w || !w.enabled) return 1;
    const s = w.startIntervalMult || 3;
    return s - (s - 1) * this._warmupProgress(id);
  }

  _canSend(id, number) {
    this._resetDailyIfNeeded();
    return (this.dailyCount.get(number) || 0) < this.effectiveDailyCap(id);
  }

  _countSend(number) {
    this.dailyCount.set(number, (this.dailyCount.get(number) || 0) + 1);
  }

  async _initiateFrom(id) {
    const sender = this.manager.get(id);
    if (!sender || sender.status !== 'connected') return;
    if (!this._withinActiveHours()) return;
    if (!this._canSend(id, sender.number)) return;

    // Precisa de pelo menos 2 números saudáveis para aquecer.
    // Alvos: apenas números saudáveis (bom conversa com bom), nunca números
    // com erro de envio.
    const healthy = this.healthyConnected();
    if (healthy.length < 2) {
      this._warnNoHealthyPair();
      return;
    }
    const targets = healthy.filter((s) => s.number !== sender.number);
    if (targets.length === 0) return;
    const target = choice(targets);

    const key = pairKey(sender.number, target.number);
    const existing = this.conversations.get(key);
    // só bloqueia se houver uma conversa ATIVA e RECENTE (evita travar o par
    // para sempre quando uma conversa fica sem resposta)
    const ttlMs = (this.cfg.conversationTtlSec || 240) * 1000;
    if (
      existing &&
      existing.turnsRemaining > 0 &&
      Date.now() - existing.updatedAt < ttlMs
    ) {
      return;
    }

    this.conversations.set(key, {
      turnsRemaining: randInt(this.cfg.minTurns, this.cfg.maxTurns),
      updatedAt: Date.now(),
    });

    const text = choice(this.phrases.openers);
    await this._deliver(sender, target.number, text, 'opener');
  }

  async _onIncoming({ id, from }) {
    if (!this.running) return;
    const receiver = this.manager.get(id);
    if (!receiver || receiver.status !== 'connected') return;
    if (!this.manager.connectedNumbers().has(from)) return; // só entre números aquecidos

    // não responder (não enviar) para números com erro de envio
    const fromSession = this.manager.byNumber(from);
    if (fromSession && !this.isHealthy(fromSession.id)) return;

    const key = pairKey(receiver.number, from);
    const convo = this.conversations.get(key);
    if (!convo || convo.turnsRemaining <= 0) return;
    if (!this._withinActiveHours()) return;
    if (!this._canSend(id, receiver.number)) return;

    if (Math.random() > this.cfg.replyProbability) {
      this.conversations.delete(key); // às vezes não responde; encerra o par
      return;
    }

    convo.turnsRemaining -= 1;
    convo.updatedAt = Date.now();
    const closing = convo.turnsRemaining <= 0;
    if (closing) this.conversations.delete(key); // libera o par para novas conversas
    const pool = closing
      ? this.phrases.followups
      : this.phrases.replies.concat(this.phrases.followups);
    const text = choice(pool);

    await new Promise((r) => setTimeout(r, randInt(1500, 6000)));
    await this._deliver(receiver, from, text, closing ? 'closing' : 'reply');
  }

  async _deliver(senderSession, toNumber, text, kind) {
    try {
      const msgId = await senderSession.sendHuman(toNumber, text);
      this._countSend(senderSession.number);
      this.emit('activity', {
        type: kind,
        from: senderSession.number,
        to: toNumber,
        text,
        time: Date.now(),
        msgId,
      });
    } catch (e) {
      this.emit('error', e);
    }
  }

  // ---------- introspecção p/ o painel ----------
  scheduleFor(id) {
    return this.schedules.get(id)?.nextFireAt || null;
  }

  multiplierFor(id) {
    return this.health.get(id)?.multiplier || 1;
  }

  status() {
    return {
      running: this.running,
      config: this.cfg,
      schedules: Object.fromEntries(
        [...this.schedules.entries()].map(([id, s]) => [id, s.nextFireAt])
      ),
      multipliers: Object.fromEntries(
        [...this.health.entries()].map(([id, h]) => [id, h.multiplier])
      ),
      healthyCount: this.healthyConnected().length,
      dailyCounts: Object.fromEntries(this.dailyCount),
    };
  }
}

module.exports = { WarmingEngine };
