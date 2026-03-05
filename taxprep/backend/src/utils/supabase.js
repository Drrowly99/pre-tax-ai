// src/utils/supabase.js
// Single shared Supabase client using the service role key.
// The service role key bypasses Row Level Security — this is intentional
// because all auth + authorization is handled at the application layer.
// NEVER expose this client or its key to the browser.

import { createClient } from '@supabase/supabase-js';
import logger from './logger.js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  logger.error('Missing Supabase environment variables', {
    hasUrl: !!SUPABASE_URL,
    hasKey: !!SUPABASE_SERVICE_KEY,
  });
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    // Service role client — disable session persistence
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

export default supabase;