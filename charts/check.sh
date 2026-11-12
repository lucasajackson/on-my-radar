#!/bin/sh
# Lint, render and schema-check the chart with every values file in on-my-radar/ci, and prove that
# the values it must refuse are refused. Needs helm and kubeconform on PATH.
#
#   sh charts/check.sh            (from the repository root)
set -eu

CHART="$(dirname "$0")/on-my-radar"
K8S_VERSION="${K8S_VERSION:-1.31.0}"
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== helm lint, one values file at a time"
for values in "$CHART"/ci/*-values.yaml; do
  echo "-- $values"
  helm lint --strict "$CHART" -f "$values"
  helm template check "$CHART" -f "$values" | kubeconform -strict -summary -kubernetes-version "$K8S_VERSION"
done

echo "== refusals"
refuses() { # $1 = what must appear in the error, the rest = helm --set arguments
  want="$1"; shift
  if out=$(helm template check "$CHART" "$@" 2>&1); then fail "rendered, but must refuse ($want)"; fi
  case "$out" in *"$want"*) echo "ok: refused ($want)";; *) fail "refused without saying '$want': $out";; esac
}
ok="publicUrl=https://notes.example.test"
sess="secrets.sessionSecret=ci-only-session-secret-not-used-anywhere-else"
db="secrets.databaseUrl=postgres://u:p@db:5432/d"
refuses "publicUrl is required" --set "$sess" --set "$db"
refuses "publicUrl must be an absolute" --set publicUrl=notes.example.test --set "$sess" --set "$db"
refuses "secrets.sessionSecret is required" --set "$ok" --set "$db"
refuses "at least 32 characters" --set "$ok" --set secrets.sessionSecret=short --set "$db"
refuses "secrets.databaseUrl is required" --set "$ok" --set "$sess"
refuses "postgres.password is required" --set "$ok" --set "$sess" --set postgres.enabled=true
refuses "only letters, digits" --set "$ok" --set "$sess" --set postgres.enabled=true --set 'postgres.password=a/b@c'

echo "== long release names: every resource name is unique and a valid label"
# Truncating "<fullname>-postgres" as a whole drops the suffix and hands the database the app's names.
for len in 53 52 47 30; do
  rel=$(printf 'preview-%s' "$(printf 'a%.0s' $(seq $((len - 8))))")
  for values in dev-postgres full existing-secret; do
    names=$(helm template "$rel" "$CHART" -f "$CHART/ci/$values-values.yaml" \
      | awk '/^kind:/{k=$2} /^metadata:/{m=1} m && /^  name:/{print k, $2; m=0}')
    dups=$(printf '%s\n' "$names" | sort | uniq -d)
    [ -z "$dups" ] || fail "release '$rel' ($values): duplicate resource names: $dups"
    printf '%s\n' "$names" | while read -r kind name; do
      [ "${#name}" -le 63 ] || fail "release '$rel': $kind $name is longer than 63 characters"
    done
  done
  echo "ok: unique names for a ${#rel}-character release name"
done

echo "== no single-user mode, no random secrets"
helm template check "$CHART" -f "$CHART/ci/full-values.yaml" | grep -q SINGLE_USER && fail "SINGLE_USER_EMAIL is rendered"
a=$(helm template check "$CHART" -f "$CHART/ci/minimal-values.yaml" | grep SESSION_SECRET)
b=$(helm template check "$CHART" -f "$CHART/ci/minimal-values.yaml" | grep SESSION_SECRET)
[ "$a" = "$b" ] || fail "SESSION_SECRET differs between two renders"
echo "chart checks passed"
