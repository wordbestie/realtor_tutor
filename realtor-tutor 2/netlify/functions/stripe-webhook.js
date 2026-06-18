// netlify/functions/stripe-webhook.js
// Stripe calls this after a successful payment. We verify the signature, then
// flip the buyer's entitlement to has_access = true. This is the ONLY place
// access is granted — the browser never gets to decide it.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const userId = session.metadata?.supabase_user_id || session.client_reference_id;
    if (userId) {
      const { error } = await supabaseAdmin
        .from('entitlements')
        .upsert(
          { user_id: userId, has_access: true, stripe_customer: session.customer, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' }
        );
      if (error) {
        return { statusCode: 500, body: `Supabase update failed: ${error.message}` };
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
