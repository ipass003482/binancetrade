"""Prospective exits require fresh, sustained, nonoverlapping sell evidence."""
import copy
import json
from pathlib import Path
import sys
from datetime import timedelta
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from demo_flow_exit import advance, LEGACY_POLICY as POLICY, STATE_KEY, LEGACY_QUALITY_VERSION as QUALITY_VERSION
from demo_order_flow import validate_flow

PAIR='ETH/USDT'
TAG='codex-'+'a'*32
OPEN=1789455000000


def proof(end, sell=True):
    latest=end+1500
    books=[]
    for i in range(3):
        mid=100+(-1 if sell else 1)*i*.001
        books.append({'at':latest-20000+i*10000,'updateId':end//10+i,
            'bids':[[str(mid-.001-k*.001),'1' if sell else '3'] for k in range(5)],
            'asks':[[str(mid+.001+k*.001),'3' if sell else '1'] for k in range(5)]})
    return {'version':'sampled-demo-flow-v1','mode':'demo','pair':PAIR,
        'source':'https://demo-api.binance.com','books':books,'startTime':end-60000,'endTime':end,
        'trades':[{'a':end//10+i,'T':end-55000+i*25000,'p':'100','q':'1','m':sell} for i in range(3)]}


def step(state,p,now=None,opened=OPEN):
    return advance(state,p,pair=PAIR,tag=TAG,policy=POLICY,opened_at=opened,now=now if now is not None else p['endTime']+1500)


def confirmed():
    state=None
    for i in range(7):
        p=proof(OPEN+60000+i*10000)
        state,exit_,reason=step(state,p)
        assert exit_ is (i==6)
    return state,p


def test_two_nonoverlapping_windows_confirm_and_persist_until_exit_fills():
    state,p=confirmed()
    assert state['first']['proof']['endTime']==p['startTime']
    assert state['decision']['proof']==p
    # A confirmed exit intent survives restart and transient feed failure.
    assert step(copy.deepcopy(state),None,now=p['endTime']+60000)[1:] == (True,'confirmed')


def test_repeated_or_overlapping_snapshot_is_not_a_second_confirmation():
    p=proof(OPEN+60000);state,_,_=step(None,p)
    for ms in [5000,10000,15000]:
        state,exit_,_=step(state,p,now=p['endTime']+1500+ms)
        assert not exit_
    assert not step(state,proof(OPEN+80000))[1]


@pytest.mark.parametrize('change',['missing','stale','buy','wrong_source','string_maker','saturated','gap','preentry','future'])
def test_invalid_or_recovered_evidence_resets_confirmation(change):
    state,_,_=step(None,proof(OPEN+60000));p=proof(OPEN+70000);now=p['endTime']+1500
    if change=='missing':p=None
    elif change=='stale':now+=46000
    elif change=='buy':p=proof(OPEN+70000,False)
    elif change=='wrong_source':p['source']='https://api.binance.com'
    elif change=='string_maker':p['trades'][0]['m']='true'
    elif change=='saturated':p['trades']=[p['trades'][0]]*1000
    elif change=='gap':p['trades'][1]['a']+=5
    elif change=='preentry':p=proof(OPEN+59000)
    elif change=='future':now=p['books'][-1]['at']-1
    new,exit_,_=step(state,p,now=now)
    assert new is None and not exit_


def test_observation_outage_starts_a_fresh_confirmation():
    state,_,_=step(None,proof(OPEN+60000))
    later=proof(OPEN+120000)
    state,exit_,_=step(state,later)
    assert not exit_ and state['first']['proof']==later


def test_reused_trade_ids_cannot_count_as_disjoint_window():
    state=None
    for i in range(6):state,_,_=step(state,proof(OPEN+60000+i*10000))
    last=proof(OPEN+120000)
    for i,t in enumerate(last['trades']):t['a']=state['first']['proof']['trades'][0]['a']+i
    assert not step(state,last)[1]


@pytest.mark.parametrize('change',['tag','pair','decision','state_type'])
def test_corrupt_persisted_state_does_not_invent_exit(change):
    state,p=confirmed()
    if change=='state_type':state=[]
    elif change=='decision':state['decision']['proof']['source']='wrong'
    else:state[change]='wrong'
    assert step(state,None,now=p['endTime']+5000)[1:]==(False,'invalid_state')


def test_native_custom_exit_uses_versioned_plan_and_preserves_legacy_and_hard_stops(tmp_path,monkeypatch):
    from test_rule_exit_profiles import fixture
    import RuleExits as module
    strategy,trade,plan,opened=fixture(module.ENTRY_RULE_VERSION)
    plan.update(executionQualityVersion=QUALITY_VERSION,flowExit=dict(POLICY))
    base=int(opened.timestamp()*1000)
    monkeypatch.setattr(module,'ROOT',tmp_path)
    path=tmp_path/'local/demo/order-flow.json';path.parent.mkdir(parents=True)
    for i in range(7):
        p=proof(base+60000+i*10000);p['pair']=trade.pair
        path.write_text(json.dumps({'mode':'demo','markets':{trade.pair:p}}),encoding='utf-8')
        at=opened+timedelta(milliseconds=61500+i*10000)
        reason=strategy.custom_exit(trade.pair,trade,at,100,0)
        assert reason==('rules_flow_invalidated' if i==6 else None)
    assert trade.get_custom_data(key=STATE_KEY)['decision'] is not None
    exits=strategy.should_exit(trade,100,at,enter=False,exit_=False)
    assert any(x.exit_reason=='rules_flow_invalidated' for x in exits)
    assert strategy.custom_exit(trade.pair,trade,at,98,0)=='rules_stop'
    assert strategy.custom_exit(trade.pair,trade,at,105,0)=='rules_target'
    plan.pop('executionQualityVersion')
    assert strategy.custom_exit(trade.pair,trade,at,100,0) is None
    plan['executionQualityVersion']=QUALITY_VERSION
    strategy.config['trading_mode']='futures'
    assert strategy.custom_exit(trade.pair,trade,at,100,0) is None


def test_missing_optional_flow_file_keeps_existing_atr_exit(tmp_path,monkeypatch):
    from test_rule_exit_profiles import fixture
    import RuleExits as module
    strategy,trade,plan,opened=fixture(module.ENTRY_RULE_VERSION)
    plan.update(executionQualityVersion=QUALITY_VERSION,flowExit=dict(POLICY))
    monkeypatch.setattr(module,'ROOT',tmp_path)
    assert strategy.custom_exit(trade.pair,trade,opened+timedelta(minutes=3),100,0) is None
    assert strategy.custom_exit(trade.pair,trade,opened+timedelta(minutes=3),98,0)=='rules_stop'
