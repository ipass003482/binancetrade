"""Exit-proof integrity regressions; synthetic pure functions, no broker or IO.

The deployed implementation fails negative-ID and regressed-feed cases.  A
repair should reject malformed IDs and reset a pending confirmation when a new
proof regresses exchange sequence IDs, while keeping duplicate observations
harmless and preserving the existing 55% / 20-second / three-sample policy.
"""
from copy import deepcopy
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from demo_flow_exit import advance
from demo_order_flow import validate_flow, FlowValidationError

OPEN = 1789515000000
PAIR = 'ETH/USDT'
TAG = 'codex-' + 'a' * 32


def opposite_proof(end):
    latest = end + 1500
    index = (end - OPEN) // 10000
    books = []
    for i in range(3):
        mid = 100 - i * .001
        books.append({
            'at': latest - 20000 + i * 10000,
            'updateId': 10000 + index * 3 + i,
            'bids': [[str(mid - .001 - j * .001), '1'] for j in range(5)],
            'asks': [[str(mid + .001 + j * .001), '3'] for j in range(5)],
        })
    return {
        'version': 'sampled-demo-flow-v1', 'mode': 'demo', 'pair': PAIR,
        'source': 'https://demo-api.binance.com', 'books': books,
        'startTime': end - 60000, 'endTime': end,
        'trades': [{'a': 1000 + index + j, 'T': end - 60000 + j * 10000,
                    'p': '100', 'q': '1', 'm': True} for j in range(7)],
    }


def step(state, proof, now=None):
    return advance(state, proof, pair=PAIR, tag=TAG, opened_at=OPEN,
                   now=proof['endTime'] + 1500 if now is None else now)


def test_negative_aggregate_trade_ids_fail_native_flow_validation():
    proof = opposite_proof(OPEN + 60000)
    for i, trade in enumerate(proof['trades']):
        trade['a'] = -9 + i
    with pytest.raises(FlowValidationError):
        validate_flow(proof, 'demo', PAIR, 'short', proof['endTime'] + 1500)


def test_three_fresh_looking_negative_id_windows_cannot_confirm_an_exit():
    state = None
    for i in range(3):
        proof = opposite_proof(OPEN + 60000 + i * 10000)
        for j, trade in enumerate(proof['trades']):
            trade['a'] = -9 + i + j
        state, should_exit, _ = step(state, proof)
        assert not should_exit
        assert state is None


@pytest.mark.parametrize('field', ['agg_trade_id', 'book_update_id'])
def test_new_proof_with_regressed_exchange_sequence_resets_confirmation(field):
    first = opposite_proof(OPEN + 60000)
    state, should_exit, _ = step(None, first)
    assert not should_exit and len(state['events']) == 1
    regressed = opposite_proof(OPEN + 70000)
    if field == 'agg_trade_id':
        for i, trade in enumerate(regressed['trades']):
            trade['a'] = 10 + i
    else:
        for i, book in enumerate(regressed['books']):
            book['updateId'] = 10 + i
    state, should_exit, reason = step(state, regressed)
    assert not should_exit
    assert state is None, f'regressed {field} retained prior confirmation: {reason}'
    for end in (OPEN + 80000, OPEN + 90000):
        state, should_exit, _ = step(state, opposite_proof(end))
        assert not should_exit, 'confirmation bridged a feed-sequence regression'
    state, should_exit, _ = step(state, opposite_proof(OPEN + 100000))
    assert should_exit


def test_an_exact_duplicate_does_not_reset_or_increase_valid_confirmation():
    first = opposite_proof(OPEN + 60000)
    state, _, _ = step(None, first)
    saved = deepcopy(state)
    state, should_exit, reason = step(state, first, first['endTime'] + 6500)
    assert not should_exit and reason == 'awaiting_fresh_sample'
    assert state == saved
    state, should_exit, _ = step(state, opposite_proof(OPEN + 70000))
    assert not should_exit
    state, should_exit, _ = step(state, opposite_proof(OPEN + 80000))
    assert should_exit


@pytest.mark.parametrize('field', ['agg_trade_id', 'book_update_id'])
def test_equal_exchange_sequence_is_not_misclassified_as_a_regression(field):
    first = opposite_proof(OPEN + 60000)
    state, _, _ = step(None, first)
    saved = deepcopy(state)
    next_proof = opposite_proof(OPEN + 70000)
    if field == 'agg_trade_id':
        for old, new in zip(first['trades'], next_proof['trades']):
            new['a'] = old['a']
    else:
        for old, new in zip(first['books'], next_proof['books']):
            new['updateId'] = old['updateId']
    state, should_exit, reason = step(state, next_proof)
    assert state is not None and not should_exit
    assert state['events'][0] == saved['events'][0]
    if field == 'agg_trade_id':
        assert reason == 'awaiting_fresh_sample'
        assert state == saved
    else:
        # V2 requires advancing sample time, window and tape ID; equal depth ID
        # is allowed by the existing policy and must not be silently tightened.
        assert reason == 'watching_opposite'
        assert len(state['events']) == 2
