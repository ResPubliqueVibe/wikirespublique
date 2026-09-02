FROM node:24-alpine

WORKDIR /app

# Зависимости отдельным слоем, чтобы не пересобирать их на каждую правку кода.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js seed.js apply.js ./
COPY src/ ./src/
COPY public/ ./public/

# Ни база, ни картинки статей не лежат в образе: оба каталога монтируются
# снаружи (data/ и media/ из каталога проекта), поэтому пересборка образа их
# не трогает, а новая фотография не требует пересборки вовсе.
ENV DB_FILE=/data/wiki.sqlite \
    MEDIA_DIR=/media \
    PORT=20030 \
    NODE_ENV=production

EXPOSE 20030

# Сеялка идемпотентна: на существующей базе она ничего не трогает.
CMD ["sh", "-c", "node seed.js && node server.js"]
