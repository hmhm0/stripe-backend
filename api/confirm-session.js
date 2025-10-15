// /api/confirm-session.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// tiny sleep
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  // CORS (adjust origin for prod if you want)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  try {
    const { sessionId } = req.body || {};
    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ ok: false, error: "missing_session_id" });
    }

    // up to 3 quick retries to allow Stripe to finalize the session
    let last, attempts = 0, paid = false, orderId = null;

    while (attempts < 3 && !paid) {
      attempts++;

      last = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent", "payment_status_transitions"],
      });

      orderId =
        last.client_reference_id ||
        (last.metadata && last.metadata.order_id) ||
        null;

      // 1) Primary signal (Checkout Session)
      const complete = last.status === "complete";
      const paidFlag = last.payment_status === "paid";

      // 2) Secondary signal (PaymentIntent)
      const pi = last.payment_intent;
      const piSucceeded =
        pi && typeof pi === "object" && pi.status === "succeeded";

      paid = !!(complete || paidFlag || piSucceeded);

      if (!paid) {
        // small backoff; usually 0–500ms is enough
        await wait(300);
      }
    }

    return res.json({
      ok: true,
      paid,
      orderId,
      // You can also return these for debugging:
      // sessionStatus: last?.status,
      // sessionPaymentStatus: last?.payment_status,
      // piStatus: last?.payment_intent?.status,
    });
  } catch (e) {
    console.error("[confirm-session] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
