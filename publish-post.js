// publish-post.js
// Receives a finished post from the wizard and forwards it to the member's own
// Make webhook (which publishes to their socials).
//
//  • PHOTO: the wizard sends base64; we store it in Supabase Storage ("post-images")
//    to get a public URL, then forward that URL.
//  • VIDEO: the wizard has ALREADY uploaded the file straight to Supabase Storage
//    ("post-media") from the browser (videos are too big to pass through a function),
//    so we just forward the public mediaUrl it gives us.
//
// Payload forwarded to the member's webhook (consumed by the combined publisher):
//   { mediaType, mediaUrl, imageUrl, caption, platforms, youtube }
//   (imageUrl is kept as an alias of mediaUrl for backward compatibility.)
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const BUCKET = 'post-images';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return resp(405, { error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return resp(500, { error: 'Publishing is not configured yet.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return resp(400, { error: 'Bad request.' }); }

  const { webhookUrl, caption, platforms, image, imageType, mediaUrl, youtube } = body;
  const mediaType = body.mediaType === 'video' ? 'video' : 'photo';

  // --- safety: only allow forwarding to a Make webhook (no open proxy / SSRF) ---
  let host = '';
  try { host = new URL(webhookUrl).host; } catch (e) {}
  if (!/^hook[a-z0-9.\-]*\.make\.com$/i.test(host)) {
    return resp(400, { error: 'That webhook link is not a valid Make webhook.' });
  }
  if (!caption || !caption.trim()) return resp(400, { error: 'No caption was provided.' });

  // --- resolve the public media URL ---
  let finalUrl;
  if (mediaType === 'video') {
    // The browser already uploaded the video to Supabase Storage; just sanity-check it.
    if (!mediaUrl || !isPublicSupabaseUrl(mediaUrl, SUPABASE_URL)) {
      return resp(400, { error: 'Your video upload was not found. Please add the video again.' });
    }
    finalUrl = mediaUrl;
  } else {
    if (!image) return resp(400, { error: 'No image was provided.' });
    const type = (imageType && /^image\//.test(imageType)) ? imageType : 'image/jpeg';
    const ext = type === 'image/png' ? 'png' : 'jpg';
    const path = `auto/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
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

  // --- forward the post to the member's Make webhook ---
  const out = {
    mediaType,
    mediaUrl: finalUrl,
    imageUrl: finalUrl,            // alias kept for older publisher blueprints
    caption,
    platforms: platforms || {},
    youtube: youtube || {}
  };
  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(out)
    });
    if (!r.ok) {
      return resp(502, { error: 'Your Make automation did not accept the post. Check that it is turned on.' });
    }
  } catch (e) {
    return resp(502, { error: 'Could not reach your Make automation.' });
  }

  return resp(200, { ok: true, mediaUrl: finalUrl, mediaType });
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
