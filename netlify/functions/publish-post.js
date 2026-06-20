// publish-post.js
// Receives a finished post from the RT wizard, stores the image in Supabase
// Storage (so it has a public URL), then forwards {caption, platforms, imageUrl}
// to the member's own Make webhook, which publishes to their socials.
//
// Reuses existing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// One-time setup: create a PUBLIC Supabase Storage bucket named "post-images".

const BUCKET = 'post-images';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Publishing is not configured yet.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Bad request.' }) }; }

  const { webhookUrl, caption, platforms, image, imageType } = body;

  // --- safety: only allow forwarding to a Make webhook (no open proxy / SSRF) ---
  let host = '';
  try { host = new URL(webhookUrl).host; } catch (e) {}
  if (!/^hook[a-z0-9.\-]*\.make\.com$/i.test(host)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'That webhook link is not a valid Make webhook.' }) };
  }
  if (!image) return { statusCode: 400, body: JSON.stringify({ error: 'No image was provided.' }) };
  if (!caption || !caption.trim()) return { statusCode: 400, body: JSON.stringify({ error: 'No caption was provided.' }) };

  const type = (imageType && /^image\//.test(imageType)) ? imageType : 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : 'jpg';
  const path = `auto/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  // --- 1) upload image to Supabase Storage ---
  let imageUrl;
  try {
    const buf = Buffer.from(image, 'base64');
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${SERVICE_KEY}`,
        'apikey': SERVICE_KEY,
        'content-type': type,
        'x-upsert': 'true'
      },
      body: buf
    });
    if (!up.ok) {
      const t = await up.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not store the image. Is the "post-images" bucket set up?', detail: t.slice(0, 200) }) };
    }
    imageUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Image upload failed.' }) };
  }

  // --- 2) forward the post to the member's Make webhook ---
  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caption, platforms: platforms || {}, imageUrl })
    });
    if (!r.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Your Make automation did not accept the post. Check that it is turned on.' }) };
    }
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Could not reach your Make automation.' }) };
  }

  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, imageUrl }) };
};
