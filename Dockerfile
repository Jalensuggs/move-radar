# 异动雷达：一个进程（网页 + 调度），数据在 /data 卷里的一个 SQLite 文件。没有原生依赖，构建很轻。
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_FILE=/data/radar.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY config ./config
COPY src ./src
COPY web ./web

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000

# /healthz 不算"有人在看"，不会让"没人看就暂停模型"失效。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

CMD ["node", "--no-warnings", "src/main.ts"]
