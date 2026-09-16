"""Reduced entry budgets must remain valid after fills/restart and retain exits."""
import copy
import pytest
from test_rule_exit_profiles import fixture
from RuleExits import ENTRY_RULE_VERSION, valid_plan, valid_risk_budget


@pytest.mark.parametrize('futures', [False, True])
@pytest.mark.parametrize('version', ['live-flow-adaptive-v1', 'live-flow-adaptive-v2'])
def test_persisted_adaptive_budget_preserves_atr_exit_plan(futures, version):
    strategy, trade, plan, now = fixture(ENTRY_RULE_VERSION, futures)
    plan.update(riskBudgetUsdt=.375, decisionCadenceVersion='flow-minute-v1',
                decisionIntervalMs=60000, decisionBoundary=1789528800000,
                adaptiveParameters={'version': version,
                                    'riskBudgetUsdt': '0.375000000000', 'riskScale': '0.375000000000'})
    assert valid_plan(plan, trade.pair, trade.is_short, trade.enter_tag) is plan
    assert strategy._rule_plan(trade) is plan
    assert strategy.custom_exit(trade.pair, trade, now, 95 if futures else 105, .05) == 'rules_target'
    assert strategy._rule_plan(trade) is plan
    # A legacy plan cannot silently adopt the new scaled risk contract.
    legacy = copy.deepcopy(plan)
    legacy.pop('adaptiveParameters')
    assert valid_plan(legacy, trade.pair, trade.is_short, trade.enter_tag) is None


@pytest.mark.parametrize('budget', [0, .24999, 1.001, True, float('nan'), '0.5'])
def test_scaled_budget_rejects_invalid_or_enlarged_values(budget):
    assert not valid_risk_budget({'riskBudgetUsdt': budget,
                                 'adaptiveParameters': {'version': 'live-flow-adaptive-v1'}})


def test_scaled_budget_must_match_persisted_profile():
    plan = {'ruleVersion': ENTRY_RULE_VERSION, 'riskBudgetUsdt': .5,
            'decisionCadenceVersion': 'flow-minute-v1', 'decisionIntervalMs': 60000,
            'decisionBoundary': 1789528800000,
            'adaptiveParameters': {'version': 'live-flow-adaptive-v1', 'riskBudgetUsdt': '.5', 'riskScale': '.5'}}
    assert valid_risk_budget(plan)
    plan['adaptiveParameters']['riskScale'] = '.6'
    assert not valid_risk_budget(plan)
