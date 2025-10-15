// /api/stripe-webhook.js
// Verifies signature, reads Checkout Session + PaymentIntent, and updates Supabase `orders`.
//
// Env needed in Vercel:
//  - STRIPE_SECRET_KEY=sk_test_...
//  - STRIPE_WEBHOOK_SECRET=whsec_...
//  - SUPABASE_URL=https://xxx.supabase.co
//  - SUPABASE_SERVICE_ROLE_KEY=service-role-key

export const config = {
  api: { bodyParser: false }, // IMPORTANT: Stripe needs the raw body
};

import Stripe from "stripe";
import getRawBody from "raw-body";
import { createClient } from "@supabase/supabase-js";

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  let event;
  try {
    const raw = await getRawBody(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[webhook] signature verify failed", err?.message);
    return res.status(400).send(`Webhook Error: ${err?.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        const orderId =
          session?.metadata?.order_id || session?.metadata?.orderId || null;

        // If you didn’t pass order_id, we can’t reconcile to an order row — acknowledge but ignore.
        if (!orderId) {
          console.warn("[webhook] session.completed without order_id; ignored");
          return res.json({ received: true, ignored: true });
        }

        const piId = session.payment_intent;
        const amountTotal = session.amount_total ?? null; // cents
        const checkoutSessionId = session.id;

        // Expand for card brand/last4 + charge id
        let brand = null, last4 = null, chargeId = null;
        if (piId) {
          const pi = await stripe.paymentIntents.retrieve(piId.toString(), {
            expand: ["latest_charge", "payment_method"],
          });

          const ch = pi.latest_charge;
          if (ch && typeof ch === "object") {
            const card = ch.payment_method_details?.card;
            brand = card?.brand || brand;
            last4 = card?.last4 || last4;
            chargeId = ch.id || chargeId;
          }
          // Fallback via attached PM
          const pm = pi.payment_method;
          if ((!brand || !last4) && pm && typeof pm === "object" && pm.card) {
            brand = brand || pm.card.brand || null;
            last4 = last4 || pm.card.last4 || null;
          }
        }

        const updates = {
          status: "paid",
          paid_at: new Date().toISOString(),
          payment_method_brand: brand,
          payment_last4: last4,
          payment_intent_id: piId ?? null,
          charge_id: chargeId,
          checkout_session_id: checkoutSessionId,
        };
        if (typeof amountTotal === "number") {
          updates.total_cents = amountTotal;
        }

        const { error } = await supabase
          .from("orders")
          .update(updates)
          .eq("id", orderId);

        if (error) {
          console.error("[webhook] Supabase update failed:", error);
          return res.status(500).json({ ok: false });
        }

        return res.json({ received: true });
      }

      case "payment_intent.succeeded": {
        // Fallback in case you ever use PI-only flows
        const pi = event.data.object;
        const orderId = pi.metadata?.order_id || pi.metadata?.orderId || null;
        if (!orderId) return res.json({ received: true, ignored: true });

        const full = await stripe.paymentIntents.retrieve(pi.id, {
          expand: ["latest_charge", "payment_method"],
        });

        let brand = null, last4 = null, chargeId = null;
        const ch = full.latest_charge;
        if (ch && typeof ch === "object") {
          const card = ch.payment_method_details?.card;
          brand = card?.brand || null;
          last4 = card?.last4 || null;
          chargeId = ch.id || null;
        }
        const pm = full.payment_method;
        if ((!brand || !last4) && pm && typeof pm === "object" && pm.card) {
          brand = brand || pm.card.brand || null;
          last4 = last4 || pm.card.last4 || null;
        }

        const { error } = await supabase
          .from("orders")
          .update({
            status: "paid",
            paid_at: new Date().toISOString(),
            payment_method_brand: brand,
            payment_last4: last4,
            payment_intent_id: full.id,
            charge_id: chargeId,
          })
          .eq("id", orderId);

        if (error) {
          console.error("[webhook] Supabase update failed:", error);
          return res.status(500).json({ ok: false });
        }

        return res.json({ received: true });
      }

      default:
        return res.json({ received: true });
    }
  } catch (err) {
    console.error("[webhook] handler error", err);
    return res.status(500).send("Webhook handler failed");
  }
}
