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

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const isUuid = (s) =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    String(s || "")
  );

function isTerminal(status, paymentStatus) {
  const s = (status || "").toLowerCase();
  const ps = (paymentStatus || "").toLowerCase();
  return (
    s === "completed" ||
    s === "canceled" ||
    ps === "paid" ||
    s === "paid"
  );
}

function extractCardBits(pi) {
  const ch = pi?.latest_charge;
  const card = ch?.payment_method_details?.card ?? {};
  return {
    brand: card.brand ?? null,
    last4: card.last4 ?? null,
    chargeId: ch?.id ?? null,
  };
}

async function markOrderPaid(orderId, updates) {
  if (!isUuid(orderId)) {
    console.warn("[webhook] invalid order_id, ignoring:", orderId);
    return { ignored: true };
  }

  const { data, error } = await supabase
    .from("orders")
    .select("status,payment_status")
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error("[webhook] read failed:", error);
    return { ok: false, reason: "read_failed" };
  }
  if (!data) return { ok: true, reason: "not_found" };
  if (isTerminal(data.status, data.payment_status))
    return { ok: true, reason: "already_terminal" };

  const payload = {
    ...updates,
    status: "paid",
    payment_status: "paid",
    paid_at: new Date().toISOString(),
  };

  const { error: upErr } = await supabase
    .from("orders")
    .update(payload)
    .eq("id", orderId)
    .not("status", "eq", "canceled");

  if (upErr) {
    console.error("[webhook] update failed:", upErr);
    return { ok: false, reason: "update_failed" };
  }

  try {
    await supabase.rpc("recalc_order_totals", { p_order_id: orderId });
  } catch (e) {
    console.warn("[webhook] recalc_order_totals failed", e.message);
  }

  return { ok: true };
}

async function handleCheckoutSession(session) {
  const orderId =
    session?.metadata?.order_id ||
    session?.metadata?.orderId ||
    session?.client_reference_id ||
    null;
  if (!orderId) return { ignored: true };

  const full = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["payment_intent.latest_charge", "payment_intent.payment_method"],
  });

  const pi = full.payment_intent;
  const { brand, last4, chargeId } = extractCardBits(pi);
  const amount = full.amount_total ?? null;

  const updates = {
    payment_provider: "stripe",
    payment_intent_id: pi?.id ?? null,
    charge_id: chargeId,
    checkout_session_id: full.id,
    payment_method_brand: brand,
    payment_last4: last4,
  };
  if (amount != null) updates.total_cents = amount;

  return await markOrderPaid(orderId, updates);
}

async function handlePaymentIntentSucceeded(piObj) {
  const orderId =
    piObj?.metadata?.order_id || piObj?.metadata?.orderId || null;
  if (!orderId) return { ignored: true };

  const full = await stripe.paymentIntents.retrieve(piObj.id, {
    expand: ["latest_charge", "payment_method"],
  });

  const { brand, last4, chargeId } = extractCardBits(full);
  const updates = {
    payment_provider: "stripe",
    payment_intent_id: full.id,
    charge_id: chargeId,
    payment_method_brand: brand,
    payment_last4: last4,
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
    console.error("[webhook] signature verify failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return res.json(await handleCheckoutSession(event.data.object));
      case "payment_intent.succeeded":
        return res.json(await handlePaymentIntentSucceeded(event.data.object));
      default:
        return res.json({ received: true });
    }
  } catch (err) {
    console.error("[webhook] handler error", err);
    return res.status(500).send("Webhook handler failed");
  }
}
