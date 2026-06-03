/**
 * Pelagos NLP module.
 *
 * Deterministic TypeScript NLP primitives used by the market filter and the
 * correlation engine. No external ML dependencies, no Python sidecar. Every
 * function is pure, stateless, unit-testable.
 *
 * What's here:
 *   - Tokeniser + stemmer-lite normaliser
 *   - Keyword lexicons for seven market categories
 *   - Category classifier (softmax over lexicon overlaps)
 *   - Quality heuristics (spam/troll/ambiguity detection)
 *   - TF-IDF corpus builder and cosine similarity for semantic dedupe
 *
 * Design contract: the classifier prefers "other" on genuinely ambiguous
 * inputs rather than forcing a label. Over-rejecting noise is safer than
 * mis-categorising a real market.
 */

// ---------- Tokenisation ----------

const STOPWORDS = new Set([
  'a','an','the','of','and','or','in','on','at','to','for','by','from','with','is','are','be','will','would','could','should','has','have','had','do','does','did','its','vs','before','after','this','that','these','those','than','into','out','over','under','up','down','new','any','all','some','not','no','it','as','if','then','when','where','who','what','how','was','were','been','being','but','so','such','more','most','less','just','very','also',
]);

/**
 * Normalise raw text into lower-case tokens of length >=3, dropping
 * punctuation, stop-words, and very-short fragments. A tiny heuristic
 * stemmer folds common English suffixes so "games" and "game" land on the
 * same token.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem);
}

function stem(word: string): string {
  // Very small suffix stripper. Good enough for market-question tokens and
  // avoids the expense of a full Porter stemmer.
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  // The English -es plural only strips to -es when the root ends in s/x/z/h
  // ("boxes" → "box", "bushes" → "bush"). Otherwise the -es is really just
  // a plural -s ("games" → "game", not "gam").
  if (/[sxzh]es$/.test(word) && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// ---------- Category lexicons ----------

export type Category =
  | 'crypto'
  | 'sports'
  | 'politics'
  | 'economics'
  | 'entertainment'
  | 'tech'
  | 'world'
  | 'other';

/**
 * Curated keyword lexicons per category. These are intentionally broad
 * (names + instruments + arenas) so the classifier can pick up markets
 * without having to learn embeddings. Stemmer-normalised.
 */
const LEXICONS: Record<Exclude<Category, 'other'>, string[]> = {
  crypto: [
    'bitcoin','btc','ethereum','eth','xrp','doge','ada','cardano','polygon','matic','avax','link','chainlink','bnb','binance','coinbase','kraken','crypto','blockchain','defi','nft','stablecoin','usdc','usdt','tether','vitalik','satoshi','halving','airdrop','meme','memecoin','token','wallet','onchain','mainnet','devnet','smartcontract','dex','cex','lightning','layer2','rollup','zk','zkroll','optimism','arbitrum','base','uniswap','aave','compound','staking','validator','mining','miner','hash','gas','gwei','wei',
  ],
  sports: [
    'nfl','nba','mlb','nhl','mls','fifa','uefa','eurovision','olympic','olympics','worldcup','super','bowl','superbowl','playoff','final','finals','champion','championship','league','team','coach','quarterback','pitcher','hitter','striker','goalkeeper','defender','midfielder','linebacker','goalie','yankees','dodgers','lakers','warriors','celtics','patriots','chiefs','eagles','cowboys','brady','lebron','messi','ronaldo','djokovic','serena','nadal','federer','tiger','woods','mcilroy','masters','grandslam','wimbledon','oscars','goldengloves','goldenglove','kentucky','derby','pga','atp','wta','nfc','afc','nba','nl','al','ncaa','ncaab','ncaaf','boxer','ufc','mma','tyson','golovkin','match','game','race','lap','goal','tackle','shot','score','win','lose','defeat','beat',
  ],
  politics: [
    'trump','biden','harris','obama','clinton','desantis','pence','vance','kamala','congress','senate','house','democrat','democrats','republican','republicans','gop','dnc','rnc','elect','election','primary','caucus','vote','ballot','poll','polls','polling','campaign','candidate','incumbent','president','presidential','governor','senator','representative','mayor','cabinet','scotus','supreme','justice','impeach','impeachment','pardon','federal','state','congressional','filibuster','midterm','convention','nominee','nomination','inauguration','oval','office','whitehouse','capitol','pentagon','gov','government','parliament','prime','minister','brexit','uk','labour','tory','tories','putin','zelensky','netanyahu','xi','jinping','modi','macron','merkel','scholz','erdogan','orban','meloni','macron','farage','liberals','conservatives','independent','progressive','socialist','communist','fascist',
  ],
  economics: [
    'fed','federal','reserve','fomc','rate','rates','hike','cut','hawk','dove','inflation','cpi','ppi','unemployment','jobs','nfp','nonfarm','payrolls','recession','gdp','growth','yield','treasury','bonds','tips','tbills','twoyear','tenyear','thirtyyear','powell','yellen','draghi','lagarde','ecb','boe','boj','pboc','yen','euro','pound','sterling','dollar','dxy','index','snp','spx','ndx','nasdaq','dow','djia','russell','ftse','dax','nikkei','hangseng','shanghai','commodity','commodities','oil','wti','brent','gas','natgas','gold','silver','copper','wheat','corn','soy','soybean','opec','trade','tariff','tariffs','sanction','sanctions','deficit','surplus','debt','ceiling','shutdown','budget','treasury','import','export','ppi','pmi','ism','retail','consumer','confidence','sentiment',
  ],
  entertainment: [
    'oscar','oscars','emmy','emmys','grammy','grammys','goldenglobe','goldenglobes','bafta','cannes','sundance','netflix','hbo','disney','hulu','paramount','showtime','amc','movie','film','season','finale','premiere','episode','series','show','celeb','celebrity','singer','rapper','actor','actress','director','producer','album','single','tour','concert','billboard','streaming','spotify','apple','music','eurovision','kardashian','jenner','swift','taylor','beyonce','drake','kanye','west','carti','playboi','eminem','rihanna','gaga','ladygaga','madonna','adele','weeknd','bieber','styles','harry','zayn','cardi','nicki','megan','stallion','ari','arianagrande','grande','charli','xcx','kendrick','lamar','future','travis','scott','quavo','migos','eilish','billieeilish','olivia','rodrigo','doja','cat','sza','snl','lorne','michaels','jimmy','fallon','kimmel','colbert','letterman','leno','conan','oprah','dr','phil','ellen','john','oliver','stephen','trevor','noah','larry','david','seinfeld','sopranos','succession','breakingbad','got','gameofthrones','starwars','mandalorian','marvel','dc','batman','spiderman','joker','disney',
  ],
  tech: [
    'openai','anthropic','google','alphabet','apple','meta','facebook','instagram','tiktok','snap','twitter','amazon','microsoft','nvidia','amd','intel','tesla','spacex','starship','falcon','boeing','airbus','uber','lyft','doordash','gpt','gpt4','gpt5','gpt6','claude','gemini','llama','mistral','ai','llm','agi','asi','chatgpt','copilot','devin','perplexity','midjourney','dalle','sora','runway','pika','altman','musk','zuckerberg','pichai','cook','nadella','huang','jensen','bezos','dorsey','brin','page','paulgraham','andreessen','thiel','balaji','naval','chipwar','semi','semiconductor','tsmc','samsung','sk','hynix','snowflake','databricks','hugging','face','huggingface','github','copilot','stripe','plaid','palantir','snowflake','mongo','postgres','supabase','firebase','vercel','netlify','cloudflare','aws','azure','gcp','kubernetes','docker','rust','typescript','python','javascript','golang',
  ],
  world: [
    'russia','ukraine','china','taiwan','korea','israel','palestine','gaza','hamas','hezbollah','iran','saudi','arabia','uae','india','pakistan','afghanistan','japan','australia','brazil','mexico','canada','france','germany','italy','spain','uk','britain','nato','eu','un','who','imf','worldbank','g7','g20','unesco','unsc','icc','icbm','nuclear','atomic','war','peace','treaty','summit','alliance','embassy','consul','visa','passport','border','refugee','migrant','climate','cop28','cop29','cop30','carbon','emissions','greenhouse','co2','methane','ipcc','paris','kyoto','wildfire','flood','hurricane','typhoon','earthquake','tsunami','eruption','volcano','pandemic','covid','sarscov2','coronavirus','mpox','monkeypox','ebola','bird','flu','avian','h5n1','h5n8',
  ],
};

const LEXICON_SETS: Record<Exclude<Category, 'other'>, Set<string>> =
  Object.fromEntries(
    Object.entries(LEXICONS).map(([k, v]) => [k, new Set(v.map(stem))]),
  ) as Record<Exclude<Category, 'other'>, Set<string>>;

// ---------- Category classifier ----------

export interface CategoryScore {
  category: Category;
  confidence: number; // [0, 1], softmax over lexicon overlaps
  runner_up?: Category;
  scores: Record<Category, number>;
}

/**
 * Assign a category to a market question via lexicon overlap.
 *
 * For each category C, count how many question tokens are in C's lexicon set.
 * Softmax over counts produces a probability distribution; the argmax is the
 * chosen category. If the top category's raw count is <= 1 or the gap to the
 * runner-up is too small, falls back to "other".
 */
export function classifyCategory(text: string): CategoryScore {
  const toks = tokenize(text);
  const scores: Record<Category, number> = {
    crypto: 0, sports: 0, politics: 0, economics: 0,
    entertainment: 0, tech: 0, world: 0, other: 0,
  };

  for (const t of toks) {
    for (const [cat, set] of Object.entries(LEXICON_SETS)) {
      if (set.has(t)) scores[cat as Category] += 1;
    }
  }

  // Softmax (with temperature 1) over the seven named categories
  const named = (Object.keys(LEXICONS) as Array<Exclude<Category, 'other'>>);
  const exps = named.map((c) => Math.exp(scores[c]));
  const z = exps.reduce((s, v) => s + v, 0);
  const probs: Record<Category, number> = { ...scores };
  named.forEach((c, i) => (probs[c] = exps[i] / z));
  probs.other = 0;

  // Rank
  const ranked = named
    .map((c) => ({ c, prob: probs[c], raw: scores[c] }))
    .sort((a, b) => b.prob - a.prob);
  const top = ranked[0];
  const runner = ranked[1];

  // Fallback to "other" when we have no confident signal: either zero lexicon
  // matches across every category, or the runner-up is within 0.1 softmax mass.
  // A single strong keyword (e.g. "bitcoin", "trump", "messi") is enough signal
  // to classify confidently since the seven lexicons are designed to be
  // mutually exclusive on named entities.
  if (top.raw === 0 || top.prob - runner.prob < 0.1) {
    return { category: 'other', confidence: 1 - top.prob, scores: probs };
  }
  return {
    category: top.c,
    confidence: top.prob,
    runner_up: runner.c,
    scores: probs,
  };
}

// ---------- Quality heuristics ----------

export interface QualityAssessment {
  passed: boolean;
  reasons: string[]; // empty when passed
  signals: {
    length: number;
    question_mark_count: number;
    has_binary_trigger: boolean;
    has_date_anchor: boolean;
    is_superlative_only: boolean;
    troll_hits: number;
  };
}

const BINARY_TRIGGERS = /\b(will|does|is|has|can|could|shall|should|did|was|were|have|had|are|be)\b/i;
const DATE_ANCHOR = /\b(before|after|by|on|in|during|this|next)\b.*\b(19|20)\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|noon|afternoon|evening|midnight|tomorrow|week|month|year|day|hour|quarter|q[1-4])\b/i;

/**
 * Joke/troll/meme markers. These are characteristic of low-quality "filler"
 * markets that don't have real price discovery.
 */
const TROLL_PATTERNS = [
  /\bgta\s*vi\b/i,
  /\brihanna\s*album\s*before\b/i,
  /\bplayboi\s*carti\s*album\s*before\b/i,
  /\bjesus\s*christ\s*return\b/i,
  /\bwill\s*\w+\s*die\b/i,
  /\baliens?\s*confirmed?\b/i,
  /\bwill\s+it\s+rain\b/i,
  /\bwill\s+\w+\s+eat\b/i,
];

/**
 * Score a market question's intrinsic quality. Questions that are too short,
 * contain troll patterns, lack a binary trigger, or are pure superlatives
 * fail. This layer catches "BS markets" before the correlation gate ever
 * sees them.
 */
export function assessQuality(text: string): QualityAssessment {
  const reasons: string[] = [];
  const len = text.length;
  const qCount = (text.match(/\?/g) ?? []).length;
  const hasBinary = BINARY_TRIGGERS.test(text);
  const hasDate = DATE_ANCHOR.test(text);
  const superlativeOnly = /^(best|worst|favorite|greatest|top|funniest)\b/i.test(text.trim());
  let trollHits = 0;
  for (const p of TROLL_PATTERNS) if (p.test(text)) trollHits++;

  if (len < 12) reasons.push('question too short');
  if (len > 240) reasons.push('question too long');
  if (qCount > 2) reasons.push('multiple question marks');
  if (!hasBinary) reasons.push('missing binary trigger verb (will/does/is/...)');
  if (!hasDate && /\?$/.test(text.trim()) === false) reasons.push('missing time anchor');
  if (superlativeOnly) reasons.push('opinion/superlative framing, not a binary outcome');
  if (trollHits > 0) reasons.push(`troll/meme pattern match (${trollHits})`);

  return {
    passed: reasons.length === 0,
    reasons,
    signals: {
      length: len,
      question_mark_count: qCount,
      has_binary_trigger: hasBinary,
      has_date_anchor: hasDate,
      is_superlative_only: superlativeOnly,
      troll_hits: trollHits,
    },
  };
}

// ---------- TF-IDF + cosine similarity ----------

export interface TfIdfCorpus {
  idf: Map<string, number>;
  docTermFreqs: Map<string, number>[]; // normalised tf per doc
  docIds: string[];
}

/**
 * Build a TF-IDF index over a corpus. Used to compute semantic similarity
 * between markets (e.g., for dedupe and basket diversity pre-filtering).
 */
export function buildTfIdf(docs: Array<{ id: string; text: string }>): TfIdfCorpus {
  const N = docs.length;
  const df = new Map<string, number>();
  const docTermFreqs = docs.map((d) => {
    const toks = tokenize(d.text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    // Normalise TF by doc length
    const maxTf = Math.max(1, ...tf.values());
    for (const [k, v] of tf) tf.set(k, v / maxTf);
    // Update document frequencies (each term counted once per doc)
    for (const k of tf.keys()) df.set(k, (df.get(k) ?? 0) + 1);
    return tf;
  });
  const idf = new Map<string, number>();
  for (const [term, n] of df) idf.set(term, Math.log((N + 1) / (n + 1)) + 1); // smoothed IDF
  return { idf, docTermFreqs, docIds: docs.map((d) => d.id) };
}

/**
 * Cosine similarity between two docs in the TF-IDF space.
 */
export function tfidfCosine(corpus: TfIdfCorpus, aIdx: number, bIdx: number): number {
  const a = corpus.docTermFreqs[aIdx];
  const b = corpus.docTermFreqs[bIdx];
  const idf = corpus.idf;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, va] of a) {
    const w = idf.get(t) ?? 0;
    const vaw = va * w;
    na += vaw * vaw;
    const vb = b.get(t);
    if (vb !== undefined) dot += vaw * vb * w;
  }
  for (const [t, vb] of b) {
    const w = idf.get(t) ?? 0;
    const vbw = vb * w;
    nb += vbw * vbw;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? Math.max(0, Math.min(1, dot / denom)) : 0;
}
