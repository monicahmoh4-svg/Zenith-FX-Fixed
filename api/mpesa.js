// api/mpesa.js — Lipana.dev STK Push integration
// Vercel Serverless Function

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.query;

  try {
    if (action === 'stkpush') {
      return await handleSTKPush(req, res);
    } else if (action === 'withdraw') {
      return await handleWithdraw(req, res);
    } else if (action === 'status') {
      return await handleStatus(req, res);
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('M-Pesa API error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}

async function handleSTKPush(req, res) {
  const { phone, amount, accountRef, userId } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({ error: 'Phone and amount are required' });
  }

  // Clean phone number — ensure format 254XXXXXXXXX
  const cleanPhone = phone.replace(/\D/g, '').replace(/^0/, '254').replace(/^\+/, '');

  if (!/^254[17]\d{8}$/.test(cleanPhone)) {
    return res.status(400).json({ error: 'Invalid Kenyan phone number' });
  }

  const amountNum = parseInt(amount);
  if (isNaN(amountNum) || amountNum < 100) {
    return res.status(400).json({ error: 'Minimum deposit is KES 100' });
  }

  // Lipana.dev API call
  // Docs: https://lipana.dev/docs
  // You must set LIPANA_API_KEY in your Vercel environment variables
  const LIPANA_API_KEY = process.env.LIPANA_API_KEY;
  const LIPANA_BASE_URL = process.env.LIPANA_BASE_URL || 'https://api.lipana.dev';

  if (!LIPANA_API_KEY) {
    // Development fallback — simulate success
    console.warn('LIPANA_API_KEY not set — returning simulated response');
    return res.status(200).json({
      success: true,
      message: 'STK Push sent (simulated)',
      checkoutRequestId: 'ws_CO_' + Date.now(),
      merchantRequestId: 'MR_' + Date.now(),
      phone: cleanPhone,
      amount: amountNum,
      simulated: true,
    });
  }

  const response = await fetch(`${LIPANA_BASE_URL}/v1/stkpush`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LIPANA_API_KEY}`,
    },
    body: JSON.stringify({
      phone: cleanPhone,
      amount: amountNum,
      account_reference: accountRef || 'ZenithFX-Deposit',
      transaction_desc: `ZenithFX Deposit - ${userId || 'User'}`,
      callback_url: `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : process.env.SITE_URL}/api/mpesa?action=callback`,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return res.status(response.status).json({
      error: data.message || 'STK Push failed',
      details: data,
    });
  }

  return res.status(200).json({
    success: true,
    message: 'STK Push sent. Enter your M-Pesa PIN to complete.',
    checkoutRequestId: data.checkout_request_id || data.CheckoutRequestID,
    merchantRequestId: data.merchant_request_id || data.MerchantRequestID,
    phone: cleanPhone,
    amount: amountNum,
  });
}

async function handleWithdraw(req, res) {
  const { phone, amount, userId } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({ error: 'Phone and amount are required' });
  }

  const cleanPhone = phone.replace(/\D/g, '').replace(/^0/, '254').replace(/^\+/, '');
  const amountNum = parseFloat(amount);

  if (isNaN(amountNum) || amountNum < 5) {
    return res.status(400).json({ error: 'Minimum withdrawal is $5' });
  }

  const LIPANA_API_KEY = process.env.LIPANA_API_KEY;
  const LIPANA_BASE_URL = process.env.LIPANA_BASE_URL || 'https://api.lipana.dev';

  if (!LIPANA_API_KEY) {
    return res.status(200).json({
      success: true,
      message: 'Withdrawal queued (simulated)',
      transactionId: 'WD_' + Date.now(),
      simulated: true,
    });
  }

  // Convert USD to KES (approximate)
  const KES_RATE = parseFloat(process.env.USD_KES_RATE || '130');
  const kesAmount = Math.round(amountNum * KES_RATE);

  const response = await fetch(`${LIPANA_BASE_URL}/v1/b2c`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LIPANA_API_KEY}`,
    },
    body: JSON.stringify({
      phone: cleanPhone,
      amount: kesAmount,
      remarks: `ZenithFX Withdrawal`,
      occasion: userId || 'withdrawal',
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return res.status(response.status).json({ error: data.message || 'Withdrawal failed' });
  }

  return res.status(200).json({
    success: true,
    message: `KES ${kesAmount} will be sent to your M-Pesa within 3 hours.`,
    transactionId: data.transaction_id || data.ConversationID,
  });
}

async function handleStatus(req, res) {
  const { checkoutRequestId } = req.body;

  if (!checkoutRequestId) {
    return res.status(400).json({ error: 'checkoutRequestId is required' });
  }

  const LIPANA_API_KEY = process.env.LIPANA_API_KEY;
  const LIPANA_BASE_URL = process.env.LIPANA_BASE_URL || 'https://api.lipana.dev';

  if (!LIPANA_API_KEY) {
    return res.status(200).json({ success: true, status: 'completed', simulated: true });
  }

  const response = await fetch(`${LIPANA_BASE_URL}/v1/stkpush/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LIPANA_API_KEY}`,
    },
    body: JSON.stringify({ checkout_request_id: checkoutRequestId }),
  });

  const data = await response.json();
  return res.status(200).json(data);
}
