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
      metadata,             // <-- include order_id here when available
      successReturnUrl,
      cancelReturnUrl,
    } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      success_url: successReturnUrl,
      cancel_url: cancelReturnUrl,
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
      metadata: metadata || {}, // e.g. { order_id: "uuid" }
    });

    res.json({ success: true, url: session.url });
  } catch (e) {
    console.error("[create-checkout-session]", e);
    res.status(500).json({ success: false });
  }
}
