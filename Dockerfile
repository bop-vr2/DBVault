FROM node:20-slim

# Install mysqldump + mysql client (same version as your Aiven MySQL)
RUN apt-get update && apt-get install -y \
    default-mysql-client \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

# Railway injects PORT automatically
EXPOSE 3000

CMD ["node", "server.js"]
