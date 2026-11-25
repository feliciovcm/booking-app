#!/usr/bin/env bash
# End-to-end smoke test for step 5, against the deployed functions:
#   checkout -> mock sends APPOINTMENT_CREATED -> boulevard-webhook records and processes it
#   -> staff reschedule and cancel in the "Boulevard" mock -> our booking follows.
#
# Needs: migrations pushed; booking, mock-boulevard, boulevard-webhook and webhook-jobs
# deployed; MOCK_WEBHOOK_URL on the mock set to <project url>/functions/v1/boulevard-webhook.
# Reads .env.local (URL, publishable key) and supabase/functions/.env (mock credentials, for
# the staff mutations). Checks rows with read-only queries (npx supabase db query --remote).
# Writes a booking with smoke-test@example.com, like smoke-booking.sh.
# Usage: bash scripts/smoke-webhooks.sh
set -euo pipefail
cd "$(dirname "$0")/.."

URL=$(grep '^VITE_SUPABASE_URL=' .env.local | cut -d= -f2-)
KEY=$(grep '^VITE_SUPABASE_PUBLISHABLE_KEY=' .env.local | cut -d= -f2-)
set -a; . supabase/functions/.env; set +a
FN="$URL/functions/v1/booking"
MOCK="$URL/functions/v1/mock-boulevard"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1: expected '$3', got '$2'"; fail=$((fail+1)); fi; }

# booking function call -> "<status> <body>", retrying UNAVAILABLE like the frontend does.
call() {
  local out status
  for _ in 1 2 3; do
    out=$(curl -s -w '\n%{http_code}' "$FN" -H "apikey: $KEY" -H 'origin: http://localhost:5173' -H 'content-type: application/json' -d "$1")
    status=$(echo "$out" | tail -1)
    [ "$status" != "503" ] && break
  done
  echo "$status $(echo "$out" | sed '$d')"
}
json() { echo "$1" | cut -d' ' -f2-; }

# Read-only SQL on the hosted database -> the rows as compact JSON.
db() { npx supabase db query --remote --read-only --output-format json "$1" 2>/dev/null | jq -c .rows; }
# wait_for LABEL SQL JQ EXPECTED: polls (webhooks arrive in the background) for up to ~60 s.
wait_for() {
  local got=""
  for _ in $(seq 1 12); do
    got=$(db "$2" | jq -r "$3")
    [ "$got" = "$4" ] && break
    sleep 5
  done
  check "$1" "$got" "$4"
}

# ------------------------------------------------------------
# 1. Book through our funnel, as smoke-booking.sh does
# ------------------------------------------------------------
S=$(json "$(call '{"action":"start","location":"noho","service":"prp"}')" | jq -r .sessionId)
FROM=$(date -u -v+1d +%F 2>/dev/null || date -u -d tomorrow +%F)
TO=$(date -u -v+14d +%F 2>/dev/null || date -u -d '+14 days' +%F)
DATE=$(json "$(call "$(jq -nc --arg s "$S" --arg f "$FROM" --arg t "$TO" '{action:"dates", sessionId:$s, from:$f, to:$t}')")" | jq -r '.dates[0]')
TIMES=$(json "$(call "$(jq -nc --arg s "$S" --arg d "$DATE" '{action:"times", sessionId:$s, date:$d}')")")
SLOT=$(echo "$TIMES" | jq -r '.times[0].id'); START=$(echo "$TIMES" | jq -r '.times[0].start')
# Another free time the same day, for the staff reschedule below.
NEW_START=$(echo "$TIMES" | jq -r '.times[-1].start')
call "$(jq -nc --arg s "$S" --arg t "$SLOT" '{action:"hold", sessionId:$s, slotId:$t}')" >/dev/null
CARD=$(curl -s "$MOCK/cards/tokenize" -H 'content-type: application/json' \
  -d '{"card":{"name":"Smoke Test","number":"4242424242424242","cvv":"123","exp_month":12,"exp_year":2030,"address_postal_code":"10012"}}' | jq -r .token)
R=$(call "$(jq -nc --arg s "$S" --arg k "$(uuidgen | tr 'A-Z' 'a-z')" --arg c "$CARD" \
  '{action:"checkout", sessionId:$s, location:"noho", service:"prp", idempotencyKey:$k, cardToken:$c,
    client:{firstName:"Smoke", lastName:"Test", email:"smoke-test@example.com"}}')")
check "checkout 200" "${R%% *}" "200"
BOOKING=$(json "$R" | jq -r .bookingId)
echo "     booking $BOOKING at $START, will move to $NEW_START"

# slot_start formatted like our API's times (UTC ISO with milliseconds), so they compare as text.
ROW="select status, provider_booking_id, provider_session_id, vendor_updated_at,
  to_char(slot_start at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as slot_start
  from public.bookings where id = '$BOOKING'"
B=$(db "$ROW")
APPT=$(echo "$B" | jq -r '.[0].provider_booking_id')
check "booking confirmed by checkout, with the vendor's ids" "$(echo "$B" | jq -r '.[0] | [.status, (.provider_booking_id|startswith("urn:blvd:Appointment:")), (.provider_session_id|startswith("urn:blvd:Cart:"))] | join(" ")')" "confirmed true true"

# The events for this appointment. state TYPE -> a jq filter giving "<processed> <attempts> <last_error>".
EVENTS="select type, processed_at is not null as processed, attempts, coalesce(last_error, '-') as last_error
  from public.webhook_events where payload->'data'->'node'->>'id' = '$APPT' order by received_at"
state() { echo "map(select(.type == \"$1\")) | .[0] | \"\\(.processed) \\(.attempts) \\(.last_error)\""; }

# ------------------------------------------------------------
# 2. The CREATED webhook arrives and is processed (nothing to change: checkout confirmed it)
# ------------------------------------------------------------
wait_for "CREATED recorded and processed once" "$EVENTS" "$(state APPOINTMENT_CREATED)" "true 1 -"
check "booking unchanged by CREATED" "$(db "$ROW" | jq -r '.[0] | "\(.status) \(.vendor_updated_at)"')" "confirmed null"

# ------------------------------------------------------------
# 3. Front desk staff move it, then cancel it (the mock's stand-ins for Boulevard's dashboard)
# ------------------------------------------------------------
TOKEN=$(curl -s "$MOCK/oauth2/token" -H 'content-type: application/json' \
  -d "$(jq -n --arg id "$MOCK_BLVD_CLIENT_ID" --arg s "$MOCK_BLVD_CLIENT_SECRET" --arg b "$MOCK_BLVD_BUSINESS_ID" \
    '{grant_type:"client_credentials", client_id:$id, client_secret:$s, business_id:$b, resource:"https://sandbox.joinblvd.com/api/2026-06/client"}')" | jq -r .access_token)
staff() { curl -s "$MOCK/api/2026-06/client" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-mock-fail: none' \
  -d "$(jq -n --arg q "$1" --argjson v "$2" '{query:$q, variables:$v}')"; }

R=$(staff 'mutation($input: MockStaffRescheduleInput!) { mockStaffRescheduleAppointment(input: $input) { appointmentId cancelled } }' \
  "$(jq -nc --arg a "$APPT" --arg t "$NEW_START" '{input:{appointmentId:$a, startTime:$t}}')")
check "staff reschedule accepted" "$(echo "$R" | jq -r '.data.mockStaffRescheduleAppointment.cancelled')" "false"
wait_for "RESCHEDULED recorded and processed" "$EVENTS" "$(state APPOINTMENT_RESCHEDULED)" "true 1 -"
B=$(db "$ROW")
check "booking moved to the new time" "$(echo "$B" | jq -r '.[0].slot_start')" "$NEW_START"
check "the vendor's change time is kept" "$(echo "$B" | jq -r '.[0].vendor_updated_at != null')" "true"

R=$(staff 'mutation($input: MockStaffCancelInput!) { mockStaffCancelAppointment(input: $input) { appointmentId cancelled } }' \
  "$(jq -nc --arg a "$APPT" '{input:{appointmentId:$a}}')")
check "staff cancel accepted" "$(echo "$R" | jq -r '.data.mockStaffCancelAppointment.cancelled')" "true"
wait_for "CANCELLED recorded and processed" "$EVENTS" "$(state APPOINTMENT_CANCELLED)" "true 1 -"
check "booking cancelled" "$(db "$ROW" | jq -r '.[0].status')" "cancelled"

# ------------------------------------------------------------
# 4. The doors stay shut
# ------------------------------------------------------------
check "unsigned delivery refused (401, never 410)" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$URL/functions/v1/boulevard-webhook" -H 'content-type: application/json' -d '{"eventType":"APPOINTMENT_CANCELLED"}')" "401"
check "jobs refuse a call without the cron secret" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/functions/v1/webhook-jobs" -H 'x-cron-secret: guess')" "401"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
