// /api/confirm-session.js
// Confirms a Stripe Checkout Session by id and returns { ok, paid, orderId, ... }.
//
// Accepts (POST body OR query string):
//   - sessionId (preferred key)
//   - session_id (Stripe appends this to success_url)
//
// Env (Vercel):
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Notes:
// - We treat the payment as paid if either:
//     session.payment_status === 'paid'  OR  payment_intent.status === 'succeeded'
// - We try to determine orderId via:
//     session.metadata.order_id -> client_reference_id -> lookup in Supabase by checkout_session_id/payment_intent_id
// - Idempotent: does NOT mutate order status (webhook does that). It may patch missing identifiers.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const {
  STRIPE_SECRET_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** Robust boolean from Stripe objects */
function isPaid(session, pi) {
  const paidBySession = (session?.payment_status || "").toLowerCase() === "paid";
  const paidByPI = (pi?.status || "").toLowerCase() === "succeeded";
  return paidBySession || paidByPI;
}

/** Pull a single order row by either checkout_session_id or payment_intent_id */
async function findOrderIdByStripeIds({ checkoutSessionId, paymentIntentId }) {
  // Prefer checkout_session_id lookup (unique index)
  if (checkoutSessionId) {
    const { data, error } = await supabase
      .from("orders")
      .select("id")
      .eq("checkout_session_id", checkoutSessionId)
      .maybeSingle();
    if (!error && data?.id) return data.id;
  }

  if (paymentIntentId) {
    const { data, error } = await supabase
      .from("orders")
      .select("id")
      .eq("payment_intent_id", paymentIntentId)
      .maybeSingle();
    if (!error && data?.id) return data.id;
  }

  return null;
}

/** Patch missing identifiers (idempotent, no status changes) */
async function backfillStripeIds(orderId, { checkoutSessionId, paymentIntentId }) {
  if (!orderId) return;

  const { data: existing, error: readErr } = await supabase
    .from("orders")
    .select("id, checkout_session_id, payment_intent_id")
    .eq("id", orderId)
    .maybeSingle();

  if (readErr || !existing) return;

  const patch = {};
  if (checkoutSessionId && !existing.checkout_session_id) patch.checkout_session_id = checkoutSessionId;
  if (paymentIntentId && !existing.payment_intent_id) patch.payment_intent_id = paymentIntentId;

  if (Object.keys(patch).length > 0) {
    await supabase.from("orders").update(patch).eq("id", orderId);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).end("Method Not Allowed");
    }

    // Accept body or query param (Stripe appends session_id on success_url)
    const sessionId =
      (req.method === "GET" ? req.query.sessionId || req.query.session_id : null) ||
      (req.body?.sessionId || req.body?.session_id);

    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ ok: false, error: "missing_session_id" });
    }

    // Retrieve session with useful expansions
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent.latest_charge", "payment_intent.payment_method"],
    });

    const pi = session.payment_intent && typeof session.payment_intent === "object"
      ? session.payment_intent
      : null;

    const paid = isPaid(session, pi);

    // Derive orderId
    let orderId =
      session?.metadata?.order_id ||
      session?.client_reference_id ||
      null;

    // If not present, try searching the DB by session/PI
    if (!orderId) {
      orderId = await findOrderIdByStripeIds({
        checkoutSessionId: session.id,
        paymentIntentId: pi?.id ?? null,
      });
    }

    // Opportunistic backfill of identifiers (does NOT change status)
    if (orderId) {
      await backfillStripeIds(orderId, {
        checkoutSessionId: session.id,
        paymentIntentId: pi?.id ?? null,
      });
    }

    // Shape a friendly response for the app
    return res.json({
      ok: true,
      paid,
      orderId: orderId || null,
      checkoutSessionId: session.id,
      paymentIntentId: pi?.id ?? null,
      amountCents: session.amount_total ?? null,
      currency: session.currency ?? null,
      // Some extra hints (can help during testing)
      sessionPaymentStatus: session.payment_status,
      paymentIntentStatus: pi?.status ?? null,
    });
  } catch (err) {
    console.error("[confirm-session] error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
