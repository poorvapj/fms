# FMS Operations backend (API). Used by Render (Docker runtime): Root Directory = backend.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# Install only runtime dependencies (TypeScript runs natively on Node 24; test tools are not needed)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
# Render provides PORT; settings (MONGODB_URI_LIVE, JWT_SECRET) come from Render's Environment
EXPOSE 10000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/env.ts", "live", "src/index.ts"]
