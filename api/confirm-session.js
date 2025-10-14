// /api/confirm-session.js
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    // /api/confirm-session/<id>
    const parts = req.url.split('/');
    const sessionId = parts[parts.length - 1];
    if (!sessionId || !sessionId.startsWith('cs_')) {
      return res.status(400).json({ ok: false, paid: false, error: 'Invalid session id' });
    }

    const s = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent', 'payment_link', 'customer', 'total_details'],
    });

    const paid = s.payment_status === 'paid' || s.status === 'complete';

    // Try to echo back your order id (prefer client_reference_id, else metadata.order_id)
    const orderId =
      (typeof s.client_reference_id === 'string' && s.client_reference_id) ||
      (typeof s.metadata?.order_id === 'string' && s.metadata.order_id) ||
      null;

    // Some handy fields the app may display or log
    return res.status(200).json({
      ok: true,
      paid,
      id: s.id,
      status: s.status,
      payment_status: s.payment_status,
      amount_total: s.amount_total,
      currency: s.currency,
      order_id: orderId,
      customer_email: s.customer_details?.email ?? null,
      payment_intent_id: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id ?? null,
      charge_id: Array.isArray(s.payment_intent?.charges?.data) && s.payment_intent.charges.data.length > 0
        ? s.payment_intent.charges.data[0].id
        : null,
    });
  } catch (err) {
    console.error('[confirm-session] error:', err);
    return res.status(500).json({ ok: false, paid: false, error: 'Failed to confirm session' });
  }
}
