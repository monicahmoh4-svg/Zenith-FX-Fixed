// api/mpesa.js — Zenith FX M-Pesa Integration via Paynecta (https://paynecta.co.ke)
//
// Paynecta API summary (from official docs/SDK):
//   Base URL:    https://paynecta.co.ke/api/v1
//   Auth:        Header "X-API-KEY: <key>" + "X-EMAIL: <email>" (API key + account email)
//   STK Push:    POST /payments/initialize  { link_code, mobile_number, amount }
//   Status:      GET  /payments/status/{transaction_reference}
//   Webhook:     POST to your registered webhook URL on payment completion/failure
//
// IMPORTANT — Paynecta requires a "Payment Link" to be created in your
// Paynecta Dashboard first (Dashboard → Payment Links → Create New).
// Copy its "link_code" into the PAYNECTA_LINK_CODE env var below.
// This is how Paynecta knows which merchant/till the STK push money goes to.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Paynecta-Signature');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (action === 'stkpush')  return await handleSTKPush(req, res);
    if (action === 'callback') return await handleCallback(req, res);
    if (action === 'status')   return await handleStatus(req, res);
    if (action === 'withdraw') return await handleWithdraw(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(`[mpesa/${action}] UNHANDLED:`, err?.message, err?.stack);
    return res.status(err?.status || 500).json({ error: err?.message || 'Internal server error' });
  }
}

// ── SUPABASE CLIENT ────────────────────────────────────────────────────────────
function getSupabase() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Object.assign(new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var missing'), { status: 500 });
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

const USD_KES = parseFloat(process.env.USD_KES_RATE || '130');

// ── PHONE HELPERS ──────────────────────────────────────────────────────────────
function cleanPhone(raw) {
  let n = String(raw).replace(/\D/g, '');
  if (n.startsWith('0'))   n = '254' + n.slice(1);
  if (n.startsWith('254')) return n;
  if (!n.startsWith('254')) n = '254' + n;
  return n;
}
function isKenyanPhone(n) { return /^254[17]\d{8}$/.test(n); }

// ── PAYNECTA API CLIENT ─────────────────────────────────────────────────────────
function paynectaHeaders() {
  const apiKey = process.env.PAYNECTA_API_KEY;
  const email  = process.env.PAYNECTA_EMAIL;
  if (!apiKey || !email) {
    throw Object.assign(new Error('PAYNECTA_API_KEY or PAYNECTA_EMAIL env var missing'), { status: 500 });
  }
  return {
    'Content-Type': 'application/json',
    'X-API-KEY':    apiKey,
    'X-EMAIL':      email,
  };
}

function paynectaBaseUrl() {
  return process.env.PAYNECTA_BASE_URL || 'https://paynecta.co.ke/api/v1';
}

async function paynectaRequest(path, options = {}) {
  const url = `${paynectaBaseUrl()}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...paynectaHeaders(), ...(options.headers || {}) },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    const msg = json?.message || json?.error || `Paynecta API error (${res.status})`;
    throw Object.assign(new Error(msg), { status: res.status, body: json });
  }
  return json;
}

// ── STK PUSH (DEPOSIT) ──────────────────────────────────────────────────────────
async function handleSTKPush(req, res) {
  const { phone, amount, userId } = req.body || {};
  if (!phone || !amount) return res.status(400).json({ error: 'phone and amount are required' });

  const phoneClean = cleanPhone(phone);
  if (!isKenyanPhone(phoneClean)) {
    return res.status(400).json({ error: 'Enter a valid Safaricom number (07XX or 01XX)' });
  }

  const kes = parseInt(amount);
  if (isNaN(kes) || kes < 1 || kes > 250000) {
    return res.status(400).json({ error: 'Amount must be between KES 1 and KES 250,000' });
  }

  const linkCode = process.env.PAYNECTA_LINK_CODE;
  if (!linkCode) {
    return res.status(500).json({ error: 'PAYNECTA_LINK_CODE env var missing — create a Payment Link in your Paynecta dashboard first.' });
  }

  // ── Call Paynecta: Initialize STK Push ──
  const data = await paynectaRequest('/payments/initialize', {
    method: 'POST',
    body: JSON.stringify({
      link_code:     linkCode,
      mobile_number: phoneClean,
      amount:        kes,
    }),
  });

  // Paynecta returns the transaction reference used to track this payment
  const reference =
    data?.data?.transaction_reference ||
    data?.transaction_reference ||
    data?.data?.reference ||
    data?.reference;

  if (!reference) {
    console.error('[stkpush] Paynecta response missing reference:', JSON.stringify(data));
    throw Object.assign(new Error('Paynecta did not return a transaction reference.'), { status: 502 });
  }

  // Persist pending transaction in Supabase — this is what the callback/poll updates
  const sb = getSupabase();
  const { error: insertErr } = await sb.from('transactions').insert({
    id:                  reference,
    user_id:             userId || null,
    type:                'deposit',
    status:              'pending',
    amount_kes:          kes,
    amount_usd:          parseFloat((kes / USD_KES).toFixed(2)),
    phone:               phoneClean,
    checkout_request_id: reference,
    created_at:          new Date().toISOString(),
  });
  if (insertErr) console.error('[stkpush] failed to insert pending transaction:', insertErr.message);

  return res.status(200).json({
    success:       true,
    message:       'STK Push sent. Enter your M-Pesa PIN to complete the deposit.',
    transactionId: reference,
    checkoutRequestId: reference,
  });
}

// ── WEBHOOK CALLBACK FROM PAYNECTA ──────────────────────────────────────────────
// Register this URL in Paynecta Dashboard → Webhooks:
//   https://YOUR-SITE.vercel.app/api/mpesa?action=callback
async function handleCallback(req, res) {
  console.log('[paynecta-callback] payload:', JSON.stringify(req.body));

  const body = req.body || {};

  // Paynecta webhook payload fields (per official SDK events):
  //   transactionReference, amount, mpesaReceiptNumber, mobileNumber, status
  const reference   = body.transactionReference || body.transaction_reference || body.reference;
  const statusRaw   = (body.status || body.event || '').toString().toLowerCase();
  const mpesaReceipt = body.mpesaReceiptNumber || body.mpesa_receipt_number || body.receipt || null;
  const amountKes    = parseFloat(body.amount || 0);
  const mobile        = (body.mobileNumber || body.mobile_number || '').replace(/^\+/, '');

  if (!reference) {
    console.warn('[paynecta-callback] missing transaction reference — ignoring');
    return res.status(200).json({ received: true, ignored: true });
  }

  // Determine final status: COMPLETED -> success, FAILED/CANCELLED -> failed
  let finalStatus = 'pending';
  if (statusRaw.includes('complet') || statusRaw.includes('success')) finalStatus = 'success';
  else if (statusRaw.includes('fail') || statusRaw.includes('cancel') || statusRaw.includes('declin')) finalStatus = 'failed';

  const sb = getSupabase();

  const { data: txRow, error: updateErr } = await sb
    .from('transactions')
    .update({
      status:        finalStatus,
      mpesa_receipt: mpesaReceipt,
      updated_at:    new Date().toISOString(),
    })
    .eq('id', reference)
    .select()
    .maybeSingle();

  if (updateErr) console.error('[paynecta-callback] update error:', updateErr.message);

  if (finalStatus === 'success' && txRow?.user_id) {
    const usdCredit = txRow.amount_usd || parseFloat((amountKes / USD_KES).toFixed(2));

    // Credit balance via RPC (atomic increment)
    const { error: rpcErr } = await sb.rpc('credit_balance', { p_user_id: txRow.user_id, p_amount: usdCredit });
    if (rpcErr) {
      console.error('[paynecta-callback] credit_balance RPC failed:', rpcErr.message);
      // Fallback: direct update
      const { data: profile } = await sb.from('profiles').select('live_balance').eq('id', txRow.user_id).single();
      if (profile) {
        await sb.from('profiles').update({ live_balance: parseFloat(profile.live_balance || 0) + usdCredit }).eq('id', txRow.user_id);
      }
    }

    // Email confirmation (non-blocking, best effort)
    try {
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
      await fetch(`${siteUrl}/api/email?action=depositConfirmed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: txRow.user_id, amountKes: txRow.amount_kes, amountUsd: usdCredit }),
      });
    } catch (e) { console.error('[paynecta-callback] email notify failed (non-fatal):', e.message); }
  }

  // Always 200 — tells Paynecta the webhook was received so it stops retrying
  return res.status(200).json({ received: true, status: finalStatus });
}

// ── STATUS POLL (frontend asks: "is my deposit done yet?") ─────────────────────
async function handleStatus(req, res) {
  const { transactionId, checkoutRequestId } = req.body || {};
  const id = transactionId || checkoutRequestId;
  if (!id) return res.status(400).json({ error: 'transactionId is required' });

  const sb = getSupabase();

  // 1. Check our own DB first (fastest, updated by webhook)
  const { data: row } = await sb
    .from('transactions')
    .select('status, amount_usd, amount_kes, mpesa_receipt, user_id')
    .or(`id.eq.${id},checkout_request_id.eq.${id}`)
    .maybeSingle();

  if (row && row.status !== 'pending') {
    return res.status(200).json({
      status:       row.status,
      amountUsd:    row.amount_usd,
      amountKes:    row.amount_kes,
      mpesaReceipt: row.mpesa_receipt,
    });
  }

  // 2. Still pending in our DB — actively query Paynecta in case the webhook
  //    hasn't arrived yet (network delay, etc.)
  try {
    const data = await paynectaRequest(`/payments/status/${encodeURIComponent(id)}`, { method: 'GET' });
    const statusRaw = (data?.data?.status || data?.status || '').toString().toLowerCase();

    let finalStatus = 'pending';
    if (statusRaw.includes('complet') || statusRaw.includes('success')) finalStatus = 'success';
    else if (statusRaw.includes('fail') || statusRaw.includes('cancel') || statusRaw.includes('declin')) finalStatus = 'failed';

    if (finalStatus !== 'pending' && row) {
      // Sync our DB and credit balance if we missed the webhook
      const mpesaReceipt = data?.data?.mpesa_receipt_number || data?.data?.mpesaReceiptNumber || null;
      await sb.from('transactions').update({
        status: finalStatus, mpesa_receipt: mpesaReceipt, updated_at: new Date().toISOString(),
      }).eq('id', id);

      if (finalStatus === 'success' && row.user_id) {
        const usdCredit = row.amount_usd;
        await sb.rpc('credit_balance', { p_user_id: row.user_id, p_amount: usdCredit }).catch(() => {});
      }
    }

    return res.status(200).json({
      status:       finalStatus,
      amountUsd:    row?.amount_usd,
      amountKes:    row?.amount_kes,
      mpesaReceipt: data?.data?.mpesa_receipt_number || null,
    });
  } catch (pollErr) {
    console.error('[status] Paynecta poll failed (non-fatal):', pollErr.message);
    return res.status(200).json({ status: row?.status || 'pending' });
  }
}

// ── WITHDRAW ─────────────────────────────────────────────────────────────────
// NOTE: Paynecta's public API/SDK (as documented) covers STK Push collections,
// payment links, banks and currency rates — it does not document a B2C/payout
// endpoint. If your Paynecta account has B2C enabled, set PAYNECTA_B2C_PATH to
// the exact path your dashboard/support gives you; otherwise withdrawals are
// queued for manual processing by your team (still updates user balance safely).
async function handleWithdraw(req, res) {
  const { phone, amountUsd, userId } = req.body || {};
  if (!phone || !amountUsd || !userId) {
    return res.status(400).json({ error: 'phone, amountUsd and userId are required' });
  }

  const phoneClean = cleanPhone(phone);
  if (!isKenyanPhone(phoneClean)) return res.status(400).json({ error: 'Invalid Kenyan phone number' });

  const usd = parseFloat(amountUsd);
  if (isNaN(usd) || usd < 5) return res.status(400).json({ error: 'Minimum withdrawal is $5' });

  const sb = getSupabase();
  const { data: profile } = await sb.from('profiles').select('live_balance').eq('id', userId).single();
  if (!profile || parseFloat(profile.live_balance) < usd) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  const kesAmount = Math.floor(usd * USD_KES);

  // Debit immediately (re-credit on failure below)
  const { error: debitErr } = await sb.rpc('debit_balance', { p_user_id: userId, p_amount: usd });
  if (debitErr) throw Object.assign(new Error('Failed to debit balance: ' + debitErr.message), { status: 500 });

  const txnId = `WD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const b2cPath = process.env.PAYNECTA_B2C_PATH; // optional — only if your account has payouts enabled

  try {
    if (b2cPath) {
      // Attempt automated payout if Paynecta has enabled B2C for this account
      await paynectaRequest(b2cPath, {
        method: 'POST',
        body: JSON.stringify({ mobile_number: phoneClean, amount: kesAmount, reference: txnId }),
      });
      await sb.from('transactions').insert({
        id: txnId, user_id: userId, type: 'withdrawal', status: 'processing',
        amount_kes: kesAmount, amount_usd: usd, phone: phoneClean, created_at: new Date().toISOString(),
      });
      return res.status(200).json({
        success: true,
        message: `KES ${kesAmount.toLocaleString()} will arrive via M-Pesa within 3 hours.`,
        transactionId: txnId,
      });
    }

    // No automated payout configured — queue for manual processing by your team.
    // Balance has already been safely debited so it cannot be double-spent.
    await sb.from('transactions').insert({
      id: txnId, user_id: userId, type: 'withdrawal', status: 'processing',
      amount_kes: kesAmount, amount_usd: usd, phone: phoneClean, created_at: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: `Withdrawal of KES ${kesAmount.toLocaleString()} has been queued. Funds will be sent to ${phoneClean} within 24 hours.`,
      transactionId: txnId,
    });
  } catch (err) {
    // Re-credit on any failure so the user never loses funds
    await sb.rpc('credit_balance', { p_user_id: userId, p_amount: usd }).catch(() => {});
    throw err;
  }
}
