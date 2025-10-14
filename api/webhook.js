// /api/webhook.js
import Stripe from 'stripe';
import getRawBody from 'raw-body';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-08-27.basil',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service role for server-side writes
);

// Helper: extract brand/last4 from a charge’s payment_method_details
function extractPmDetails(charge) {
  if (!charge || !charge.payment_method_details) return { brand: null, last4: null };

  const pmd = charge.payment_method_details;

  // Cards
  if (pmd.card) {
    return {
      brand: pmd.card.brand || 'card',
      last4: pmd.card.last4 || null,
    };
  }

  // GrabPay (no last4)
  if (pmd.grabpay) {
    return { brand: 'grabpay', last4: null };
  }

  // PayNow (no last4)
  if (pmd.paynow) {
    return { brand: 'paynow', last4: null };
  }

  // Fallback
  const type = pmd.type || 'unknown';
  return { brand: type, last4: null };
}

async function markPaidBySession(session) {
  const orderId = session.client_reference_id || session.metadata?.order_id || null;
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;

  // Update as much as we know here; charge_id/brand/last4 may be filled by later charge event
  const { error } = await supabase
    .from('orders')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      checkout_session_id: session.id,
      payment_intent_id: paymentIntentId || null,
    })
    .eq('id', orderId);

  if (error) {
    console.error('[webhook] supabase update (session) error:', error);
  } else {
    console.info('[webhook] Order %s marked paid (session path)', orderId);
  }
}

async function upsertChargeDetails(pi) {
  // Fetch the latest intent with expanded charges to get brand/last4
  const intent =
    typeof pi === 'string'
      ? await stripe.paymentIntents.retrieve(pi, { expand: ['charges.data.balance_transaction', 'latest_charge', 'latest_charge.payment_method_details'] })
      : pi;

  const paymentIntentId = typeof intent === 'string' ? intent : intent?.id;
  if (!paymentIntentId) return;

  // Get primary charge
  const chargeId =
    intent.latest_charge?.id ||
    (intent.charges?.data?.length ? intent.charges.data[0].id : null);
  const primaryCharge =
    intent.latest_charge || (intent.charges?.data?.length ? intent.charges.data[0] : null);

  const { brand, last4 } = extractPmDetails(primaryCharge);

  // Tie back to order using metadata.order_id (set in your create-checkout-session)
  const orderId =
    intent.metadata?.order_id ||
    primaryCharge?.metadata?.order_id ||
    null;

  if (!orderId) return;

  const { error } = await supabase
    .from('orders')
    .update({
      status: 'paid', // idempotent if already paid
      paid_at: new Date().toISOString(),
      payment_intent_id: paymentIntentId,
      charge_id: chargeId,
      payment_method_brand: brand,
      payment_last4: last4,
    })
    .eq('id', orderId);

  if (error) {
    console.error('[webhook] supabase update (charge) error:', error);
  } else {
    console.info('[webhook] Order %s enriched with charge details', orderId);
  }
}

export const config = {
  api: {
    bodyParser: false, // important: we need raw body for signature verification
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (e) {
    console.error('[webhook] raw-body error', e);
    return res.status(400).send('Invalid body');
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).send('Missing signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] signature error:', err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.info(
          '[webhook] checkout.session.completed',
          'session=' + session.id,
          'client_reference_id=' + session.client_reference_id,
          'meta.order_id=' + (session.metadata?.order_id || '')
        );
        await markPaidBySession(session);
        // If the intent is already available, enrich now too
        if (session.payment_intent) {
          await upsertChargeDetails(session.payment_intent);
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        await upsertChargeDetails(pi);
        break;
      }

      case 'charge.succeeded': {
        // Defensive: some integrations forward charge events separately
        const ch = event.data.object;
        if (ch.payment_intent) {
          await upsertChargeDetails(ch.payment_intent);
        }
        break;
      }

      // (Optional) reflect refunds/cancellations to orders table
      // case 'charge.refunded':
      // case 'payment_intent.canceled':
      //   // mark order canceled/refunded, store reason, etc.
      //   break;

      default:
        // No-op for other events
        break;
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('[webhook] handler error:', e);
    return res.status(500).json({ error: 'handler failed' });
  }
}
