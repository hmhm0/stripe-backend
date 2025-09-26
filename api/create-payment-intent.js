// Vercel Serverless Function: GET/POST /api/confirm-session
// Usage from app (after deep link):
//   GET /api/confirm-session?session_id=cs_test_123
//
// Returns:
//  {
//    ok: true,
//    paid: true,
//    status: 'complete',
//    payment_status: 'paid',
//    session_id: 'cs_...',
//    amount_total: 1234,
//    currency: 'sgd',
//    orderId: 'ord_123',         // if you passed client_reference_id when creating session
//    customer_email: '...@...',
//    payment_intent_id: 'pi_...',
//    charge_id: 'ch_...'         // if available
//  }

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

export default async function handler(req, res) {
  // Basic CORS (tighten to your app origin for prod)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const sessionId =
      (req.method === 'GET' ? req.query.session_id : req.body?.session_id) || '';

    if (typeof sessionId !== 'string' || sessionId.length < 6 || !sessionId.startsWith('cs_')) {
      return res.status(400).json({ ok: false, error: 'Invalid session_id' });
    }

    // Expand to get PI + charge details in one round-trip
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: [
        'payment_intent',
        'payment_intent.latest_charge',
        'customer_details',
      ],
    });

    const status = session.status;                   // 'complete' when the flow finished
    const paymentStatus = session.payment_status;    // 'paid' when money captured/authorized
    const isPaid = status === 'complete' && paymentStatus === 'paid';

    const pi = session.payment_intent;
    const charge = pi?.latest_charge;

    return res.status(200).json({
      ok: true,
      paid: !!isPaid,
      status,
      payment_status: paymentStatus,
      session_id: session.id,
      amount_total: session.amount_total ?? null,     // integer (cents)
      currency: session.currency ?? null,            // e.g. 'sgd'
      orderId: session.client_reference_id ?? null,  // your order ref if you set it
      customer_email: session.customer_details?.email ?? null,
      payment_intent_id: typeof pi?.id === 'string' ? pi.id : null,
      charge_id: typeof charge?.id === 'string' ? charge.id : null,
    });
  } catch (err) {
    console.error('[confirm-session] error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
