import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

export const configReady = Boolean(url && publishableKey && !url.includes('YOUR-PROJECT-REF') && !publishableKey.includes('replace_with_your_key'));
export const supabase = configReady ? createClient(url, publishableKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
}) : null;
