#!/bin/sh
# Install the chart into the cluster kubectl points at, cold, with two app replicas and the
# throwaway Postgres, and check what a self-hoster would: both replicas become ready (they race for
# the migration lock), the readiness endpoint answers, and agent setup is stamped with the
# configured address rather than the build's.
#
#   sh charts/smoke.sh <image-repository> <image-tag>      # the image must already be on the nodes
set -eu

REPO="${1:?usage: smoke.sh <image-repository> <image-tag>}"
TAG="${2:?usage: smoke.sh <image-repository> <image-tag>}"
CHART="$(dirname "$0")/on-my-radar"
NS=omr-smoke
# Not the Dockerfile's default (http://localhost:3500): the check below must not pass by accident.
PUBLIC_URL=https://omr.smoke.example.test
PF_PID=

cleanup() { [ -z "$PF_PID" ] || kill "$PF_PID" 2>/dev/null || true; }
trap cleanup EXIT
diagnose() {
  echo "--- pods"; kubectl -n "$NS" get pods -o wide || true
  echo "--- events"; kubectl -n "$NS" get events --sort-by=.lastTimestamp | tail -30 || true
  echo "--- app logs"; kubectl -n "$NS" logs -l app.kubernetes.io/component=app --all-containers --tail=60 || true
  echo "--- worker logs"; kubectl -n "$NS" logs -l app.kubernetes.io/component=worker --all-containers --tail=30 || true
}
fail() { echo "FAIL: $*" >&2; diagnose; exit 1; }

helm upgrade --install smoke "$CHART" --namespace "$NS" --create-namespace \
  --set image.repository="$REPO" --set image.tag="$TAG" --set image.pullPolicy=Never \
  --set publicUrl="$PUBLIC_URL" \
  --set secrets.sessionSecret=ci-only-session-secret-not-used-anywhere-else \
  --set postgres.enabled=true --set postgres.password=ci-only-postgres-password \
  --set app.replicas=2 \
  --wait --timeout 8m || fail "helm install did not become ready"

ready=$(kubectl -n "$NS" get deploy smoke-on-my-radar -o jsonpath='{.status.readyReplicas}')
[ "$ready" = 2 ] || fail "expected 2 ready app replicas, got '$ready'"
kubectl -n "$NS" rollout status deploy/smoke-on-my-radar-worker --timeout=60s || fail "worker not ready"

kubectl -n "$NS" port-forward svc/smoke-on-my-radar 3500:3500 >/dev/null 2>&1 &
PF_PID=$!
i=0
until curl -fsS http://127.0.0.1:3500/health/ready >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || fail "/health/ready never answered"; sleep 1
done
echo "ready: $(curl -fsS http://127.0.0.1:3500/health/ready)"

prompt=$(curl -fsS http://127.0.0.1:3500/agent-setup/prompt.md) || fail "/agent-setup/prompt.md was not served"
case "$prompt" in
  *"$PUBLIC_URL"*) echo "ok: agent-setup prompt names $PUBLIC_URL" ;;
  *) fail "/agent-setup/prompt.md does not name $PUBLIC_URL" ;;
esac
echo "smoke passed"
