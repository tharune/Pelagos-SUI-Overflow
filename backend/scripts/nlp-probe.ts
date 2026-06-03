/**
 * Dev-only NLP + filter smoke probe.
 *
 * Exercises edge cases of the NLP module and full pipeline that would be
 * painful to hit over HTTP. Run with:
 *   npx tsx scripts/nlp-probe.ts
 */
import {
  tokenize,
  classifyCategory,
  assessQuality,
  buildTfIdf,
  tfidfCosine,
} from '../src/services/nlp';
import { gateCheckLeg, filterMarkets } from '../src/services/market-filter';

function expect(name: string, actual: any, predicate: (x: any) => boolean) {
  const ok = predicate(actual);
  // eslint-disable-next-line no-console
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log('       actual:', JSON.stringify(actual));
    process.exitCode = 1;
  }
}

// ---- Tokenizer ----
expect('tokenize strips stopwords and short tokens',
  tokenize('Will the BTC be at $100k in 2026'),
  (t) => t.includes('btc') && !t.includes('the') && !t.includes('be'));

expect('stemmer folds plurals',
  tokenize('games and game'),
  (t) => new Set(t).size === 1 && t[0] === 'game');

// ---- Classifier ----
expect('crypto classification',
  classifyCategory('Will Bitcoin hit $100k by April 2026?'),
  (s) => s.category === 'crypto');

expect('sports classification',
  classifyCategory('Will the Lakers win the NBA championship in 2026?'),
  (s) => s.category === 'sports');

expect('politics classification',
  classifyCategory('Will Trump be impeached by Congress before the midterm?'),
  (s) => s.category === 'politics');

expect('other fallback on ambiguous',
  classifyCategory('Will it happen?'),
  (s) => s.category === 'other');

expect('other fallback on empty',
  classifyCategory(''),
  (s) => s.category === 'other');

// ---- Quality ----
expect('short question fails',
  assessQuality('hi'),
  (q) => !q.passed && q.reasons.includes('question too short'));

expect('troll pattern fails',
  assessQuality('Will aliens confirmed before GTA VI?'),
  (q) => !q.passed && q.signals.troll_hits > 0);

expect('clean question passes',
  assessQuality('Will Bitcoin hit $100k by April 2026?'),
  (q) => q.passed);

expect('pure superlative fails',
  assessQuality('Best movie of 2026'),
  (q) => !q.passed && q.signals.is_superlative_only);

// ---- TF-IDF ----
const corpus = buildTfIdf([
  { id: 'a', text: 'Will Bitcoin hit 100k by April 2026?' },
  { id: 'b', text: 'Will Bitcoin hit 100k by April 2026?' }, // exact dupe
  { id: 'c', text: 'Will the Lakers win the NBA championship?' },
]);
expect('identical docs have cosine ~1', tfidfCosine(corpus, 0, 1),
  (v) => v > 0.99);
expect('unrelated docs have cosine < 0.3', tfidfCosine(corpus, 0, 2),
  (v) => v < 0.3);

const emptyCorpus = buildTfIdf([{ id: 'x', text: '' }, { id: 'y', text: 'crypto' }]);
expect('empty doc cosine is 0', tfidfCosine(emptyCorpus, 0, 1),
  (v) => v === 0);

// ---- gateCheckLeg ----
const fakeMarket = {
  id: '1', question: 'Will Bitcoin hit $100k by April 2026?',
  condition_id: '0x', tokens: [], outcomePrices: '["0.5","0.5"]',
  volume: '10000', active: true, closed: false,
  end_date_iso: new Date(Date.now() + 30 * 86_400_000).toISOString(),
} as any;

expect('gate passes clean market',
  gateCheckLeg(fakeMarket, 'Will Bitcoin hit $100k by April 2026?'),
  (r) => r.passed === true);

expect('gate fails closed market',
  gateCheckLeg({ ...fakeMarket, closed: true }, 'Will Bitcoin hit $100k by April 2026?'),
  (r) => !r.passed && r.record.stages[0].reasons.includes('market closed'));

expect('gate fails inactive market',
  gateCheckLeg({ ...fakeMarket, active: false }, 'Will Bitcoin hit $100k by April 2026?'),
  (r) => !r.passed && r.record.stages[0].reasons.includes('market inactive'));

expect('gate fails troll question',
  gateCheckLeg(fakeMarket, 'Will Jesus Christ return before GTA VI?'),
  (r) => !r.passed && r.record.stages[1].reasons.some((x: string) => x.includes('troll')));

expect('gate fails too-soon resolution',
  gateCheckLeg({ ...fakeMarket, end_date_iso: new Date(Date.now() + 3600_000).toISOString() },
               'Will Bitcoin hit $100k by April 2026?'),
  (r) => !r.passed && r.record.stages[2].reasons.some((x: string) => x.includes('<')));

expect('gate fails too-far resolution',
  gateCheckLeg({ ...fakeMarket, end_date_iso: new Date(Date.now() + 400 * 86_400_000).toISOString() },
               'Will Bitcoin hit $100k by April 2026?'),
  (r) => !r.passed && r.record.stages[2].reasons.some((x: string) => x.includes('>')));

expect('gate records ALL failures, not just first',
  gateCheckLeg({ ...fakeMarket, closed: true }, 'hi'), // closed AND short
  (r) => r.record.stages[0].passed === false && r.record.stages[1].passed === false);

// ---- Full pipeline ----
const markets = [
  { ...fakeMarket, id: 'm1', question: 'Will Bitcoin hit $100k by April 2026?' },
  { ...fakeMarket, id: 'm2', question: 'Will Bitcoin hit $100k by April 2026?', volume: '20000' }, // duplicate
  { ...fakeMarket, id: 'm3', question: 'Will Jesus Christ return before GTA VI?' }, // troll
  { ...fakeMarket, id: 'm4', question: 'Will the Lakers win the 2026 NBA championship?' },
  { ...fakeMarket, id: 'm5', question: 'Will the Celtics win the 2026 NBA championship?' },
  { ...fakeMarket, id: 'm6', volume: '100', question: 'Will Bitcoin hit $1m by April 2026?' }, // low volume
  { ...fakeMarket, id: 'm7', closed: true, question: 'Will Bitcoin hit $100k by April 2026?' }, // closed
];
const result = filterMarkets(markets);
expect('pipeline runs 5 stages', Object.keys(result.funnel.per_stage).length,
  (n) => n === 5);
expect('pipeline rejects troll',
  result.rejected.some((r) => r.market.id === 'm3' && r.droppedAt === 'quality_nlp'),
  (v) => v === true);
expect('pipeline rejects low-volume',
  result.rejected.some((r) => r.market.id === 'm6' && r.droppedAt === 'liquidity_floor'),
  (v) => v === true);
expect('pipeline rejects closed',
  result.rejected.some((r) => r.market.id === 'm7' && r.droppedAt === 'liquidity_floor'),
  (v) => v === true);
expect('pipeline dedupes m1/m2 keeping higher-volume',
  result.kept.find((r) => r.market.id === 'm2') && !result.kept.find((r) => r.market.id === 'm1'),
  (v) => !!v);

// eslint-disable-next-line no-console
console.log('\n--- Summary ---');
console.log(`kept: ${result.kept.length}, rejected: ${result.rejected.length}`);
console.log('kept ids:', result.kept.map((r) => r.market.id).join(','));
for (const r of result.rejected) {
  console.log(`  rejected ${r.market.id} at ${r.droppedAt}`);
}

if (process.exitCode === 1) {
  console.log('\nONE OR MORE PROBES FAILED');
  process.exit(1);
}
console.log('\nAll probes passed.');
