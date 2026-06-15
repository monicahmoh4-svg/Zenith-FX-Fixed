// api/trade.js — Trade execution and history
// Actions: place | settle | history | balance | update-profile
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function getUser(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  const { data: { user } } = await supabase.auth.getUser(token);
  return user;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  try {
    if (action === 'place')          return await handlePlace(req, res);
    if (action === 'settle')         return await handleSettle(req, res);
    if (action === 'history')        return await handleHistory(req, res);
    if (action === 'balance')        return await handleBalance(req, res);
    if (action === 'update-profile') return await handleUpdateProfile(req, res);
    if (action === 'update-balance-demo') return await handleUpdateDemoBalance(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[trade]', err);
    return res.status(500).json({ error: err.message });
  }
}

// Place a binary options trade
async function handlePlace(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { asset, contractType, direction, stake, duration, durationUnit, isDemo, multiplier } = req.body || {};
  if (!asset || !contractType || !direction || !stake || !duration)
    return res.status(400).json({ error: 'Missing required trade fields' });

  const { data: profile } = await supabase.from('profiles').select('demo_balance, live_balance').eq('id', user.id).single();
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const balField = isDemo ? 'demo_balance' : 'live_balance';
  const balance  = profile[balField];
  const stakeNum = parseFloat(stake);

  if (stakeNum < 1)       return res.status(400).json({ error: 'Minimum stake is $1' });
  if (stakeNum > balance) return res.status(400).json({ error: 'Insufficient balance' });

  // Deduct stake
  await supabase.from('profiles').update({ [balField]: balance - stakeNum }).eq('id', user.id);

  // Create trade record
  const { data: trade, error } = await supabase.from('trades').insert({
    user_id:       user.id,
    asset,
    contract_type: contractType,
    direction,
    stake:         stakeNum,
    multiplier:    parseFloat(multiplier || 1.92),
    duration:      parseInt(duration),
    duration_unit: durationUnit || 'ticks',
    is_demo:       isDemo ?? true,
    status:        'open',
    entry_price:   parseFloat(req.body.entryPrice || 0),
    placed_at:     new Date().toISOString(),
  }).select().single();

  if (error) {
    // Refund on DB error
    await supabase.from('profiles').update({ [balField]: balance }).eq('id', user.id);
    throw error;
  }

  // Award PetaPips (1 pip per $1 staked)
  await supabase.rpc('add_petapips', { p_user_id: user.id, p_amount: Math.floor(stakeNum) });

  return res.status(201).json({ success: true, trade });
}

// Settle a trade (called by the frontend when timer expires)
async function handleSettle(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { tradeId, exitPrice, won } = req.body || {};
  if (!tradeId) return res.status(400).json({ error: 'tradeId required' });

  const { data: trade } = await supabase.from('trades').select('*').eq('id', tradeId).eq('user_id', user.id).single();
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  if (trade.status !== 'open') return res.status(400).json({ error: 'Trade already settled' });

  const didWin   = won === true || won === 'true';
  const payout   = didWin ? parseFloat((trade.stake * trade.multiplier).toFixed(2)) : 0;
  const profit   = didWin ? payout - trade.stake : -trade.stake;
  const balField = trade.is_demo ? 'demo_balance' : 'live_balance';

  // Credit payout if won
  if (didWin && payout > 0) {
    await supabase.rpc('credit_balance_field', {
      p_user_id: user.id, p_field: balField, p_amount: payout
    });
  }

  await supabase.from('trades').update({
    status:     didWin ? 'won' : 'lost',
    payout,
    profit,
    exit_price: parseFloat(exitPrice || 0),
    settled_at: new Date().toISOString(),
  }).eq('id', tradeId);

  return res.status(200).json({ success: true, won: didWin, payout, profit });
}

// Trade history
async function handleHistory(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { limit = 50, offset = 0, isDemo } = req.query;
  let query = supabase.from('trades').select('*').eq('user_id', user.id).order('placed_at', { ascending: false }).range(offset, offset + limit - 1);
  if (isDemo !== undefined) query = query.eq('is_demo', isDemo === 'true');

  const { data, error } = await query;
  if (error) throw error;
  return res.status(200).json({ trades: data || [] });
}

// Get current balances
async function handleBalance(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { data } = await supabase.from('profiles').select('demo_balance, live_balance, petapips, tier').eq('id', user.id).single();
  return res.status(200).json(data || { demo_balance: 10000, live_balance: 0 });
}

// Update profile fields
async function handleUpdateProfile(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const allowed = ['first_name','last_name','phone','country'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  await supabase.from('profiles').update(updates).eq('id', user.id);
  return res.status(200).json({ success: true });
}

// Sync demo balance from frontend (for demo-only mode)
async function handleUpdateDemoBalance(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  const { demoBalance } = req.body || {};
  if (demoBalance === undefined) return res.status(400).json({ error: 'demoBalance required' });
  await supabase.from('profiles').update({ demo_balance: parseFloat(demoBalance) }).eq('id', user.id);
  return res.status(200).json({ success: true });
}
