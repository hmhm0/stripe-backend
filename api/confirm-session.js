// /api/confirm-session.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // must be service-role for webhook/admin writes
);

/**
 * Extract a few useful payment fields from Stripe objects.
 */
function extractPaymentMeta(session, pi, charge) {
  const brand = charge?.payment_method_details?.card?.brand ?? null;
  const last4 = charge?.payment_method_details?.card?.last4 ?? null;

  return {
    checkout_session_id: session?.id ?? null,
    payment_intent_id: pi?.id ?? null,
    charge_id: charge?.id ?? null,
    payment_method_brand: brand,
    payment_last4: last4,
    amount_total: Number.isFinite(session?.amount_total) ? session.amount_total : null,
    currency: session?.currency ?? null,
  };
}

/** Resolve fields from GET or POST body */
function pick(req, name, fallback = "") {
  return req.method === "GET" ? (req.query?.[name] ?? fallback) : (req.body?.[name] ?? fallback);
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

    // Retrieve the session with expands so we can make a robust decision
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "payment_intent.charges.data"],
    });

    const pi =
      session.payment_intent && typeof session.payment_intent === "object"
        ? session.payment_intent
        : null;

    // First charge (for card there will typically be one)
    const charge = pi?.charges?.data?.[0] ?? null;

    // Determine paid
    const sessionPaid =
      session?.status === "complete" || session?.payment_status === "paid";
    const intentSucceeded = pi?.status === "succeeded";
    const chargeSucceeded = charge?.status === "succeeded";
    const isPaid = Boolean(sessionPaid || intentSucceeded || chargeSucceeded);

    // Resolve order id consistently
    const orderId =
      hintedOrderId ||
      session?.client_reference_id ||
      session?.metadata?.order_id ||
      null;

    // If paid and we know which order, persist details into Supabase
    if (isPaid && orderId) {
      const meta = extractPaymentMeta(session, pi, charge);

      // If your orders table has (status, payment_status, paid_at, *_ids, brand/last4, amount/currency)
      // We avoid overwriting a canceled order.
      // If you don't have amount/currency columns, remove them below.
      const { data: existing, error: fetchErr } = await supabase
        .from("orders")
        .select("status")
        .eq("id", orderId)
        .maybeSingle();

      if (fetchErr) {
        console.error("[confirm-session] fetch order error:", fetchErr);
      }

      const alreadyCanceled = (existing?.status ?? "").toLowerCase() === "canceled";

      const updatePayload = {
        payment_status: "paid",
        paid_at: new Date().toISOString(),
        checkout_session_id: meta.checkout_session_id,
        payment_intent_id: meta.payment_intent_id,
        charge_id: meta.charge_id,
        payment_method_brand: meta.payment_method_brand,
        payment_last4: meta.payment_last4,
      };

      // If your schema has these (optional)
      if (meta.amount_total != null) updatePayload.total_cents = meta.amount_total;
      if (meta.currency) updatePayload.currency = meta.currency;

      // Only set status='paid' if it isn't canceled already
      if (!alreadyCanceled) {
        updatePayload.status = "paid";
      }

      const { error: upErr } = await supabase
        .from("orders")
        .update(updatePayload)
        .eq("id", orderId);

      if (upErr) {
        // Don’t fail the confirm if DB write has a transient issue
        console.error("[confirm-session] supabase update error:", upErr);
      }

      // Optional but nice: ensure totals are fresh (name matches your function)
      try {
        await supabase.rpc("recalc_order_totals", { p_order_id: orderId });
      } catch (e) {
        // swallow (best effort)
        // console.warn("[confirm-session] recalc_order_totals failed", e);
      }

      return res.status(200).json({
        ok: true,
        paid: true,
        orderId,
        session: { id: session.id, status: session.status, payment_status: session.payment_status },
        intent: { id: pi?.id ?? null, status: pi?.status ?? null },
        charge: { id: charge?.id ?? null, status: charge?.status ?? null },
      });
    }

    // Not paid (yet) – webhook may update it a moment later
    return res.status(200).json({
      ok: true,
      paid: false,
      orderId: orderId || null,
      session: { id: session.id, status: session.status, payment_status: session.payment_status },
      intent: { id: pi?.id ?? null, status: pi?.status ?? null },
      charge: { id: charge?.id ?? null, status: charge?.status ?? null },
    });
  } catch (e) {
    console.error("[confirm-session] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
