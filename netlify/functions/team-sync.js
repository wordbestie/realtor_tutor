// team-sync.js
// The single source of truth the wizard uses for Pro / Team seats.
// Given the caller's session token, returns their effective subscription status
// and (if they're a Pro owner) their seat list.
//
// A user is "active" (unlimited posting) if EITHER:
//   - their own entitlements row is sub_status='active', OR
//   - their email matches an invite (team_members, status='invited') whose owner
//     has an active Pro plan (sub_tier='pro', sub_status='active').
// Resolved live — so when a Pro owner cancels, their seats deactivate by themselves.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FREE_POST_LIMIT (optional)

const { createClient } = require('@supabase/supabase-js');
const SEAT_LIMIT = 5;
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function period() { return new Date().toISOString().slice(0, 7); }
function freeLimit() { return parseInt(process.env.FREE_POST_LIMIT || '3', 10); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method not allowed' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'Bad request.' }); }
  if (!body.access_token) return resp(401, { error: 'Please sign in again.' });

  let user;
  try { const { data } = await admin.auth.getUser(body.access_token); user = data && data.user; } catch (e) {}
  if (!user) return resp(401, { error: 'Please sign in again.' });

  const email = (user.email || '').toLowerCase();

  let ent = {};
  try {
    const { data } = await admin.from('entitlements')
      .select('sub_tier,sub_status,usage_period,usage_count').eq('user_id', user.id).maybeSingle();
    ent = data || {};
  } catch (e) {}

  const ownActive = ent.sub_status === 'active';
  const used = (ent.usage_period === period()) ? (ent.usage_count || 0) : 0;
  const limit = freeLimit();

  // Pro owner — can manage seats
  if (ownActive && ent.sub_tier === 'pro') {
    const seats = await seatList(user.id);
    return resp(200, { active: true, role: 'owner', used, limit, seats, seatLimit: SEAT_LIMIT, seatsUsed: 1 + seats.length });
  }
  // Solo subscriber
  if (ownActive) return resp(200, { active: true, role: 'solo', used, limit });

  // Seat on someone's active Pro team?
  const owner = await coveringOwner(email);
  if (owner) return resp(200, { active: true, role: 'seat', used, limit, ownerEmail: owner.email });

  return resp(200, { active: false, role: 'none', used, limit });
};

async function seatList(ownerId) {
  try {
    const { data } = await admin.from('team_members')
      .select('email').eq('owner_id', ownerId).eq('status', 'invited').order('created_at', { ascending: true });
    return (data || []).map(r => ({ email: r.email }));
  } catch (e) { return []; }
}

async function coveringOwner(email) {
  if (!email) return null;
  try {
    const { data: invites } = await admin.from('team_members').select('owner_id').eq('email', email).eq('status', 'invited');
    if (!invites || !invites.length) return null;
    const ids = invites.map(i => i.owner_id);
    const { data: owners } = await admin.from('entitlements')
      .select('user_id').in('user_id', ids).eq('sub_tier', 'pro').eq('sub_status', 'active');
    if (!owners || !owners.length) return null;
    let oemail = 'your team admin';
    try { const { data } = await admin.auth.admin.getUserById(owners[0].user_id); if (data && data.user && data.user.email) oemail = data.user.email; } catch (e) {}
    return { id: owners[0].user_id, email: oemail };
  } catch (e) { return null; }
}

function resp(code, obj) { return { statusCode: code, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }; }
