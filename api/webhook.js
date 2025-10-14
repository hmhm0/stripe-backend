// /api/webhook.js
import Stripe from 'stripe';
import getRawBody from 'raw-body';
import { createClient } from '@supabase/supabase-js';

// If this repo is a Next.js project deployed on Vercel, this disables body parsing.
// (Harmless on Vercel’s serverless functions too.)
export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2022-11-15',
});

// Optional: allow a second secret for local vs prod, try primary then fallback
function getSigningSecrets() {
  const primary = process.env.STRIPE_WEBHOOK_SECRET;       // set this!
  const fallback = process.env.STRIPE_WEBHOOK_SECRET_ALT;  // optional
  return [primary, fallback].filter(Boolean);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // server-side only
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error('[webhook] failed to read raw body:', err);
    return res.status(400).send('Could not read body');
  }

  const sig = req.headers['stripe-signature'];
  let event;

  // Verify signature with one of the configured secrets
  const secrets = getSigningSecrets();
  let verified = false;
  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, secret);
      verified = true;
      break;
    } catch (err) {
      // try next secret
    }
  }
  if (!verified) {
    console.error(
      '[webhook] signature error: No signatures found matching the expected signature for payload.'
    );
    return res.status(400).send('Signature verification failed');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;

        // We prefer client_reference_id; fallback to metadata.order_id
        const orderId =
          s.client_reference_id ||
          (s.metadata && s.metadata.order_id) ||
          null;

        // Pull PI/charge details if available
        const paymentIntentId = s.payment_intent || null;
        let chargeId = null;
        let pmBrand = null;
        let last4 = null;

        try {
          if (paymentIntentId) {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
            const ch = Array.isArray(pi.charges?.data) ? pi.charges.data[0] : null;
            chargeId = ch?.id ?? null;

            // Try to enrich payment method details
            pmBrand =
              ch?.payment_method_details?.card?.brand ||
              ch?.payment_method_details?.card_present?.brand ||
              null;
            last4 =
              ch?.payment_method_details?.card?.last4 ||
              ch?.payment_method_details?.card_present?.last4 ||
              null;
          }
        } catch (e) {
          // Non-fatal: we’ll still mark as paid
        }

        if (orderId) {
          // Mark the order as paid in Supabase and store identifiers
          await supabase
            .from('orders')
            .update({
              status: 'paid',
              paid_at: new Date().toISOString(),
              checkout_session_id: s.id ?? null,
              payment_intent_id: paymentIntentId,
              charge_id: chargeId,
              payment_method_brand: pmBrand,
              payment_last4: last4,
            })
            .eq('id', orderId);
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const orderId =
          (pi.metadata && pi.metadata.order_id) ? pi.metadata.order_id : null;

        let chargeId = null;
        try {
          const ch = Array.isArray(pi.charges?.data) ? pi.charges.data[0] : null;
          chargeId = ch?.id ?? null;
        } catch (_) {}

        if (orderId) {
          await supabase
            .from('orders')
            .update({
              status: 'paid',
              paid_at: new Date().toISOString(),
              payment_intent_id: pi.id,
              charge_id: chargeId,
            })
            .eq('id', orderId);
        }
        break;
      }

      // You can handle refunds/cancellations here later

      default:
        // noop
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
}
