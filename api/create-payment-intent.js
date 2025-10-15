// /api/create-payment-intent.js
// Creates a PaymentIntent for in-app payments (PaymentSheet).
//
// Required env:
//   STRIPE_SECRET_KEY=sk_live_... or sk_test_...
// Optional env:
//   ORIGIN_ALLOWLIST=https://example.com,capacitor://localhost,ionic://localhost,http://localhost:3000

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// --- optional CORS allow-list ---
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

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ success: false, error: "method_not_allowed" });
  }

  try {
    const {
      amount,
      amountCents,                 // preferred
      currency = "sgd",
      description,
      desc,                        // alias
      metadata,
      allowRedirects = "never",    // keep "never" to avoid redirect methods in-app
    } = req.body || {};

    const cents = Number.isFinite(amountCents) ? Number(amountCents) : Number(amount);
    if (!Number.isInteger(cents) || cents <= 0) {
      return res.status(400).json({ success: false, error: "invalid_amount_cents" });
    }

    const cur = String(currency || "sgd").trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(cur)) {
      return res.status(400).json({ success: false, error: "invalid_currency" });
    }

    const safeDescription =
      typeof description === "string" && description.length > 0
        ? description
        : typeof desc === "string" && desc.length > 0
        ? desc
        : undefined;

    const safeMetadata = metadata && typeof metadata === "object" ? metadata : undefined;

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ success: false, error: "missing_stripe_key" });
    }

    const body = {
      amount: cents,
      currency: cur,
      description: safeDescription,
      metadata: safeMetadata,
      automatic_payment_methods: {
        enabled: true,
        // Keep redirect methods out of PaymentSheet; use Checkout for those.
        allow_redirects: allowRedirects === "always" ? "always" : "never",
      },
    };

    const idem = req.headers["x-idempotency-key"];
    const intent = await stripe.paymentIntents.create(
      body,
      idem ? { idempotencyKey: String(idem) } : undefined
    );

    // Standardize response shape for the app:
    //  - success: boolean
    //  - id: PaymentIntent id
    //  - clientSecret: client secret (if you later use PaymentSheet)
    //  - status: Stripe status for logging
    return res.status(200).json({
      success: true,
      id: intent.id,
      clientSecret: intent.client_secret ?? null,
      status: intent.status,
    });
  } catch (err) {
    console.error("[create-payment-intent] error", err);
    return res.status(500).json({
      success: false,
      id: null,
      status: "failed",
      error: typeof err?.message === "string" ? err.message : "server_error",
    });
  }
}
