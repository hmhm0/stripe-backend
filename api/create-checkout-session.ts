// Vercel Serverless Function: POST /api/create-checkout-session
// Body: { amount, currency, description?, metadata?, successUrl, cancelUrl }
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Basic CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { amount, currency, description, metadata, successUrl, cancelUrl } = req.body || {};
    if (!amount || !currency || !successUrl || !cancelUrl) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const stripeSecret = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecret) {
      return res.status(500).json({ error: 'Stripe secret key not configured' });
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(stripeSecret, { apiVersion: '2024-06-20' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'], // later you can add 'paynow', etc. in dashboard
      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: description ?? 'Home Cafe order' },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      metadata,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return res.status(200).json({
      id: session.id,
      url: session.url,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error', detail: `${err}` });
  }
}
