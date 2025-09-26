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
      orderId,
    } = req.body || {};

    if (!amountCents || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid amountCents' });
    }

    // Build the payment methods list.
    // PayNow works only with SGD + SG accounts; add it when eligible.  【docs】
    const pmTypes = ['card'];
    if (currency.toUpperCase() === 'SGD') {
      pmTypes.push('paynow'); // enables PayNow on Checkout
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',

      // Explicitly list payment methods for predictability.
      // Alternatively, you can omit this and let "dynamic payment methods" show
      // eligible methods you enabled in the Dashboard.  【docs】
      payment_method_types: pmTypes,

      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: description || 'Home Cafe order' },
            // Using a single consolidated line with quantity 1 is fine.
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],

      // For reconciliation (you'll also see these on the Session/PaymentIntent)
      client_reference_id: orderId || null,
      metadata,

      // Must match AndroidManifest intent-filters (HTTPS App Links)
      success_url:
        'https://stripe-backend-rose.vercel.app/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:
        'https://stripe-backend-rose.vercel.app/checkout/cancel',

      // (Optional) Localize/brand the Checkout page a bit
      // customer_email: req.body?.email || undefined,
      // locale: 'auto',
    });

    return res.status(200).json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('[create-checkout-session] error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
