#!/usr/bin/env bash
# Mirrors the "PostgreSQL (wal_level=logical)" job in .github/workflows/ci.yml,
# so the real-Postgres realtime + migrator suites can be run locally before
# pushing, instead of burning CI minutes on a private repo to find out.
#
# Known issue on Docker Desktop for Mac: its network virtualization has
# documented trouble with Postgres's logical-replication (COPY BOTH) protocol
# — connections here can fail with "Connection terminated unexpectedly" on
# every attempt even when the exact same suite is green on CI's native Linux
# runner. If every replication test fails immediately (not hangs) on this
# machine, that's this, not a real regression — verify against CI before
# concluding otherwise.
#
# Usage: ./scripts/test-postgres.sh
set -euo pipefail

CONTAINER=indigo-wal-local
PORT=55432
DB=indigo_test

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Starting Postgres 17 (wal_level=logical) on :$PORT"
cleanup # in case a stale container is still around
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB="$DB" \
  -p "$PORT":5432 \
  postgres:17 \
  -c wal_level=logical -c max_replication_slots=4 -c max_wal_senders=4 >/dev/null

echo "==> Waiting for Postgres to accept connections"
ready=false
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo "Postgres did not become ready within 30s." >&2
  docker logs "$CONTAINER" >&2
  exit 1
fi
echo "Postgres is ready."

echo "==> Building workspace"
pnpm build

echo "==> Running real-Postgres realtime + migrator suites (5min cap, mirrors CI)"
export INDIGODB_TEST_DATABASE_URL="postgres://postgres:postgres@localhost:${PORT}/${DB}"
timeout 300 pnpm --filter @indigodb/realtime test
timeout 300 pnpm --filter @indigodb/migrator test

echo "==> All Postgres-backed suites passed."
