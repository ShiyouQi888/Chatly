FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3002 \
    HOST=0.0.0.0
WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src
COPY server/assets/seed ./assets/seed
COPY shared /shared
RUN mkdir -p /app/uploads /app/private-uploads \
  && chown -R node:node /app

USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3002/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["npm", "start"]
