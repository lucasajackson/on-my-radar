#!/bin/sh
# Exercise the actual static server: document policy must survive every location.
set -eu
nginx_bin=${NGINX_BIN:-nginx}
port=${NGINX_TEST_PORT:-8080}
mime_types=${NGINX_MIME_TYPES:-/etc/nginx/mime.types}
case "$port" in ''|*[!0-9]*) echo 'NGINX_TEST_PORT must be a port number'; exit 1 ;; esac
[ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || exit 1
[ -f "$mime_types" ] || { echo "Missing nginx MIME definitions: $mime_types"; exit 1; }
fixture=$(mktemp -d)
# Alpine nginx drops worker privileges when the harness starts as root.
chmod 755 "$fixture"
nginx_pid=
cleanup() {
  if [ -n "$nginx_pid" ]; then kill "$nginx_pid" 2>/dev/null || true; fi
  rm -rf "$fixture"
}
trap cleanup EXIT INT TERM
mkdir -p "$fixture/html/assets"
printf '<!doctype html><title>UI serving fixture</title>' > "$fixture/html/index.html"
printf 'console.log("fixture");' > "$fixture/html/assets/app-fixture.js"
printf '/* push worker fixture */' > "$fixture/html/sw.js"
printf '<svg xmlns="http://www.w3.org/2000/svg"/>' > "$fixture/html/favicon.svg"
mkdir -p "$fixture/html/agent-setup"
printf '# Set up On My Radar\n' > "$fixture/html/agent-setup/prompt.md"
printf 'console.log(1);\n' > "$fixture/html/agent-setup/omr-agent.mjs"
printf '{"name":"onmyradar"}\n' > "$fixture/html/agent-setup/marketplace.json"
printf 'PK fixture' > "$fixture/html/agent-setup/omr-plugin-0.0.0-abcdef012345.zip"
printf 'abc  omr-agent.mjs\n' > "$fixture/html/agent-setup/SHA256SUMS"
sed "s|root /usr/share/nginx/html;|root $fixture/html;|; s|pid /tmp/nginx.pid;|pid $fixture/nginx.pid;|; s|include /etc/nginx/mime.types;|include $mime_types;|; s|listen 8080;|listen $port;|" \
  packages/ui/deploy/nginx.conf > "$fixture/nginx.conf"
"$nginx_bin" -t -c "$fixture/nginx.conf"
"$nginx_bin" -c "$fixture/nginx.conf" -g 'daemon off;' &
nginx_pid=$!
for attempt in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:$port/health/live" >/dev/null; then break; fi
  sleep 1
done
check_response() {
  request_path=$1
  expected_status=$2
  expected_cache=$3
  status=$(curl -sS -D "$fixture/headers" -o "$fixture/body" -w '%{http_code}' "http://127.0.0.1:$port$request_path")
  [ "$status" = "$expected_status" ] || { echo "$request_path: expected $expected_status, got $status"; exit 1; }
  tr -d '\r' < "$fixture/headers" > "$fixture/normalized"
  grep -qi "^Content-Security-Policy: .*script-src 'self'.*frame-src 'self'.*frame-ancestors 'none'" "$fixture/normalized"
  grep -qi '^X-Content-Type-Options: nosniff$' "$fixture/normalized"
  grep -qi '^X-Frame-Options: SAMEORIGIN$' "$fixture/normalized"
  grep -qi '^Referrer-Policy: strict-origin-when-cross-origin$' "$fixture/normalized"
  if [ -n "$expected_cache" ]; then
    grep -qi "^Cache-Control: $expected_cache$" "$fixture/normalized"
  else
    # An absent asset must not be cached immutably for a year.
    if grep -qi '^Cache-Control: .*immutable' "$fixture/normalized"; then exit 1; fi
  fi
  echo "verified $request_path ($status)"
}
check_response / 200 no-cache
check_response /radars/example 200 no-cache
check_response /assets/app-fixture.js 200 'public, max-age=31536000, immutable'
check_response /sw.js 200 no-cache
check_response /favicon.svg 200 'public, max-age=86400'
check_response /robots.txt 200 'public, max-age=86400'
check_response /health/live 200 no-cache
grep -qi '^Content-Type: application/json$' "$fixture/normalized"
check_response /assets/missing.js 404 ''

# https://onmyradar.io/agent-setup/ (docs/AGENT_REPO.md §V2.18): exact types,
# no-cache for the unversioned names, a year for the digest-named zip, and a
# 404 -- never the SPA shell -- for a file that is not there.
check_type() {
  grep -qi "^Content-Type: $1$" "$fixture/normalized" || { echo "$2: expected Content-Type $1"; cat "$fixture/normalized"; exit 1; }
}
check_response /agent-setup/prompt.md 200 no-cache
check_type 'text/markdown; charset=utf-8' prompt.md
check_response /agent-setup/omr-agent.mjs 200 no-cache
check_type 'text/javascript; charset=utf-8' omr-agent.mjs
check_response /agent-setup/marketplace.json 200 no-cache
check_type 'application/json; charset=utf-8' marketplace.json
check_response /agent-setup/SHA256SUMS 200 no-cache
check_type 'text/plain; charset=utf-8' SHA256SUMS
check_response /agent-setup/omr-plugin-0.0.0-abcdef012345.zip 200 'public, max-age=31536000, immutable'
check_type 'application/zip' zip
check_response /agent-setup/missing.mjs 404 ''
if grep -q 'UI serving fixture' "$fixture/body"; then echo 'agent-setup 404 served the SPA shell'; exit 1; fi

# Addresses that were never pages: a real 404, not the SPA shell.
check_response /docs 404 ''
check_response /llms.txt 404 ''

# Cloudflare terminates TLS: a visitor on plain http (CF-Visitor) is sent to https, an https
# visitor and an in-cluster probe (no CF-Visitor) are served, and /health is never redirected.
check_redirect() {
  extra=$1
  request_path=$2
  expected_status=$3
  status=$(curl -sS -D "$fixture/headers" -o "$fixture/body" -w '%{http_code}' -H "Host: onmyradar.io" $extra "http://127.0.0.1:$port$request_path")
  [ "$status" = "$expected_status" ] || { echo "$request_path ($extra): expected $expected_status, got $status"; exit 1; }
  tr -d '\r' < "$fixture/headers" > "$fixture/normalized"
  echo "verified $request_path ($extra) -> $status"
}
check_redirect '-H CF-Visitor:{"scheme":"http"}' '/radar/abc?x=1' 301
grep -qi '^Location: https://onmyradar.io/radar/abc?x=1$' "$fixture/normalized" || { echo 'redirect: wrong Location'; cat "$fixture/normalized"; exit 1; }
grep -qi '^Strict-Transport-Security: max-age=15552000; includeSubDomains$' "$fixture/normalized" || { echo 'redirect: no HSTS'; exit 1; }
check_redirect '-H CF-Visitor:{"scheme":"https"}' /radars/example 200
grep -qi '^Strict-Transport-Security: max-age=15552000; includeSubDomains$' "$fixture/normalized" || { echo 'UI response: no HSTS'; exit 1; }
check_redirect '' /health/live 200
check_redirect '-H CF-Visitor:{"scheme":"http"}' /health/live 200
check_redirect '-H CF-Visitor:{"scheme":"http"}' /healthy 301
