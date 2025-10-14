// /api/webhook.js
import Stripe from 'stripe';
import getRawBody from 'raw-body';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2022-11-15',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // must be service role
);

function getSigningSecrets() {
  const a = process.env.STRIPE_WEBHOOK_SECRET;
  const b = process.env.STRIPE_WEBHOOK_SECRET_ALT; // optional
  return [a, b].filter(Boolean);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // 1) Verify signature with RAW body
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (e) {
    console.error('[webhook] raw body read error:', e);
    return res.status(400).send('Bad body');
  }
  const sig = req.headers['stripe-signature'];

  let event;
  let verified = false;
  for (const secret of getSigningSecrets()) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, secret);
      verified = true;
      break;
    } catch (_) {}
  }
  if (!verified) {
    console.error('[webhook] signature verification failed');
    return res.status(400).send('Bad signature');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const orderId =
          s.client_reference_id ||
          (s.metadata && s.metadata.order_id) ||
          null;

        console.log(
          `[webhook] checkout.session.completed`,
          `session=${s.id}`,
          `client_reference_id=${s.client_reference_id || '∅'}`,
          `meta.order_id=${s.metadata?.order_id || '∅'}`
        );

        let paymentIntentId = s.payment_intent || null;
        let chargeId = null;
        let pmBrand = null;
        let last4 = null;

        if (paymentIntentId) {
          try {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
            const ch = Array.isArray(pi.charges?.data) ? pi.charges.data[0] : null;
            chargeId = ch?.id ?? null;
            pmBrand =
              ch?.payment_method_details?.card?.brand ||
              ch?.payment_method_details?.card_present?.brand ||
              null;
            last4 =
              ch?.payment_method_details?.card?.last4 ||
              ch?.payment_method_details?.card_present?.last4 ||
              null;
          } catch (e) {
            console.warn('[webhook] PI fetch failed (non-fatal):', e.message);
          }
        }

        if (!orderId) {
          console.warn('[webhook] No orderId on session — skipping DB update.');
          break;
        }

        const { error } = await supabase
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

        if (error) {
          console.error('[webhook] Supabase update error (session):', error);
        } else {
          console.log(`[webhook] Order ${orderId} marked paid (session path)`);
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const orderId = pi.metadata?.order_id || null;

        console.log(
          `[webhook] payment_intent.succeeded`,
          `pi=${pi.id}`,
          `meta.order_id=${orderId || '∅'}`
        );

        let chargeId = null;
        try {
          const ch = Array.isArray(pi.charges?.data) ? pi.charges.data[0] : null;
          chargeId = ch?.id ?? null;
        } catch (_) {}

        if (!orderId) break;

        const { error } = await supabase
          .from('orders')
          .update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            payment_intent_id: pi.id,
            charge_id: chargeId,
          })
          .eq('id', orderId);

        if (error) {
          console.error('[webhook] Supabase update error (PI):', error);
        } else {
          console.log(`[webhook] Order ${orderId} marked paid (PI path)`);
        }
        break;
      }

      default:
        // no-op
        break;
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('[webhook] handler error:', e);
    return res.status(500).json({ error: 'Webhook failure' });
  }
}
