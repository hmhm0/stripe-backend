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
if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing required env vars for Stripe/Supabase.");
}
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
// ---------- helpers ----------
const isUuid = (s) =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
    String(s || "")
  );
const toCurrency = (c) => String(c || "").trim().toUpperCase();
const cents = (n) => (typeof n === "number" ? Math.round(n) : null);
function extractCardBitsFromPI(pi) {
  const ch = pi?.latest_charge;
  const card = ch?.payment_method_details?.card ?? {};
  return {
    brand: card.brand ?? null,
    last4: card.last4 ?? null,
    chargeId: ch?.id ?? null,
  };
}
// Updated: Logs FULL payload for debugging
async function logStripeEventOnce(event) {
  try {
    const { data, error } = await supabase
      .from("stripe_event_logs")
      .insert({
        event_id: event.id,
        type: event.type,
        payload: event, // <--- NEW: Stores the full JSON body
        created_at: new Date().toISOString(),
      })
      .select("event_id")
      .maybeSingle();
    if (error) {
      if (String(error.message || "").toLowerCase().includes("duplicate")) {
        return { alreadyProcessed: true };
      }
      // If column 'payload' is missing, this might error. Ensure logic handles it?
      // For now we assume you ran the schema update.
      console.error("[logStripeEventOnce] DB Insert Error:", error.message);
      return { error };
    }
    return { ok: true, id: data?.event_id };
  } catch (e) {
    console.error("[logStripeEventOnce] Exception:", e);
    // Swallow logging errors; never block payment handling
    return { loggingDisabled: true };
  }
}
async function callMarkOrderPaid({
  orderId,
  checkoutSessionId,
  paymentIntentId,
  chargeId,
  amountCents,
  currency,
}) {
  const { error } = await supabase.rpc("mark_order_paid", {
    p_order_id: orderId,
    p_checkout_session_id: checkoutSessionId ?? null,
    p_payment_intent_id: paymentIntentId ?? null,
    p_charge_id: chargeId ?? null,
    p_amount_cents: amountCents ?? null,
    p_currency: currency ?? null,
  });
  if (error) throw new Error(`[rpc:mark_order_paid] ${error.message}`);
  return { ok: true };
}
async function callMarkOrderRefunded({
  orderId,
  chargeId,
  amountCents,
  currency,
  reason,
}) {
  try {
    const { error } = await supabase.rpc("mark_order_refunded", {
      p_order_id: orderId,
      p_charge_id: chargeId ?? null,
      p_amount_cents: amountCents ?? null,
      p_currency: currency ?? null,
      p_reason: reason ?? null,
    });
    if (error) throw error;
    return { ok: true };
  } catch (e) {
    const msg = String(e.message || "").toLowerCase();
    if (msg.includes("function") && msg.includes("does not exist")) {
      return { skipped: true, reason: "mark_order_refunded not deployed" };
    }
    throw new Error(`[rpc:mark_order_refunded] ${e.message}`);
  }
}
function readOrderIdFromMeta(metaLike) {
  const m = metaLike?.metadata || metaLike || {};
  return m.order_id || m.orderId || null;
}
// ---------- handlers ----------
async function handleCheckoutSession(session) {
  const orderId =
    readOrderIdFromMeta(session) || session?.client_reference_id || null;
  if (!orderId || !isUuid(orderId)) {
    return { ignored: true, reason: "missing_or_invalid_order_id" };
  }
  const full = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["payment_intent.latest_charge", "payment_intent.payment_method"],
  });
  const pi = full.payment_intent;
  const { brand, last4, chargeId } = extractCardBitsFromPI(pi);
  const amountTotal = cents(full.amount_total);
  const currency = toCurrency(full.currency);
  await callMarkOrderPaid({
    orderId,
    checkoutSessionId: full.id,
    paymentIntentId: pi?.id ?? null,
    chargeId,
    amountCents: amountTotal,
    currency,
  });
  return {
    ok: true,
    orderId,
    payment_method: { brand, last4, chargeId },
  };
}
async function handlePaymentIntentSucceeded(piObj) {
  const orderId = readOrderIdFromMeta(piObj);
  if (!orderId || !isUuid(orderId)) {
    return { ignored: true, reason: "missing_or_invalid_order_id" };
  }
  const full = await stripe.paymentIntents.retrieve(piObj.id, {
    expand: ["latest_charge", "payment_method"],
  });
  const { brand, last4, chargeId } = extractCardBitsFromPI(full);
  const amountCents = cents(full.amount_received ?? full.amount ?? null);
  const currency = toCurrency(full.currency);
  await callMarkOrderPaid({
    orderId,
    checkoutSessionId: null,
    paymentIntentId: full.id,
    chargeId,
    amountCents,
    currency,
  });
  return {
    ok: true,
    orderId,
    payment_method: { brand, last4, chargeId },
  };
}
async function handleRefundEvent(refundObj) {
  const chargeId = refundObj?.charge ?? refundObj?.id ?? null;
  let paymentIntentId =
    refundObj?.payment_intent ||
    refundObj?.payment_intent_id ||
    refundObj?.payment_intent?.id ||
    null;
  let piFull = null;
  if (paymentIntentId) {
    piFull = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge", "payment_method"],
    });
  } else if (chargeId) {
    const charge = await stripe.charges.retrieve(chargeId);
    paymentIntentId = charge?.payment_intent || null;
    if (paymentIntentId) {
      piFull = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge", "payment_method"],
      });
    }
  }
  const orderId = readOrderIdFromMeta(piFull);
  if (!orderId || !isUuid(orderId)) {
    return { ignored: true, reason: "refund_without_order_id" };
  }
  const amountCents =
    cents(refundObj?.amount) ??
    cents(piFull?.amount_received) ??
    cents(piFull?.amount) ??
    null;
  const currency =
    toCurrency(refundObj?.currency) || toCurrency(piFull?.currency) || null;
  const result = await callMarkOrderRefunded({
    orderId,
    chargeId,
    amountCents,
    currency,
    reason: refundObj?.reason || null,
  });
  return { ok: true, orderId, refunded: true, rpc: result };
}
// ---------- main entry ----------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");
  let event;
  try {
    const raw = await getRawBody(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[webhook] signature verify failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  const logResult = await logStripeEventOnce(event);
  if (logResult?.alreadyProcessed) {
    return res.json({ ok: true, reason: "duplicate_event" });
  }
  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return res.json(await handleCheckoutSession(event.data.object));
      case "payment_intent.succeeded":
        return res.json(await handlePaymentIntentSucceeded(event.data.object));
      case "charge.refunded":
      case "refund.succeeded":
      case "charge.refund.updated":
        return res.json(await handleRefundEvent(event.data.object));
      case "checkout.session.expired":
        return res.json({ ok: true, received: true, action: "noop" });
      default:
        return res.json({ received: true });
    }
  } catch (err) {
    console.error("[webhook] handler error", err);
    return res.status(500).send("Webhook handler failed");
  }
}
