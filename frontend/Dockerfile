# syntax=docker/dockerfile:1
# DocuMind frontend: Vite production build served as static assets by an unprivileged Nginx.
# The public edge proxy (deploy/nginx) routes "/" here and "/api" to the API — this image
# never proxies API traffic and knows nothing about internal services.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src ./src
# Same-origin API path; never a localhost URL.
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

FROM nginx:1.27-alpine AS runtime
# Run as the unprivileged nginx user on port 8080.
RUN rm -f /etc/nginx/conf.d/default.conf \
 && mkdir -p /var/cache/nginx /tmp/nginx \
 && chown -R nginx:nginx /var/cache/nginx /tmp/nginx /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/index.html || exit 1
STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
