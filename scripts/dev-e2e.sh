#!/bin/sh
set -u
IMAGE="prompt-theater:e2e"
NET="prompt-theater-e2e"
DB="prompt-theater-db-e2e"
APP="prompt-theater-app-e2e"
pass(){ printf 'PASS %s\n' "$1"; }
fail(){ printf 'FAIL %s\n' "$1"; docker logs "$APP" 2>/dev/null | tail -100; exit 1; }
cleanup(){ docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
cleanup
docker build -t "$IMAGE" . || fail 'docker build'
pass 'docker build'
docker network create "$NET" >/dev/null || fail 'network create'
docker run -d --name "$DB" --network "$NET" -e POSTGRES_USER=prompt -e POSTGRES_PASSWORD=prompt -e POSTGRES_DB=prompt postgres:16-alpine >/dev/null || fail 'postgres start'
for i in $(seq 1 30); do docker exec "$DB" pg_isready -U prompt >/dev/null 2>&1 && break; sleep 1; done
docker run -d --name "$APP" --network "$NET" -p 3000:3000 -e DATABASE_URL=postgres://prompt:prompt@${DB}:5432/prompt -e FAL_FAKE=1 -e SCENE_SECONDS=15 -e STRIPE_SECRET_KEY=sk_test_placeholder -e STRIPE_WEBHOOK_SECRET=whsec_e2e_secret -e PUBLIC_URL=http://127.0.0.1:3000 -e DATA_DIR=/data "$IMAGE" >/dev/null || fail 'app start'
for i in $(seq 1 40); do curl -fsS http://127.0.0.1:3000/ >/dev/null 2>&1 && break; sleep 1; done
docker run --rm --network "$NET" -e DATABASE_URL=postgres://prompt:prompt@${DB}:5432/prompt -e E2E_URL=http://${APP}:3000 -e STRIPE_WEBHOOK_SECRET=whsec_e2e_secret "$IMAGE" node scripts/e2e-runner.mjs || fail 'integration path'
pass 'full integration path'
docker run --rm "$IMAGE" npm test || fail 'unit tests'
pass 'unit tests'
