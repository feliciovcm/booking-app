#!/usr/bin/env bash
# Smoke test for the deployed booking function, called the way the browser will call it
# (publishable key, Origin header). Booking -> Boulevard adapter -> mock-boulevard.
# Reads the URL and publishable key from .env.local.
# Usage: bash scripts/smoke-booking.sh
set -euo pipefail
cd "$(dirname "$0")/.."

URL=$(grep '^VITE_SUPABASE_URL=' .env.local | cut -d= -f2-)
KEY=$(grep '^VITE_SUPABASE_PUBLISHABLE_KEY=' .env.local | cut -d= -f2-)
FN="$URL/functions/v1/booking"
ORIGIN="http://localhost:5173"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1: expected '$3', got '$2'"; fail=$((fail+1)); fi; }

# call JSON -> prints "<status> <body>". The mock fails ~10% of calls at random; the
# adapter retries queries itself, and here we retry UNAVAILABLE like the frontend will.
call() {
  local out status
  for _ in 1 2 3; do
    out=$(curl -s -w '\n%{http_code}' "$FN" -H "apikey: $KEY" -H "origin: $ORIGIN" -H 'content-type: application/json' -d "$1")
    status=$(echo "$out" | tail -1)
    [ "$status" != "503" ] && break
  done
  echo "$status $(echo "$out" | sed '$d')"
}
status() { echo "$1" | cut -d' ' -f1; }
json() { echo "$1" | cut -d' ' -f2-; }

PRE=$(curl -s -o /dev/null -D - -X OPTIONS "$FN" -H "origin: $ORIGIN" | tr -d '\r')
check "preflight 204" "$(echo "$PRE" | head -1 | cut -d' ' -f2)" "204"
check "preflight allows our origin" "$(echo "$PRE" | grep -i '^access-control-allow-origin' | cut -d' ' -f2)" "$ORIGIN"

R=$(call '{"action":"start","location":"noho","service":"prp"}')
check "start 200" "$(status "$R")" "200"
S=$(json "$R" | jq -r .sessionId)
check "session id records its vendor" "${S%%|*}" "boulevard"

FROM=$(date -u -v+1d +%F 2>/dev/null || date -u -d tomorrow +%F)
TO=$(date -u -v+14d +%F 2>/dev/null || date -u -d '+14 days' +%F)
R=$(call "$(jq -nc --arg s "$S" --arg f "$FROM" --arg t "$TO" '{action:"dates", sessionId:$s, from:$f, to:$t}')")
check "dates 200" "$(status "$R")" "200"
DATE=$(json "$R" | jq -r '.dates[0]')
echo "     first date: $DATE"

R=$(call "$(jq -nc --arg s "$S" --arg d "$DATE" '{action:"times", sessionId:$s, date:$d}')")
check "times 200" "$(status "$R")" "200"
SLOT=$(json "$R" | jq -r '.times[0].id'); START=$(json "$R" | jq -r '.times[0].start')
echo "     first time: $START (UTC)"

R=$(call "$(jq -nc --arg s "$S" --arg t "$SLOT" '{action:"hold", sessionId:$s, slotId:$t}')")
check "hold 200" "$(status "$R")" "200"
check "hold returns the same start" "$(json "$R" | jq -r .start)" "$START"

S2=$(json "$(call '{"action":"start","location":"noho","service":"prp"}')" | jq -r .sessionId)
R=$(call "$(jq -nc --arg s "$S2" --arg t "$SLOT" '{action:"hold", sessionId:$s, slotId:$t}')")
check "second session can't take the same time" "$(status "$R") $(json "$R" | jq -r .error.code)" "409 SLOT_UNAVAILABLE"

# Checkout (step 4). Writes a real row to bookings with a fake example.com email.
R=$(call "$(jq -nc --arg s "$S" '{action:"summary", sessionId:$s}')")
check "summary shows the hold" "$(status "$R") $(json "$R" | jq -r .hold.start)" "200 $START"

# The card goes straight to the vendor's tokenizer, like the browser will do. Our function only sees the token.
CARD=$(curl -s "$URL/functions/v1/mock-boulevard/cards/tokenize" -H 'content-type: application/json' \
  -d '{"card":{"name":"Smoke Test","number":"4242424242424242","cvv":"123","exp_month":12,"exp_year":2030,"address_postal_code":"10012"}}' | jq -r .token)
check "test card tokenized" "${#CARD}" "36"

IDEM=$(uuidgen | tr 'A-Z' 'a-z')
checkout() { jq -nc --arg s "$1" --arg k "$2" --arg l "$3" --arg c "$CARD" \
  '{action:"checkout", sessionId:$s, location:$l, service:"prp", idempotencyKey:$k, cardToken:$c,
    client:{firstName:"Smoke", lastName:"Test", email:"smoke-test@example.com"}}'; }
R=$(call "$(checkout "$S" "$IDEM" noho)")
check "checkout 200 with the held start" "$(status "$R") $(json "$R" | jq -r .start)" "200 $START"
BOOKING=$(json "$R" | jq -r .bookingId)
R=$(call "$(checkout "$S" "$IDEM" noho)")
check "retry with the same key returns the same booking" "$(json "$R" | jq -r .bookingId)" "$BOOKING"
R=$(call "$(jq -nc --arg s "$S" '{action:"summary", sessionId:$s}')")
check "no live hold after checkout" "$(json "$R" | jq -r .hold)" "null"
R=$(call "$(checkout "$S" "$(uuidgen | tr 'A-Z' 'a-z')" grand-central)")
check "another clinic's slug with this cart is refused" "$(status "$R") $(json "$R" | jq -r .error.code)" "400 INVALID_REQUEST"

R=$(call '{"action":"start","location":"noho","service":"legacy-serum"}')
check "inactive treatment is not bookable" "$(status "$R") $(json "$R" | jq -r .error.code)" "404 NOT_BOOKABLE"
R=$(call '{"action":"times","sessionId":"gone-vendor|abc","date":"2026-12-01"}')
check "unknown vendor session is expired" "$(status "$R") $(json "$R" | jq -r .error.code)" "409 SESSION_EXPIRED"
R=$(call '{"action":"delete-everything"}')
check "bad request 400" "$(status "$R")" "400"
check "no apikey 401" "$(curl -s -o /dev/null -w '%{http_code}' "$FN" -H 'content-type: application/json' -d '{"action":"start","location":"noho","service":"prp"}')" "401"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
