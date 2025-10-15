// /api/create-checkout-session.js
// Creates a Stripe Checkout Session and returns { success, id, url }.
// Works with both HTTPS App Links and custom-scheme deep links.
// 
// Required env (Vercel):
//  - STRIPE_SECRET_KEY=sk_live_... (or sk_test_... in test)

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// --- Helpers -----------------------------------------------------------------

/** Ensure we have something that looks like an absolute URL or custom-scheme URL */
function isAcceptableReturnUrl(u) {
  try {
    const url = new URL(u);
    // Accept any scheme; Stripe just needs a valid absolute URL string.
    // (https for App Links, custom scheme like myapp:// for deep links)
    return !!url.protocol && !!url.host;
  } catch {
    // Also allow custom schemes of the form: myapp://host/path?x=y without a host? (rare)
    // But URL() requires a host, so fall back to a looser check:
    return typeof u === "string" && /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(u);
  }
}

/** Append/override query params while preserving existing ones */
function withParams(baseUrl, params) {
  const u = new URL(baseUrl);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    u.searchParams.set(k, String(v));
  });
  return u.toString();
}

/** Choose the best success/cancel URLs from body (new or legacy keys) */
function pickReturnUrls(body) {
  const success = body?.successUrl || body?.successReturnUrl;
  const cancel  = body?.cancelUrl  || body?.cancelReturnUrl;
  return { success, cancel };
}

// --- Handler -----------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  try {
    const {
      amountCents,
      currency,
      description,
      metadata,
      orderId, // preferred explicit order id from app
    } = req.body || {};

    const { success: rawSuccess, cancel: rawCancel } = pickReturnUrls(req.body);

    // Validate basics
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ success: false, error: "Invalid amountCents" });
    }
    if (!currency || typeof currency !== "string") {
      return res.status(400).json({ success: false, error: "currency is required" });
    }
    if (!rawSuccess || !isAcceptableReturnUrl(rawSuccess)) {
      return res.status(400).json({ success: false, error: "Valid successUrl (or successReturnUrl) is required" });
    }
    if (!rawCancel || !isAcceptableReturnUrl(rawCancel)) {
      return res.status(400).json({ success: false, error: "Valid cancelUrl (or cancelReturnUrl) is required" });
    }

    // Resolve order id (prefer explicit)
    const resolvedOrderId = orderId || metadata?.order_id;
    // Build success/cancel with required params
    // NOTE: Stripe will expand {CHECKOUT_SESSION_ID} to the created session id.
    const successUrl = withParams(rawSuccess, {
      order_id: resolvedOrderId,
      session_id: "{CHECKOUT_SESSION_ID}",
      // Optional extra aliases your app may also accept:
      cs_id: "{CHECKOUT_SESSION_ID}",
    });
    const cancelUrl = withParams(rawCancel, {
      order_id: resolvedOrderId,
      session_id: "{CHECKOUT_SESSION_ID}",
      cs_id: "{CHECKOUT_SESSION_ID}",
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: resolvedOrderId || undefined, // helps correlate on success/cancel
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
        ...(resolvedOrderId ? { order_id: resolvedOrderId } : {}),
      },
    });

    return res.json({ success: true, id: session.id, url: session.url });
  } catch (e) {
    console.error("[create-checkout-session] error:", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
}
