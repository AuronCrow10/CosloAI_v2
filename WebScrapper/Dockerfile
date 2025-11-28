# STAGE 1: build su immagine Playwright
FROM mcr.microsoft.com/playwright:v1.56.1-jammy AS build

WORKDIR /app

COPY package*.json tsconfig.json ./

RUN npm ci

COPY . .

RUN npm run build

# STAGE 2: runtime, stessa immagine Playwright
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app
ENV NODE_ENV=production

# 🔴 QUI: copiamo anche package.json, così Node vede "type": "module"
COPY --from=build /app/package*.json ./

# codice compilato + node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules

EXPOSE 3001

CMD ["node", "dist/server.js"]
