// schedule-post.js
// Enqueues a post to be published LATER. Verifies the signed-in user, uploads
// the image to Supabase Storage (so it has a public URL), and inserts a row
// into the scheduled_posts table. A scheduled Netlify function
// (run-scheduled-posts.js) delivers it at the chosen time to the member's
// own Make webhook — the same pipeline publish-post.js uses for "post now".
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Requires: PUBLIC Storage bucket "post-images" + table public.scheduled_posts.

const { createClient } = require('@supabase/supabase-js');
const BUCKET = 'post-images';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return resp(500, { error: 'Scheduling is not configured yet.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return resp(400, { error: 'Bad request.' }); }

  const { access_token, webhookUrl, caption, platforms, image, imageType, scheduledFor } = body;

  // --- who is this? (verify the Supabase session token) ---
  if (!access_token) return resp(401, { error: 'Please sign in again.' });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  let userId;
  try {
    const { data, error } = await admin.auth.getUser(access_token);
    if (error || !data || !data.user) return resp(401, { error: 'Please sign in again.' });
    userId = data.user.id;
  } catch (e) { return resp(401, { error: 'Please sign in again.' }); }

  // --- safety: only allow forwarding to a Make webhook (no open proxy / SSRF) ---
  let host = '';
  try { host = new URL(webhookUrl).host; } catch (e) {}
  if (!/^hook[a-z0-9.\-]*\.make\.com$/i.test(host)) {
    return resp(400, { error: 'That webhook link is not a valid Make webhook.' });
  }
  if (!image) return resp(400, { error: 'No image was provided.' });
  if (!caption || !caption.trim()) return resp(400, { error: 'No caption was provided.' });

  // --- validate the time (must be in the future) ---
  const when = new Date(scheduledFor);
  if (isNaN(when.getTime())) return resp(400, { error: 'Invalid date or time.' });
  if (when.getTime() < Date.now() - 60000) return resp(400, { error: 'Pick a time in the future.' });

  // --- upload the image now (so the runner just forwards a URL later) ---
  const type = (imageType && /^image\//.test(imageType)) ? imageType : 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : 'jpg';
  const path = `sched/${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  let imageUrl;
  try {
    const buf = Buffer.from(image, 'base64');
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, 'content-type': type, 'x-upsert': 'true' },
      body: buf
    });
    if (!up.ok) {
      const t = await up.text();
      return resp(502, { error: 'Could not store the image. Is the "post-images" bucket set up?', detail: t.slice(0, 200) });
    }
    imageUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  } catch (e) {
    return resp(502, { error: 'Image upload failed.' });
  }

  // --- add it to the queue ---
  try {
    const { error } = await admin.from('scheduled_posts').insert({
      user_id: userId,
      caption: caption.trim(),
      platforms: platforms || {},
      image_url: imageUrl,
      webhook: webhookUrl,
      scheduled_for: when.toISOString(),
      status: 'pending'
    });
    if (error) return resp(500, { error: 'Could not save the schedule. Try again.', detail: error.message });
  } catch (e) {
    return resp(500, { error: 'Could not save the schedule. Try again.' });
  }

  return resp(200, { ok: true, scheduledFor: when.toISOString() });
};

function resp(code, obj) {
  return { statusCode: code, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
