// /api/create-checkout-session.js
// Creates a Stripe Checkout Session for one-off payments.
//
// Required env (Vercel):
//   STRIPE_SECRET_KEY=sk_live_... or sk_test_...
// Optional env (recommended):
//   APP_LINKS_HOST=example.com                // your HTTPS App Links host (for success/cancel URLs)
//   APP_SCHEME=myapp                          // your custom scheme (if you also accept custom deep links)
//   APP_DEEPLINK_HOST=link                    // host part after scheme, e.g. myapp://link/success
//   ORIGIN_ALLOWLIST=https://example.com,capacitor://localhost,ionic://localhost,http://localhost:3000

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// --- optional CORS allow-list (keep strict in prod) ---
function cors(req, res) {
  const allow = (process.env.ORIGIN_ALLOWLIST || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin;
  const isAllowed = origin && allow.length > 0 && allow.includes(origin);

  if (isAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-idempotency-key");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

function validateReturnUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const appHost = process.env.APP_LINKS_HOST?.trim();
    const scheme = process.env.APP_SCHEME?.trim();
    const deeplinkHost = process.env.APP_DEEPLINK_HOST?.trim();

    // Allow either:
    //  1) HTTPS app links to your domain
    //  2) Custom scheme deep links (e.g. myapp://link/success)
    const isHttpsOk = appHost && url.protocol === "https:" && url.hostname === appHost;
    const isCustomOk = scheme && deeplinkHost && url.protocol === `${scheme}:` && url.hostname === deeplinkHost;

    return Boolean(isHttpsOk || isCustomOk);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "method_not_allowed" });

  try {
    const {
      amountCents,
      currency,
      description,
      metadata,            // may include { order_id: '...' }
      successReturnUrl,
      cancelReturnUrl,
    } = req.body || {};

    // --- validate required fields ---
    const cents = Number.isFinite(amountCents) ? Number(amountCents) : NaN;
    if (!Number.isInteger(cents) || cents <= 0) {
      return res.status(400).json({ success: false, error: "invalid_amount_cents" });
    }

    const cur = String(currency || "").trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(cur)) {
      return res.status(400).json({ success: false, error: "invalid_currency" });
    }

    if (typeof successReturnUrl !== "string" || !validateReturnUrl(successReturnUrl)) {
      return res.status(400).json({ success: false, error: "invalid_success_return_url" });
    }
    if (typeof cancelReturnUrl !== "string" || !validateReturnUrl(cancelReturnUrl)) {
      return res.status(400).json({ success: false, error: "invalid_cancel_return_url" });
    }

    // --- coerce optional fields ---
    const safeDescription =
      typeof description === "string" && description.length > 0 ? description : "Order";
    const safeMetadata = metadata && typeof metadata === "object" ? metadata : {};

    // --- create Checkout Session ---
    // NOTE: If you pass metadata.order_id, your webhook will reconcile to Supabase orders.
    const params = {
      mode: "payment",
      submit_type: "pay",
      success_url: successReturnUrl,
      cancel_url: cancelReturnUrl,
      line_items: [
        {
          price_data: {
            currency: cur,
            product_data: { name: safeDescription },
            unit_amount: cents,
          },
          quantity: 1,
        },
      ],
      metadata: safeMetadata,
      allow_promotion_codes: true, // optional, safe to enable
      // automatic_tax: { enabled: false }, // enable if you’ve configured tax
    };

    // Optional idempotency (recommended). App can pass x-idempotency-key header.
    const idem = req.headers["x-idempotency-key"];
    const session = await stripe.checkout.sessions.create(
      params,
      idem ? { idempotencyKey: String(idem) } : undefined
    );

    return res.status(200).json({ success: true, url: session.url });
  } catch (e) {
    console.error("[create-checkout-session]", e);
    return res.status(500).json({ success: false, error: "server_error" });
  }
}
