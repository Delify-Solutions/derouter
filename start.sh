#!/bin/sh
# Rebuild and restart the local container without taking the service down first.
# Building before stopping means a failed build leaves the old container running.
set -eu

IMAGE=derouter:local
NAME=derouter

echo "Building $IMAGE ..."
docker build -t "$IMAGE" .

echo "Replacing the running container ..."
# -f removes it even if it is running; there is nothing to lose because the image
# is already built and the database lives in the derouter-data volume.
docker rm -f "$NAME" 2>/dev/null || true

docker run -d --name "$NAME" \
  -p 20128:20128 \
  --env-file .env \
  -v derouter-data:/app/data \
  --restart always \
  "$IMAGE"

echo "Waiting for /api/health ..."
i=0
while [ "$i" -lt 30 ]; do
  if docker exec "$NAME" node -e "fetch('http://127.0.0.1:20128/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "Up: http://localhost:20128"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "Container started but /api/health did not answer in 30s. Logs:" >&2
docker logs --tail 40 "$NAME" >&2
exit 1
