# Cognitum Fugu apicompletions — Cloud Run service (ADR-203 §7.1).
# Mirrors the @cognitum-one/api-gateway Dockerfile (node:20-alpine, port 8080),
# the upstream this service sits behind on api.cognitum.one.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
