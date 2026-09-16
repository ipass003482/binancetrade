"""Live-sample confirmation, persisted evidence and legacy exit compatibility."""
import copy
import json
from datetime import timedelta
import pytest
from test_demo_flow_exit import proof, PAIR, TAG, OPEN
from demo_flow_exit import advance, POLICY, QUALITY_VERSION, policy_for_plan


def step(state, p, now=None):
    return advance(state, p, pair=PAIR, tag=TAG, opened_at=OPEN,
                   now=now if now is not None else p['endTime']+1500)


def sequence():
    state = None
    for i in range(3):
        p = proof(OPEN+60000+i*10000)
        state, exit_, reason = step(state, p)
        assert exit_ is (i == 2)
    return state, p


def test_three_fresh_samples_over_twenty_seconds_confirm_and_survive_restart():
    state, p = sequence()
    assert len(state['events']) == 3
    assert state['decision']['proof'] == p
    assert step(copy.deepcopy(state), None, now=OPEN+900000)[1:] == (True, 'confirmed')


def test_duplicate_samples_do_not_count_and_event_time_alone_cannot_confirm():
    p = proof(OPEN+60000)
    state, _, _ = step(None, p)
    for delay in (5000, 10000, 15000, 20000):
        state, exit_, reason = step(state, p, p['endTime']+1500+delay)
        assert not exit_ and len(state['events']) == 1
    for end in (OPEN+65000, OPEN+70000):
        state, exit_, _ = step(state, proof(end))
        assert not exit_


def test_fresh_books_without_new_tape_cannot_count():
    p = proof(OPEN+60000); state, _, _ = step(None, p)
    nxt = proof(OPEN+70000)
    for old, new in zip(p['trades'], nxt['trades']):
        new['a'] = old['a']
    new_state, exit_, reason = step(state, nxt)
    assert new_state == state and not exit_ and reason == 'awaiting_fresh_sample'


@pytest.mark.parametrize('fault,reason', [
    ('missing','data_missing_or_invalid'), ('buy','taker_not_opposing'),
    ('depth','depth_not_opposing'), ('price','price_not_opposing'),
    ('trade_gap','trade_gap'), ('source','source_invalid'),
    ('preentry','preentry_window'), ('stale','book_stale_or_window_mismatch')])
def test_failed_conditions_reset_with_distinct_diagnostics(fault,reason):
    state, _, _ = step(None, proof(OPEN+60000))
    p = proof(OPEN+70000); now = p['endTime']+1500
    if fault == 'missing': p = None
    elif fault == 'buy': p = proof(OPEN+70000,False)
    elif fault == 'depth':
        for row in p['books'][1]['bids']: row[1] = '9'
    elif fault == 'price':
        for i, book in enumerate(p['books']):
            for key in ('bids','asks'):
                for row in book[key]: row[0] = str(float(row[0])+i*.01)
    elif fault == 'trade_gap': p['trades'][1]['a'] += 2
    elif fault == 'source': p['source'] = 'https://api.binance.com'
    elif fault == 'preentry': p = proof(OPEN+59000)
    elif fault == 'stale': now += 46000
    assert step(state,p,now)[0:3] == (None,False,reason)


def test_outage_restarts_confirmation_and_neutral_interrupts_it():
    state, _, _ = step(None,proof(OPEN+60000))
    state, exit_, reason = step(state,proof(OPEN+90000))
    assert not exit_ and reason == 'observation_gap_reset' and len(state['events']) == 1
    assert step(state,proof(OPEN+100000,False))[0] is None


@pytest.mark.parametrize('fault',['tag','pair','decision','middle_source','middle_time','truncate','version'])
def test_persisted_proof_tampering_never_authorizes_an_exit(fault):
    state, p = sequence()
    if fault in ('tag','pair','version'): state[fault] = 'wrong'
    elif fault == 'decision': state['decision']['proof']['source'] = 'wrong'
    elif fault == 'middle_source': state['events'][1]['proof']['source'] = 'wrong'
    elif fault == 'middle_time': state['events'][1]['checkedAt'] += 100000
    elif fault == 'truncate': state['events'] = state['events'][-1:]
    assert step(state,None,now=OPEN+200000)[1:] == (False,'invalid_state')


def test_native_v2_exit_uses_new_plan_and_keeps_stop_target_priority(tmp_path,monkeypatch):
    from test_rule_exit_profiles import fixture
    import RuleExits as module
    strategy,trade,plan,opened = fixture(module.ENTRY_RULE_VERSION)
    plan.update(executionQualityVersion=QUALITY_VERSION,flowExit=dict(POLICY))
    assert policy_for_plan(plan) == POLICY
    monkeypatch.setattr(module,'ROOT',tmp_path)
    path=tmp_path/'local/demo/order-flow.json'; path.parent.mkdir(parents=True)
    base=int(opened.timestamp()*1000)
    for i in range(3):
        p=proof(base+60000+i*10000); p['pair']=trade.pair
        path.write_text(json.dumps({'mode':'demo','markets':{trade.pair:p}}),encoding='utf-8')
        at=opened+timedelta(milliseconds=61500+i*10000)
        assert strategy.custom_exit(trade.pair,trade,at,100,0) == ('rules_flow_invalidated' if i==2 else None)
    assert strategy.custom_exit(trade.pair,trade,at,98,0)=='rules_stop'
    assert strategy.custom_exit(trade.pair,trade,at,105,0)=='rules_target'
    strategy.config['trading_mode']='futures'
    assert strategy.custom_exit(trade.pair,trade,at,100,0) is None


def test_policy_cannot_be_loosened_or_applied_to_unversioned_plan():
    assert policy_for_plan({'flowExit':POLICY}) is None
    p=dict(POLICY,minSamples=1)
    assert policy_for_plan({'executionQualityVersion':QUALITY_VERSION,'flowExit':p}) is None
