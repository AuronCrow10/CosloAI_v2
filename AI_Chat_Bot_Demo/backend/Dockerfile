# STAGE 1: build
FROM node:20-bullseye AS build

WORKDIR /app

COPY package*.json tsconfig.json ./
COPY prisma ./prisma

RUN npm ci

COPY . .

RUN npm run build

# STAGE 2: runtime
FROM node:20-bullseye

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY public ./public

RUN npx prisma generate

EXPOSE 4000

CMD ["node", "dist/index.js"]
