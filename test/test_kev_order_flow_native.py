"""Offline contracts for Kev's candle-free authority and native enforcement."""
import copy
import json
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal, localcontext
from hashlib import sha256
from pathlib import Path
import sys
import shutil
import socket
import subprocess
from types import SimpleNamespace

import ccxt
import pytest

from demo_model_guard_support import guard, isolate, fake_exchange, MS, BOUNDARY, SNAPSHOT_ID, TAG
from demo_order_flow import validate_flow, FlowValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'freqtrade' / 'strategies'))
from RuleExits import RuleExits, valid_plan, TRAILING_POLICY


def iso(stamp):
    return datetime.fromtimestamp(stamp / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()
    path.write_bytes(raw)
    return sha256(raw).hexdigest()


def quote_path(root, value):
    stem = value['snapshotId']
    if value.get('executionPolicyVersion'):
        stem += '.' + value['tag'].removeprefix('codex-')
    return root / 'local' / value['nativeEntryGuard']['mode'] / 'runs' / (stem + '.execution-quote.json')


def write_cost_fixture(root, value, proof, *, buy='.001', sell='.001', funding='0', spread='1'):
    mode, pair = value['nativeEntryGuard']['mode'], value['pair']
    method = 'standard_plus_tax_plus_special_no_bnb_discount' if mode == 'demo' else 'symbol_taker_rate'
    source = 'https://demo-api.binance.com' if mode == 'demo' else 'https://demo-fapi.binance.com'
    at = value['nativeEntryGuard']['quoteFetchedAt']
    config = dict(version=1, maxAgeSeconds=300, slippageBpsPerSide=5, priceSpaceBufferBps=30, fundingReserveEvents=1)
    with localcontext() as context:
        context.prec = 20
        fees = (Decimal(buy) + Decimal(sell)) * 10000
        reserve = abs(Decimal(funding)) * 10000 if mode == 'demo-futures' else Decimal(0)
        total = fees + Decimal(spread) + 10 + reserve
        required = total + 30
    cost = dict(status='ok', mode=mode, pair=pair, source=source, observedAt=at, method=method,
        buyRate=buy, sellRate=sell, roundTripFeeBps=str(fees), spreadBps=spread,
        slippageBpsPerSide=5, fundingReserveEvents=1, fundingReserveBps=str(reserve),
        estimatedRoundTripCostBps=str(total), requiredPriceSpaceBps=str(required))
    quote = dict(mode=mode, pair=pair, source=source, timeframe='order-flow',
        verifiedSpot=mode == 'demo', verifiedFutures=mode == 'demo-futures',
        bid='100', ask=str(Decimal(100) * (1 + Decimal(spread) / 10000)), spreadBps=float(spread),
        fundingRate=funding, fetchedAt=at, orderFlow=proof, entryCost=cost)
    facts = dict(schemaVersion=1, mode=mode, kind='costs', readOnly=True, source=source, observedAt=at,
        rates=[dict(pair=pair, status='ok', buyRate=buy, sellRate=sell, method=method)])
    cadence = {key: value[key] for key in guard._CADENCE_KEYS}
    write_json(root / 'local' / mode / 'runs' / (value['snapshotId'] + '.snapshot.json'),
        dict(id=value['snapshotId'], mode=mode, timeframe='order-flow', **cadence, costFacts=facts, markets=[quote]))
    write_json(root / 'config/costs.json', config)
    write_json(quote_path(root, value), quote)
    review_path = root / 'local' / mode / 'runs' / (value['snapshotId'] + '.kev-review.json')
    review = json.loads(review_path.read_text())
    review['request']['state']['markets'] = [dict(pair=pair, bid=quote['bid'], ask=quote['ask'], quoteObservedAt=quote['fetchedAt'], costs={key: cost[key] for key in
        ('estimatedRoundTripCostBps', 'requiredPriceSpaceBps', 'roundTripFeeBps', 'slippageBpsPerSide', 'fundingReserveBps', 'observedAt')})]
    value['nativeEntryGuard']['kevReviewSha256'] = write_json(review_path, review)
    value['riskCostFraction'] = float(total / 10000)
    value['nativeEntryGuard']['requiredPriceSpaceBps'] = str(required)
    price = quote['bid' if value['isShort'] else 'ask']
    value['nativeEntryGuard']['bridgeQuotePrice'] = price
    value['entryConfirmation']['quotePrice'] = price


def plan(root, short=False, minute=0):
    now, boundary = MS + minute * 60000, BOUNDARY + minute * 60000
    mode, pair, side = ('demo-futures', 'ETH/USDT:USDT', 'short') if short else ('demo', 'ETH/USDT', 'long')
    action = 'open-short' if short else 'buy'
    # Deliberately bearish depth/tape and flat sampled prices. Kev may choose a
    # long, unlike the legacy deterministic flow strategy.
    books = [dict(at=now-20000+i*10000, updateId=i+1,
        bids=[[str(99.99-k*.01), '1'] for k in range(5)],
        asks=[[str(100.01+k*.01), '3'] for k in range(5)]) for i in range(3)]
    proof = dict(version='sampled-demo-flow-v1', mode=mode, pair=pair,
        source='https://demo-fapi.binance.com' if short else 'https://demo-api.binance.com',
        books=books, startTime=now-61500, endTime=now-1500,
        trades=[dict(a=i+1, T=now-55000+i*25000, p='100', q='1', m=True) for i in range(3)])
    probabilities = {'q0': .8, 'hold': .2}
    decision = dict(pair=pair, action=action, approved=True, choice='select', probabilities=probabilities)
    selection = dict(choice='q0', probabilities=probabilities)
    review = dict(version='kev-codex-entry-v1', enabled=True, mode=mode, snapshotId=SNAPSHOT_ID,
        snapshotSha256='a'*64, configSha256='b'*64, proofSha256='c'*64,
        startedAt=iso(now-10000), completedAt=iso(now-1000), expiresAt=iso(boundary+60000),
        decisionMode='autonomous', invoked=True, requestAttempted=True, status='reviewed',
        actualModel='test-model', requestId='test-request', approvedPairs=[pair], decisions=[decision], selection=selection,
        request=dict(model='kev-codex', state=dict(mode=mode, snapshotId=SNAPSHOT_ID, decisionMode='autonomous',
            candidates=[dict(id='q0', pair=pair, action=action)])),
        response=dict(model='kev-codex', request_id='test-request', backend=dict(name='codex-cli', actual_model='test-model',
            weights_loaded=False, probabilities_calibrated=False, cli_calls=1),
            answers=dict(entry=dict(type='choice', **selection))))
    receipt = dict(version=review['version'], decisionMode='autonomous', provider='codex-cli', model=review['actualModel'],
        requestId=review['requestId'], snapshotId=SNAPSHOT_ID, snapshotSha256=review['snapshotSha256'],
        configSha256=review['configSha256'], proofSha256=review['proofSha256'], completedAt=review['completedAt'], expiresAt=review['expiresAt'],
        decision=decision, selection=selection, probabilitiesCalibrated=False)
    cadence = dict(decisionCadenceVersion='flow-minute-v1', decisionIntervalMs=60000, decisionBoundary=boundary)
    folder = root / 'local' / mode / 'runs'
    review_hash = write_json(folder / (SNAPSHOT_ID+'.kev-review.json'), review)
    value = dict(ruleVersion='kev-order-flow-v1', entryPolicyVersion='kev-order-flow-v1', entrySignalEngine='kev_order_flow',
        purpose='strategy', timeframe='order-flow', snapshotId=SNAPSHOT_ID, pair=pair, isShort=short, tag=TAG,
        stopFraction=.005, targetFraction=.015, maxHoldingBars=0, maxHoldingSeconds=900,
        riskBudgetUsdt=1, riskCostFraction=.0031, maxEntryNotionalUsdt=25, createdAt=iso(now), **cadence,
        riskPolicy=dict(version='native-stop-risk-v1', mode=mode, stopLimitRatio=None if short else '0.995',
            reserveFraction='0' if short else '0.005'), profitProtection=dict(TRAILING_POLICY),
        entryConfirmation=dict(version='kev-flow-confirmation-v1', orderFlow=proof, quotePrice='100'),
        entryEvidence=dict(version='kev-order-flow-evidence-v1', snapshotId=SNAPSHOT_ID, usedForEntryDecision=True,
            proofSha256=sha256(json.dumps(proof, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest(), kevReview=receipt),
        nativeEntryGuard=dict(version='kev-native-entry-v1', snapshotId=SNAPSHOT_ID, mode=mode, pair=pair, side=side,
            **cadence, entryDeadline=boundary+60000, requiredPriceSpaceBps='61', bridgeQuotePrice='100',
            quoteFetchedAt=iso(now), maxPriceMoveBps='50', leverage=1, kevReviewSha256=review_hash,
            clock=dict(mode=mode, source=('https://demo-fapi.binance.com/fapi/v1/time' if short else 'https://demo-api.binance.com/api/v3/time'),
                requestStartedAt=now-10, receivedAt=now, serverTime=now)))
    write_cost_fixture(root, value, proof)
    return value


@pytest.fixture
def frozen(tmp_path, monkeypatch):
    return isolate(monkeypatch, tmp_path)


def authorize(exchange, value, amount=.25, rate=100):
    return guard.authorize_entry(exchange, value, exchange._protection_mode, value['pair'],
        'short' if value['isShort'] else 'long', amount, rate, 'market')


def context(exchange, value):
    return guard.order_context(exchange, pair=value['pair'], side='sell' if value['isShort'] else 'buy',
        amount=.25, rate=100, leverage=1, reduce_only=False, initial_order=True, order_type='market')


def wire(exchange, value):
    host = 'https://demo-fapi.binance.com/fapi/v1/order' if value['isShort'] else 'https://demo-api.binance.com/api/v3/order'
    side = 'SELL' if value['isShort'] else 'BUY'
    guard.guard_order_wire(exchange, host, 'POST', f'symbol=ETHUSDT&side={side}&type=MARKET&quantity=0.25')


@pytest.mark.parametrize('short', [False, True])
@pytest.mark.parametrize('minute', [0, 1, 2, 3, 4])
def test_kev_can_choose_direction_and_enter_every_minute_without_candles(frozen, tmp_path, short, minute):
    frozen['wall'] += minute*60000
    frozen['mono'] += minute*60000
    value = plan(tmp_path, short, minute)
    proof = value['entryConfirmation']['orderFlow']
    with pytest.raises(FlowValidationError):
        validate_flow(proof, value['nativeEntryGuard']['mode'], value['pair'], 'short' if short else 'long', frozen['wall'])
    exchange = fake_exchange(value['nativeEntryGuard']['mode'])
    assert valid_plan(value, value['pair'], short, value['tag']) is value
    model_stop = tmp_path / 'local/model-research/STOP'
    model_stop.parent.mkdir(parents=True)
    model_stop.write_text('Kronos is not an authority for this route')
    assert authorize(exchange, value)
    with context(exchange, value):
        wire(exchange, value)
        with pytest.raises(ccxt.PermissionDenied, match='WIRE_CONTEXT_REQUIRED'):
            wire(exchange, value)


@pytest.mark.parametrize('mutation', [
    lambda p: p.update(model=None), lambda p: p.update(atrTimeframe='15m'),
    lambda p: p.update(candleBoundary=BOUNDARY), lambda p: p.update(adaptiveParameters={}),
    lambda p: p.update(timeframe='5m'), lambda p: p.update(ruleVersion='kronos-direction-v12'),
    lambda p: p.update(entryPolicyVersion='order-flow-only-v1'), lambda p: p.update(targetFraction=.02),
    lambda p: p.update(stopFraction=.01), lambda p: p.update(maxHoldingSeconds=14400),
    lambda p: p['nativeEntryGuard'].update(decisionBoundary=BOUNDARY+1),
    lambda p: p['nativeEntryGuard'].update(entryDeadline=BOUNDARY+60001),
    lambda p: p['nativeEntryGuard'].update(kevReviewSha256='d'*64),
    lambda p: p['nativeEntryGuard'].update(leverage=2),
    lambda p: p['entryEvidence']['kevReview']['decision'].update(action='open-short'),
    lambda p: p['entryEvidence']['kevReview'].update(model='wrong-model'),
    lambda p: p['entryConfirmation']['orderFlow']['trades'][1].update(a=9),
])
def test_kev_malformed_or_mixed_authority_plan_fails_closed(frozen, tmp_path, mutation):
    value = plan(tmp_path)
    mutation(value)
    with pytest.raises(ccxt.PermissionDenied):
        authorize(fake_exchange(), value)


@pytest.mark.parametrize('phase', ['callback', 'context', 'wire'])
@pytest.mark.parametrize('damage', ['stop', 'review', 'snapshot', 'clock', 'expiry'])
def test_native_rechecks_mutations_and_timing_at_every_boundary(frozen, tmp_path, phase, damage):
    value, exchange = plan(tmp_path), fake_exchange()
    def mutate():
        if damage == 'stop':
            (tmp_path / 'local/demo/STOP').write_text('pause')
        elif damage == 'review':
            (tmp_path / 'local/demo/runs' / (SNAPSHOT_ID+'.kev-review.json')).write_text('{}')
        elif damage == 'snapshot':
            path = tmp_path / 'local/demo/runs' / (SNAPSHOT_ID+'.snapshot.json')
            snapshot = json.loads(path.read_text())
            snapshot['markets'][0]['orderFlow']['trades'][0]['q'] = '2'
            write_json(path, snapshot)
        elif damage == 'clock':
            frozen['wall'] += 251
        else:
            frozen['wall'] += 41000
            frozen['mono'] += 41000
    if phase == 'callback':
        mutate()
        # A callback establishes the wall/monotonic baseline itself.
        if damage == 'clock':
            value['nativeEntryGuard']['clock']['serverTime'] += 5000
        with pytest.raises(ccxt.PermissionDenied):
            authorize(exchange, value)
    else:
        assert authorize(exchange, value)
        if phase == 'context':
            mutate()
            with pytest.raises(ccxt.PermissionDenied):
                with context(exchange, value):
                    pass
        else:
            with context(exchange, value):
                mutate()
                with pytest.raises(ccxt.PermissionDenied):
                    wire(exchange, value)


@pytest.mark.parametrize('damage', ['trade_gap', 'book_gap', 'source', 'stale', 'nonfinite'])
def test_data_only_flow_retains_source_structure_and_freshness(tmp_path, damage):
    proof = plan(tmp_path)['entryConfirmation']['orderFlow']
    if damage == 'trade_gap': proof['trades'][1]['a'] += 1
    elif damage == 'book_gap': proof['books'][1]['at'] += 19000
    elif damage == 'source': proof['source'] = 'https://api.binance.com'
    elif damage == 'stale': proof['books'][-1]['at'] -= 46000
    else: proof['books'][0]['bids'][0][1] = 'NaN'
    with pytest.raises(FlowValidationError):
        validate_flow(proof, 'demo', 'ETH/USDT', 'long', MS, data_only=True)


def test_cost_and_position_risk_remain_native_constraints(frozen, tmp_path):
    value = plan(tmp_path)
    with pytest.raises(ccxt.PermissionDenied, match='RISK_BUDGET'):
        authorize(fake_exchange(), value, amount=1)
    # 20 bps actual spot fees + 10 bps slippage + 1 bps spread stays eligible.
    assert value['riskCostFraction'] == .0031
    assert authorize(fake_exchange(), value)
    write_cost_fixture(tmp_path, value, value['entryConfirmation']['orderFlow'], buy='.002', sell='.002')
    with pytest.raises(ccxt.PermissionDenied, match='NET_REWARD_RISK'):
        authorize(fake_exchange(), value)
    value = plan(tmp_path)
    with pytest.raises(ccxt.PermissionDenied, match='PRICE_MOVED'):
        authorize(fake_exchange(), value, amount=.24, rate=101)


def move_kev_bridge_quote(root, value, signed_bps):
    """Keep the approved quote fixed; only replace the fresh execution book."""
    path = quote_path(root, value)
    quote = json.loads(path.read_text())
    side = 'bid' if value['isShort'] else 'ask'
    anchor = Decimal(quote[side])
    factor = 1 + Decimal(str(signed_bps)) / 10000
    quote.update(bid=str(Decimal(quote['bid']) * factor), ask=str(Decimal(quote['ask']) * factor))
    write_json(path, quote)
    bridge = Decimal(quote[side])
    value['entryConfirmation']['quotePrice'] = str(bridge)
    value['nativeEntryGuard'].update(bridgeQuotePrice=str(bridge), maxPriceMoveBps=100)
    return anchor, bridge


@pytest.mark.parametrize('short', [False, True])
@pytest.mark.parametrize('signed_bps', [-90, -6, 6, 90])
def test_bridge_cannot_reanchor_the_original_kev_quote(frozen, tmp_path, short, signed_bps):
    value = plan(tmp_path, short)
    _, bridge = move_kev_bridge_quote(tmp_path, value, signed_bps)
    with pytest.raises(ccxt.PermissionDenied, match='KEV_DECISION_QUOTE_MOVED'):
        authorize(fake_exchange(value['nativeEntryGuard']['mode']), value, amount=.2, rate=str(bridge))


@pytest.mark.parametrize('short', [False, True])
@pytest.mark.parametrize('sign', [-1, 1])
def test_two_four_bps_legs_cannot_spend_the_five_bps_budget_twice(frozen, tmp_path, short, sign):
    value = plan(tmp_path, short)
    _, bridge = move_kev_bridge_quote(tmp_path, value, sign * 4)
    callback = bridge * (1 + Decimal(sign * 4) / 10000)
    with pytest.raises(ccxt.PermissionDenied, match='KEV_DECISION_QUOTE_MOVED'):
        authorize(fake_exchange(value['nativeEntryGuard']['mode']), value, amount=.2, rate=str(callback))


@pytest.mark.parametrize('short', [False, True])
@pytest.mark.parametrize('sign', [-1, 1])
def test_original_quote_budget_boundary_is_inclusive_without_float_epsilon(frozen, tmp_path, short, sign):
    value = plan(tmp_path, short)
    anchor, bridge = move_kev_bridge_quote(tmp_path, value, sign * 4)
    rate = anchor * (1 + Decimal(sign * 5) / 10000)
    exchange = fake_exchange(value['nativeEntryGuard']['mode'])
    assert authorize(exchange, value, amount=.2, rate=str(rate))
    guard.clear_entry_permit()
    rate += Decimal(sign) * Decimal('0.000000000001')
    with pytest.raises(ccxt.PermissionDenied, match='KEV_DECISION_QUOTE_MOVED'):
        authorize(exchange, value, amount=.2, rate=str(rate))


@pytest.mark.parametrize('phase', ['callback', 'context', 'wire'])
@pytest.mark.parametrize('short', [False, True])
def test_native_rechecks_the_quote_budget_at_every_boundary(frozen, tmp_path, phase, short):
    value = plan(tmp_path, short)
    mode = value['nativeEntryGuard']['mode']
    exchange = fake_exchange(mode)
    def damage():
        # A later bridge rewrite cannot supersede the immutable model quote.
        # Copy the same changed plan to the pending permit to get beyond the
        # existing context identity check and exercise the independent guard.
        move_kev_bridge_quote(tmp_path, value, 6)
        permit = guard._pending.get() or guard._active.get()
        if permit is not None:
            permit['plan']['entryConfirmation']['quotePrice'] = value['entryConfirmation']['quotePrice']
            permit['plan']['nativeEntryGuard'].update(value['nativeEntryGuard'])
    if phase == 'callback':
        damage()
        with pytest.raises(ccxt.PermissionDenied, match='KEV_DECISION_QUOTE_MOVED'):
            authorize(exchange, value)
    else:
        assert authorize(exchange, value)
        if phase == 'context':
            damage()
            with pytest.raises(ccxt.PermissionDenied, match='KEV_DECISION_QUOTE_MOVED'):
                with context(exchange, value):
                    pass
        else:
            with context(exchange, value):
                damage()
                with pytest.raises(ccxt.PermissionDenied, match='KEV_DECISION_QUOTE_MOVED'):
                    wire(exchange, value)


@pytest.mark.parametrize('damage', ['bid', 'ask', 'time', 'duplicate'])
def test_quote_anchor_must_match_the_original_review_market(frozen, tmp_path, damage):
    value = plan(tmp_path)
    path = tmp_path / 'local/demo/runs' / (SNAPSHOT_ID + '.kev-review.json')
    review = json.loads(path.read_text())
    markets = review['request']['state']['markets']
    if damage in ('bid', 'ask'):
        markets[0][damage] = '101'
    elif damage == 'time':
        markets[0]['quoteObservedAt'] = iso(MS - 1)
    else:
        markets.append(copy.deepcopy(markets[0]))
    value['nativeEntryGuard']['kevReviewSha256'] = write_json(path, review)
    with pytest.raises(ccxt.PermissionDenied):
        authorize(fake_exchange(), value)


def test_host_cannot_raise_the_cap_beyond_cost_config(frozen, tmp_path):
    value = plan(tmp_path)
    value['nativeEntryGuard']['maxPriceMoveBps'] = 100000
    with pytest.raises(ccxt.PermissionDenied, match='KEV_DECISION_QUOTE_MOVED'):
        authorize(fake_exchange(), value, amount=.2, rate=100.08)


@pytest.mark.parametrize('short', [False, True])
@pytest.mark.parametrize('phase', ['callback', 'context', 'wire'])
@pytest.mark.parametrize('damage', [
    'facts_missing', 'facts_source', 'facts_stale', 'pair_duplicate', 'fee_missing', 'fee_negative',
    'fee_method', 'snapshot_total', 'quote_missing', 'quote_torn', 'quote_source', 'quote_time',
    'quote_spread', 'quote_book', 'config_slip',
])
def test_native_cost_proof_rechecked_at_all_three_boundaries(frozen, tmp_path, short, phase, damage):
    value = plan(tmp_path, short)
    exchange = fake_exchange(value['nativeEntryGuard']['mode'])
    snapshot_path = tmp_path / 'local' / value['nativeEntryGuard']['mode'] / 'runs' / (SNAPSHOT_ID+'.snapshot.json')

    def mutate():
        path = quote_path(tmp_path, value) if damage.startswith('quote_') else (
            tmp_path / 'config/costs.json' if damage.startswith('config_') else snapshot_path)
        if damage == 'quote_missing':
            path.unlink()
            return
        if damage == 'quote_torn':
            path.write_text('{"pair":')
            return
        data = json.loads(path.read_text())
        if damage == 'facts_missing': del data['costFacts']
        elif damage == 'facts_source': data['costFacts']['source'] = 'https://api.binance.com'
        elif damage == 'facts_stale': data['costFacts']['observedAt'] = iso(frozen['wall']-300001)
        elif damage == 'pair_duplicate': data['costFacts']['rates'] *= 2
        elif damage == 'fee_missing': del data['costFacts']['rates'][0]['sellRate']
        elif damage == 'fee_negative': data['costFacts']['rates'][0]['buyRate'] = '-0.001'
        elif damage == 'fee_method': data['costFacts']['rates'][0]['method'] = 'assumed_discount'
        elif damage == 'snapshot_total': data['markets'][0]['entryCost']['estimatedRoundTripCostBps'] = '0'
        elif damage == 'quote_source': data['source'] = 'https://api.binance.com'
        elif damage == 'quote_time': data['fetchedAt'] = iso(frozen['wall']-1)
        elif damage == 'quote_spread': data['spreadBps'] = 0
        elif damage == 'quote_book': data['ask'] = '100.02'
        elif damage == 'config_slip': data['slippageBpsPerSide'] = 0
        else: raise AssertionError(damage)
        write_json(path, data)

    if phase == 'callback':
        mutate()
        with pytest.raises(ccxt.PermissionDenied):
            authorize(exchange, value)
    else:
        assert authorize(exchange, value)
        if phase == 'context':
            mutate()
            with pytest.raises(ccxt.PermissionDenied):
                with context(exchange, value): pass
        else:
            with context(exchange, value):
                mutate()
                with pytest.raises(ccxt.PermissionDenied):
                    wire(exchange, value)


@pytest.mark.parametrize('short', [False, True])
def test_host_cannot_reduce_cost_and_buffer_together(frozen, tmp_path, short):
    value = plan(tmp_path, short)
    value['riskCostFraction'] = 0
    value['nativeEntryGuard']['requiredPriceSpaceBps'] = '30'
    with pytest.raises(ccxt.PermissionDenied, match='KEV_COST_PLAN'):
        authorize(fake_exchange(value['nativeEntryGuard']['mode']), value)


@pytest.mark.parametrize('short', [False, True])
def test_snapshot_costs_must_match_the_costs_kev_reviewed(frozen, tmp_path, short):
    value = plan(tmp_path, short)
    path = tmp_path / 'local' / value['nativeEntryGuard']['mode'] / 'runs' / (SNAPSHOT_ID+'.kev-review.json')
    review = json.loads(path.read_text())
    review['request']['state']['markets'][0]['costs']['roundTripFeeBps'] = '0'
    value['nativeEntryGuard']['kevReviewSha256'] = write_json(path, review)
    with pytest.raises(ccxt.PermissionDenied, match='KEV_COST_REVIEW'):
        authorize(fake_exchange(value['nativeEntryGuard']['mode']), value)


@pytest.mark.parametrize('short', [False, True])
def test_native_uses_fresh_spread_and_funding_separately_from_snapshot(frozen, tmp_path, short):
    value = plan(tmp_path, short)
    path = quote_path(tmp_path, value)
    quote = json.loads(path.read_text())
    quote.update(ask='100.03', spreadBps=3)
    if short: quote['fundingRate'] = '-0.0002'
    write_json(path, quote)
    fresh_total = Decimal(35 if short else 33)
    price = quote['bid' if short else 'ask']
    value['entryConfirmation']['quotePrice'] = price
    value['nativeEntryGuard'].update(bridgeQuotePrice=price, requiredPriceSpaceBps=str(fresh_total+30))
    value['riskCostFraction'] = float(fresh_total/10000)
    exchange = fake_exchange(value['nativeEntryGuard']['mode'])
    assert authorize(exchange, value)
    with context(exchange, value): wire(exchange, value)
    # The original 31-bps snapshot would understate the updated executable book.
    value['riskCostFraction'] = .0031
    value['nativeEntryGuard']['requiredPriceSpaceBps'] = '61'
    with pytest.raises(ccxt.PermissionDenied, match='KEV_COST_PLAN'):
        authorize(exchange, value)


@pytest.mark.parametrize('phase', ['callback', 'context', 'wire'])
def test_futures_funding_cannot_disappear_after_review(frozen, tmp_path, phase):
    value = plan(tmp_path, True)
    write_cost_fixture(tmp_path, value, value['entryConfirmation']['orderFlow'], funding='-.0002')
    exchange = fake_exchange('demo-futures')
    def remove():
        path = quote_path(tmp_path, value)
        quote = json.loads(path.read_text())
        del quote['fundingRate']
        write_json(path, quote)
    if phase == 'callback':
        remove()
        with pytest.raises(ccxt.PermissionDenied, match='KEV_COST_FUNDING'): authorize(exchange, value)
    else:
        assert authorize(exchange, value)
        if phase == 'context':
            remove()
            with pytest.raises(ccxt.PermissionDenied, match='KEV_COST_FUNDING'):
                with context(exchange, value): pass
        else:
            with context(exchange, value):
                remove()
                with pytest.raises(ccxt.PermissionDenied, match='KEV_COST_FUNDING'): wire(exchange, value)


@pytest.mark.parametrize('phase', ['context', 'wire'])
def test_fee_sample_expiry_is_rechecked_after_authorization(frozen, tmp_path, phase):
    value = plan(tmp_path)
    folder = tmp_path / 'local/demo/runs'
    snapshot_path, review_path = folder / (SNAPSHOT_ID+'.snapshot.json'), folder / (SNAPSHOT_ID+'.kev-review.json')
    snapshot, review = json.loads(snapshot_path.read_text()), json.loads(review_path.read_text())
    observed = iso(frozen['wall']-300000)
    snapshot['costFacts']['observedAt'] = snapshot['markets'][0]['entryCost']['observedAt'] = observed
    review['request']['state']['markets'][0]['costs']['observedAt'] = observed
    write_json(snapshot_path, snapshot)
    value['nativeEntryGuard']['kevReviewSha256'] = write_json(review_path, review)
    exchange = fake_exchange()
    assert authorize(exchange, value)
    def advance():
        frozen['wall'] += 1
        frozen['mono'] += 1
    if phase == 'context':
        advance()
        with pytest.raises(ccxt.PermissionDenied, match='KEV_COST_STALE'):
            with context(exchange, value): pass
    else:
        with context(exchange, value):
            advance()
            with pytest.raises(ccxt.PermissionDenied, match='KEV_COST_STALE'): wire(exchange, value)


@pytest.mark.parametrize('short', [False, True])
def test_persisted_kev_plan_retains_seconds_exit_without_research_files(tmp_path, short, monkeypatch):
    value = plan(tmp_path, short)
    def forbidden(*_args): raise AssertionError('Existing exits must not read entry fee/research proof')
    monkeypatch.setattr(guard, '_read_kev_json', forbidden)
    strategy = RuleExits()
    now = datetime.fromtimestamp(MS / 1000, timezone.utc)
    trade = SimpleNamespace(pair=value['pair'], is_short=short, enter_tag=TAG,
        get_custom_data=lambda key, default=None: value if key == 'rule_plan' else default,
        open_rate=100, open_date_utc=now, leverage=1)
    assert strategy._rule_plan(trade) is value
    assert strategy.custom_roi(value['pair'], trade, now, 0, TAG, 'short' if short else 'long') is None
    assert strategy.custom_exit(value['pair'], trade, now+timedelta(seconds=899), 100, 0) is None
    assert strategy.custom_exit(value['pair'], trade, now+timedelta(seconds=900), 100, 0) == 'rules_time'
    assert strategy.custom_exit(value['pair'], trade, now, 98 if short else 102, .02) == 'rules_target'
    assert strategy.custom_exit(value['pair'], trade, now, 101 if short else 99, -.01) == 'rules_stop'


def test_kev_callback_rejection_receipt_uses_minute_identity(frozen, tmp_path):
    value = plan(tmp_path, minute=1)
    write_json(tmp_path / 'local/demo/entry-plans' / (TAG+'.json'), value)
    assert guard.record_callback_rejection(value, 'demo', value['pair'], TAG, 'DEMO_NATIVE_MODEL_KEV_SELECTION')
    receipt = json.loads((tmp_path / 'local/demo/entry-rejections' / (TAG+'.json')).read_text())
    assert receipt['nativeEntryGuardVersion'] == 'kev-native-entry-v1'
    assert receipt['decisionBoundary'] == BOUNDARY+60000


@pytest.fixture(scope='module')
def host_plans():
    executable = os.environ.get('BINANCETRADE_NODE')
    if not executable:
        bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
        executable = str(bundled) if bundled.is_file() else shutil.which('node')
    assert executable, 'Node is required for the actual host/native contract'
    source = """
import {mock} from 'node:test';
import {buildKevFlowBridgePlan,KEV_BRIDGE_TEST_NOW} from './test/kev-flow-bridge-fixture.mjs';
mock.timers.enable({apis:['Date'],now:KEV_BRIDGE_TEST_NOW});
try {
 const rows=[];
 for (const [mode,short] of [['demo',false],['demo-futures',false],['demo-futures',true]])
  rows.push(await buildKevFlowBridgePlan({mode,short}));
 console.log(JSON.stringify(rows));
} finally { mock.timers.reset(); }
"""
    result = subprocess.run([executable, '--input-type=module', '-e', source],
        cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    return {(row['mode'], row['short']): row for row in json.loads(result.stdout)}


@pytest.mark.parametrize('case', [('demo', False), ('demo-futures', False), ('demo-futures', True)])
def test_actual_candle_free_host_plan_through_native_callback_context_wire(host_plans, frozen, tmp_path, monkeypatch, case):
    f = copy.deepcopy(host_plans[case])
    frozen.update(wall=f['now'], mono=100000.0)
    folder = tmp_path / 'local' / f['mode'] / 'runs'
    folder.mkdir(parents=True)
    snapshot_id = f['snapshot']['id']
    (folder / (snapshot_id+'.kev-review.json')).write_bytes(f['reviewRaw'].encode())
    write_json(folder / (snapshot_id+'.snapshot.json'), f['snapshot'])
    write_json(tmp_path / 'config/costs.json', f['costConfig'])
    write_json(quote_path(tmp_path, f['plan']), f['executionQuote'])
    def no_network(*_args, **_kwargs):
        raise AssertionError('Native contract fixture must not connect to a network')
    monkeypatch.setattr(socket.socket, 'connect', no_network)
    plan = f['plan']
    assert f['boundary'] % 300000 != 0
    assert plan['timeframe'] == 'order-flow' and 'candleBoundary' not in plan
    assert valid_plan(plan, f['pair'], f['short'], plan['tag']) is plan
    exchange = fake_exchange(f['mode'])
    calls, original = [], guard._validate
    def observed(permit, now, mono):
        calls.append(permit['plan']['snapshotId'])
        return original(permit, now, mono)
    monkeypatch.setattr(guard, '_validate', observed)
    strategy = RuleExits()
    strategy.config = {'trading_mode': 'spot' if f['mode'] == 'demo' else 'futures'}
    strategy.dp = SimpleNamespace(_exchange=exchange)
    strategy._entry_plan = lambda *_: plan
    assert strategy.entry_risk_allowed(pair=f['pair'], order_type='market', amount=f['amount'], rate=f['rate'],
        time_in_force='GTC', current_time=datetime.fromtimestamp(f['now']/1000, timezone.utc),
        entry_tag=plan['tag'], side='short' if f['short'] else 'long')
    assert len(calls) == 1
    with guard.order_context(exchange, pair=f['pair'], side='sell' if f['short'] else 'buy', amount=f['amount'],
            rate=f['rate'], leverage=1, reduce_only=False, initial_order=True, order_type='market') as state:
        assert len(calls) == 2
        endpoint = 'https://demo-api.binance.com/api/v3/order' if f['mode'] == 'demo' else 'https://demo-fapi.binance.com/fapi/v1/order'
        side = 'SELL' if f['short'] else 'BUY'
        body = f'symbol=ETHUSDT&side={side}&type=MARKET&quantity=0.1'
        guard.guard_order_wire(exchange, endpoint, 'POST', body)
        assert len(calls) == 3 and state['wireSent'] is True
        with pytest.raises(ccxt.PermissionDenied, match='WIRE_CONTEXT_REQUIRED'):
            guard.guard_order_wire(exchange, endpoint, 'POST', body)
