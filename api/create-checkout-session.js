// /api/create-checkout-session.js
// Creates a Stripe Checkout Session for one-off payments.
//
// Env needed (Vercel):
//  - STRIPE_SECRET_KEY=sk_live_... (or sk_test_... in test)

import Stripe from "stripe";

const { STRIPE_SECRET_KEY } = process.env;
if (!STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY");
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  try {
    const {
      // Amount (in cents) + currency
      amountCents: rawAmountCents,
      amount, // alias (fallback)
      currency: rawCurrency = "sgd",

      // Optional label shown on the Stripe page
      description,

      // Reconciliation
      orderId,     // preferred, from your app when paying for a created order
      metadata,    // optional; we will merge order_id into it if not present

      // Return URLs (either pair is accepted)
      successUrl,
      cancelUrl,
      successReturnUrl, // alias
      cancelReturnUrl,  // alias
    } = req.body || {};

    // ---- Validate inputs ----
    const amountCents =
      Number.isFinite(rawAmountCents) ? rawAmountCents :
      Number.isFinite(amount) ? amount : NaN;

    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ success: false, error: "Invalid amountCents" });
    }

    const success = successUrl || successReturnUrl;
    const cancel = cancelUrl || cancelReturnUrl;
    if (!success || !cancel) {
      return res.status(400).json({ success: false, error: "Missing success/cancel URLs" });
    }

    const currency = String(rawCurrency || "sgd").toLowerCase();
    const safeDescription =
      typeof description === "string" && description.trim().length > 0
        ? description.trim()
        : "Order";

    // ---- Build metadata + client_reference_id (nice in Stripe Dashboard) ----
    const md = (metadata && typeof metadata === "object") ? { ...metadata } : {};
    if (orderId && !md.order_id) md.order_id = String(orderId);
    const clientRef = orderId ? String(orderId) : undefined;

    // ---- Create the Checkout Session ----
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: clientRef,     // helps reconciliation + shows in Dashboard
      success_url: String(success),
      cancel_url: String(cancel),
      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: safeDescription },
            unit_amount: Math.trunc(amountCents),
          },
          quantity: 1,
        },
      ],
      metadata: md,
      // Nice-to-have (optional):
      allow_promotion_codes: true,
      automatic_tax: { enabled: false },
    });

    return res.status(200).json({
      success: true,
      id: session.id,
      url: session.url,
    });
  } catch (e) {
    console.error("[create-checkout-session] error", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
}
