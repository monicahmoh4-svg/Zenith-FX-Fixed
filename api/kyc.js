// api/kyc.js — KYC document management
// Actions: upload-url | submit | status | admin-review
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
    if (action === 'upload-url')    return await handleUploadUrl(req, res);
    if (action === 'submit')        return await handleSubmit(req, res);
    if (action === 'status')        return await handleStatus(req, res);
    if (action === 'admin-review')  return await handleAdminReview(req, res);
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[kyc]', err);
    return res.status(500).json({ error: err.message });
  }
}

// Returns a signed upload URL so the browser uploads directly to Supabase Storage
async function handleUploadUrl(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { fileName, fileType } = req.body || {};
  if (!fileName || !fileType) return res.status(400).json({ error: 'fileName and fileType required' });

  const ext     = fileName.split('.').pop();
  const path    = `kyc/${user.id}/${Date.now()}.${ext}`;

  const { data, error } = await supabase.storage
    .from('kyc-documents')
    .createSignedUploadUrl(path);

  if (error) throw error;

  return res.status(200).json({ uploadUrl: data.signedUrl, path });
}

// After upload, save KYC submission record
async function handleSubmit(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { docType, docNumber, frontPath, backPath } = req.body || {};
  if (!docType || !docNumber || !frontPath)
    return res.status(400).json({ error: 'docType, docNumber and frontPath required' });

  // Upsert KYC record
  await supabase.from('kyc_submissions').upsert({
    user_id:    user.id,
    doc_type:   docType,
    doc_number: docNumber,
    front_path: frontPath,
    back_path:  backPath || null,
    status:     'pending',
    submitted_at: new Date().toISOString(),
  });

  // Update profile KYC status
  await supabase.from('profiles').update({ kyc_status: 'pending' }).eq('id', user.id);

  // Notify admin
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || 'https://' + req.headers.host}/api/email?action=kycPending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, userId: user.id, docType }),
    }).catch(() => {});
  }

  return res.status(200).json({ success: true, message: 'KYC submitted. Review takes up to 24 hours.' });
}

// Get current user KYC status
async function handleStatus(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const { data } = await supabase
    .from('kyc_submissions')
    .select('status, doc_type, submitted_at, reviewed_at, rejection_reason')
    .eq('user_id', user.id)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .single();

  return res.status(200).json({ kyc: data || null });
}

// Admin: approve or reject KYC
async function handleAdminReview(req, res) {
  // Simple admin check — in prod use Supabase RLS or a proper admin role
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.SUPABASE_SERVICE_ROLE_KEY)
    return res.status(403).json({ error: 'Forbidden' });

  const { userId, decision, reason } = req.body || {};
  if (!userId || !decision) return res.status(400).json({ error: 'userId and decision required' });

  const kycStatus = decision === 'approve' ? 'verified' : 'rejected';
  await supabase.from('profiles').update({ kyc_status: kycStatus }).eq('id', userId);
  await supabase.from('kyc_submissions')
    .update({ status: kycStatus, reviewed_at: new Date().toISOString(), rejection_reason: reason || null })
    .eq('user_id', userId);

  // Email the user
  const emailAction = decision === 'approve' ? 'kycApproved' : 'kycRejected';
  await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || 'https://' + req.headers.host}/api/email?action=${emailAction}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, reason }),
  }).catch(() => {});

  return res.status(200).json({ success: true });
}
