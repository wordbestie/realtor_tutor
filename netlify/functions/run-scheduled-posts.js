// run-scheduled-posts.js  —  Netlify SCHEDULED function
// Runs on a cron (configured in netlify.toml). Each run finds posts whose
// scheduled time has arrived and delivers each to its member's Make webhook,
// then marks it published (or failed). Members don't need to be online.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Uses the service role, so it bypasses RLS to read/update every member's queue.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return done({ skipped: 'not configured' });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const nowIso = new Date().toISOString();

  // 1) find posts that are due
  let due = [];
  try {
    const { data, error } = await admin
      .from('scheduled_posts')
      .select('id,caption,platforms,image_url,webhook')
      .eq('status', 'pending')
      .lte('scheduled_for', nowIso)
      .order('scheduled_for', { ascending: true })
      .limit(50);
    if (error) return done({ error: 'query: ' + error.message });
    due = data || [];
  } catch (e) {
    return done({ error: 'query failed' });
  }

  let sent = 0, failed = 0;
  for (const row of due) {
    // 2) claim it (so two overlapping runs can't double-post the same row)
    try {
      const { data: claimed } = await admin
        .from('scheduled_posts')
        .update({ status: 'sending' })
        .eq('id', row.id)
        .eq('status', 'pending')
        .select('id');
      if (!claimed || !claimed.length) continue; // already taken
    } catch (e) { continue; }

    // 3) safety: only ever forward to a Make webhook
    let host = '';
    try { host = new URL(row.webhook).host; } catch (e) {}
    if (!/^hook[a-z0-9.\-]*\.make\.com$/i.test(host)) {
      await mark(admin, row.id, 'failed', 'Invalid webhook');
      failed++; continue;
    }

    // 4) deliver
    try {
      const r = await fetch(row.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caption: row.caption, platforms: row.platforms || {}, imageUrl: row.image_url })
      });
      if (r.ok) { await mark(admin, row.id, 'published', null); sent++; }
      else { await mark(admin, row.id, 'failed', 'Make returned ' + r.status); failed++; }
    } catch (e) {
      await mark(admin, row.id, 'failed', 'Could not reach Make');
      failed++;
    }
  }

  return done({ checked: due.length, sent, failed });
};

async function mark(admin, id, status, error) {
  const patch = { status };
  if (status === 'published') patch.published_at = new Date().toISOString();
  if (error) patch.error = error;
  try { await admin.from('scheduled_posts').update(patch).eq('id', id); } catch (e) {}
}

function done(obj) {
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
