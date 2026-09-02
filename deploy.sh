#!/bin/sh
# Приводит живую вики в соответствие с main: пересобирает образ, поднимает
# контейнер заново и подтягивает тексты статей из src/content.js в базу.
#
# Запускается сам после каждого мержа в main (хук scripts/post-merge) и руками:
#   sh deploy.sh
#
# Всё, что зависит от машины, вынесено в переменные: с ними тот же скрипт
# поднимает тестовый контейнер, не трогая живой.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IMAGE=${WIKI_IMAGE:-tgcc-p27/respublique-wiki:latest}
NAME=${WIKI_CONTAINER:-tgcc-p27-wiki}
PORT=${WIKI_PORT:-20030}
DATA=${WIKI_DATA:-$ROOT/data}
MEDIA=${WIKI_MEDIA:-$ROOT/media}

say() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

mkdir -p "$DATA"

# Два мержа подряд — два деплоя одновременно: сборка и docker run передрались бы
# за имя контейнера.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$DATA/deploy.lock"
  flock -w 900 9 || { say "не дождался предыдущего деплоя, выхожу"; exit 1; }
fi

say "деплой $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?') → $NAME"

say "сборка образа $IMAGE"
docker build -t "$IMAGE" "$ROOT"

say "перезапуск контейнера"
docker rm -f "$NAME" >/dev/null 2>&1 || true
# --restart unless-stopped: иначе вики не встаёт после перезагрузки хоста.
docker run -d --name "$NAME" --restart unless-stopped \
  -p "127.0.0.1:$PORT:20030" \
  -e PUBLIC_WIKI=1 -e SECURE_COOKIES=1 \
  -v "$DATA:/data" -v "$MEDIA:/media:ro" \
  "$IMAGE" >/dev/null

# Проверяем изнутри контейнера: снаружи порт слушает только 127.0.0.1, и у
# сессий бота своё сетевое пространство, откуда его не видно.
i=0
until docker exec "$NAME" wget -qO /dev/null "http://127.0.0.1:20030/login" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    say "вики не ответила за 60 секунд, последние строки лога:"
    docker logs --tail 30 "$NAME" 2>&1
    exit 1
  fi
  sleep 1
done
say "вики отвечает"

# Сеялка при старте создаёт только недостающие страницы, поэтому правки текста
# в репозитории доезжают до базы отдельно. Страницы, поправленные руками в вики,
# apply.js не трогает.
say "обновление статей из src/content.js"
docker exec "$NAME" node apply.js --all

# Хук живёт в .git и версией не отслеживается: обновляем его на каждом деплое,
# чтобы правка scripts/post-merge не осталась только в репозитории.
sh "$ROOT/scripts/install-hooks.sh" >/dev/null 2>&1 || say "хук обновить не удалось"

say "готово"
