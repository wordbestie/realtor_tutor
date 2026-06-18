// netlify/functions/create-checkout.js
// Creates a Stripe Checkout session for the $349 one-time, lifetime-access purchase.
// Verifies the Supabase access token server-side, then attaches the user id to the
// session so the webhook can grant access to the right account.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- price / branding (edit here) ---
const PRICE_CENTS = 34900;      // $349.00
const CURRENCY    = 'cad';      // change to 'usd' if you prefer
const PRODUCT_NAME = 'Realtor Tutor — Lifetime Access';
// 13% HST is applied as a fixed Stripe Tax Rate. Create a 13% (exclusive) tax rate
// in Stripe once, then set its id (txr_...) as STRIPE_TAX_RATE_ID in Netlify.
const TAX_RATE_ID = process.env.STRIPE_TAX_RATE_ID;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  try {
    const { access_token } = JSON.parse(event.body || '{}');
    if (!access_token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing access token' }) };
    }

    // Verify the token and get the real user — never trust an id sent from the browser.
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(access_token);
    if (error || !user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session' }) };
    }

    const siteUrl = process.env.SITE_URL || `https://${event.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: { supabase_user_id: user.id },
      line_items: [{
        quantity: 1,
        tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
        price_data: {
          currency: CURRENCY,
          unit_amount: PRICE_CENTS,
          product_data: { name: PRODUCT_NAME, description: 'One-time payment. Lifetime access to every wizard.' },
        },
      }],
      success_url: `${siteUrl}/?paid=1`,
      cancel_url: `${siteUrl}/?canceled=1`,
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
