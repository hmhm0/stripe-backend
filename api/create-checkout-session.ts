// /api/create-checkout-session.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');

  try {
    const {
      amount,                   // integer cents
      currency = 'sgd',
      description,
      metadata = {},
      successUrl,               // required: deep link back to app, e.g. myapp://pay/success
      cancelUrl,                // required: deep link back, e.g. myapp://pay/cancel
      paymentMethodTypes,       // optional override, else default below
      customerId,               // optional: use if you maintain Stripe Customers
      customerEmail,            // optional
    } = (req.body ?? {}) as Record<string, any>;

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount (cents) required' });
    }
    if (!successUrl || !cancelUrl) {
      return res.status(400).json({ error: 'successUrl & cancelUrl are required' });
    }

    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) {
      return res.status(500).json({ error: 'Stripe secret key not configured' });
    }

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(secret, { apiVersion: '2024-06-20' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: successUrl + '&sid={CHECKOUT_SESSION_ID}',
      cancel_url: cancelUrl,
      payment_method_types: paymentMethodTypes ?? ['card', 'paynow'],
      line_items: [
        {
          price_data: {
            currency,
            unit_amount: amount,
            product_data: { name: description ?? 'Order' },
          },
          quantity: 1,
        },
      ],
      metadata,
      ...(customerId ? { customer: customerId } : {}),
      ...(customerEmail ? { customer_email: customerEmail } : {}),
      // You can also add allow_promotion_codes, shipping_address_collection, etc.
    });

    return res.status(200).json({
      url: session.url,
      id: session.id,
    });
  } catch (err: any) {
    console.error('create-checkout-session error', err);
    return res.status(500).json({ error: 'server_error', detail: String(err?.message ?? err) });
  }
}
