# Use the lightweight Alpine version of Node
FROM node:20-alpine

# Set the working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy Prisma schema and config
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Generate Prisma Client (Crucial for Prisma 7)
RUN npx prisma generate

# Copy the rest of your application code
COPY . .

# Expose the port for Render's health check
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]