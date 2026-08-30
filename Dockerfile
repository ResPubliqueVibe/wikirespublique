FROM node:24-alpine

WORKDIR /app

# Зависимости отдельным слоем, чтобы не пересобирать их на каждую правку кода.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js seed.js ./
COPY src/ ./src/
COPY public/ ./public/

# База лежит в томе, а не в образе.
ENV DB_FILE=/data/wiki.sqlite \
    PORT=20030 \
    NODE_ENV=production
VOLUME /data

EXPOSE 20030

# Сеялка идемпотентна: на существующей базе она ничего не трогает.
CMD ["sh", "-c", "node seed.js && node server.js"]
