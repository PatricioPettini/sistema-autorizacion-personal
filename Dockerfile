# Imagen única: compila el frontend + backend y corre el servidor Node.
# El backend sirve el frontend ya compilado y la API en el mismo puerto.
FROM node:22-bookworm-slim

# Herramientas para compilar módulos nativos (better-sqlite3) si no hay binario prebuilt.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalar dependencias (workspaces: backend + frontend) aprovechando la caché de Docker.
COPY package*.json ./
COPY backend/package*.json backend/
COPY frontend/package*.json frontend/
RUN npm install

# Copiar el código y compilar (frontend/dist + backend/dist).
COPY . .
RUN npm run build

ENV NODE_ENV=production
# El disco persistente de Fly se monta en /data (ver fly.toml).
ENV STORAGE_PATH=/data/storage
ENV HOST=0.0.0.0
ENV PORT=8080
ENV TZ=America/Argentina/Buenos_Aires

EXPOSE 8080
CMD ["node", "backend/dist/index.js"]
