// Vercel Serverless Function: POST /api/create-payment-intent
// Body JSON:
// {
//   amount?: number,                 // in cents
//   amountCents?: number,            // alias (preferred name in your app)
//   currency?: string,               // default 'sgd'
//   description?: string,            // optional
//   desc?: string,                   // alias (client convenience)
//   metadata?: object,               // optional
//   testAutoConfirm?: boolean,       // TEST mode helper; confirms with pm_card_visa
//   allowRedirects?: 'never'|'always'// default 'never' (no redirect methods in PaymentSheet)
// }
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

export default async function handler(req, res) {
  // Basic CORS (tighten this to your app origin before prod)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const {
      amount,
      amountCents, // alias
      currency: rawCurrency = 'sgd',
      description,
      desc, // alias
      metadata,
      testAutoConfirm = false,
      allowRedirects = 'never', // <- keep "never" for in-app PaymentSheet
    } = req.body || {};

    const cents = Number.isFinite(amountCents) ? amountCents : amount;
    if (!Number.isFinite(cents) || cents <= 0) {
      return res.status(400).json({ error: 'Invalid amount (in cents) required' });
    }

    const currency = String(rawCurrency || 'sgd').toLowerCase();
    const safeDescription =
      typeof description === 'string' && description.length > 0
        ? description
        : typeof desc === 'string'
        ? desc
        : undefined;
    const safeMetadata = metadata && typeof metadata === 'object' ? metadata : undefined;

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'Stripe secret key not configured' });
    }

    // IMPORTANT:
    // - PaymentSheet (in-app) works great with automatic_payment_methods.enabled = true
    // - We set allow_redirects: 'never' so redirect methods (PayNow, GrabPay) are EXCLUDED here.
    //   Those are handled by your Checkout Session flow instead.
    // - Apple Pay / Google Pay are surfaced by PaymentSheet when card is available & device supports it.
    const intent = await stripe.paymentIntents.create(
      {
        amount: cents,
        currency,
        description: safeDescription,
        metadata: safeMetadata,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: allowRedirects === 'always' ? 'always' : 'never',
        },
      },
      // Optional: idempotency to avoid double-charges if client retries
      // (You can pass a header like x-idempotency-key from the app)
      // { idempotencyKey: req.headers['x-idempotency-key'] }
    );

    let finalIntent = intent;

    // TEST helper: auto-confirm with a test card (only works with sk_test_*)
    if (testAutoConfirm && process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
      finalIntent = await stripe.paymentIntents.confirm(intent.id, {
        payment_method: 'pm_card_visa',
      });
    }

    return res.status(200).json({
      id: finalIntent.id,
      status: finalIntent.status,
      clientSecret: finalIntent.client_secret ?? null,
    });
  } catch (err) {
    console.error('[create-payment-intent] error', err);
    return res.status(500).json({
      id: 'server_error',
      status: 'failed',
      error: typeof err?.message === 'string' ? err.message : 'server_error',
    });
  }
}
