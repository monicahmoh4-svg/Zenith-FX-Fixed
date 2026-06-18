// api/mpesa.js — Zenith FX M-Pesa Integration via Paynecta (https://paynecta.co.ke)
//
// Paynecta's docs site is JS-rendered, so exact raw REST paths aren't
// scrapeable from static HTML. To avoid "API endpoint not found" errors
// caused by a path mismatch, this file tries several known/likely path
// variants in order and surfaces Paynecta's REAL error message back to
// you (in the toast + Vercel logs) so you can see exactly what Paynecta
// is rejecting if all variants fail — instead of a generic dead end.
//
// REQUIRED Vercel env vars (see bottom of this file for full list):
//   PAYNECTA_API_KEY, PAYNECTA_EMAIL, PAYNECTA_LINK_CODE
//
// IMPORTANT: PAYNECTA_LINK_CODE comes from Paynecta Dashboard → Payment
// Links → Create New Link. STK push is always routed through a link code,
// confirmed by their official SDK: payments()->initialize($linkCode, $phone, $amount)

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
    if (action === 'debug')    return await handleDebug(req, res); // diagnostic helper
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
  if (!n.startsWith('254')) n = '254' + n;
  return n;
}
function isKenyanPhone(n) { return /^254[17]\d{8}$/.test(n); }

// ── PAYNECTA CONFIG ──────────────────────────────────────────────────────────────
function paynectaConfig() {
  const apiKey = process.env.PAYNECTA_API_KEY;
  const email  = process.env.PAYNECTA_EMAIL;
  const base   = (process.env.PAYNECTA_BASE_URL || 'https://paynecta.co.ke/api/v1').replace(/\/+$/, '');
  if (!apiKey) throw Object.assign(new Error('PAYNECTA_API_KEY env var missing'), { status: 500 });
  if (!email)  throw Object.assign(new Error('PAYNECTA_EMAIL env var missing'), { status: 500 });
  return { apiKey, email, base };
}

// Build the auth header set Paynecta documents: X-API-KEY + X-EMAIL.
// We ALSO send Authorization: Bearer as a fallback in case the live API
// expects bearer-token auth instead — sending both is harmless and Paynecta
// will simply ignore the header it doesn't use.
function paynectaHeaders({ apiKey, email }) {
  return {
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    'X-API-KEY':     apiKey,
    'X-EMAIL':       email,
    'Authorization': `Bearer ${apiKey}`,
  };
}

// Low-level fetch wrapper — returns { ok, status, json, raw, url }
async function tryRequest(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (networkErr) {
    return { ok: false, status: 0, json: null, raw: networkErr.message, url, networkError: true };
  }
  const raw = await response.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not JSON */ }
  return { ok: response.ok, status: response.status, json, raw, url };
}

// Does this response look like a routing 404 (wrong path) rather than a
// genuine business-logic 404/400 from Paynecta?
function looksLikeRouteNotFound(result) {
  if (result.networkError) return false;
  if (result.status !== 404) return false;
  const text = (result.raw || '').toLowerCase();
  // Typical framework "no route matched" responses
  return (
    text.includes('cannot ') && text.includes('route') ||
    text.includes('not found') && text.includes('html') ||
    text.includes('<!doctype html') ||
    text === '' ||
    (result.json === null) // non-JSON 404 body strongly suggests a webserver-level 404, not an API error
  );
}

// Try a POST against multiple candidate paths in order; stop at the first
// one that returns a JSON business response (success OR a real validation
// error) — only fall through to the next candidate on a route-level 404.
async function paynectaPostWithFallback(paths, body) {
  const cfg = paynectaConfig();
  const headers = paynectaHeaders(cfg);
  const attempts = [];

  for (const path of paths) {
    const url = `${cfg.base}${path}`;
    const result = await tryRequest(url, { method: 'POST', headers, body: JSON.stringify(body) });
    attempts.push({ path, status: result.status, raw: (result.raw || '').slice(0, 300) });

    if (result.networkError) continue; // try next candidate

    if (result.ok) {
      return { result, attempts };
    }

    if (!looksLikeRouteNotFound(result)) {
      // This is a REAL error from Paynecta (auth failure, validation error,
      // insufficient permissions, etc.) — surface it immediately instead of
      // masking it by trying more paths.
      return { result, attempts };
    }
    // else: looked like a dead route — try the next candidate path
  }

  // Every candidate path looked like a dead route
  const err = new Error(
    'Paynecta API endpoint not found at any known path. ' +
    'Verify PAYNECTA_BASE_URL and check your Paynecta dashboard for the exact API path, ' +
    'or contact hello@paynecta.co.ke. Attempted: ' + attempts.map(a => `${a.path} (${a.status})`).join(', ')
  );
  err.status = 404;
  err.attempts = attempts;
  throw err;
}

async function paynectaGetWithFallback(paths) {
  const cfg = paynectaConfig();
  const headers = paynectaHeaders(cfg);
  const attempts = [];

  for (const path of paths) {
    const url = `${cfg.base}${path}`;
    const result = await tryRequest(url, { method: 'GET', headers });
    attempts.push({ path, status: result.status, raw: (result.raw || '').slice(0, 300) });

    if (result.networkError) continue;
    if (result.ok) return { result, attempts };
    if (!looksLikeRouteNotFound(result)) return { result, attempts };
  }

  const err = new Error('Paynecta status endpoint not found at any known path. Attempted: ' + attempts.map(a => `${a.path} (${a.status})`).join(', '));
  err.status = 404;
  err.attempts = attempts;
  throw err;
}

function extractErrorMessage(json, raw, fallback) {
  if (json) {
    return json.message || json.error || json.errors?.[0]?.message || JSON.stringify(json).slice(0, 200);
  }
  if (raw && raw.length < 300) return raw;
  return fallback;
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
    return res.status(500).json({ error: 'PAYNECTA_LINK_CODE env var missing — create a Payment Link in your Paynecta dashboard first (Dashboard → Payment Links → Create New).' });
  }

  // Candidate request bodies — different field-naming conventions Paynecta's
  // API might expect (snake_case is what the SDK config implies, but we also
  // try camelCase as a safety net).
  const bodyVariants = [
    { link_code: linkCode, mobile_number: phoneClean, amount: kes },
    { linkCode,             mobileNumber: phoneClean,  amount: kes },
  ];

  // Candidate paths, most-likely-first based on official SDK base_url + REST conventions
  const pathCandidates = [
    '/payments/initialize',
    `/payment-links/${linkCode}/initialize`,
    '/stk-push',
    '/stk/push',
    '/payments/stk-push',
    '/payment/initialize',
  ];

  let lastErr = null;
  for (const body of bodyVariants) {
    try {
      const { result, attempts } = await paynectaPostWithFallback(pathCandidates, body);

      if (!result.ok) {
        const msg = extractErrorMessage(result.json, result.raw, `Paynecta returned HTTP ${result.status}`);
        console.error('[stkpush] Paynecta rejected request:', msg, '| attempts:', JSON.stringify(attempts));
        lastErr = Object.assign(new Error(msg), { status: result.status >= 400 && result.status < 500 ? 400 : 502 });
        continue; // try next body variant
      }

      // SUCCESS — extract transaction reference (try every known field name)
      const data = result.json;
      const reference =
        data?.data?.transaction_reference ||
        data?.data?.transactionReference  ||
        data?.transaction_reference       ||
        data?.transactionReference        ||
        data?.data?.reference             ||
        data?.reference;

      if (!reference) {
        console.error('[stkpush] Paynecta success response missing reference field:', JSON.stringify(data));
        lastErr = Object.assign(new Error('Paynecta accepted the request but did not return a transaction reference. Check Vercel logs for the raw response.'), { status: 502 });
        continue;
      }

      // Persist pending transaction in Supabase
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

      console.log('[stkpush] SUCCESS via path used. Reference:', reference);
      return res.status(200).json({
        success:           true,
        message:           'STK Push sent. Enter your M-Pesa PIN to complete the deposit.',
        transactionId:     reference,
        checkoutRequestId: reference,
      });

    } catch (throwErr) {
      lastErr = throwErr;
      continue; // try next body variant
    }
  }

  // All variants exhausted — surface the most informative error we collected
  throw lastErr || Object.assign(new Error('Paynecta STK push failed for an unknown reason.'), { status: 502 });
}

// ── WEBHOOK CALLBACK FROM PAYNECTA ──────────────────────────────────────────────
// Register this URL in Paynecta Dashboard → Webhooks:
//   https://YOUR-SITE.vercel.app/api/mpesa?action=callback
async function handleCallback(req, res) {
  console.log('[paynecta-callback] payload:', JSON.stringify(req.body));

  const body = req.body || {};

  const reference    = body.transactionReference || body.transaction_reference || body.reference || body.data?.transactionReference || body.data?.transaction_reference;
  const statusRaw     = (body.status || body.event || body.data?.status || '').toString().toLowerCase();
  const mpesaReceipt  = body.mpesaReceiptNumber || body.mpesa_receipt_number || body.receipt || body.data?.mpesaReceiptNumber || null;
  const amountKes     = parseFloat(body.amount || body.data?.amount || 0);

  if (!reference) {
    console.warn('[paynecta-callback] missing transaction reference — ignoring. Raw body:', JSON.stringify(body));
    return res.status(200).json({ received: true, ignored: true });
  }

  let finalStatus = 'pending';
  if (statusRaw.includes('complet') || statusRaw.includes('success')) finalStatus = 'success';
  else if (statusRaw.includes('fail') || statusRaw.includes('cancel') || statusRaw.includes('declin')) finalStatus = 'failed';

  const sb = getSupabase();

  const { data: txRow, error: updateErr } = await sb
    .from('transactions')
    .update({ status: finalStatus, mpesa_receipt: mpesaReceipt, updated_at: new Date().toISOString() })
    .eq('id', reference)
    .select()
    .maybeSingle();

  if (updateErr) console.error('[paynecta-callback] update error:', updateErr.message);

  if (finalStatus === 'success' && txRow?.user_id) {
    const usdCredit = txRow.amount_usd || parseFloat((amountKes / USD_KES).toFixed(2));

    const { error: rpcErr } = await sb.rpc('credit_balance', { p_user_id: txRow.user_id, p_amount: usdCredit });
    if (rpcErr) {
      console.error('[paynecta-callback] credit_balance RPC failed, using direct update fallback:', rpcErr.message);
      const { data: profile } = await sb.from('profiles').select('live_balance').eq('id', txRow.user_id).single();
      if (profile) {
        await sb.from('profiles').update({ live_balance: parseFloat(profile.live_balance || 0) + usdCredit }).eq('id', txRow.user_id);
      }
    }

    try {
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`;
      await fetch(`${siteUrl}/api/email?action=depositConfirmed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: txRow.user_id, amountKes: txRow.amount_kes, amountUsd: usdCredit }),
      });
    } catch (e) { console.error('[paynecta-callback] email notify failed (non-fatal):', e.message); }
  }

  return res.status(200).json({ received: true, status: finalStatus });
}

// ── STATUS POLL (frontend asks: "is my deposit done yet?") ─────────────────────
async function handleStatus(req, res) {
  const { transactionId, checkoutRequestId } = req.body || {};
  const id = transactionId || checkoutRequestId;
  if (!id) return res.status(400).json({ error: 'transactionId is required' });

  const sb = getSupabase();

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

  // Still pending — actively query Paynecta in case the webhook hasn't landed yet
  try {
    const pathCandidates = [
      `/payments/status/${encodeURIComponent(id)}`,
      `/payments/query/${encodeURIComponent(id)}`,
      `/payments/${encodeURIComponent(id)}/status`,
      `/transactions/${encodeURIComponent(id)}`,
    ];
    const { result } = await paynectaGetWithFallback(pathCandidates);

    if (!result.ok) {
      // Don't fail the poll loop hard — just report still-pending and let the frontend retry
      return res.status(200).json({ status: row?.status || 'pending' });
    }

    const data = result.json;
    const statusRaw = (data?.data?.status || data?.status || '').toString().toLowerCase();

    let finalStatus = 'pending';
    if (statusRaw.includes('complet') || statusRaw.includes('success')) finalStatus = 'success';
    else if (statusRaw.includes('fail') || statusRaw.includes('cancel') || statusRaw.includes('declin')) finalStatus = 'failed';

    if (finalStatus !== 'pending' && row) {
      const mpesaReceipt = data?.data?.mpesa_receipt_number || data?.data?.mpesaReceiptNumber || null;
      await sb.from('transactions').update({
        status: finalStatus, mpesa_receipt: mpesaReceipt, updated_at: new Date().toISOString(),
      }).eq('id', id);

      if (finalStatus === 'success' && row.user_id) {
        await sb.rpc('credit_balance', { p_user_id: row.user_id, p_amount: row.amount_usd }).catch(() => {});
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

  const { error: debitErr } = await sb.rpc('debit_balance', { p_user_id: userId, p_amount: usd });
  if (debitErr) throw Object.assign(new Error('Failed to debit balance: ' + debitErr.message), { status: 500 });

  const txnId = `WD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const b2cPath = process.env.PAYNECTA_B2C_PATH;

  try {
    if (b2cPath) {
      const { result } = await paynectaPostWithFallback([b2cPath], { mobile_number: phoneClean, amount: kesAmount, reference: txnId });
      if (!result.ok) {
        const msg = extractErrorMessage(result.json, result.raw, `Paynecta payout returned HTTP ${result.status}`);
        throw Object.assign(new Error(msg), { status: 502 });
      }
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

    // No automated payout configured — queue for manual processing.
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
    await sb.rpc('credit_balance', { p_user_id: userId, p_amount: usd }).catch(() => {});
    throw err;
  }
}

// ── DEBUG HELPER ─────────────────────────────────────────────────────────────────
// Call once manually to see exactly what Paynecta returns for each candidate path.
// Visit: https://your-site.vercel.app/api/mpesa?action=debug  (GET, no auth needed)
// REMOVE or protect this route once you've confirmed the correct path.
async function handleDebug(req, res) {
  try {
    const cfg = paynectaConfig();
    const headers = paynectaHeaders(cfg);
    const testPaths = [
      '/payments/initialize',
      '/stk-push',
      '/stk/push',
      '/payments/stk-push',
      '/payment/initialize',
      '/payment-links',
      '/banks',
    ];
    const results = [];
    for (const path of testPaths) {
      const url = `${cfg.base}${path}`;
      const r = await tryRequest(url, { method: 'GET', headers });
      results.push({ path, url, status: r.status, bodyPreview: (r.raw || '').slice(0, 200) });
    }
    return res.status(200).json({ base: cfg.base, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
