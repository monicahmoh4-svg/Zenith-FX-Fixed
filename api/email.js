// api/email.js — Transactional email sender
// Actions: depositConfirmed | withdrawalProcessed | kycApproved | kycRejected | tradeAlert | resetPassword
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;

  try {
    const body = req.body || {};

    // Resolve user email
    let email = body.email;
    if (!email && body.userId) {
      const { data } = await supabase.from('profiles').select('email, first_name').eq('id', body.userId).single();
      if (data) { email = data.email; body.firstName = data.first_name; }
    }
    if (!email) return res.status(400).json({ error: 'email or userId required' });

    const templates = {
      depositConfirmed:     depositConfirmedHtml,
      withdrawalProcessed:  withdrawalHtml,
      kycApproved:          kycApprovedHtml,
      kycRejected:          kycRejectedHtml,
    };

    const subjects = {
      depositConfirmed:    '✅ Deposit Confirmed — Zenith FX',
      withdrawalProcessed: '💸 Withdrawal Processed — Zenith FX',
      kycApproved:         '✅ KYC Approved — Zenith FX',
      kycRejected:         '⚠️ KYC Needs Attention — Zenith FX',
    };

    if (!templates[action]) return res.status(400).json({ error: 'Unknown email action' });

    await sendMail({
      to: email,
      subject: subjects[action],
      html: templates[action](body),
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[email]', err);
    return res.status(500).json({ error: err.message });
  }
}

async function sendMail({ to, subject, html }) {
  const nodemailer = (await import('nodemailer')).default;
  const t = nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return t.sendMail({ from: process.env.SMTP_FROM || 'Zenith FX <noreply@zenithfx.io>', to, subject, html });
}

const wrap = (content) => `
<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;background:#0d1117;color:#e6edf3;border-radius:12px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#1f9cf0,#22d3ee);padding:1.5rem 2rem;display:flex;align-items:center;gap:10px">
    <div style="font-size:1.5rem;font-weight:900;color:#fff">Zenith FX</div>
  </div>
  <div style="padding:2rem">${content}</div>
  <div style="padding:1rem 2rem 1.5rem;text-align:center;color:#6e7681;font-size:.75rem;border-top:1px solid #21262d">
    Zenith FX Limited · support@zenithfx.io<br>
    ⚠️ Trading involves substantial risk. Never invest money you cannot afford to lose.
  </div>
</div>`;

function depositConfirmedHtml({ firstName, amountKes, amountUsd }) {
  return wrap(`
    <h2 style="margin:0 0 1rem">Deposit Confirmed ✅</h2>
    <p style="color:#8b949e;line-height:1.7">Hi ${firstName || 'Trader'},</p>
    <p style="color:#8b949e;line-height:1.7">Your deposit has been received and credited to your live trading account.</p>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin:1.5rem 0">
      <div style="display:flex;justify-content:space-between;margin-bottom:.5rem">
        <span style="color:#8b949e">Amount (KES)</span>
        <strong style="color:#3fb950">KES ${Number(amountKes).toLocaleString()}</strong>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span style="color:#8b949e">Credited (USD)</span>
        <strong style="color:#38bdf8">$${Number(amountUsd).toFixed(2)}</strong>
      </div>
    </div>
    <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://zenithfx.vercel.app'}" style="display:inline-block;background:linear-gradient(135deg,#1f9cf0,#38bdf8);color:#fff;font-weight:700;padding:.75rem 1.8rem;border-radius:8px;text-decoration:none">Start Trading →</a>
  `);
}

function withdrawalHtml({ firstName, amountKes, amountUsd, phone }) {
  return wrap(`
    <h2 style="margin:0 0 1rem">Withdrawal Processed 💸</h2>
    <p style="color:#8b949e;line-height:1.7">Hi ${firstName || 'Trader'},</p>
    <p style="color:#8b949e;line-height:1.7">Your withdrawal is being processed and will arrive on your M-Pesa within 3 hours.</p>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin:1.5rem 0">
      <div style="display:flex;justify-content:space-between;margin-bottom:.5rem">
        <span style="color:#8b949e">Amount</span>
        <strong style="color:#f85149">-$${Number(amountUsd).toFixed(2)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:.5rem">
        <span style="color:#8b949e">KES Amount</span>
        <strong style="color:#e6edf3">KES ${Number(amountKes).toLocaleString()}</strong>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span style="color:#8b949e">M-Pesa Number</span>
        <strong style="color:#e6edf3">+${phone}</strong>
      </div>
    </div>
  `);
}

function kycApprovedHtml({ firstName }) {
  return wrap(`
    <h2 style="margin:0 0 1rem">KYC Approved ✅</h2>
    <p style="color:#8b949e;line-height:1.7">Hi ${firstName || 'Trader'},</p>
    <p style="color:#8b949e;line-height:1.7">Your identity has been verified. You now have full access to all Zenith FX features including unlimited withdrawals.</p>
    <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://zenithfx.vercel.app'}" style="display:inline-block;margin-top:1rem;background:linear-gradient(135deg,#1f9cf0,#38bdf8);color:#fff;font-weight:700;padding:.75rem 1.8rem;border-radius:8px;text-decoration:none">Go to Dashboard →</a>
  `);
}

function kycRejectedHtml({ firstName, reason }) {
  return wrap(`
    <h2 style="margin:0 0 1rem">KYC Needs Attention ⚠️</h2>
    <p style="color:#8b949e;line-height:1.7">Hi ${firstName || 'Trader'},</p>
    <p style="color:#8b949e;line-height:1.7">We were unable to verify your identity. Reason: <strong style="color:#f85149">${reason || 'Document unclear or expired'}</strong></p>
    <p style="color:#8b949e;line-height:1.7">Please re-upload a clear, valid document in your dashboard.</p>
    <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://zenithfx.vercel.app'}" style="display:inline-block;margin-top:1rem;background:linear-gradient(135deg,#1f9cf0,#38bdf8);color:#fff;font-weight:700;padding:.75rem 1.8rem;border-radius:8px;text-decoration:none">Update KYC →</a>
  `);
}
