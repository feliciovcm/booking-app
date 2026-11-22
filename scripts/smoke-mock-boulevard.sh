#!/usr/bin/env bash
# Smoke test for the deployed mock-boulevard function: token, the whole booking flow,
# a double-booking race, checkout retry, and forced failures.
# Reads the URL from .env.local and the mock credentials from supabase/functions/.env.
# Usage: bash scripts/smoke-mock-boulevard.sh
set -euo pipefail
cd "$(dirname "$0")/.."

URL=$(grep '^VITE_SUPABASE_URL=' .env.local | cut -d= -f2-)
set -a; . supabase/functions/.env; set +a
BASE="$URL/functions/v1/mock-boulevard"
API="$BASE/api/2026-06/client"
NOHO="urn:blvd:Location:6c1f0a52-1d3e-4b7a-9f20-000000000001"
PRP="urn:blvd:Service:2b7d4e90-5a1c-4f3e-8d6b-000000000001"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1: expected '$3', got '$2'"; fail=$((fail+1)); fi; }

TOKEN=$(curl -s "$BASE/oauth2/token" -H 'content-type: application/json' \
  -d "$(jq -n --arg id "$MOCK_BLVD_CLIENT_ID" --arg s "$MOCK_BLVD_CLIENT_SECRET" --arg b "$MOCK_BLVD_BUSINESS_ID" \
    '{grant_type:"client_credentials", client_id:$id, client_secret:$s, business_id:$b, resource:"https://sandbox.joinblvd.com/api/2026-06/client"}')" | jq -r .access_token)
check "server token" "${TOKEN:0:9}" "mockblvd."

# gql QUERY VARIABLES_JSON [extra curl args]. "x-mock-fail: none" turns off random failures.
gql() { curl -s "$API" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-mock-fail: none' "${@:3}" \
  -d "$(jq -n --arg q "$1" --argjson v "$2" '{query:$q, variables:$v}')"; }

check "locations" "$(gql '{ business { locations { edges { node { id } } } } }' '{}' | jq '.data.business.locations.edges | length')" "4"

new_cart() {
  local id
  id=$(gql 'mutation($l: ID!) { createCart(input: { locationId: $l }) { cart { id } } }' "{\"l\":\"$NOHO\"}" | jq -r .data.createCart.cart.id)
  gql 'mutation($id: ID!, $i: ID!) { addCartSelectedBookableItem(input: { id: $id, itemId: $i }) { cart { id } } }' "{\"id\":\"$id\",\"i\":\"$PRP\"}" >/dev/null
  echo "$id"
}
A=$(new_cart); B=$(new_cart)
check "cart id is opaque urn" "${A:0:14}" "urn:blvd:Cart:"

FROM=$(date -u -v+1d +%F 2>/dev/null || date -u -d tomorrow +%F)
TO=$(date -u -v+14d +%F 2>/dev/null || date -u -d '+14 days' +%F)
DATE=$(gql 'query($id: ID!, $f: Date!, $t: Date!) { cartBookableDates(id: $id, searchRangeLower: $f, searchRangeUpper: $t) { date } }' \
  "{\"id\":\"$A\",\"f\":\"$FROM\",\"t\":\"$TO\"}" | jq -r '.data.cartBookableDates[0].date')
echo "     first bookable date: $DATE"
TIMES=$(gql 'query($id: ID!, $d: Date!) { cartBookableTimes(id: $id, searchDate: $d) { id startTime } }' "{\"id\":\"$A\",\"d\":\"$DATE\"}")
T=$(echo "$TIMES" | jq -r '.data.cartBookableTimes[0].id')
echo "     first time: $(echo "$TIMES" | jq -r '.data.cartBookableTimes[0].startTime') ($T)"

reserve() { gql 'mutation($id: ID!, $t: ID!) { reserveCartBookableItems(input: { id: $id, bookableTimeId: $t }) { cart { expiresAt } } }' "{\"id\":\"$1\",\"t\":\"$2\"}"; }
check "cart A reserves" "$(reserve "$A" "$T" | jq -r '.errors // [] | length')" "0"
check "cart B can't take the same time" "$(reserve "$B" "$T" | jq -r '.errors[0].code')" "CART_TIME_NOT_AVAILABLE"

gql 'mutation($id: ID!) { updateCart(input: { id: $id, clientInformation: { email: "smoke@example.com", firstName: "Smoke", lastName: "Test", phoneNumber: "+12125550100" } }) { cart { id } } }' "{\"id\":\"$A\"}" >/dev/null
gql 'mutation($id: ID!) { addCartCardPaymentMethod(input: { id: $id, token: "tok_smoke", select: true }) { cart { id } } }' "{\"id\":\"$A\"}" >/dev/null
CHECKOUT='mutation($id: ID!) { checkoutCart(input: { id: $id }) { cart { completedAt } appointments { appointmentId } } }'
APPT=$(gql "$CHECKOUT" "{\"id\":\"$A\"}" | jq -r '.data.checkoutCart.appointments[0].appointmentId')
check "checkout returns an appointment" "${APPT:0:21}" "urn:blvd:Appointment:"
check "checkout retry returns the same appointment" "$(gql "$CHECKOUT" "{\"id\":\"$A\"}" | jq -r '.data.checkoutCart.appointments[0].appointmentId')" "$APPT"
check "checkout with nothing filled in" "$(gql "$CHECKOUT" "{\"id\":\"$B\"}" | jq -r '.errors[0].code')" "CART_MISSING_CLIENT_INFORMATION"

check "no token is 401" "$(curl -s -o /dev/null -w '%{http_code}' "$API" -H 'content-type: application/json' -d '{"query":"{ business { id } }"}')" "401"
check "forced 429" "$(curl -s -o /dev/null -w '%{http_code}' "$API" -H "authorization: Bearer $TOKEN" -H 'x-mock-fail: 429' -d '{"query":"{ business { id } }"}')" "429"
check "forced timeout trips a 3s client timeout" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$API" -H "authorization: Bearer $TOKEN" -H 'x-mock-fail: timeout' -d '{"query":"{ business { id } }"}' || true)" "000"

codes=$(for _ in $(seq 20); do curl -s -o /dev/null -w '%{http_code}\n' "$API" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"query":"{ business { id } }"}'; done | sort | uniq -c | tr '\n' ' ')
echo "     20 calls with random failures on: $codes"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
