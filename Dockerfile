# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# package-lock の eris は git+ssh 指定なので HTTPS で取得させる
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/ \
 && npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node
CMD ["node", "index.js"]
