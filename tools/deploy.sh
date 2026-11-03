#!/usr/bin/env bash
# Build the game and publish it to Yandex Object Storage behind the CDN (https://leonida-drive.io).
# Content types are set explicitly per extension (module scripts must be served as JavaScript).
# Hashed bundles are immutable; world data is cached for a day; HTML/manifest/icons always revalidate.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/yandex-cloud/bin:$PATH"
BUCKET=leonida-drive-web
CDN_ID=bc8r2ixdg5hdwyoswiwz

if [[ "${LEONIDA_DEPLOY_BUILT:-0}" == "1" ]]; then
  test -s dist/index.html || { echo "Build dist/ before deploying with LEONIDA_DEPLOY_BUILT=1" >&2; exit 1; }
else
  node tools/licenses.mjs
  npx vite build
fi
ctype() {
  case "$1" in
    *.js|*.mjs) echo "text/javascript; charset=utf-8" ;;
    *.css) echo "text/css; charset=utf-8" ;;
    *.html) echo "text/html; charset=utf-8" ;;
    *.json) echo "application/json" ;;
    *.webmanifest) echo "application/manifest+json" ;;
    *.wasm) echo "application/wasm" ;;
    *.svg) echo "image/svg+xml" ;;
    *.png) echo "image/png" ;;
    *.webp) echo "image/webp" ;;
    *.jpg|*.jpeg) echo "image/jpeg" ;;
    *.woff2) echo "font/woff2" ;;
    *.woff) echo "font/woff" ;;
    *.txt) echo "text/plain; charset=utf-8" ;;
    *) echo "application/octet-stream" ;;
  esac
}
cache() {
  case "$1" in
    assets/*) echo "public, max-age=31536000, immutable" ;;
    data/*) echo "public, max-age=86400" ;;
    *) echo "no-cache" ;;
  esac
}
cd dist
find . -type f | sed 's|^\./||' | sort | while read -r f; do
  yc storage s3 cp "$f" "s3://$BUCKET/$f" --content-type "$(ctype "$f")" --cache-control "$(cache "$f")" --no-guess-mime-type --only-show-errors
done
cd ..
yc cdn cache purge --resource-id "$CDN_ID" --path "/*" >/dev/null
echo "deployed: https://leonida-drive.io"
