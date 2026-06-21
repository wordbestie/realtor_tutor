// team-remove.js
// A Pro owner removes a teammate seat. The teammate loses unlimited posting
// immediately (access is resolved live).
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

  let user;
  try { const { data } = await admin.auth.getUser(body.access_token); user = data && data.user; } catch (e) {}
  if (!user) return resp(401, { error: 'Please sign in again.' });

  let ent = {};
  try { const { data } = await admin.from('entitlements').select('sub_tier,sub_status').eq('user_id', user.id).maybeSingle(); ent = data || {}; } catch (e) {}
  if (!(ent.sub_status === 'active' && ent.sub_tier === 'pro')) return resp(403, { error: 'Team seats are a Pro feature.' });

  try {
    await admin.from('team_members').update({ status: 'removed' }).eq('owner_id', user.id).eq('email', email);
  } catch (e) { return resp(500, { error: 'Could not remove that seat. Try again.' }); }

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
