FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# SearXNG connection config
# Can be overridden at runtime with -e SEARXNG_PROTOCOL=<protocol> -e SEARXNG_HOST=<host> -e SEARXNG_PORT=<port>
ENV SEARXNG_PROTOCOL=http
ENV SEARXNG_HOST=localhost
ENV SEARXNG_PORT=8888

# Cache config
ENV CACHE_TTL=600000
ENV MAX_CACHE_SIZE=100

EXPOSE 8888

CMD ["node", "build/index.js"]
