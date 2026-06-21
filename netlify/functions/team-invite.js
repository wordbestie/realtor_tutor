// team-invite.js
// A Pro owner adds a teammate by email (up to 5 seats incl. themselves).
// The teammate gets unlimited posting as soon as they sign in with that email
// (access is resolved live in team-sync / generate-caption).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');
const SEAT_LIMIT = 5;
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method not allowed' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'Bad request.' }); }
  if (!body.access_token) return resp(401, { error: 'Please sign in again.' });

  const email = (body.email || '').toString().trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return resp(400, { error: 'Enter a valid email address.' });

  let user;
  try { const { data } = await admin.auth.getUser(body.access_token); user = data && data.user; } catch (e) {}
  if (!user) return resp(401, { error: 'Please sign in again.' });
  if (email === (user.email || '').toLowerCase()) return resp(400, { error: "That's your own email — you're already on the team." });

  // must be an active Pro owner
  let ent = {};
  try { const { data } = await admin.from('entitlements').select('sub_tier,sub_status').eq('user_id', user.id).maybeSingle(); ent = data || {}; } catch (e) {}
  if (!(ent.sub_status === 'active' && ent.sub_tier === 'pro')) return resp(403, { error: 'Team seats are a Pro feature.' });

  // seat-limit check (owner = seat 1)
  let current = [];
  try { const { data } = await admin.from('team_members').select('email,status').eq('owner_id', user.id); current = data || []; } catch (e) {}
  const activeInvites = current.filter(r => r.status === 'invited');
  const alreadyInvited = current.find(r => r.email === email && r.status === 'invited');
  if (!alreadyInvited && (1 + activeInvites.length) >= SEAT_LIMIT) {
    return resp(400, { error: 'Your team is full (5 seats). Remove someone first.' });
  }

  try {
    await admin.from('team_members').upsert(
      { owner_id: user.id, email, status: 'invited' },
      { onConflict: 'owner_id,email' }
    );
  } catch (e) { return resp(500, { error: 'Could not add that seat. Try again.' }); }

  const seats = await seatList(user.id);
  return resp(200, { ok: true, seats, seatLimit: SEAT_LIMIT, seatsUsed: 1 + seats.length });
};

async function seatList(ownerId) {
  try {
    const { data } = await admin.from('team_members')
      .select('email').eq('owner_id', ownerId).eq('status', 'invited').order('created_at', { ascending: true });
    return (data || []).map(r => ({ email: r.email }));
  } catch (e) { return []; }
}

function resp(code, obj) { return { statusCode: code, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }; }
