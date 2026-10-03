#!/usr/bin/env bash
# Reset the super admin password, then restart the backend so it takes effect.
#
# Run it on the server, from anywhere:
#
#   bash /docker/investigation-chart/scripts/reset-superadmin-password.sh
#
# The super admin isn't stored in the database: it's APP_USERNAME / APP_PASSWORD
# in server/.env, read when the backend starts. This script:
#   1. asks for the new password twice (never shown, never saved in shell history);
#   2. backs up server/.env;
#   3. pins the WATI webhook key and the WhatsApp PDF-link key, which used to be
#      derived from the old password — so the webhook URL set in WATI and the PDF
#      links already sent keep working — and gives sessions their own new secret
#      (everyone, you included, signs in again);
#   4. writes the new APP_PASSWORD and recreates the backend container;
#   5. checks the new password signs in — and puts everything back if it doesn't.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE=server/.env
CONTAINER=investigation-backend
COMPOSE=(docker compose -f docker-compose.yml)
[[ -f docker-compose.prod.yml ]] && COMPOSE+=(-f docker-compose.prod.yml)

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "$PWD/$ENV_FILE not found — run this from the project on the server."
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true || die "The $CONTAINER container isn't running. Start the app first."

# Current value of KEY in server/.env (last one wins, quotes removed), or empty.
env_get() {
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed -E "s/^'(.*)'\$/\\1/; s/^\"(.*)\"\$/\\1/" || true
}
# Sets KEY to the value in $VALUE (passed in the environment, so it never shows
# in the process list), replacing the existing line or adding one.
env_set() {
  local key="$1" quote="${2:-}" tmp
  tmp="$(mktemp)"
  KEY="$key" Q="$quote" awk '
    BEGIN { line = ENVIRON["KEY"] "=" ENVIRON["Q"] ENVIRON["VALUE"] ENVIRON["Q"] }
    index($0, ENVIRON["KEY"] "=") == 1 { if (!done) print line; done = 1; next }
    { print }
    END { if (!done) print line }
  ' "$ENV_FILE" >"$tmp"
  cat "$tmp" >"$ENV_FILE" # keeps the file's owner and permissions
  rm -f "$tmp"
}

# ---- 1. The new password -------------------------------------------------------
USERNAME="$(docker exec "$CONTAINER" node --input-type=module -e 'import { config } from "/app/src/config.js"; console.log(config.auth.username)')"
say "Super admin username: $USERNAME"
read -r -s -p "New super admin password: " PW1; echo
read -r -s -p "Type it again: " PW2; echo
[[ "$PW1" == "$PW2" ]] || die "The two passwords don't match — nothing was changed."
(( ${#PW1} >= 10 )) || die "Use at least 10 characters (12+ recommended) — nothing was changed."
[[ "$PW1" != *"'"* ]] || die "Please don't use a single quote ( ' ) in the password — nothing was changed."
[[ "$PW1" == "${PW1#[[:space:]]}" && "$PW1" == "${PW1%[[:space:]]}" ]] || die "No spaces at the start or end — nothing was changed."
unset PW2

# ---- 2. Backup -----------------------------------------------------------------
BACKUP="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP"
say "Backed up server/.env to $BACKUP"

# ---- 3. Keys that came from the old password -----------------------------------
# Worked out inside the running container, from the settings it is using now.
KEYS="$(docker exec "$CONTAINER" node --input-type=module -e '
  import crypto from "crypto";
  import fs from "fs";
  import { config } from "/app/src/config.js";
  const link = process.env.PUBLIC_LINK_SECRET
    || crypto.createHash("sha256").update(`investigation-public-link:${config.auth.username}:${config.auth.password}`).digest();
  const hook = process.env.WATI_WEBHOOK_KEY
    || crypto.createHmac("sha256", typeof link === "string" && /^hex:/i.test(link) ? Buffer.from(link.slice(4), "hex") : link).update("wati-webhook").digest("base64url").slice(0, 32);
  const hexOk = fs.readFileSync("/app/src/services/publicLinkService.js", "utf8").includes("hex:");
  console.log(hook);
  console.log(process.env.PUBLIC_LINK_SECRET ? "" : hexOk ? `hex:${link.toString("hex")}` : "unsupported");
')"
OLD_HOOK="$(sed -n 1p <<<"$KEYS")"
OLD_LINK="$(sed -n 2p <<<"$KEYS")"

if [[ -z "$(env_get WATI_WEBHOOK_KEY)" ]]; then
  VALUE="$OLD_HOOK" env_set WATI_WEBHOOK_KEY
  say "Pinned WATI_WEBHOOK_KEY — the webhook URL in WATI stays the same."
fi
if [[ -z "$(env_get PUBLIC_LINK_SECRET)" ]]; then
  if [[ "$OLD_LINK" == hex:* ]]; then
    VALUE="$OLD_LINK" env_set PUBLIC_LINK_SECRET
    say "Pinned PUBLIC_LINK_SECRET — WhatsApp PDF links already sent keep working."
  else
    VALUE="$(openssl rand -base64 32)" env_set PUBLIC_LINK_SECRET
    say "Set a new PUBLIC_LINK_SECRET (this server's code is older, so PDF links from the last few days"
    say "  won't open from WATI's inbox any more — patients already have the files on their phones)."
  fi
fi
# Sessions get a fresh secret: every signed-in browser, old password's included, signs in again.
VALUE="$(openssl rand -base64 32)" env_set SESSION_SECRET
[[ -n "$(env_get APP_USERNAME)" ]] || VALUE="$USERNAME" env_set APP_USERNAME

# ---- 4. The new password -------------------------------------------------------
VALUE="$PW1" env_set APP_PASSWORD "'" # single quotes: $, #, spaces etc. stay literal

restore() {
  say "Putting the old server/.env back…"
  cat "$BACKUP" >"$ENV_FILE"
  "${COMPOSE[@]}" up -d --no-deps --force-recreate server >/dev/null 2>&1 || true
  die "$1 — nothing changed; the old password still works."
}

say "Restarting the backend…"
"${COMPOSE[@]}" up -d --no-deps --force-recreate server >/dev/null 2>&1 || restore "The backend didn't restart"

# ---- 5. Check it signs in (then sign that test session out again) ----------------
STATUS="$(printf '%s' "$PW1" | docker exec -i "$CONTAINER" node --input-type=module -e '
  import { config } from "/app/src/config.js";
  let password = "";
  for await (const chunk of process.stdin) password += chunk;
  const base = `http://localhost:${process.env.PORT || 2003}/api`;
  for (let i = 0; i < 45; i++) {
    try {
      const r = await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: config.auth.username, password }) });
      if (r.ok) {
        const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
        await fetch(`${base}/logout`, { method: "POST", headers: { cookie } }).catch(() => {});
      }
      console.log(r.status);
      process.exit(0);
    } catch {
      await new Promise((ok) => setTimeout(ok, 2000)); // still starting
    }
  }
  console.log("timeout");
' 2>/dev/null || true)"
unset PW1

case "$STATUS" in
  200) ;;
  timeout | "") restore "The backend didn't come back within 90 seconds" ;;
  *) restore "The new password was refused (HTTP $STATUS)" ;;
esac

say ""
say "Done. The super admin password is changed."
say "  • Sign in as '$USERNAME' with the new password (everyone signs in again once)."
say "  • The old password no longer works."
say "  • Backup of the previous server/.env: $BACKUP (holds the OLD password — delete it once you're happy:"
say "      rm '$PWD/$BACKUP')"
