# Multi-stage build for Railway / any container platform.
# Stage 1: install all deps + compile TypeScript.
# Stage 2: ship only production deps + compiled JS.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Re-install only production deps (smaller final image).
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Railway injects PORT; fall back to 3001 for local docker runs.
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/index.js"]
