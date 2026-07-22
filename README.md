# 🔥 Aquecimento de Números (WhatsApp)

Sistema para **aquecer números de WhatsApp** fazendo-os conversar entre si de
forma automática e com aparência humana. Os números conectam via **WhatsApp Web**
(protocolo multi-dispositivo, através da biblioteca [Baileys](https://github.com/WhiskeySockets/Baileys),
sem abrir navegador) e são gerenciados por um **painel web**.

> ⚠️ **Aviso.** Automatizar contas com bibliotecas não oficiais viola os Termos de
> Uso do WhatsApp e pode levar ao **banimento** dos números, mesmo com aquecimento.
> Use apenas com números **seus** e por sua conta e risco. Este projeto tem fins
> educacionais.

## Como funciona

- Cada número é uma **sessão** independente (credenciais salvas em `auth/<apelido>/`).
- O **motor de aquecimento** periodicamente escolhe dois números conectados e faz
  um iniciar uma conversa com o outro, usando frases do banco `data/phrases.json`.
- Quem recebe **responde** após um atraso, com o indicador "digitando…" proporcional
  ao tamanho do texto. A conversa dura algumas trocas e então encerra naturalmente.
- Comportamento humanizado: intervalos aleatórios, horário ativo, limite diário por
  número e probabilidade de resposta.

### Novidades do painel

- **Agendamento por número:** cada número tem seu próprio timer. O card mostra uma
  **contagem regressiva** ("Próximo disparo: em 42s") de quando ele vai iniciar a
  próxima conversa.
- **Editar o tempo ao vivo:** a barra *Configurações* altera intervalos, trocas por
  conversa, limite diário e horário ativo. Salva no `config.json` e **reagenda na hora**.
- **Reconectar na mesma instância:** se um número cair ou for deslogado pelo celular,
  o card ganha um botão **Reconectar** (mantém o mesmo apelido; se foi deslogado,
  gera um novo QR na mesma instância).

## Instalação

```bash
npm install
ADMIN_PASSWORD="sua-senha-forte" npm start
```

Abra **http://localhost:3000** — o painel é **restrito a administradores** e pede
login (senha).

### Acesso de administrador

O painel inteiro (página, API e Socket.io) exige autenticação. Defina a senha pela
variável de ambiente **`ADMIN_PASSWORD`** (recomendado). Sem ela, cai para
`config.json → admin.password` e, por último, para `admin` (troque isso!).

- Login em `/login`, cookie de sessão `HttpOnly` válido por 7 dias.
- Botão **Sair** no topo do painel encerra a sessão.
- **Nunca** versione a senha real no `config.json` — use `ADMIN_PASSWORD`.

## Uso

1. No painel, digite um **apelido** para o número (ex.: `numero-01`) e clique em
   *Adicionar*. Um **QR code** vai aparecer no card.
2. No celular: **WhatsApp → Aparelhos conectados → Conectar um aparelho** e escaneie.
3. Repita para todos os números que quiser aquecer (recomendado **2 ou mais**).
4. Quando houver pelo menos 2 conectados, clique em **Iniciar aquecimento**.
5. Acompanhe as conversas em tempo real no painel.

As sessões são restauradas automaticamente ao reiniciar o servidor (não precisa
escanear o QR de novo, a menos que você desconecte pelo celular).

## Configuração — `config.json`

| Campo | Descrição |
|-------|-----------|
| `minIntervalSec` / `maxIntervalSec` | Intervalo aleatório entre disparos **de cada número** (sorteado por número) |
| `minTurns` / `maxTurns` | Quantas trocas (ida e volta) cada conversa tem |
| `replyProbability` | Chance de responder a uma mensagem (0–1) |
| `dailyCapPerNumber` | Máximo de mensagens enviadas por número por dia |
| `activeHours` | Faixa de horas em que o aquecimento roda (ex.: 8–22) |
| `typing` | Parâmetros do atraso de "digitando…" |
| `server.port` | Porta do painel |

Edite as frases em [`data/phrases.json`](data/phrases.json) (`openers`, `replies`,
`followups`) para deixar as conversas com a sua cara.

## Diagnóstico de quedas de conexão

Quando um número cai, o painel mostra o **motivo** no card (ex.: *"Última queda:
código 515 — reinício necessário"*) e registra no feed de atividade. O log interno
detalhado do Baileys fica em **`logs/baileys.log`** (suba o nível com
`LOG_LEVEL=debug npm start` para investigar a fundo).

Códigos de desconexão e o que fazer:

| Código | Significado | O sistema faz | Ação sua |
|-------:|-------------|---------------|----------|
| **515** | Reinício necessário (normal logo após parear) | Reconecta sozinho | Nada |
| **408** | Timeout / conexão perdida (rede/latência) | Reconecta com backoff | Nada |
| **428** | Conexão fechada pelo servidor | Reconecta com backoff | Nada |
| **440** | Conexão substituída (o número abriu outra sessão) | **Não** reconecta | Feche o WhatsApp Web aberto em outro lugar |
| **401** | Deslogado (deslogou pelo celular) | **Não** reconecta | Botão **Reconectar** → novo QR |
| **403** | Proibido (possível bloqueio/ban) | **Não** reconecta | Verifique o número no celular |
| **500** | Sessão corrompida | **Não** reconecta | Botão **Reconectar** → novo QR |

**Robustez implementada:** reconexão automática com *backoff* exponencial (1s, 2s,
4s… até 30s, máx. 8 tentativas), sem sockets duplicados, `keepAlive` a cada 30s e
timeout de *init queries* tolerante — o que elimina o clássico "envia uma mensagem
e cai" causado por timeout `408` em ambiente de datacenter.

**Sobre o `error 463` no envio:** é um erro no *ack* de entrega da mensagem, **não
da conexão** (a sessão continua no ar). Significa que o WhatsApp **recusou entregar**
a mensagem ao destinatário. Se ele aparecer de forma **persistente** e o número de
destino nunca receber (nenhum `[recebido]` no console), é sinal de **bloqueio de
entrega do lado do WhatsApp** — normalmente anti-spam contra automação, comum em
números novos ou já sinalizados. Coisas que ajudam:

- Trocar **algumas mensagens manualmente pelo celular** entre os números antes de
  automatizar (cria histórico legítimo).
- Usar números com **uso humano real** e mais antigos; evitar chips recém-comprados.
- Reduzir bastante o volume (`dailyCapPerNumber` baixo) e o ritmo.
- Se o `463` for constante, aqueles números provavelmente já estão sinalizados —
  não há ajuste de código que force a entrega.

Para conferir se estão realmente conversando, veja no console os pares
`[envio]` / `[recebido]`: só há conversa de verdade quando aparecem **os dois**.

## Dicas para reduzir risco de banimento

- Comece com **poucas mensagens/dia** e aumente gradualmente ao longo de dias.
- Mantenha `activeHours` num período realista (horário comercial/noite).
- Não use números recém-criados em volume alto logo de cara.
- Varie bastante as frases.

## Estrutura

```
config.json            # parâmetros do aquecimento e do servidor
data/phrases.json      # banco de frases
src/server.js          # servidor web + Socket.io (painel em tempo real)
src/warmer/session.js  # uma conexão WhatsApp (Baileys)
src/warmer/manager.js  # gerencia todas as sessões
src/warmer/engine.js   # orquestra as conversas entre os números
public/                # painel web (HTML/CSS/JS)
auth/                  # credenciais das sessões (gerado, fora do git)
```
