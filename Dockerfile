FROM cloudron/base:4.0.0

RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/code
WORKDIR /app/code

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "/app/code/server.js"]
