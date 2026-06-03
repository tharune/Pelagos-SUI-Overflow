import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, ".env") });
import { createClient } from "@supabase/supabase-js";
(async () => {
  const s = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { data } = await s.from("positions").select("wallet_address, created_at").order("created_at", { ascending: false }).limit(5);
  console.log("Recent positions (wallets that have deposited):");
  for (const r of data || []) console.log(" ", r.wallet_address, r.created_at);
  const { data: txs } = await s.from("transactions").select("wallet_address, created_at, type, tx_signature").order("created_at", { ascending: false }).limit(5);
  console.log("\nRecent transactions:");
  for (const r of txs || []) console.log(" ", r.wallet_address, r.type, r.tx_signature?.slice(0, 12)+"…", r.created_at);
})();
