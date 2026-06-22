// schedule-post.js
// Enqueues a post to be published LATER. Verifies the signed-in user, resolves a
// public media URL, and inserts a row into scheduled_posts. A scheduled Netlify
// function (run-scheduled-posts.js) delivers it at the chosen time to the
// member's own Make webhook — same pipeline as publish-post.js ("post now").
//
//  • PHOTO: wizard sends base64; we upload it to "post-images" for a public URL.
//  • VIDEO: wizard already uploaded the file to "post-media" from the browser;
//    we store the public mediaUrl it provides.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Requires: PUBLIC buckets "post-images" + "post-media", table public.scheduled_posts
//           (columns: media_type, media_url, yt_title, yt_description — see setup md).

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

  const { access_token, webhookUrl, caption, platforms, image, imageType, mediaUrl, youtube, scheduledFor } = body;
  const mediaType = body.mediaType === 'video' ? 'video' : 'photo';

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
  if (!caption || !caption.trim()) return resp(400, { error: 'No caption was provided.' });

  // --- validate the time (must be in the future) ---
  const when = new Date(scheduledFor);
  if (isNaN(when.getTime())) return resp(400, { error: 'Invalid date or time.' });
  if (when.getTime() < Date.now() - 60000) return resp(400, { error: 'Pick a time in the future.' });

  // --- resolve the public media URL now (so the runner just forwards a URL later) ---
  let finalUrl;
  if (mediaType === 'video') {
    if (!mediaUrl || !isPublicSupabaseUrl(mediaUrl, SUPABASE_URL)) {
      return resp(400, { error: 'Your video upload was not found. Please add the video again.' });
    }
    finalUrl = mediaUrl;
  } else {
    if (!image) return resp(400, { error: 'No image was provided.' });
    const type = (imageType && /^image\//.test(imageType)) ? imageType : 'image/jpeg';
    const ext = type === 'image/png' ? 'png' : 'jpg';
    const path = `sched/${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
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
      finalUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
    } catch (e) {
      return resp(502, { error: 'Image upload failed.' });
    }
  }

  // --- add it to the queue ---
  const yt = youtube || {};
  try {
    const { error } = await admin.from('scheduled_posts').insert({
      user_id: userId,
      caption: caption.trim(),
      platforms: platforms || {},
      media_type: mediaType,
      media_url: finalUrl,
      image_url: finalUrl,                 // alias kept for backward compatibility
      yt_title: (yt.title || '').toString().slice(0, 100) || null,
      yt_description: (yt.description || '').toString() || null,
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

function isPublicSupabaseUrl(url, base) {
  try {
    const u = new URL(url);
    return u.origin === new URL(base).origin && u.pathname.indexOf('/storage/v1/object/public/') === 0;
  } catch (e) { return false; }
}

function resp(code, obj) {
  return { statusCode: code, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
