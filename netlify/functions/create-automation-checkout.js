// netlify/functions/create-automation-checkout.js
// Creates a Stripe Checkout session for the $397 Content Automation Package.
// Same pattern as create-checkout.js, but a different price + a metadata flag
// (product: 'automation') so the webhook knows to grant has_automation — NOT
// to touch the buyer's existing has_access.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- price / branding (edit here) ---
const PRICE_CENTS  = 39700;     // $397.00
const CURRENCY     = 'cad';
const PRODUCT_NAME = 'Realtor Tutor — Content Automation Package';
// Same 13% (exclusive) HST tax rate used by the main checkout.
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

    // Verify the token and get the real user — never trust an id from the browser.
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
      metadata: { supabase_user_id: user.id, product: 'automation' },
      line_items: [{
        quantity: 1,
        tax_rates: TAX_RATE_ID ? [TAX_RATE_ID] : undefined,
        price_data: {
          currency: CURRENCY,
          unit_amount: PRICE_CENTS,
          product_data: { name: PRODUCT_NAME, description: 'One-time. The full hands-off content engine — every format, every platform.' },
        },
      }],
      success_url: `${siteUrl}/?automation=1`,
      cancel_url: `${siteUrl}/?canceled=1`,
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
