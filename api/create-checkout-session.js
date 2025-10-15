// /api/create-checkout-session.js
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// --- Helpers -----------------------------------------------------------------

function isAcceptableReturnUrl(u) {
  try {
    const url = new URL(u);
    return !!url.protocol && !!url.host; // works for https:// and custom schemes with host
  } catch {
    // Accept custom scheme without host: myapp://path
    return typeof u === "string" && /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(u);
  }
}

/** Append query params; supports https and custom schemes (even without host) */
function withParams(baseUrl, params) {
  try {
    const u = new URL(baseUrl);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      u.searchParams.set(k, String(v));
    });
    return u.toString();
  } catch {
    // Fallback: manual append (for custom schemes that URL() can’t parse)
    const q = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (!q) return baseUrl;
    return baseUrl.includes("?") ? `${baseUrl}&${q}` : `${baseUrl}?${q}`;
  }
}

function pickReturnUrls(body) {
  const success = body?.successUrl || body?.successReturnUrl;
  const cancel  = body?.cancelUrl  || body?.cancelReturnUrl;
  return { success, cancel };
}

// --- Handler -----------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  try {
    const { amountCents, currency, description, metadata, orderId } = req.body || {};
    const { success: rawSuccess, cancel: rawCancel } = pickReturnUrls(req.body);

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

    const resolvedOrderId = orderId || metadata?.order_id;

    // Only success needs session_id; include order_id to help UX/debug
    const successUrl = withParams(rawSuccess, {
      order_id: resolvedOrderId,
      session_id: "{CHECKOUT_SESSION_ID}",
    });
    const cancelUrl = withParams(rawCancel, {
      order_id: resolvedOrderId,
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: resolvedOrderId || undefined,
      line_items: [{
        price_data: {
          currency,
          product_data: { name: description || "Order" },
          unit_amount: amountCents,
        },
        quantity: 1,
      }],
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
