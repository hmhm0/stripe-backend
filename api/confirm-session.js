// /api/confirm-session.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/** Extract useful payment fields from Stripe */
function extractPaymentMeta(session, pi, charge) {
  const brand = charge?.payment_method_details?.card?.brand ?? null;
  const last4 = charge?.payment_method_details?.card?.last4 ?? null;

  return {
    checkout_session_id: session?.id ?? null,
    payment_intent_id: pi?.id ?? null,
    charge_id: charge?.id ?? null,
    payment_method_brand: brand,
    payment_last4: last4,
    amount_total: Number.isFinite(session?.amount_total)
      ? session.amount_total
      : null,
    currency: session?.currency ?? null,
  };
}

/** param picker */
function pick(req, name, fallback = "") {
  return req.method === "GET"
    ? req.query?.[name] ?? fallback
    : req.body?.[name] ?? fallback;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    const sessionId = String(pick(req, "session_id", "")).trim();
    const hintedOrderId = String(pick(req, "order_id", "")).trim();

    if (!sessionId || !sessionId.startsWith("cs_")) {
      return res.status(400).json({ ok: false, error: "invalid_session_id" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "payment_intent.charges.data"],
    });

    const pi =
      session.payment_intent && typeof session.payment_intent === "object"
        ? session.payment_intent
        : null;
    const charge = pi?.charges?.data?.[0] ?? null;

    const sessionPaid =
      session?.status === "complete" || session?.payment_status === "paid";
    const intentSucceeded = pi?.status === "succeeded";
    const chargeSucceeded = charge?.status === "succeeded";
    const isPaid = Boolean(sessionPaid || intentSucceeded || chargeSucceeded);

    const orderId =
      hintedOrderId ||
      session?.client_reference_id ||
      session?.metadata?.order_id ||
      null;

    if (isPaid && orderId) {
      const meta = extractPaymentMeta(session, pi, charge);

      const { data: existing, error: fetchErr } = await supabase
        .from("orders")
        .select("status,payment_status")
        .eq("id", orderId)
        .maybeSingle();

      if (fetchErr) console.error("[confirm-session] fetch order error:", fetchErr);

      const currentStatus = (existing?.status ?? "").toLowerCase();
      const currentPay = (existing?.payment_status ?? "").toLowerCase();
      const alreadyPaid =
        currentStatus === "paid" || currentPay === "paid" || currentStatus === "completed";

      // compose update
      const updatePayload = {
        status: alreadyPaid ? existing.status : "paid",
        payment_status: "paid",
        paid_at: new Date().toISOString(),
        payment_provider: "stripe",
        checkout_session_id: meta.checkout_session_id,
        payment_intent_id: meta.payment_intent_id,
        charge_id: meta.charge_id,
        payment_method_brand: meta.payment_method_brand,
        payment_last4: meta.payment_last4,
      };
      if (meta.amount_total != null) updatePayload.total_cents = meta.amount_total;
      if (meta.currency) updatePayload.currency = meta.currency;

      const { error: upErr } = await supabase
        .from("orders")
        .update(updatePayload)
        .eq("id", orderId)
        .not("status", "eq", "canceled");

      if (upErr) console.error("[confirm-session] supabase update error:", upErr);

      try {
        await supabase.rpc("recalc_order_totals", { p_order_id: orderId });
      } catch (e) {
        console.warn("[confirm-session] recalc_order_totals failed", e.message);
      }

      return res.status(200).json({
        ok: true,
        paid: true,
        orderId,
        stripe: {
          session: session.id,
          intent: pi?.id,
          charge: charge?.id,
          amount_total: meta.amount_total,
          currency: meta.currency,
        },
      });
    }

    return res.status(200).json({
      ok: true,
      paid: false,
      orderId: orderId || null,
      stripe: {
        session: session.id,
        status: session.status,
        payment_status: session.payment_status,
      },
    });
  } catch (e) {
    console.error("[confirm-session] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
