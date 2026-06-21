// netlify/functions/create-subscription-checkout.js
// Starts a RECURRING Stripe Checkout for the content engine subscription.
// Two tiers: 'solo' ($67/mo) and 'pro' ($197/mo, up to 5 seats).
//
// The actual prices live in Stripe (you create them in the dashboard and paste
// their IDs into these Netlify env vars):
//   STRIPE_PRICE_SOLO = price_xxx   (recurring, $67.00/mo CAD)
//   STRIPE_PRICE_PRO  = price_yyy   (recurring, $197.00/mo CAD)
//
// We tag BOTH the checkout session AND the subscription with the user id + tier,
// so later lifecycle events (renewals, cancellations) still know whose row to update.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PRICES = {
  solo: process.env.STRIPE_PRICE_SOLO,
  pro:  process.env.STRIPE_PRICE_PRO,
};
// Same 13% (exclusive) HST tax rate used by the one-time checkouts.
const TAX_RATE_ID = process.env.STRIPE_TAX_RATE_ID;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  try {
    const body = JSON.parse(event.body || '{}');
    const access_token = body.access_token;
    const tier = body.tier === 'pro' ? 'pro' : 'solo';   // default to solo

    if (!access_token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing access token' }) };
    }
    const price = PRICES[tier];
    if (!price) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Subscription pricing is not configured yet.' }) };
    }

    // Verify the token and get the real user — never trust an id from the browser.
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(access_token);
    if (error || !user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session' }) };
    }

    const siteUrl = process.env.SITE_URL || `https://${event.headers.host}`;
    const meta = { supabase_user_id: user.id, product: 'content_sub', tier };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: meta,
      subscription_data: { metadata: meta },   // so renewals/cancellations know the user + tier
      line_items: [{
        price,
        quantity: 1,
        tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
      }],
      allow_promotion_codes: true,
      success_url: `${siteUrl}/?subscribed=1`,
      cancel_url: `${siteUrl}/?canceled=1`,
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
