const fs = require('fs');
const path = require('path');
const pino = require('pino');

// Grava os logs internos do Baileys em arquivo para diagnóstico, sem poluir o
// terminal. Nível padrão 'warn' captura erros de stream e desconexões.
// Suba com LOG_LEVEL=debug (ou trace) para investigar a fundo.
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
const logDir = path.join(dataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });

const level = process.env.LOG_LEVEL || 'warn';
const baileysLogger = pino(
  { level },
  pino.destination({ dest: path.join(logDir, 'baileys.log'), sync: false })
);

module.exports = { baileysLogger, logDir };
