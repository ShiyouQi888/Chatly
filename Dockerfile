FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci \
  && npm install --no-save --package-lock=false @rollup/rollup-linux-x64-gnu@4.64.2

COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
COPY shared ./shared
ARG VITE_TMAP_KEY=
ENV VITE_TMAP_KEY=${VITE_TMAP_KEY}
RUN npm run build

FROM nginx:alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
