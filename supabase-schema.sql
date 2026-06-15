-- ═══════════════════════════════════════════════════════════
-- ZENITH FX — Supabase Database Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── PROFILES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  first_name      TEXT,
  last_name       TEXT,
  phone           TEXT,
  country         TEXT DEFAULT 'KE',
  avatar_url      TEXT,
  demo_balance    NUMERIC(14,2) DEFAULT 10000.00,
  live_balance    NUMERIC(14,2) DEFAULT 0.00,
  kyc_status      TEXT DEFAULT 'unverified' CHECK (kyc_status IN ('unverified','pending','verified','rejected')),
  referral_code   TEXT UNIQUE,
  referred_by     TEXT,
  petapips        INTEGER DEFAULT 0,
  tier            TEXT DEFAULT 'bronze' CHECK (tier IN ('bronze','silver','gold','platinum')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── TRANSACTIONS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.transactions (
  id                  TEXT PRIMARY KEY,
  user_id             UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  type                TEXT NOT NULL CHECK (type IN ('deposit','withdrawal')),
  status              TEXT DEFAULT 'pending' CHECK (status IN ('pending','success','failed','processing')),
  amount_kes          NUMERIC(14,2),
  amount_usd          NUMERIC(14,2),
  phone               TEXT,
  checkout_request_id TEXT,
  mpesa_receipt       TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── TRADES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trades (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  asset           TEXT NOT NULL,
  contract_type   TEXT NOT NULL,
  direction       TEXT NOT NULL,
  stake           NUMERIC(14,2) NOT NULL,
  multiplier      NUMERIC(8,4) DEFAULT 1.92,
  duration        INTEGER NOT NULL,
  duration_unit   TEXT DEFAULT 'ticks',
  is_demo         BOOLEAN DEFAULT TRUE,
  status          TEXT DEFAULT 'open' CHECK (status IN ('open','won','lost','cancelled')),
  entry_price     NUMERIC(20,5),
  exit_price      NUMERIC(20,5),
  payout          NUMERIC(14,2) DEFAULT 0,
  profit          NUMERIC(14,2) DEFAULT 0,
  placed_at       TIMESTAMPTZ DEFAULT NOW(),
  settled_at      TIMESTAMPTZ
);

-- ── KYC SUBMISSIONS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kyc_submissions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  doc_type          TEXT NOT NULL,
  doc_number        TEXT,
  front_path        TEXT,
  back_path         TEXT,
  selfie_path       TEXT,
  status            TEXT DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  rejection_reason  TEXT,
  submitted_at      TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at       TIMESTAMPTZ
);

-- ── AFFILIATE ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.affiliates (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  referred_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  commission_pct  NUMERIC(5,2) DEFAULT 40.00,
  total_earned    NUMERIC(14,2) DEFAULT 0.00,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referred_id)
);

-- ── COPY TRADES ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.copy_trades (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  copier_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider_name   TEXT NOT NULL,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════
-- DATABASE FUNCTIONS (called by API)
-- ═══════════════════════════════════════════════════════════

-- Credit live balance
CREATE OR REPLACE FUNCTION public.credit_balance(p_user_id UUID, p_amount NUMERIC)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.profiles
  SET live_balance = live_balance + p_amount,
      updated_at   = NOW()
  WHERE id = p_user_id;
END;
$$;

-- Debit live balance
CREATE OR REPLACE FUNCTION public.debit_balance(p_user_id UUID, p_amount NUMERIC)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.profiles
  SET live_balance = GREATEST(0, live_balance - p_amount),
      updated_at   = NOW()
  WHERE id = p_user_id;
END;
$$;

-- Credit a named balance field (demo or live)
CREATE OR REPLACE FUNCTION public.credit_balance_field(p_user_id UUID, p_field TEXT, p_amount NUMERIC)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_field = 'demo_balance' THEN
    UPDATE public.profiles SET demo_balance = demo_balance + p_amount, updated_at = NOW() WHERE id = p_user_id;
  ELSE
    UPDATE public.profiles SET live_balance = live_balance + p_amount, updated_at = NOW() WHERE id = p_user_id;
  END IF;
END;
$$;

-- Add PetaPips and update tier
CREATE OR REPLACE FUNCTION public.add_petapips(p_user_id UUID, p_amount INTEGER)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  new_pp INTEGER;
BEGIN
  UPDATE public.profiles
  SET petapips   = petapips + p_amount,
      updated_at = NOW()
  WHERE id = p_user_id
  RETURNING petapips INTO new_pp;

  -- Update tier
  UPDATE public.profiles SET tier =
    CASE
      WHEN new_pp >= 20000 THEN 'platinum'
      WHEN new_pp >= 5000  THEN 'gold'
      WHEN new_pp >= 1000  THEN 'silver'
      ELSE 'bronze'
    END
  WHERE id = p_user_id;
END;
$$;

-- Auto-create profile on signup (trigger)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, first_name, last_name, phone, country, referral_code)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'firstName', NEW.raw_user_meta_data->>'given_name', split_part(NEW.email,'@',1)),
    COALESCE(NEW.raw_user_meta_data->>'lastName',  NEW.raw_user_meta_data->>'family_name', ''),
    NEW.raw_user_meta_data->>'phone',
    COALESCE(NEW.raw_user_meta_data->>'country', 'KE'),
    UPPER(SUBSTRING(MD5(NEW.id::TEXT) FROM 1 FOR 8))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ═══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════
ALTER TABLE public.profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kyc_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.copy_trades    ENABLE ROW LEVEL SECURITY;

-- Profiles: users can only read/update their own row
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Transactions: users see only their own
CREATE POLICY "txn_select_own" ON public.transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "txn_service_all" ON public.transactions FOR ALL USING (TRUE); -- service role only

-- Trades: users see only their own
CREATE POLICY "trades_select_own" ON public.trades FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "trades_insert_own" ON public.trades FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "trades_update_own" ON public.trades FOR UPDATE USING (auth.uid() = user_id);

-- KYC: users see only their own
CREATE POLICY "kyc_select_own" ON public.kyc_submissions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "kyc_insert_own" ON public.kyc_submissions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "kyc_update_own" ON public.kyc_submissions FOR UPDATE USING (auth.uid() = user_id);

-- Affiliates
CREATE POLICY "aff_select_own" ON public.affiliates FOR SELECT USING (auth.uid() = referrer_id);
CREATE POLICY "copy_select_own" ON public.copy_trades FOR SELECT USING (auth.uid() = copier_id);
CREATE POLICY "copy_insert_own" ON public.copy_trades FOR INSERT WITH CHECK (auth.uid() = copier_id);

-- ═══════════════════════════════════════════════════════════
-- STORAGE BUCKETS
-- Run these separately in Supabase Storage section OR via SQL:
-- ═══════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public)
VALUES ('kyc-documents', 'kyc-documents', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "kyc_upload_own" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'kyc-documents' AND
  auth.uid()::TEXT = (storage.foldername(name))[1]
);

CREATE POLICY "kyc_read_own" ON storage.objects
FOR SELECT USING (
  bucket_id = 'kyc-documents' AND
  auth.uid()::TEXT = (storage.foldername(name))[1]
);

-- Service role can read all KYC docs (for admin review)
CREATE POLICY "kyc_service_read" ON storage.objects
FOR SELECT USING (bucket_id = 'kyc-documents');
