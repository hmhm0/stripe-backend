// /api/stripe-webhook.js
export const config = { api: { bodyParser: false } };

import Stripe from "stripe";
import getRawBody from "raw-body";
import { createClient } from "@supabase/supabase-js";

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- helpers ---
const isUuid = (s) =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    String(s || "")
  );

function isTerminal(status, paymentStatus) {
  // treat terminal if payment already paid OR order completed/canceled
  if (typeof paymentStatus === "string" && paymentStatus.toLowerCase() === "paid") {
    return true;
  }
  const s = (status || "").toLowerCase();
  return s === "completed" || s === "canceled";
}

function extractCardBitsFromPI(pi) {
  let brand = null, last4 = null, chargeId = null;
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

async function markOrderPaid(orderId, fields) {
  if (!isUuid(orderId)) {
    console.warn("[webhook] invalid order_id, ignoring:", orderId);
    return { ok: true, ignored: true };
  }

  const { data: rows, error: readErr } = await supabase
    .from("orders")
    .select("id,status,payment_status")
    .eq("id", orderId)
    .limit(1);

  if (readErr) {
    console.error("[webhook] Supabase read failed:", readErr);
    return { ok: false, reason: "read_failed" };
  }
  if (!rows || rows.length === 0) {
    console.warn("[webhook] order not found:", orderId);
    return { ok: true, reason: "not_found" };
  }

  const current = rows[0];
  if (isTerminal(current.status, current.payment_status)) {
    return { ok: true, reason: "already_terminal" };
  }

  const { error: updErr } = await supabase
    .from("orders")
    .update(fields)
    .eq("id", orderId);

  if (updErr) {
    console.error("[webhook] Supabase update failed:", updErr);
    return { ok: false, reason: "update_failed" };
  }
  return { ok: true };
}

async function handleCheckoutSession(session) {
  const orderId =
    session?.metadata?.order_id ||
    session?.metadata?.orderId ||
    session?.client_reference_id ||
    null;

  if (!orderId) {
    console.warn("[webhook] session without order_id/client_reference_id; ignored");
    return { ignored: true };
  }

  const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["payment_intent.latest_charge", "payment_intent.payment_method"],
  });

  const pi = fullSession.payment_intent;
  const amountTotal = fullSession.amount_total ?? null; // cents
  const checkoutSessionId = fullSession.id;

  const { brand, last4, chargeId } = extractCardBitsFromPI(pi);

  const updates = {
    payment_status: "paid",               // <-- enum payment_status
    paid_at: new Date().toISOString(),
    payment_provider: "stripe",
    payment_intent_id: pi?.id ?? null,
    payment_ref: pi?.id ?? null,
    charge_id: chargeId,
    checkout_session_id: checkoutSessionId,
    payment_method_brand: brand,
    payment_last4: last4,
  };
  if (typeof amountTotal === "number") {
    updates.total_cents = amountTotal;
  }

  return await markOrderPaid(orderId, updates);
}

async function handlePaymentIntentSucceeded(piEventObject) {
  const orderId =
    piEventObject?.metadata?.order_id || piEventObject?.metadata?.orderId || null;
  if (!orderId) return { ignored: true };

  const full = await stripe.paymentIntents.retrieve(piEventObject.id, {
    expand: ["latest_charge", "payment_method"],
  });

  const { brand, last4, chargeId } = extractCardBitsFromPI(full);

  const updates = {
    payment_status: "paid",
    paid_at: new Date().toISOString(),
    payment_provider: "stripe",
    payment_intent_id: full.id,
    payment_ref: full.id,
    charge_id: chargeId,
  };

  return await markOrderPaid(orderId, updates);
}

// --- handler ---
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
