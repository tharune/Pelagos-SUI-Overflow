import { config } from '../config';
import { supabase } from '../db/supabase';
import { fetchMarkets } from '../services/polymarket';
import * as fs from 'fs';
import * as path from 'path';

function log(msg: string) {
  console.log(`[setup] ${msg}`);
}

function pass(label: string) {
  console.log(`[setup] OK  ${label}`);
}

function fail(label: string, detail?: string) {
  console.error(`[setup] FAIL  ${label}${detail ? ': ' + detail : ''}`);
}

async function checkSupabase(): Promise<boolean> {
  log('Testing Supabase connection...');

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    fail('Supabase', 'SUPABASE_URL or SUPABASE_ANON_KEY not set in .env');
    return false;
  }

  try {
    const { data, error } = await supabase
      .from('bundles')
      .select('id')
      .limit(1);

    if (error) {
      // Check if it's a "table doesn't exist" error
      if (error.message.includes('does not exist') || error.code === '42P01') {
        fail('Supabase tables', 'Tables not created yet');
        log('');
        log('Tables not found. Paste this SQL into the Supabase SQL Editor:');
        log('─'.repeat(60));
        const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf-8');
        console.log(schema);
        log('─'.repeat(60));
        log('Go to: https://supabase.com/dashboard -> SQL Editor -> New Query');
        return false;
      }
      fail('Supabase', error.message);
      return false;
    }

    pass(`Supabase connected (${config.supabaseUrl})`);
    if (data && data.length > 0) {
      log(`  Found ${data.length} existing bundle(s)`);
    } else {
      log('  Tables exist, no bundles yet (run npm run seed)');
    }
    return true;
  } catch (err) {
    fail('Supabase', String(err));
    return false;
  }
}

async function checkPolymarket(): Promise<boolean> {
  log('Testing Polymarket API...');

  try {
    const markets = await fetchMarkets({ limit: 1, active: true });
    if (markets.length > 0) {
      pass(`Polymarket API (fetched: "${markets[0].question.slice(0, 50)}...")`);
      return true;
    } else {
      fail('Polymarket API', 'No markets returned');
      return false;
    }
  } catch (err) {
    fail('Polymarket API', String(err));
    return false;
  }
}

async function main() {
  log('Pelagos Backend Setup Check');
  log('─'.repeat(40));

  const results = {
    supabase: await checkSupabase(),
    polymarket: await checkPolymarket(),
  };

  log('');
  log('─'.repeat(40));

  const allGood = Object.values(results).every(Boolean);
  if (allGood) {
    log('All checks passed. Run `npm run seed` to populate demo data.');
  } else {
    log('Some checks failed. Fix the issues above and re-run `npm run setup`.');
  }

  process.exit(allGood ? 0 : 1);
}

main().catch((err) => {
  console.error('[setup] Fatal error:', err);
  process.exit(1);
});
