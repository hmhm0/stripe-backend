// /api/create-checkout-session.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");
  try {
    const {
      amountCents,
      currency,
      description,
      metadata,
      // accept both, prefer the explicit camelCase sent by the app now
      successUrl,
      cancelUrl,
      successReturnUrl,
      cancelReturnUrl,
      // optional: orderId so we can set client_reference_id too
      orderId,
    } = req.body || {};

    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ success: false, error: "Invalid amountCents" });
    }
    if (!currency) {
      return res.status(400).json({ success: false, error: "currency is required" });
    }

    const finalSuccess = successUrl || successReturnUrl;
    const finalCancel = cancelUrl || cancelReturnUrl;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      success_url: finalSuccess, // e.g. myapp://success or https://app.example.com/stripe/success
      cancel_url: finalCancel,   // e.g. myapp://cancel  or https://app.example.com/stripe/cancel
      client_reference_id: orderId || metadata?.order_id || undefined,
      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: description || "Order" },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        ...(metadata || {}),
        ...(orderId ? { order_id: orderId } : {}),
      },
    });

    res.json({ success: true, id: session.id, url: session.url });
  } catch (e) {
    console.error("[create-checkout-session]", e);
    res.status(500).json({ success: false, error: "server_error" });
  }
}
