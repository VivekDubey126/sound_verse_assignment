FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY knexfile.ts ./
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY knexfile.ts ./
RUN mkdir -p data/audio
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/src/index.js"]

