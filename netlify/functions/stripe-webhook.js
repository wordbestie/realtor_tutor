// netlify/functions/stripe-webhook.js
// Stripe calls this after payments and subscription changes. We verify the
// signature, then update the buyer's entitlement row. This is the ONLY place
// access is granted or revoked — the browser never gets to decide it.
//
// Handles:
//   checkout.session.completed        -> one-time access / automation, OR a new subscription
//   customer.subscription.updated     -> keep sub_status in sync (active/past_due/canceled)
//   customer.subscription.deleted     -> sub_status = canceled (access revoked)

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function saveRow(row) {
  const { error } = await supabaseAdmin
    .from('entitlements')
    .upsert(row, { onConflict: 'user_id' });
  if (error) throw new Error('Supabase update failed: ' + error.message);
}

// Map Stripe's many subscription statuses down to the three we care about.
function simpleStatus(s) {
  if (s === 'active' || s === 'trialing') return 'active';
  if (s === 'past_due' || s === 'unpaid') return 'past_due';
  if (s === 'canceled' || s === 'incomplete_expired') return 'canceled';
  return s; // incomplete, paused, etc. -> not 'active', so no access
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    // event.body must be the RAW body for signature verification.
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return { statusCode: 400, body: `Webhook signature failed: ${err.message}` };
  }

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const userId = session.metadata?.supabase_user_id || session.client_reference_id;
      if (userId) {
        const product = session.metadata?.product || 'access';
        const row = {
          user_id: userId,
          stripe_customer: session.customer,
          updated_at: new Date().toISOString(),
        };
        if (session.mode === 'subscription' || product === 'content_sub') {
          // New content-engine subscription.
          row.sub_tier = session.metadata?.tier || 'solo';
          row.sub_status = 'active';
          if (session.subscription) row.stripe_subscription = session.subscription;
        } else if (product === 'automation') {
          row.has_automation = true;   // one-time add-on; leaves has_access untouched
        } else {
          row.has_access = true;       // one-time main purchase: lifetime access
        }
        await saveRow(row);
      }
    }

    else if (stripeEvent.type === 'customer.subscription.updated' ||
             stripeEvent.type === 'customer.subscription.deleted') {
      const sub = stripeEvent.data.object;
      const userId = sub.metadata?.supabase_user_id;
      if (userId) {
        const row = {
          user_id: userId,
          stripe_customer: sub.customer,
          stripe_subscription: sub.id,
          updated_at: new Date().toISOString(),
        };
        if (stripeEvent.type === 'customer.subscription.deleted') {
          row.sub_status = 'canceled';
        } else {
          row.sub_status = simpleStatus(sub.status);
          if (sub.metadata?.tier) row.sub_tier = sub.metadata.tier;
        }
        await saveRow(row);
      }
    }
  } catch (err) {
    // Return 500 so Stripe retries rather than silently dropping the change.
    return { statusCode: 500, body: err.message };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
