# Deploy no EasyPanel (Hostinger)

Este app é **always-on** (mantém conexões WebSocket com o WhatsApp, estado em
memória e arquivos em disco). Por isso **não** roda em serverless (Vercel/Netlify).
No EasyPanel roda perfeitamente, via Docker + volume persistente.

## Pré-requisitos

- Um VPS com **EasyPanel** instalado (na Hostinger, o template de EasyPanel já faz isso).
- O código num repositório **GitHub** (recomendado) ou usando o Dockerfile deste projeto.

## Passo a passo

### 1. Suba o código para o GitHub
```bash
git add .
git commit -m "Aquecedor de números"
git push
```
> O `.gitignore` já evita subir `auth/`, `logs/`, `sessions.json` e `node_modules/`.

### 2. Crie o serviço no EasyPanel
1. **Create → App**.
2. Em **Source**, escolha:
   - **GitHub** e selecione o repositório (build automático pelo Dockerfile), ou
   - **Dockerfile** apontando para este projeto.
3. O EasyPanel detecta o `Dockerfile` e faz o build.

### 3. Variáveis de ambiente (Environment)
Adicione:
| Variável | Valor | Para quê |
|---|---|---|
| `ADMIN_PASSWORD` | *(uma senha forte sua)* | senha do painel |
| `DATA_DIR` | `/data` | onde ficam auth/sessions/logs |
| `PORT` | `3000` | porta interna (já é o padrão) |
| `TZ` | `America/Sao_Paulo` | horário correto para o "horário ativo" |

### 4. Volume persistente (ESSENCIAL)
Sem isso, os números **desconectam a cada redeploy** (perde o `auth/`).

- Em **Mounts / Volumes**, crie um **Volume**:
  - **Mount Path:** `/data`
- Salve. É aqui que ficam `auth/`, `sessions.json`, `logs/` e o `config.json`
  editado pelo painel.

### 5. Porta e domínio
- Em **Domains**, aponte um domínio/subdomínio para a porta **3000**.
- O EasyPanel provisiona **HTTPS** automaticamente (importante: o cookie de login
  e o WhatsApp Web funcionam melhor sob HTTPS).

### 6. Deploy
- Clique em **Deploy**. Acompanhe os logs do build/runtime no EasyPanel.
- Acesse o domínio → tela de **login** → entre com a `ADMIN_PASSWORD`.
- Adicione os números e escaneie os QR codes.

## Atualizações
- `git push` → no EasyPanel clique em **Deploy** (ou ative auto-deploy).
- Como `auth/` está no volume, os números **continuam conectados** após o redeploy.

## ⚠️ Aviso importante sobre entrega (error 463)

Rodar de um **datacenter** (qualquer VPS) faz o WhatsApp desconfiar mais e pode
**agravar** a recusa de entrega (`error 463`) que já diagnosticamos — IPs de
datacenter são mais sinalizados que residenciais. O deploy resolve o "ficar online
24/7", mas **não** garante a entrega das mensagens. Se o `463` persistir, o
problema é anti-spam do WhatsApp, não do servidor (veja a seção de diagnóstico no
[README](README.md)).
