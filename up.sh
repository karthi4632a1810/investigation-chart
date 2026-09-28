#!/usr/bin/env bash
# Build and start the stack, then print a summary of every published port.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

docker compose up -d --build "$@"

echo
echo "================ Service Ports ================"
printf "%-12s %-24s %s\n" "SERVICE" "CONTAINER" "URL"

docker compose ps --format json | jq -r '
  .Name as $name |
  .Service as $service |
  (.Publishers // [])
  | map(select(.URL == "0.0.0.0"))
  | .[]
  | "\($service)\t\($name)\thttp://localhost:\(.PublishedPort)"
' | sort -u | while IFS=$'\t' read -r service name url; do
  printf "%-12s %-24s %s\n" "$service" "$name" "$url"
done

echo "================================================="
