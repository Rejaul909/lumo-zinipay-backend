# LUMO — ZiniPay Payment Backend

This is the backend that connects the LUMO landing page's "Pay Delivery Fee &
Confirm Order" button to real ZiniPay bKash/Nagad payments — **without ever
putting the ZiniPay API key in the frontend HTML/JS.**

## How it fits together

```
Browser (lumo-landing-page.html)
   │
   │ 1. POST /api/payments/create   (name, phone, address, delivery-fee amount)
   ▼
This backend
   │
   │ 2. POST https://api.zinipay.com/v1/payment/create   (zini-api-key header)
   ▼
ZiniPay
   │
   │ 3. { payment_url }
   ▼
Browser redirects to payment_url → customer pays via bKash/Nagad
   │
   │ 4. ZiniPay calls webhook_url after payment
   ▼
This backend
   │
   │ 5. POST https://api.zinipay.com/v1/payment/verify   (re-verify, don't trust webhook blindly)
   ▼
Order marked COMPLETED / FAILED
   │
   │ 6. ZiniPay redirects browser back to redirect_url (?order_id=...)
   ▼
Browser calls GET /api/payments/status?order_id=...
   │
   ▼
Existing LUMO confirmation modal shows the result (no new UI)
```

## Setup

```bash
cd backend
cp .env.example .env      # then fill in your real values
npm install
npm start                 # or: npm run dev (auto-restart)
```

Requires **Node.js 18+** (uses the built-in `fetch`).

### Where to get your ZiniPay API key

1. Log in to your ZiniPay dashboard.
2. Go to **Main Menu → Brands**.
3. Copy your **Brand Key / API Key**.
4. Put it in `.env` as `ZINIPAY_API_KEY` — never in any frontend file.

Use the sandbox key while testing (`https://secure.zinipay.com/demo/payment`),
switch to your live key only when you're ready to accept real money.

## Connecting the frontend

The landing page already points at these routes:

- `POST /api/payments/create`
- `GET  /api/payments/status?order_id=...`

If your backend runs on a different host than the page (e.g. page on a
static host, backend on a separate server), update `PAYMENT_API_ENDPOINT`
and `STATUS_API_ENDPOINT` near the top of the `<script>` block in
`lumo-landing-page.html` to the full backend URL.

To serve both from one place, drop `lumo-landing-page.html` into
`backend/public/index.html` — the server already serves that folder.

## What gets sent to ZiniPay

Only the **delivery charge** (the advance/confirmation amount) is sent as
the invoice `amount` — matching the "Pay Delivery Fee & Confirm Order" flow.
The remaining product price stays as Cash On Delivery and is never charged
through ZiniPay.

Customer name, phone, and address are collected on the frontend and sent to
this backend, which stores them locally against the order and passes the
name (and a light metadata reference) to ZiniPay when creating the invoice.

## Data storage

Orders are stored in `backend/orders.json`, a flat JSON file, purely to keep
this example runnable with zero external dependencies. **Replace this with a
real database** (Postgres, MySQL, MongoDB, etc.) before handling real order
volume — a flat file has no concurrency safety and isn't durable on most
hosting platforms.

## Security checklist (matches ZiniPay's own production checklist)

- [x] API key stored in an environment variable (`ZINIPAY_API_KEY`), never in
      frontend code or committed to git (`.env` should be in `.gitignore`).
- [ ] **HTTPS enabled** on your real domain before going live — bKash/Nagad
      redirect flows require it.
- [ ] **Redirect domain matches** the domain registered against your ZiniPay
      brand (`APP_BASE_URL` in `.env`).
- [x] **Backend verification added** — the webhook handler never trusts the
      incoming payload's status field; it always calls ZiniPay's Verify
      Invoice endpoint before marking an order paid. `/api/payments/status`
      does the same as a fallback if the webhook hasn't landed yet.
- [ ] **Logging enabled** — this example logs to the console; wire that into
      your real logging/monitoring stack in production.
- [x] **Webhook secured** — the webhook URL includes a random `?token=...`
      (`WEBHOOK_SECRET`) that's checked before processing; requests without a
      matching token are rejected with `401`.

## Endpoints reference

### `POST /api/payments/create`

```json
{
  "orderId": "LM4821",
  "amount": 110,
  "orderTotal": 1390,
  "remainingCOD": 1280,
  "customerName": "Rahim Uddin",
  "customerPhone": "01712345678",
  "customerAddress": "House 12, Road 4, Dhanmondi, Dhaka",
  "quantity": 1,
  "method": "bkash"
}
```

Response:
```json
{ "success": true, "payment_url": "https://secure.zinipay.com/payment/INVOICE_ID" }
```

### `POST /api/payments/webhook` (called by ZiniPay, not by your frontend)

Receives `{ invoice_id, status }`, ignores the given `status`, and instead
calls ZiniPay's Verify Invoice endpoint to get the authoritative result.

### `GET /api/payments/status?order_id=LM4821`

```json
{
  "success": true,
  "status": "COMPLETED",
  "orderId": "LM4821",
  "name": "Rahim Uddin",
  "phone": "01712345678",
  "address": "House 12, Road 4, Dhanmondi, Dhaka",
  "quantity": 1,
  "method": "bkash",
  "payNow": 110,
  "remaining": 1280,
  "orderTotal": 1390,
  "transactionId": "TXN123456789"
}
```

`status` is one of `PENDING`, `COMPLETED`, `FAILED`.
