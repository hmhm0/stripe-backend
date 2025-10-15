// /api/stripe-webhook.js
// Verifies signature, reads Checkout Session + PaymentIntent, and updates Supabase `orders`.
//
// Required env (Vercel):
//  - STRIPE_SECRET_KEY=sk_live_... (or sk_test_... in test)
//  - STRIPE_WEBHOOK_SECRET=whsec_...
//  - SUPABASE_URL=https://xxx.supabase.co
//  - SUPABASE_SERVICE_ROLE_KEY=service-role-key

export const config = {
  api: { bodyParser: false }, // IMPORTANT: Stripe needs the raw body
};

import Stripe from "stripe";
import getRawBody from "raw-body";
import { createClient } from "@supabase/supabase-js";

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (!STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY");
}
if (!STRIPE_WEBHOOK_SECRET) {
  throw new Error("Missing STRIPE_WEBHOOK_SECRET");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** Returns true if local row is already terminal (avoid re-updates) */
function isTerminal(status) {
  if (typeof status !== "string") return false;
  const s = status.toLowerCase();
  return s === "paid" || s === "completed" || s === "canceled";
}

/** Safely extracts (brand, last4, chargeId) from PI expanded object */
function extractCardBitsFromPI(pi) {
  let brand = null,
    last4 = null,
    chargeId = null;

  const ch = pi?.latest_charge;
  if (ch && typeof ch === "object") {
    const card = ch.payment_method_details?.card;
    brand = card?.brand ?? brand;
    last4 = card?.last4 ?? last4;
    chargeId = ch.id ?? chargeId;
  }
  const pm = pi?.payment_method;
  if ((!brand || !last4) && pm && typeof pm === "object" && pm.card) {
    brand = brand ?? pm.card.brand ?? null;
    last4 = last4 ?? pm.card.last4 ?? null;
  }
  return { brand, last4, chargeId };
}

/** Updates a single order row if not already terminal */
async function markOrderPaid(orderId, fields) {
  // Check current status (idempotency)
  const { data: rows, error: readErr } = await supabase
    .from("orders")
    .select("id,status")
    .eq("id", orderId)
    .limit(1);

  if (readErr) {
    console.error("[webhook] Supabase read failed:", readErr);
    return { ok: false, reason: "read_failed" };
  }
  if (!rows || rows.length === 0) {
    console.warn("[webhook] order not found:", orderId);
    // Acknowledge anyway to avoid retries; you may want to alert ops here.
    return { ok: true, reason: "not_found" };
  }

  const current = rows[0]?.status;
  if (isTerminal(current)) {
    // Already paid/completed/canceled — do nothing
    return { ok: true, reason: "already_terminal" };
  }

  const { error: updErr } = await supabase.from("orders").update(fields).eq("id", orderId);
  if (updErr) {
    console.error("[webhook] Supabase update failed:", updErr);
    return { ok: false, reason: "update_failed" };
  }
  return { ok: true };
}

/** Handles a Checkout Session (completed/async_succeeded) */
async function handleCheckoutSession(session) {
  // Prefer metadata.order_id; fallback to client_reference_id if you set it on creation
  const orderId =
    session?.metadata?.order_id ||
    session?.metadata?.orderId ||
    session?.client_reference_id ||
    null;

  if (!orderId) {
    console.warn("[webhook] session without order_id/client_reference_id; ignored");
    return { ignored: true };
  }

  // Retrieve session again with deep expand for consistent shape
  const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["payment_intent.latest_charge", "payment_intent.payment_method"],
  });

  const pi = fullSession.payment_intent;
  const amountTotal = fullSession.amount_total ?? null; // cents
  const checkoutSessionId = fullSession.id;

  const { brand, last4, chargeId } = extractCardBitsFromPI(pi);

  const updates = {
    status: "paid",
    paid_at: new Date().toISOString(),
    payment_method_brand: brand,
    payment_last4: last4,
    payment_intent_id: pi?.id ?? null,
    charge_id: chargeId,
    checkout_session_id: checkoutSessionId,
  };
  if (typeof amountTotal === "number") {
    updates.total_cents = amountTotal;
  }

  return await markOrderPaid(orderId, updates);
}

/** Fallback for PI-only flows (if you ever charge without Checkout Session) */
async function handlePaymentIntentSucceeded(piEventObject) {
  const orderId =
    piEventObject?.metadata?.order_id || piEventObject?.metadata?.orderId || null;
  if (!orderId) return { ignored: true };

  // Retrieve PI with expand to extract card and latest charge
  const full = await stripe.paymentIntents.retrieve(piEventObject.id, {
    expand: ["latest_charge", "payment_method"],
  });

  const { brand, last4, chargeId } = extractCardBitsFromPI(full);

  const updates = {
    status: "paid",
    paid_at: new Date().toISOString(),
    payment_method_brand: brand,
    payment_last4: last4,
    payment_intent_id: full.id,
    charge_id: chargeId,
  };

  return await markOrderPaid(orderId, updates);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  let event;
  try {
    const raw = await getRawBody(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[webhook] signature verify failed:", err?.message);
    return res.status(400).send(`Webhook Error: ${err?.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        const result = await handleCheckoutSession(session);
        return res.json({ received: true, ...result });
      }

      case "payment_intent.succeeded": {
        const pi = event.data.object;
        const result = await handlePaymentIntentSucceeded(pi);
        return res.json({ received: true, ...result });
      }

      // You can optionally log failures/expired for support:
      case "checkout.session.expired":
      case "payment_intent.payment_failed": {
        console.warn("[webhook]", event.type, event.data?.object?.id);
        return res.json({ received: true });
      }

      default:
        return res.json({ received: true });
    }
  } catch (err) {
    console.error("[webhook] handler error", err);
    return res.status(500).send("Webhook handler failed");
  }
}
