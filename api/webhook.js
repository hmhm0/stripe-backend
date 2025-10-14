// /api/webhook.js
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import getRawBody from 'raw-body';

export const config = {
  api: {
    bodyParser: false, // we need the raw body for Stripe signature verification
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service role so we can bypass RLS on server
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let event;
  try {
    const raw = await getRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(
      raw,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] signature error:', err?.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      // 1) Store checkout_session_id as soon as Checkout completes
      case 'checkout.session.completed': {
        const s = event.data.object;
        const orderId =
          s.client_reference_id || (s.metadata && s.metadata.order_id) || null;
        if (!orderId) break;

        // Idempotent: only set if empty
        await supabase
          .from('orders')
          .update({ checkout_session_id: s.id })
          .eq('id', orderId)
          .is('checkout_session_id', null);
        break;
      }

      // 2) Mark order paid when the PaymentIntent succeeds, capture IDs
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const orderId = pi?.metadata?.order_id || null;
        if (!orderId) break;

        // Fetch full PI with charges expanded so we can get charge id + card info
        const piFull = await stripe.paymentIntents.retrieve(pi.id, {
          expand: ['latest_charge.payment_method_details', 'charges.data'],
        });

        const latestCharge =
          piFull.latest_charge && typeof piFull.latest_charge === 'object'
            ? piFull.latest_charge
            : (piFull.charges?.data || [])[0];

        const chargeId = latestCharge?.id || null;

        let brand = null;
        let last4 = null;
        const pmd = latestCharge?.payment_method_details;
        if (pmd?.card) {
          brand = pmd.card.brand || null;
          last4 = pmd.card.last4 || null;
        }

        // Idempotent update: only promote to paid if not already paid and PI not stored
        const { error } = await supabase
          .from('orders')
          .update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            payment_intent_id: piFull.id,
            charge_id: chargeId,
            payment_method_brand: brand,
            payment_last4: last4,
          })
          .eq('id', orderId)
          .is('payment_intent_id', null); // prevents overwriting if retried
        if (error) {
          console.error('[webhook] supabase update error:', error);
        }
        break;
      }

      default:
        // ignore other events
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
}
