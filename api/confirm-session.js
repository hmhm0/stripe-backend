// /api/confirm-session.js
// Verifies a Stripe Checkout Session by id (session_id / cs_id).
// Returns { ok, paid, orderId, status, paymentStatus, piStatus }.

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// small helper: wait
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch + decide paid
async function fetchAndJudge(sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent"],
  });

  const status = session.status;                     // 'open' | 'complete' | ...
  const paymentStatus = session.payment_status;      // 'paid' | 'unpaid' | 'no_payment_required'
  const pi = session.payment_intent;
  const piStatus = pi && typeof pi === "object" ? pi.status : null; // 'succeeded' etc.

  const paid =
    paymentStatus === "paid" ||
    status === "complete" ||
    piStatus === "succeeded";

  // Prefer explicit order id that you set as client_reference_id or metadata.order_id
  const orderId = session.client_reference_id || session.metadata?.order_id || null;

  return { paid, orderId, status, paymentStatus, piStatus };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).end("Method Not Allowed");
  }

  try {
    const sessionId =
      req.query.session_id ||
      req.query.cs_id ||
      req.body?.session_id ||
      req.body?.cs_id;

    if (!sessionId) {
      return res.status(400).json({ ok: false, paid: false, error: "missing_session_id" });
    }

    // Retry a few times to out-wait Stripe’s eventual consistency
    const attempts = [0, 400, 900, 1500]; // ms
    let last = null;

    for (let i = 0; i < attempts.length; i++) {
      if (i > 0) await sleep(attempts[i]);
      last = await fetchAndJudge(sessionId);
      if (last.paid) {
        return res.json({ ok: true, paid: true, orderId: last.orderId, ...last });
      }
    }

    // Still not paid
    return res.json({ ok: true, paid: false, orderId: last?.orderId || null, ...last });
  } catch (e) {
    console.error("[confirm-session] error:", e);
    return res.status(500).json({ ok: false, paid: false, error: "server_error" });
  }
}
