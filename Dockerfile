# Development / preview image for roll-fem-lab.
# Everything (node, npm cache, node_modules) stays inside the container so the
# host stays clean.
FROM node:22-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false CI=true

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# --- live dev server with hot reload ---
FROM deps AS dev
COPY . .
EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173"]

# --- static production build ---
FROM deps AS build
COPY . .
RUN npx vite build

FROM nginx:alpine AS serve
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
