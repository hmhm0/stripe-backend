// /api/webhook.js
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // In prod you should verify the signature with STRIPE_WEBHOOK_SECRET
  // For now we trust the forwarded JSON from Stripe CLI / Vercel
  const event = req.body;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        // Prefer client_reference_id; fall back to metadata.order_id
        const orderId =
          session?.client_reference_id ||
          (session?.metadata && session.metadata.order_id) ||
          null;

        if (!orderId) {
          console.warn('[webhook] no orderId in session; skipping update');
          break;
        }

        // session.payment_intent may be a string (id) or null
        const paymentIntentId =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : (session?.payment_intent?.id ?? null);

        // If you really want the charge id, you can fetch the PI (costs an API call)
        // Keep it optional for now.
        let chargeId = null;
        if (paymentIntentId) {
          try {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
            // latest_charge is a string charge id on the PI
            chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : null;
          } catch (e) {
            console.warn('[webhook] could not retrieve PI:', e?.message || e);
          }
        }

        const { error } = await supabase
          .from('orders')
          .update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            payment_intent_id: paymentIntentId,
            charge_id: chargeId,
          })
          .eq('id', orderId);

        if (error) {
          console.error('[webhook] supabase update error:', error);
          // Still return 200 so Stripe doesn’t retry forever; log for ops to inspect
        } else {
          console.log('[webhook] order marked paid:', {
            orderId,
            paymentIntentId,
            chargeId,
          });
        }
        break;
      }

      // (Optional hardening) If you also want to react to PI events:
      case 'payment_intent.succeeded':
        // no-op; covered by checkout.session.completed above
        break;

      default:
        // Not interested; acknowledge
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err);
    // Return 200 to avoid Stripe retries while you iterate; switch to 500 once stable
    return res.status(200).json({ received: true, note: 'swallowed error during dev' });
  }
}
