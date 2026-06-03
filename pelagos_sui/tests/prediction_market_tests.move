#[test_only]
module pelagos_sui::prediction_market_tests;

use pelagos_sui::prediction_market;

#[test]
fun prorata_reward_splits_losing_pool_by_winner_weight() {
    assert!(prediction_market::prorata_reward_for_testing(25, 100, 80) == 20);
    assert!(prediction_market::prorata_reward_for_testing(75, 100, 80) == 60);
}

#[test]
fun prorata_reward_is_zero_without_counterparty_liquidity() {
    assert!(prediction_market::prorata_reward_for_testing(100, 100, 0) == 0);
    assert!(prediction_market::prorata_reward_for_testing(100, 0, 100) == 0);
}
