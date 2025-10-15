// /api/create-checkout-session.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// Optional env to centralize your deep link shape
const APP_SCHEME = process.env.APP_SCHEME || "myapp";
const APP_HOST   = process.env.APP_HOST   || "checkout"; // myapp://checkout/...

function isCustomScheme(url) {
  // Very loose check: treat scheme:// as custom
  return typeof url === "string" && /^[a-z][a-z0-9+\-.]*:\/\//i.test(url) && !url.startsWith("http");
}

function withParams(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  try {
    const {
      amountCents,
      currency,
      description,
      metadata,
      // may be provided by the app:
      successUrl,
      cancelUrl,
      successReturnUrl,
      cancelReturnUrl,
      orderId,
    } = req.body || {};

    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ success: false, error: "Invalid amountCents" });
    }
    if (!currency) {
      return res.status(400).json({ success: false, error: "currency is required" });
    }
    if (!orderId && !metadata?.order_id) {
      return res.status(400).json({ success: false, error: "orderId is required" });
    }
    const resolvedOrderId = orderId || metadata.order_id;

    // Prefer client deep links if they’re clearly custom-scheme
    const clientSuccess = successUrl || successReturnUrl;
    const clientCancel  = cancelUrl  || cancelReturnUrl;

    // Default deep links (custom scheme) — match your AndroidManifest
    const defaultSuccess = `${APP_SCHEME}://${APP_HOST}/success`;
    const defaultCancel  = `${APP_SCHEME}://${APP_HOST}/cancel`;

    // Use client-provided only if they look like deep links; otherwise build ours.
    let finalSuccess = isCustomScheme(clientSuccess) ? clientSuccess : defaultSuccess;
    let finalCancel  = isCustomScheme(clientCancel)  ? clientCancel  : defaultCancel;

    // Ensure both carry order_id and the Checkout Session id placeholder
    finalSuccess = withParams(finalSuccess, { order_id: resolvedOrderId, cs_id: "{CHECKOUT_SESSION_ID}" });
    finalCancel  = withParams(finalCancel,  { order_id: resolvedOrderId, cs_id: "{CHECKOUT_SESSION_ID}" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      // Deep links that bounce back into your app:
      success_url: finalSuccess,
      cancel_url: finalCancel,

      // Helpful for debugging in Stripe dashboard:
      client_reference_id: resolvedOrderId,

      // Webhook will rely on this:
      metadata: { ...(metadata || {}), order_id: resolvedOrderId },

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
    });

    return res.json({ success: true, id: session.id, url: session.url });
  } catch (e) {
    console.error("[create-checkout-session]", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
}
