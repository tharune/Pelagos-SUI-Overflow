# Multi-stage build for Railway / any container platform.
# Stage 1: install all deps + compile TypeScript.
# Stage 2: ship only production deps + compiled JS.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Re-install only production deps (smaller final image).
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The monitor's static HTML isn't compiled by tsc — copy it next to the compiled
# dist/monitor/server.js, which reads ./monitor.html via path.join(__dirname,...).
# Without this the monitor served the degraded inline placeholder in-container.
COPY --from=build /app/src/monitor/monitor.html ./dist/monitor/monitor.html
# The app binds config.port = process.env.PORT || 13101 (see src/config/index.ts).
# Default PORT and EXPOSE to that same 13101 so the documented port, the bound
# port, and the Akash SDL `port:` all agree. (Audit fix: was EXPOSE 3001 while
# the app actually listened on 13101.) Akash / Railway inject their own PORT,
# which overrides this default at runtime — and the app honors it.
ENV PORT=13101
EXPOSE 13101
CMD ["node", "dist/index.js"]
