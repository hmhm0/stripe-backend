// /api/webhook.js
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// --- Stripe + Supabase setup ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // ⚠️ must be service_role, not anon!
);

export const config = {
  api: {
    bodyParser: false, // ✅ Stripe requires raw body for signature verification
  },
};

// --- Helper to get raw body for Stripe verification ---
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).send('Missing Stripe signature');
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET // ✅ from your Stripe dashboard
    );
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Handle only successful Checkout completions
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const paid = session.payment_status === 'paid';
      if (!paid) {
        console.log(`[Webhook] Session ${session.id} not paid yet.`);
        return res.status(200).send('Not paid yet');
      }

      // Extract the order id
      const orderId =
        session.client_reference_id ||
        (session.metadata && session.metadata.order_id);

      if (!orderId) {
        console.warn(`[Webhook] No order_id found in session ${session.id}`);
        return res.status(200).send('Missing order_id');
      }

      // Optional details to store
      const paymentIntentId =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id ?? null;

      // ✅ Update order in Supabase
      const { error } = await supabase
        .from('orders')
        .update({
          status: 'paid',
          paid_at: new Date().toISOString(),
          payment_intent_id: paymentIntentId,
        })
        .eq('id', orderId);

      if (error) {
        console.error(`[Webhook] Supabase update failed for order ${orderId}:`, error);
        return res.status(500).send('Supabase update failed');
      }

      console.log(`[Webhook] Order ${orderId} marked as PAID.`);
    }

    // You can handle other events (like refund or payment_failed) here later
    return res.status(200).send('ok');
  } catch (err) {
    console.error('[Webhook] handler failed:', err);
    return res.status(500).send('Internal Error');
  }
}
