# Imagem para deploy always-on (EasyPanel / Docker / VPS)
FROM node:20-slim

WORKDIR /app

# instala só as dependências de produção primeiro (melhor cache)
COPY package*.json ./
RUN npm ci --omit=dev

# copia o restante do código
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# diretório de dados persistentes — monte um volume aqui no EasyPanel.
# Usa /data (fora de /app) para não colidir com a pasta data/ do app (phrases.json).
ENV DATA_DIR=/data

EXPOSE 3000

# cria o diretório de dados (será sobreposto pelo volume montado)
RUN mkdir -p /data

CMD ["node", "src/server.js"]
