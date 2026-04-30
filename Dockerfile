FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --include=dev
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# bookworm-slim (glibc) is used over alpine (musl) so better-sqlite3's
# prebuilt binary loads without rebuilding from source. Review item #33.
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
EXPOSE 4021
CMD ["node", "dist/server.js"]
