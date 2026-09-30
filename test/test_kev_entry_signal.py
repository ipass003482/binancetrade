"""Offline coherent flow contracts, including cross-runtime arithmetic parity."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from decimal import Decimal

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from kev_entry_signal import KEV_ENTRY_SIGNAL_POLICY, valid_kev_entry_signal_policy, assess_kev_entry_signal

NOW = 1800000000000


def proof(long=True, mode='demo', now=NOW):
    pair = 'ETH/USDT' if mode == 'demo' else 'ETH/USDT:USDT'
    books = []
    for i in range(3):
        mid = Decimal('99.98') + Decimal('.01') * i if long else Decimal('100.04') - Decimal('.01') * i
        books.append(dict(at=now-20000+i*10000, updateId=100+i,
            bids=[[str(mid-Decimal('.001')-Decimal('.02')*j), '1' if long else '2'] for j in range(5)],
            asks=[[str(mid+Decimal('.001')+Decimal('.02')*j), '2' if long else '1'] for j in range(5)]))
    return dict(version='sampled-demo-flow-v1', mode=mode, pair=pair,
        source='https://demo-api.binance.com' if mode == 'demo' else 'https://demo-fapi.binance.com',
        startTime=now-61500, endTime=now-1500, books=books,
        trades=[dict(a=i+1, T=now+offset, p='100', q='3' if i % 2 == 0 else '2',
                     m=not long if i % 2 == 0 else long)
                for i, offset in enumerate((-20000, -15000, -10000, -1500))])


def assess(value, long=True, now=NOW):
    return assess_kev_entry_signal(value, value['mode'], value['pair'], long, now)


@pytest.mark.parametrize('long,mode', [(True, 'demo'), (True, 'demo-futures'), (False, 'demo-futures')])
def test_common_price_response_can_accept_opposing_static_depth(long, mode):
    value = proof(long, mode)
    result = assess(value, long)
    assert result['eligible'] is True
    assert result['overall']['directionalShare'] == '0.6'
    assert [h['tradeCount'] for h in result['halves']] == [2, 2]
    assert all(Decimal(v) < 0 if long else Decimal(v) > 0 for v in result['bookImbalances'])


@pytest.mark.parametrize('change', [lambda p:p.update(extra=1), lambda p:p.update(minimumTradeCount=True),
    lambda p:p.update(minimumDirectionalShare=.55), lambda p:p.update(minimumDirectionalShare='0.54'),
    lambda p:p.pop('version')])
def test_exact_frozen_policy_rejects_added_missing_or_coerced_fields(change):
    value = dict(KEV_ENTRY_SIGNAL_POLICY)
    assert valid_kev_entry_signal_policy(value)
    change(value)
    assert not valid_kev_entry_signal_policy(value)


def test_whole_original_tape_validated_before_common_window_filter():
    value = proof()
    value['trades'].insert(0, dict(a=-1, T=NOW-50000, p='100', q='100', m=False))
    result = assess(value)
    assert result['status'] == 'unavailable'
    assert result['validationReason'] == 'FLOW_TRADE_GAP'


def test_old_tape_cannot_rescue_weak_common_direction_and_halves():
    value = proof()
    value['trades'].insert(0, dict(a=0, T=NOW-50000, p='100', q='1000', m=False))
    value['trades'][1]['q'] = '1'
    result = assess(value)
    assert result['tradeCount'] == 4
    assert result['overall']['directionalShare'] == '0.5'
    assert 'KEV_SIGNAL_HALF_DIRECTION_NOT_CONFIRMED' in result['reasons']


def test_tape_boundaries_count_middle_once_and_end_inclusively():
    value = proof()
    result = assess(value)
    assert result['tradeCount'] == 4
    assert result['window']['durationMs'] == 18500
    assert result['halves'][0]['endInclusive'] is False
    assert result['halves'][1]['endInclusive'] is True


def test_mid_rise_does_not_hide_an_adverse_bid_interval():
    value = proof()
    value['books'][1]['bids'][0][0] = '99.9785'
    result = assess(value)
    assert result['reason'] == 'KEV_SIGNAL_QUOTE_INTERVAL_ADVERSE'
    assert result['quoteResponse']['finalFavorable'] is True


def test_sub_precision_price_reversal_is_not_rounded_into_acceptance():
    value = proof()
    value['books'][1]['bids'][0][0] = '99.97899999999999999999999999999999999999999'
    result = assess(value)
    assert result['reason'] == 'KEV_SIGNAL_QUOTE_INTERVAL_ADVERSE'
    assert result['quoteResponse']['intervals'][0]['bidMoveBps'] == '0'


def test_exact_half_tie_and_total_threshold_boundaries():
    value = proof()
    for i, trade in enumerate(value['trades']):
        trade['q'] = '11' if i % 2 == 0 else '9'
    assert assess(value)['eligible']
    value['trades'][0]['q'] = '8'
    value['trades'][2]['q'] = '30'
    result = assess(value)
    assert Decimal(result['overall']['directionalShare']) > Decimal('.55')
    assert result['reason'] == 'KEV_SIGNAL_HALF_DIRECTION_NOT_CONFIRMED'


def test_missing_half_remains_missing_and_original_staleness_rejects():
    value = proof()
    for trade in value['trades']:
        trade['T'] = NOW-5000
    assert 'KEV_SIGNAL_HALF_TAPE_INCOMPLETE' in assess(value)['reasons']
    assert assess(value, now=NOW+45001)['validationReason'] == 'FLOW_STALE'


def test_python_matches_host_full_diagnostics_without_io_or_order_clients():
    bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
    node = os.environ.get('BINANCETRADE_NODE') or (str(bundled) if bundled.is_file() else shutil.which('node'))
    cases = []
    for long, mode in ((True, 'demo'), (True, 'demo-futures'), (False, 'demo-futures')):
        cases.append(dict(proof=proof(long, mode), long=long, now=NOW))
    for damage in ('half', 'gap_before', 'adverse', 'tiny_adverse', 'depth', 'direction'):
        value = proof()
        long = True
        if damage == 'half': value['trades'][0]['q'] = '1'
        elif damage == 'gap_before': value['trades'].insert(0, dict(a=10,T=NOW-50000,p='100',q='1000',m=False))
        elif damage == 'adverse': value['books'][1]['bids'][0][0] = '99.9785'
        elif damage == 'tiny_adverse': value['books'][1]['bids'][0][0] = '99.97899999999999999999999999999999999999999'
        elif damage == 'depth':
            for book in value['books']:
                for row in book['asks']: row[1] = '50'
        else: long = None
        cases.append(dict(proof=value, long=long, now=NOW))
    script = "import {assessKevEntrySignal} from './src/kev-entry-signal.mjs';let t='';for await(const c of process.stdin)t+=c;console.log(JSON.stringify(JSON.parse(t).map(c=>assessKevEntrySignal(c.proof,{mode:c.proof.mode,pair:c.proof.pair,long:c.long,now:c.now}))));"
    result = subprocess.run([node, '--input-type=module', '-e', script], cwd=ROOT,
                            input=json.dumps(cases), text=True, capture_output=True, check=True)
    host = json.loads(result.stdout)
    assert host == [assess(c['proof'], c['long'], c['now']) for c in cases]
