FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY prisma ./prisma/
COPY prisma.config.ts ./

# We pass a dummy variable just to satisfy the config validator during build
RUN DIRECT_URL="postgresql://unused" npx prisma generate

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]