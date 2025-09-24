// Vercel Serverless Function: POST /api/create-payment-intent
// Body JSON:
// {
//   amount: number (in cents),                 // required
//   currency?: string,                         // default 'sgd'
//   description?: string,                      // optional
//   desc?: string,                             // alias (client convenience)
//   metadata?: object,                         // optional
//   testAutoConfirm?: boolean                  // when true (TEST keys), confirm server-side with pm_card_visa
// }
export default async function handler(req, res) {
  // Basic CORS
  res.setHeader('Access-Control-Allow-Origin', '*'); // TODO: restrict to your app origin later
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = req.body || {};
    const {
      amount,
      currency: rawCurrency = 'sgd',
      description,
      desc, // alias supported
      metadata,
      testAutoConfirm = false,
    } = body;

    // Validation
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount (in cents) required' });
    }
    const currency = String(rawCurrency || 'sgd').toLowerCase();
    const safeDescription = (typeof description === 'string' && description.length > 0)
      ? description
      : (typeof desc === 'string' ? desc : undefined);
    const safeMetadata = (metadata && typeof metadata === 'object') ? metadata : undefined;

    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecret) {
      return res.status(500).json({ error: 'Stripe secret key not configured' });
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(stripeSecret, { apiVersion: '2024-06-20' });

    // 1) Create the PaymentIntent
    const intent = await stripe.paymentIntents.create({
      amount,
      currency,
      description: safeDescription,
      metadata: safeMetadata,
      automatic_payment_methods: { enabled: true },
    });

    let finalIntent = intent;

    // 2) In TEST mode, auto-confirm when requested
    // NOTE: This only works with TEST secret keys (sk_test_*)
    if (testAutoConfirm && stripeSecret.startsWith('sk_test_')) {
      finalIntent = await stripe.paymentIntents.confirm(intent.id, {
        // Test card (Stripe TEST mode) — simulates a successful payment
        payment_method: 'pm_card_visa',
      });
    }

    // 3) Return a compact, predictable shape
    return res.status(200).json({
      id: finalIntent.id,
      status: finalIntent.status,
      clientSecret: finalIntent.client_secret ?? null,
    });
  } catch (err) {
    console.error('[create-payment-intent] error', err);
    return res.status(200).json({
      id: 'server_error',
      status: 'failed',
      error: typeof err?.message === 'string' ? err.message : 'server_error',
    });
  }
}
