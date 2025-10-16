// /api/confirm-session.js
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    // Accept both GET and POST: session_id and optional order_id
    const sessionId =
      (req.method === "GET" ? req.query.session_id : req.body?.session_id) || "";
    const hintedOrderId =
      (req.method === "GET" ? req.query.order_id : req.body?.order_id) || "";

    if (!sessionId || !String(sessionId).startsWith("cs_")) {
      return res.status(400).json({ ok: false, error: "invalid_session_id" });
    }

    // Retrieve the session with expands so we can make a robust decision
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "payment_intent.charges.data"],
    });

    const pi = session.payment_intent && typeof session.payment_intent === "object"
      ? session.payment_intent
      : null;

    // Pick the first charge (for card there will be one)
    const charge = pi?.charges?.data?.[0] ?? null;

    // Determine paid
    const sessionPaid =
      session?.status === "complete" || session?.payment_status === "paid";
    const intentSucceeded = pi?.status === "succeeded";
    const isPaid = Boolean(sessionPaid || intentSucceeded);

    // Figure out order id
    const orderId =
      hintedOrderId ||
      session?.client_reference_id ||
      session?.metadata?.order_id ||
      null;

    // If it’s paid and we have an order id, update Supabase
    if (isPaid && orderId) {
      const meta = extractPaymentMeta(session, pi, charge);

      // Update orders set status + payment info.
      // (Column names assume your earlier schema; adjust if needed.)
      const { error: upErr } = await supabase
        .from("orders")
        .update({
          status: "paid",
          paid_at: new Date().toISOString(),
          checkout_session_id: meta.checkout_session_id,
          payment_intent_id: meta.payment_intent_id,
          charge_id: meta.charge_id,
          payment_method_brand: meta.payment_method_brand,
          payment_last4: meta.payment_last4,
        })
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
      }

      return res.status(200).json({ ok: true, paid: true, orderId });
    }

    // Not paid yet (webhook may update it a moment later)
    return res.status(200).json({
      ok: true,
      paid: false,
      orderId: orderId || null,
      session: { id: session.id, status: session.status, payment_status: session.payment_status },
      intent: { id: pi?.id ?? null, status: pi?.status ?? null },
    });
  } catch (e) {
    console.error("[confirm-session] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
