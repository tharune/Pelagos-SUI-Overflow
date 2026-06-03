import dotenv from 'dotenv';
import { AppConfig } from '../types';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

// Detect placeholder credentials so we can short-circuit DB calls (7s timeout otherwise).
function isPlaceholder(url: string, key: string): boolean {
  if (!url || !key) return true;
  if (url.includes('placeholder') || url.includes('your_supabase')) return true;
  if (key.startsWith('placeholder') || key.startsWith('your_supabase')) return true;
  return false;
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '13101', 10),
  supabaseUrl,
  supabaseAnonKey,
  supabaseConfigured: !isPlaceholder(supabaseUrl, supabaseAnonKey),
  polymarketApiUrl: process.env.POLYMARKET_API_URL || 'https://clob.polymarket.com',
  structuringFee: 0.005, // 0.5%
};

if (!config.supabaseConfigured) {
  console.warn(
    '[config] Supabase credentials are missing or placeholder  -  DB queries will short-circuit and return empty. Set SUPABASE_URL + SUPABASE_ANON_KEY in backend/.env to enable full functionality.',
  );
}
