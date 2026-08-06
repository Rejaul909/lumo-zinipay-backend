/**
 * LUMO — ZiniPay Payment Backend
 * --------------------------------------------------------------
 * This server is the ONLY place that ever sees your ZiniPay API key.
 * The frontend (lumo-landing-page.html) only ever talks to the two
 * routes below — never to ZiniPay directly.
 *
 * Routes:
 *   POST /api/payments/create   -> creates a ZiniPay invoice for the
 *                                  delivery-fee advance amount and
 *                                  returns { success, payment_url }
 *   POST /api/payments/webhook  -> ZiniPay calls this after payment;
 *                                  we re-verify server-side before
 *                                  trusting anything
 *   GET  /api/payments/status   -> polled by the frontend after the
 *                                  customer is redirected back
 *
 * Setup:
 *   1. cp .env.example .env   and fill in your real values
 *   2. npm install
 *   3. npm start
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors({
  origin: "https://striplight.netlify.app",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ------------------------------------------------------------ */
/* Config                                                        */
/* ------------------------------------------------------------ */
const ZINIPAY_BASE_URL = 'https://api.zinipay.com';
const ZINIPAY_API_KEY = process.env.ZINIPAY_API_KEY;
const APP_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const PORT = process.env.PORT || 3000;

if (!ZINIPAY_API_KEY) {
  console.warn(
    '\n[WARN] ZINIPAY_API_KEY is not set. Copy .env.example to .env and add your ' +
    'ZiniPay Brand/API key before accepting real payments.\n'
  );
}
if (!WEBHOOK_SECRET) {
  console.warn(
    '[WARN] WEBHOOK_SECRET is not set. It is strongly recommended so random ' +
    'internet traffic cannot spam your webhook endpoint.\n'
  );
}

/* ------------------------------------------------------------ */
/* Very small JSON-file order store.                             */
/* Demo-grade only — swap for a real database (Postgres, Mongo,  */
/* etc.) before going to production / handling real volume.      */
/* ------------------------------------------------------------ */
const DB_FILE = path.join(__dirname, 'orders.json');

function readOrders() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeOrders(orders) {
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2));
}

/* ------------------------------------------------------------ */
/* ZiniPay helpers                                                */
/* ------------------------------------------------------------ */
async function zinipayCreateInvoice(body) {
  const res = await fetch(`${ZINIPAY_BASE_URL}/v1/payment/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'zini-api-key': ZINIPAY_API_KEY
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function zinipayVerifyInvoice(invoice_id) {
  const res = await fetch(`${ZINIPAY_BASE_URL}/v1/payment/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'zini-api-key': ZINIPAY_API_KEY
    },
    body: JSON.stringify({ invoice_id })
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

function findOrderIdByInvoice(orders, invoice_id) {
  return Object.keys(orders).find((id) => orders[id].invoice_id === invoice_id);
}

/* ------------------------------------------------------------ */
/* POST /api/payments/create                                     */
/* ------------------------------------------------------------ */
app.post('/api/payments/create', async (req, res) => {
  try {
    const {
      orderId, amount, orderTotal, remainingCOD,
      customerName, customerPhone, customerAddress, quantity, method
    } = req.body || {};

    // ---- validation ----
    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({ success: false, error: 'missing_order_id' });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'invalid_amount' });
    }
    if (!customerName || !customerPhone || !customerAddress) {
      return res.status(400).json({ success: false, error: 'missing_customer_details' });
    }
    if (!/^01[0-9]{9}$/.test(customerPhone)) {
      return res.status(400).json({ success: false, error: 'invalid_phone' });
    }
    if (!['bkash', 'nagad'].includes(method)) {
      return res.status(400).json({ success: false, error: 'invalid_method' });
    }
    if (!ZINIPAY_API_KEY) {
      return res.status(500).json({ success: false, error: 'server_not_configured' });
    }

    const orders = readOrders();

    // idempotency guard — if this orderId already has a pending invoice, reuse it
    // instead of creating a duplicate ZiniPay invoice on accidental double-click.
    if (orders[orderId] && orders[orderId].status === 'PENDING' && orders[orderId].payment_url) {
      return res.json({ success: true, payment_url: orders[orderId].payment_url });
    }

    const metadata = {
      order_id: orderId,
      phone: customerPhone,
      quantity: quantity,
      method: method
      // keep metadata small — ZiniPay caps it at 1KB
    };

    const { ok, data } = await zinipayCreateInvoice({
      cus_name: customerName,
      amount: Number(amount), // delivery-fee-only advance amount
      metadata,
      redirect_url: `${APP_BASE_URL}/?order_id=${encodeURIComponent(orderId)}`,
      cancel_url: `${APP_BASE_URL}/?order_id=${encodeURIComponent(orderId)}&payment=cancelled`,
      webhook_url: `${APP_BASE_URL}/api/payments/webhook${WEBHOOK_SECRET ? `?token=${encodeURIComponent(WEBHOOK_SECRET)}` : ''}`
    });

    if (!ok || !data.status || !data.payment_url) {
      console.error('ZiniPay create invoice failed:', data);
      return res.status(502).json({ success: false, error: 'zinipay_create_failed' });
    }

    const invoiceId = data.invoice_id || data.payment_url.split('/').filter(Boolean).pop();

    orders[orderId] = {
      orderId,
      invoice_id: invoiceId,
      payment_url: data.payment_url,
      status: 'PENDING',
      customerName,
      customerPhone,
      customerAddress,
      quantity,
      method,
      amount: Number(amount),          // paid now (delivery fee / advance)
      remainingCOD: Number(remainingCOD) || 0,
      orderTotal: Number(orderTotal) || 0,
      createdAt: new Date().toISOString()
    };
    writeOrders(orders);

    return res.json({ success: true, payment_url: data.payment_url });
  } catch (err) {
    console.error('create-payment error:', err);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

/* ------------------------------------------------------------ */
/* POST /api/payments/webhook                                    */
/* ------------------------------------------------------------ */
app.post('/api/payments/webhook', async (req, res) => {
  try {
    if (WEBHOOK_SECRET && req.query.token !== WEBHOOK_SECRET) {
      console.warn('Webhook rejected: bad or missing token');
      return res.status(401).send('unauthorized');
    }

    const invoice_id = req.body.invoice_id || req.query.invoice_id;
    if (!invoice_id) return res.status(400).send('missing invoice_id');

    // IMPORTANT: never trust the webhook's own status field.
    // Always re-verify the invoice directly against ZiniPay's API.
    const { ok, data } = await zinipayVerifyInvoice(invoice_id);
    if (!ok) {
      console.error('Webhook verify failed for', invoice_id, data);
      return res.status(502).send('verify_failed');
    }

    const orders = readOrders();
    const orderId = data?.metadata?.order_id || findOrderIdByInvoice(orders, invoice_id);

    if (!orderId || !orders[orderId]) {
      console.warn('Webhook: no matching local order for invoice', invoice_id);
      return res.status(200).send('ok'); // ack so ZiniPay stops retrying
    }

    orders[orderId].status = data.status; // PENDING | COMPLETED | FAILED
    orders[orderId].transaction_id = data.transaction_id || null;
    orders[orderId].verified_payment_method = data.payment_method || null;
    orders[orderId].verifiedAt = new Date().toISOString();
    writeOrders(orders);

    console.log(`Order ${orderId} -> ${data.status} (invoice ${invoice_id})`);
    return res.status(200).send('ok');
  } catch (err) {
    console.error('webhook error:', err);
    return res.status(500).send('server_error');
  }
});

/* ------------------------------------------------------------ */
/* GET /api/payments/status?order_id=...                         */
/* Polled by the frontend after the customer is redirected back. */
/* ------------------------------------------------------------ */
app.get('/api/payments/status', async (req, res) => {
  try {
    const { order_id } = req.query;
    if (!order_id) return res.status(400).json({ success: false, error: 'missing_order_id' });

    const orders = readOrders();
    const order = orders[order_id];
    if (!order) return res.status(404).json({ success: false, error: 'order_not_found' });

    // Cover the race where the browser returns before the webhook lands:
    // actively re-verify with ZiniPay if we're still showing PENDING.
    if (order.status === 'PENDING' && order.invoice_id && ZINIPAY_API_KEY) {
      const { ok, data } = await zinipayVerifyInvoice(order.invoice_id);
      if (ok && data.status) {
        order.status = data.status;
        order.transaction_id = data.transaction_id || order.transaction_id || null;
        order.verified_payment_method = data.payment_method || order.verified_payment_method || null;
        orders[order_id] = order;
        writeOrders(orders);
      }
    }

    return res.json({
      success: true,
      status: order.status, // PENDING | COMPLETED | FAILED
      orderId: order.orderId,
      name: order.customerName,
      phone: order.customerPhone,
      address: order.customerAddress,
      quantity: order.quantity,
      method: order.method,
      payNow: order.amount,
      remaining: order.remainingCOD,
      orderTotal: order.orderTotal,
      transactionId: order.transaction_id || null
    });
  } catch (err) {
    console.error('status error:', err);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

/* ------------------------------------------------------------ */
/* Serve the landing page itself (optional convenience).         */
/* Put lumo-landing-page.html into ./public/index.html           */
/* ------------------------------------------------------------ */
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`LUMO payment backend running on http://localhost:${PORT}`);
});
