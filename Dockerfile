FROM cloudron/base:4.0.0

RUN mkdir -p /app/code
WORKDIR /app/code

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["/usr/local/bin/node", "/app/code/server.js"]
