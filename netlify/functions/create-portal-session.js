// netlify/functions/create-portal-session.js
// Returns a Stripe Customer Portal URL so a subscriber can manage or cancel
// their own subscription. No work for you — Stripe hosts the whole thing.
//
// One-time setup: enable the Customer Portal in
//   Stripe Dashboard -> Settings -> Billing -> Customer portal (allow cancellation).

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  try {
    const { access_token } = JSON.parse(event.body || '{}');
    if (!access_token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing access token' }) };
    }

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(access_token);
    if (error || !user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session' }) };
    }

    // Find this user's Stripe customer id (saved when they subscribed).
    const { data: ent } = await supabaseAdmin
      .from('entitlements')
      .select('stripe_customer')
      .eq('user_id', user.id)
      .maybeSingle();

    const customer = ent && ent.stripe_customer;
    if (!customer) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No subscription found for this account.' }) };
    }

    const siteUrl = process.env.SITE_URL || `https://${event.headers.host}`;
    const portal = await stripe.billingPortal.sessions.create({
      customer,
      return_url: `${siteUrl}/?from=portal`,
    });

    return { statusCode: 200, body: JSON.stringify({ url: portal.url }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
