// api/mpesa.js
// Real Lipana.dev M-Pesa integration
// Endpoints:
//   POST /api/mpesa?action=stkpush   → initiate deposit
//   POST /api/mpesa?action=callback  → Lipana webhook (set this URL in Lipana dashboard)
//   POST /api/mpesa?action=status    → query transaction status
//   POST /api/mpesa?action=withdraw  → B2C payout to phone

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LIPANA_KEY = process.env.LIPANA_SECRET_KEY;
const LIPANA_API = 'https://api.lipana.dev/v1';
const USD_KES   = parseFloat(process.env.USD_KES_RATE || '130');

// ── helpers ──────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-lipana-signature');
}

function cleanPhone(raw) {
  // Accept 07XX, 01XX, +254XX, 254XX → return 254XXXXXXXXX
  let n = String(raw).replace(/\D/g, '');
  if (n.startsWith('0'))  n = '254' + n.slice(1);
  if (!n.startsWith('254')) n = '254' + n;
  return n;
}

function isKenyanPhone(n) {
  return /^254[17]\d{8}$/.test(n);
}

async function lipanaPost(path, body) {
  const res = await fetch(`${LIPANA_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': LIPANA_KEY,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.message || 'Lipana error'), { status: res.status, body: json });
  return json;
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (action === 'stkpush')  return await handleSTKPush(req, res);
    if (action === 'callback') return await handleCallback(req, res);
    if (action === 'status')   return await handleStatus(req, res);
    if (action === 'withdraw') return await handleWithdraw(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(`[mpesa/${action}]`, err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  }
}

// ── STK PUSH ─────────────────────────────────────────────────────────────────
async function handleSTKPush(req, res) {
  const { phone, amount, userId } = req.body || {};
  if (!phone || !amount) return res.status(400).json({ error: 'phone and amount required' });

  const phoneClean = cleanPhone(phone);
  if (!isKenyanPhone(phoneClean))
    return res.status(400).json({ error: 'Enter a valid Safaricom number (07XX or 01XX)' });

  const kes = parseInt(amount);
  if (isNaN(kes) || kes < 100) return res.status(400).json({ error: 'Minimum deposit is KES 100' });

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
  const callbackUrl = `${siteUrl}/api/mpesa?action=callback`;

  // Call Lipana STK Push
  const data = await lipanaPost('/transactions/push-stk', {
    phone: `+${phoneClean}`,
    amount: kes,
    callback_url: callbackUrl,    // Lipana will POST here on completion
  });

  const txnId          = data?.data?.transactionId || data?.transactionId;
  const checkoutReqId  = data?.data?.checkoutRequestID || data?.checkoutRequestID;

  // Persist pending transaction in Supabase
  await supabase.from('transactions').insert({
    id:                  txnId,
    user_id:             userId || null,
    type:                'deposit',
    status:              'pending',
    amount_kes:          kes,
    amount_usd:          parseFloat((kes / USD_KES).toFixed(2)),
    phone:               phoneClean,
    checkout_request_id: checkoutReqId,
    created_at:          new Date().toISOString(),
  });

  return res.status(200).json({
    success: true,
    message: 'STK Push sent. Enter your M-Pesa PIN.',
    transactionId:      txnId,
    checkoutRequestId:  checkoutReqId,
  });
}

// ── LIPANA WEBHOOK CALLBACK ───────────────────────────────────────────────────
// Set this URL in your Lipana Dashboard → Settings → Webhook URL:
//   https://your-site.vercel.app/api/mpesa?action=callback
async function handleCallback(req, res) {
  // Verify Lipana signature
  const sig    = req.headers['x-lipana-signature'];
  const secret = process.env.LIPANA_WEBHOOK_SECRET;

  if (secret && sig) {
    // Lipana uses HMAC-SHA256 of raw body
    const crypto = await import('crypto');
    const rawBody = JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (sig !== expected) {
      console.warn('[callback] Invalid Lipana signature — ignoring');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const event  = req.body?.event;        // "payment.success" | "payment.failed"
  const txData = req.body?.data || {};

  const txnId    = txData.transactionId;
  const status   = event === 'payment.success' ? 'success' : 'failed';
  const amountKes = txData.amount || 0;
  const phone    = txData.phone?.replace(/^\+/, '') || '';

  // Update transaction record
  const { data: txRow } = await supabase
    .from('transactions')
    .update({ status, mpesa_receipt: txData.mpesaReceiptNumber || null, updated_at: new Date().toISOString() })
    .eq('id', txnId)
    .select()
    .single();

  if (status === 'success' && txRow?.user_id) {
    // Credit the user's live balance
    const usdCredit = parseFloat((amountKes / USD_KES).toFixed(2));
    await supabase.rpc('credit_balance', { p_user_id: txRow.user_id, p_amount: usdCredit });

    // Notify user by email
    await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || 'https://' + req.headers.host}/api/email?action=depositConfirmed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: txRow.user_id, amountKes, amountUsd: usdCredit }),
    }).catch(() => {});
  }

  // Always respond 200 to Lipana so it stops retrying
  return res.status(200).json({ received: true });
}

// ── TRANSACTION STATUS POLL ───────────────────────────────────────────────────
async function handleStatus(req, res) {
  const { transactionId, checkoutRequestId } = req.body || {};
  const id = transactionId || checkoutRequestId;
  if (!id) return res.status(400).json({ error: 'transactionId required' });

  // Check our DB first
  const { data: row } = await supabase
    .from('transactions')
    .select('status, amount_usd, amount_kes, mpesa_receipt, user_id')
    .or(`id.eq.${id},checkout_request_id.eq.${id}`)
    .single();

  if (row) {
    return res.status(200).json({
      status:       row.status,
      amountUsd:    row.amount_usd,
      amountKes:    row.amount_kes,
      mpesaReceipt: row.mpesa_receipt,
    });
  }

  return res.status(200).json({ status: 'pending' });
}

// ── WITHDRAW (B2C) ────────────────────────────────────────────────────────────
async function handleWithdraw(req, res) {
  const { phone, amountUsd, userId } = req.body || {};
  if (!phone || !amountUsd || !userId) return res.status(400).json({ error: 'phone, amountUsd and userId required' });

  const phoneClean = cleanPhone(phone);
  if (!isKenyanPhone(phoneClean)) return res.status(400).json({ error: 'Invalid Kenyan phone number' });

  const usd = parseFloat(amountUsd);
  if (isNaN(usd) || usd < 5) return res.status(400).json({ error: 'Minimum withdrawal is $5' });

  // Check user balance
  const { data: profile } = await supabase.from('profiles').select('live_balance').eq('id', userId).single();
  if (!profile || profile.live_balance < usd)
    return res.status(400).json({ error: 'Insufficient balance' });

  const kesAmount = Math.floor(usd * USD_KES);

  // Debit balance first (idempotent — re-credit on failure)
  await supabase.rpc('debit_balance', { p_user_id: userId, p_amount: usd });

  let txnId;
  try {
    // Lipana B2C payout
    const data = await lipanaPost('/transactions/payout', {
      phone: `+${phoneClean}`,
      amount: kesAmount,
      remarks: 'ZenithFX Withdrawal',
    });
    txnId = data?.data?.transactionId || data?.transactionId || `WD_${Date.now()}`;
  } catch (err) {
    // Re-credit on Lipana failure
    await supabase.rpc('credit_balance', { p_user_id: userId, p_amount: usd });
    throw err;
  }

  // Log withdrawal
  await supabase.from('transactions').insert({
    id:         txnId,
    user_id:    userId,
    type:       'withdrawal',
    status:     'processing',
    amount_kes: kesAmount,
    amount_usd: usd,
    phone:      phoneClean,
    created_at: new Date().toISOString(),
  });

  return res.status(200).json({
    success: true,
    message: `KES ${kesAmount.toLocaleString()} will arrive via M-Pesa within 3 hours.`,
    transactionId: txnId,
  });
}
