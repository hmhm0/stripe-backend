// /api/create-checkout-session.js
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Creates a Stripe Checkout Session.
 * Accepts both camelCase and snake_case keys from the client.
 * Ensures client_reference_id is set when orderId is provided.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = req.body || {};

    // Support both camelCase and snake_case
    const rawAmount =
      body.amountCents ?? body.amount_cents ?? body.amount ?? body.amount_cents;
    const currency = (body.currency ?? body.currency_code ?? 'SGD').toString();
    const description = body.description || 'Home Cafe order';
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    const orderId =
      typeof body.orderId === 'string'
        ? body.orderId
        : typeof body.order_id === 'string'
        ? body.order_id
        : '';

    // Optional client-provided URLs (we still keep safe defaults)
    const successUrl = body.successUrl || body.success_url;
    const cancelUrl = body.cancelUrl || body.cancel_url;

    // Normalize and validate amount
    const amountCents = Number(rawAmount);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid amountCents' });
    }

    // Payment methods
    const pmTypes = ['card'];
    if (currency.toUpperCase() === 'SGD') {
      pmTypes.push('paynow', 'grabpay');
    }

    // Stripe App/Universal Links (HTTPS) — keep in sync with your app manifest
    const fallbackSuccess =
      'https://stripe-backend-rose.vercel.app/checkout/success?session_id={CHECKOUT_SESSION_ID}';
    const fallbackCancel =
      'https://stripe-backend-rose.vercel.app/checkout/cancel';

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
      // Always carry orderId through both places when provided
      ...(orderId && orderId.trim()
        ? {
            client_reference_id: orderId.trim(),
            metadata: { ...metadata, order_id: orderId.trim() },
          }
        : { metadata }),
      success_url: successUrl || fallbackSuccess,
      cancel_url: cancelUrl || fallbackCancel,
    });

    return res.status(200).json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('[create-checkout-session] error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
