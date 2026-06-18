# Realtor Tutor — setup

Same stack you used for Report Card Autopilot: **Netlify** (hosting + functions), **Stripe** (one-time $299 payment), **Supabase** (accounts + who-has-access).

Until you add real keys, the site runs in **demo mode** so you can click the whole flow (sign up → paywall → dashboard) with nothing connected.

## 1. Supabase
1. Create a project. In **SQL Editor**, run `supabase-setup.sql`.
2. **Authentication → Providers → Email**: keep it on. For the smoothest start, turn **"Confirm email"** off (otherwise users must click an email link before they can pay).
3. From **Project Settings → API**, copy the **Project URL** and the **anon public** key into the top of `gate.js` (`RT_SUPABASE_URL`, `RT_SUPABASE_ANON_KEY`). This one file is the single source of truth — both the homepage and every wizard read from it. These values are safe to expose.

## 2. Stripe
1. Get your **Secret key** (`sk_...`) from the Stripe dashboard.
2. You'll create the webhook secret in step 4.
3. Price/currency live in `netlify/functions/create-checkout.js` (`PRICE_CENTS = 29900`, `CURRENCY = 'cad'`).

## 3. Deploy to Netlify
1. Push this folder to a Git repo and **Import** it in Netlify (publish dir `.`, functions `netlify/functions`).
2. In **Site settings → Environment variables**, add:

   | Variable | Value |
   |---|---|
   | `STRIPE_SECRET_KEY` | `sk_live_...` (or test key) |
   | `STRIPE_WEBHOOK_SECRET` | from step 4 |
   | `SUPABASE_URL` | your project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | the **service_role** key — server only, never in the browser |
   | `SITE_URL` | `https://your-site.netlify.app` |

## 4. Stripe webhook
1. In Stripe → **Developers → Webhooks → Add endpoint**: `https://your-site.netlify.app/.netlify/functions/stripe-webhook`
2. Subscribe to **`checkout.session.completed`**.
3. Copy the **Signing secret** (`whsec_...`) into the `STRIPE_WEBHOOK_SECRET` env var and redeploy.

## 5. Go live
Add your real keys to `gate.js`, redeploy. Demo mode switches off automatically once `RT_SUPABASE_URL` / `RT_SUPABASE_ANON_KEY` are filled in — and at that point the wizard pages start enforcing sign-in + payment too.

## Assets to drop in (same folder as index.html)
- `hero.mp4` — the edge-to-edge hero video (optional `hero-poster.jpg`).
- `tutor.jpg` — your photo for the profile circle (replaces the "RZ" monogram automatically).
- `demo.mp4` — the "See what's inside" demo on the landing page.
- One explainer video per wizard (each card shows the exact filename it expects):
  `listing-intake-demo.mp4`, `broker-load-demo.mp4`, `open-house-demo.mp4`,
  `making-an-offer-demo.mp4`, `going-firm-demo.mp4`, `marketing-automation-demo.mp4`.
  Until a file is added, that card shows a play-button placeholder. Filenames live in the `CATEGORIES` config.

## Wizards live in `/wizards/`
Each wizard is its own self-contained, Realtor Tutor-branded page (`wizards/listing-intake.html`, `wizards/broker-load.html`, `wizards/open-house.html`, `wizards/going-firm.html`). They're multi-step forms that end in a copy / print / email summary. Fields are defined in a `CONFIG` object near the bottom of each file, so adding or renaming a field is a one-line edit. The dashboard links to them with relative paths. "Making an Offer" and the Marketing blueprint are intentionally left as "Coming soon."

Each wizard is gated: on load it runs `requireMemberAccess()` from `gate.js`, which checks the visitor is signed in and has paid before revealing the form — otherwise it redirects to the homepage. So a shared or guessed `/wizards/...` link won't open for a non-member. (In demo mode the gate lets everyone through so you can preview.)

## Things to edit in `index.html`
- `CATEGORIES` — wizard names, blurbs, and URLs (only the Listing Intake Wizard URL is confirmed).
- `SOCIAL` — Instagram/Facebook links and your contact email.
- Modal copy (FAQ / Privacy / Accountability) lives near the bottom of the script — **have a lawyer review the privacy and accountability text before launch.**

## How access actually works
The browser can never grant itself access. Stripe confirms payment → the webhook (using the service-role key) sets `has_access = true` in Supabase → the front-end reads that row and unlocks the dashboard. That's the part a plain HTML file can't do on its own, and why the functions exist.
