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
      // optional extras you might pass from the app later:
      // customerEmail,
      // locale = 'auto',
    } = req.body || {};

    if (!amountCents || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid amountCents' });
    }

    // Base methods
    // - 'card' enables regular cards AND wallet buttons like Apple Pay / Google Pay on Checkout
    // - Add real-time/redirect methods that matter in SG: PayNow + GrabPay (when currency is SGD)
    const paymentMethodTypes = ['card'];
    if (currency.toUpperCase() === 'SGD') {
      paymentMethodTypes.push('paynow', 'grabpay');
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: paymentMethodTypes,

      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: description || 'Home Cafe order' },
            unit_amount: amountCents, // total amount (in the smallest currency unit)
          },
          quantity: 1,
        },
      ],

      // Helps with reconciliation (also appears on the Session/PaymentIntent in Dashboard)
      client_reference_id: orderId || null,
      metadata,

      // Must match your AndroidManifest App Links
      success_url:
        'https://stripe-backend-rose.vercel.app/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:
        'https://stripe-backend-rose.vercel.app/checkout/cancel',

      // (Optional) Card options
      // payment_method_options: {
      //   card: { request_three_d_secure: 'automatic' },
      // },

      // (Optional) lighten up the page with your customer’s email / locale
      // customer_email: customerEmail,
      // locale,

      // (Optional) Allow coupons via Stripe Dashboard promotion codes
      // allow_promotion_codes: true,
    });

    return res.status(200).json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('[create-checkout-session] error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
