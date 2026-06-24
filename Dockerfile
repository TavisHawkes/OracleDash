# syntax=docker/dockerfile:1.7
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Create required directories for Cloudron
RUN mkdir -p /app/data /tmp

# Set environment
ENV NODE_ENV=production

EXPOSE 3000

USER node

CMD ["node", "server.js"]
