// /api/create-checkout-session.js
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const {
      amountCents,
      currency = 'SGD',
      description,
      metadata = {},
      orderId,            // may be undefined, null, '' — we'll guard it
      // Optional, if you ever want client-provided URLs:
      successUrl,
      cancelUrl,
    } = req.body || {};

    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid amountCents' });
    }

    const pmTypes = ['card'];
    if (String(currency).toUpperCase() === 'SGD') {
      pmTypes.push('paynow', 'grabpay');
    }

    // Allow either body.orderId OR metadata.order_id (Flutter currently sends metadata)
    const orderIdFromMeta =
      typeof metadata?.order_id === 'string' && metadata.order_id.trim().length > 0
        ? metadata.order_id.trim()
        : undefined;

    const clientRef =
      typeof orderId === 'string' && orderId.trim().length > 0
        ? orderId.trim()
        : orderIdFromMeta;

    // Use your verified App Links (kept hard-coded for now)
    const success = 'https://stripe-backend-rose.vercel.app/checkout/success?session_id={CHECKOUT_SESSION_ID}';
    const cancel  = 'https://stripe-backend-rose.vercel.app/checkout/cancel';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: pmTypes,
      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: description || 'Home Cafe order' },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      ...(clientRef ? { client_reference_id: clientRef } : {}),
      metadata,
      success_url: success,
      cancel_url: cancel,
    });

    return res.status(200).json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('[create-checkout-session] error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
