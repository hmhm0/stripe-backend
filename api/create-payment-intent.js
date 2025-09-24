// Vercel Serverless Function: POST /api/create-payment-intent
// Body: { amount: number (in cents), currency: "sgd"|"usd"|..., metadata?: object, description?: string }
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Basic CORS (relaxed). Tighten to your app’s origin when you know it.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { amount, currency = 'sgd', metadata = {}, description } = req.body || {};
    if (!amount || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount (in cents) required' });
    }

    // Stripe secret key comes from Vercel Environment Variables
    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecret) {
      return res.status(500).json({ error: 'Stripe secret key not configured' });
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(stripeSecret, { apiVersion: '2024-06-20' });

    // Test mode automatically applies when your key starts with sk_test_
    const paymentIntent = await stripe.paymentIntents.create({
      amount,           // e.g. 1234 = $12.34
      currency,         // "sgd" recommended for you
      description,      // optional
      metadata,         // optional (orderId, userId, etc.)
      // You can also add: automatic_payment_methods: { enabled: true }
      automatic_payment_methods: { enabled: true },
    });

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      id: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: `${err}` });
  }
}
