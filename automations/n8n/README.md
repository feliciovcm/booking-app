# n8n workflows

Workflows exported from n8n, so they're reviewed and versioned like code.

## `booking-events.json`

Receives the events our edge functions forward (`_shared/automations.ts`):

```
Webhook (POST /webhook/booking-events, Header Auth) → Switch on body.type
  ├─ booking.cancelled → "Cancellation message" (clinic local time)
  └─ alert.*           → "Ops alert"
```

`booking.confirmed` and `booking.rescheduled` match no rule and end at the Switch.
Events carry ids, our slugs and UTC times only: no client data reaches n8n.

## Import it

1. In n8n: **Create Workflow**, then **⋯ → Import from File** and pick `booking-events.json`.
2. Create a **Header Auth** credential and select it on the Webhook node:
   - **Name:** `x-automations-secret`
   - **Value:** the same value as `AUTOMATIONS_SECRET` (kept in `supabase/functions/.env`, which git ignores)
3. Save, then activate (or publish) the workflow.
4. Point Supabase at it:
   `npx supabase secrets set AUTOMATIONS_WEBHOOK_URL=<n8n public url>/webhook/booking-events`

The credential is referenced by id and name only. Its value stays in n8n's encrypted
store and is never exported.

## Export after a change

```bash
docker exec n8n n8n export:workflow --all --separate --pretty --output=/tmp/n8n-export/
docker cp n8n:/tmp/n8n-export ./n8n-export
jq 'del(.shared)' ./n8n-export/<id>.json > automations/n8n/booking-events.json && rm -r ./n8n-export
```

`del(.shared)` drops the owner account (it holds an email), which import doesn't need.
