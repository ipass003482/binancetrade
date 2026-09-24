"""One-use native entry proof; no credentials, network calls or order retries.

The bridge establishes the model decision. Native code only enforces the same
deadline, price-space and STOP constraints after RPC queuing / CCXT throttling.
"""
import copy
import json
import math
import os
import re
import tempfile
import time
from hashlib import sha256
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from urllib.parse import urlsplit, parse_qsl

from ccxt import PermissionDenied
from demo_order_flow import validate_flow, derive_adaptive_parameters

from demo_flow_exit import QUALITY_VERSION, POLICY as FLOW_EXIT_POLICY, strength as flow_strength

ROOT = Path(__file__).resolve().parents[1]
VERSION = 'kronos-native-entry-v12'
MINUTE_LEGACY_VERSION = 'kronos-native-entry-v11'
LEGACY_VERSION = 'kronos-native-entry-v10'
_MINUTE_VERSIONS = (VERSION, MINUTE_LEGACY_VERSION)
_CADENCE_KEYS = {'decisionCadenceVersion', 'decisionIntervalMs', 'decisionBoundary'}
RULE_VERSION = 'kronos-direction-v12'
KEV_RULE_VERSION = 'kev-order-flow-v1'
KEV_GUARD_VERSION = 'kev-native-entry-v1'
PROBE_VERSION = 'demo-execution-probe-v1'
RISK_POLICY_VERSION = 'native-stop-risk-v1'
_pending = ContextVar('demo_model_pending_entry', default=None)
_active = ContextVar('demo_model_active_order', default=None)
_GUARD_KEYS = {'version', 'snapshotId', 'mode', 'pair', 'side', 'modelFingerprint',
               'predictionSha256', 'candleBoundary', 'modelDeadline', 'issuedAt',
               'requiredPriceSpaceBps', 'forecastClose', 'bridgeQuotePrice',
               'quoteFetchedAt', 'maxPriceMoveBps', 'leverage', 'clock',
               'forecastCloses', 'originClose', 'atr15', 'targetAtr', 'targetFraction'}
_HEX = re.compile(r'[a-f0-9]{64}')
_UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
MODEL_ASSIST_VERSION = 'kronos-flow-v1'
# Retain the historical Futures-only identity for archived entry plans.
FUTURES_MODEL_ASSIST_VERSION = 'futures-kronos-flow-v1'


def wall_ms():
    return time.time_ns() // 1_000_000


def monotonic_ms():
    return time.monotonic_ns() / 1_000_000


def reject(code):
    raise PermissionDenied('DEMO_NATIVE_MODEL_' + code)


def decimal(value, positive=False, *, signed=False):
    if type(value) not in (int, float, str) or (isinstance(value, str) and not value.strip()):
        reject('NUMBER_INVALID')
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        reject('NUMBER_INVALID')
    if not result.is_finite() or abs(result.adjusted()) > 50 or (result <= 0 if positive else (result < 0 and not signed)):
        reject('NUMBER_INVALID')
    return result


def timestamp(value):
    try:
        if not isinstance(value, str):
            reject('TIME_INVALID')
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            reject('TIME_INVALID')
        stamp = parsed.timestamp() * 1000
        if not math.isfinite(stamp) or stamp < 0:
            reject('TIME_INVALID')
        return round(stamp)
    except (ValueError, OverflowError, TypeError):
        reject('TIME_INVALID')


def clock_range(clock, mode, now):
    expected = ('https://demo-api.binance.com/api/v3/time' if mode == 'demo'
                else 'https://demo-fapi.binance.com/fapi/v1/time')
    if (not isinstance(clock, dict) or clock.get('mode') != mode or clock.get('source') != expected
            or any(type(clock.get(k)) is not int or not 0 < clock[k] <= 2**53 - 1
                   for k in ('serverTime', 'requestStartedAt', 'receivedAt'))):
        reject('CLOCK_INVALID')
    rtt = clock['receivedAt'] - clock['requestStartedAt']
    lower = clock['serverTime'] - clock['receivedAt']
    upper = clock['serverTime'] - clock['requestStartedAt']
    if not 0 <= rtt <= 1500 or max(abs(lower), abs(upper)) > 2000:
        reject('CLOCK_INVALID')
    if not 0 <= now - clock['receivedAt'] <= 60000:
        reject('CLOCK_STALE')
    return now + lower, now + upper


def _stopped(mode, model):
    paths = [ROOT / 'local' / mode / 'STOP']
    if model:
        paths.append(ROOT / 'local/model-research/STOP')
    for path in paths:
        try:
            path.stat()
        except FileNotFoundError:
            continue
        except OSError:
            reject('STOP_UNREADABLE')
        reject('STOPPED')


def _entry_tag(plan, pair):
    version = plan.get('executionPolicyVersion')
    if version not in (None, 'per-pair-cycle-v1'):
        reject('EXECUTION_IDENTITY')
    snapshot = plan.get('snapshotId')
    if not isinstance(snapshot, str):
        reject('EXECUTION_IDENTITY')
    payload = json.dumps([version, snapshot, pair], separators=(',', ':')) if version else snapshot
    return 'codex-' + sha256(payload.encode()).hexdigest()[:32]


def _validate_model_assist(ai, mode, pair, side, snapshot_id):
    """Validate the optional host-side Kronos direction veto in a flow plan.

    The producer remains advisory and never sends an order.  Native code only
    checks the compact, immutable evidence copied into the entry plan; flow,
    price, cost, risk and protection checks below remain the actual authority.
    """
    current = (mode in ('demo', 'demo-futures') and isinstance(ai, dict)
               and ai.get('version') == MODEL_ASSIST_VERSION)
    legacy = (mode == 'demo-futures' and isinstance(ai, dict)
              and ai.get('version') == FUTURES_MODEL_ASSIST_VERSION)
    if (not current and not legacy
            or not isinstance(ai, dict)
            or ai.get('usedForEntryDecision') is not True
            or ai.get('snapshotId') != snapshot_id
            or ai.get('direction') != side
            or not isinstance(ai.get('modelFingerprint'), str) or not _HEX.fullmatch(ai['modelFingerprint'])
            or not isinstance(ai.get('predictionSha256'), str) or not _HEX.fullmatch(ai['predictionSha256'])
            or not isinstance(ai.get('issuedAt'), str)
            or not isinstance(ai.get('originClose'), str)
            or not isinstance(ai.get('forecastCloses'), list) or len(ai['forecastCloses']) != 3):
        reject('MODEL_ASSIST_IDENTITY')
    origin = decimal(ai['originClose'], True)
    closes = [decimal(value, True) for value in ai['forecastCloses']]
    if any((value <= origin if side == 'long' else value >= origin) for value in closes):
        reject('MODEL_ASSIST_DIRECTION')
    move = decimal(ai.get('forecastMoveBps'), signed=True)
    if move <= 0:
        reject('MODEL_ASSIST_MOVE')


def _guard(plan, mode, pair, side):
    if plan.get('entryPolicyVersion') == KEV_RULE_VERSION:
        return _kev_guard(plan, mode, pair, side)
    if plan.get('entryPolicyVersion') == 'order-flow-only-v1':
        return _flow_guard(plan, mode, pair, side)
    guard = plan.get('nativeEntryGuard')
    model, confirmation = plan.get('model'), plan.get('entryConfirmation')
    if (not isinstance(guard, dict) or set(guard) != _GUARD_KEYS or guard['version'] != LEGACY_VERSION
            or any(key in plan for key in _CADENCE_KEYS | {'adaptiveParameters'})
            or guard['mode'] != mode or guard['pair'] != pair or guard['side'] != side
            or plan.get('purpose') != 'strategy' or plan.get('ruleVersion') != RULE_VERSION
            or not isinstance(guard['snapshotId'], str) or not _UUID.fullmatch(guard['snapshotId'])
            or guard['snapshotId'] != plan.get('snapshotId')
            or plan.get('tag') != _entry_tag(plan, pair)
            or any(not isinstance(guard[k], str) or not _HEX.fullmatch(guard[k])
                   for k in ('modelFingerprint', 'predictionSha256'))
            or not isinstance(model, dict) or model.get('usedForEntryDecision') is not True
            or model.get('snapshotId') != guard['snapshotId']
            or any(model.get(k) != guard[k] for k in ('modelFingerprint', 'predictionSha256', 'issuedAt'))
            or not isinstance(confirmation, dict) or confirmation.get('version') != 'kronos-direction-atr-v1'
            or any(confirmation.get(k) != guard[k] for k in ('modelFingerprint', 'predictionSha256', 'issuedAt'))
            or type(guard['candleBoundary']) is not int or guard['candleBoundary'] <= 0
            or guard['candleBoundary'] % 300000 or type(guard['modelDeadline']) is not int
            or guard['modelDeadline'] != guard['candleBoundary'] + 60000
            or confirmation.get('confirmationAt') != guard['candleBoundary']
            or confirmation.get('targetCloseAt') != guard['candleBoundary'] + 900000 - 1):
        reject('GUARD_IDENTITY')
    if (decimal(guard['forecastClose'], True) != decimal(confirmation.get('forecastClose'), True)
            or decimal(guard['bridgeQuotePrice'], True) != decimal(confirmation.get('quotePrice'), True)
            or decimal(guard['requiredPriceSpaceBps']) < decimal(plan.get('riskCostFraction')) * 10000):
        reject('GUARD_IDENTITY')
    # Preserve the actual model path. ATR supplies an exit-distance hypothesis,
    # not a replacement/amplification of the model's forecast close.
    path, confirmed_path = guard['forecastCloses'], confirmation.get('forecastCloses')
    if (not isinstance(path, list) or len(path) != 3 or not isinstance(confirmed_path, list)
            or len(confirmed_path) != 3 or plan.get('atrTimeframe') != '15m'):
        reject('GUARD_IDENTITY')
    closes = [decimal(value, True) for value in path]
    if (closes != [decimal(value, True) for value in confirmed_path]
            or closes[-1] != decimal(guard['forecastClose'], True)
            or any(decimal(guard[key], True) != decimal(confirmation.get(key), True)
                   for key in ('originClose', 'atr15', 'targetAtr', 'targetFraction'))):
        reject('GUARD_IDENTITY')
    origin = decimal(guard['originClose'], True)
    if plan.get('entryPolicyVersion') in ('trend-pullback-model-v1', 'trend-pullback-flow-v1'):
        if plan.get('entryPolicyVersion') == 'trend-pullback-flow-v1':
            checks = _pullback(confirmation.get('priceConfirmation'), guard['candleBoundary'], side, origin, allow_flow=True)
            route = confirmation.get('entryRoute')
            if route == 'pullback':
                if not all(checks.values()):
                    reject('PULLBACK_SIGNAL')
            elif route == 'order-flow' and checks['trend']:
                try:
                    validate_flow(confirmation.get('orderFlow'), mode, pair, side, timestamp(guard['quoteFetchedAt']))
                except Exception:
                    reject('FLOW_EVIDENCE')
            else:
                reject('FLOW_ROUTE')
        else:
            _pullback(confirmation.get('priceConfirmation'), guard['candleBoundary'], side, origin)
        with localcontext() as context:
            context.prec=40
            expected_stop=min(decimal(guard['atr15'], True)/origin, Decimal('.02'))
            if abs(decimal(plan.get('stopFraction'), True)-expected_stop)>Decimal('1e-12'):
                reject('ATR_STOP_IDENTITY')
            # The host retains an exact decimal required-space string, but the
            # legacy exit plan serializes costFraction as an IEEE-754 number.
            # At most one ULP accounts for that serialization, never a bps buffer cut.
            cost_value=plan.get('riskCostFraction')
            serialized_ulp=Decimal(str(math.ulp(float(cost_value))))
            if decimal(guard['requiredPriceSpaceBps']) < (decimal(cost_value)-serialized_ulp)*10000+30:
                reject('COST_BUFFER_IDENTITY')
    elif plan.get('entrySignalEngine') != 'kronos_ai':
        momentum = confirmation.get('priceConfirmation')
        if (plan.get('entryPolicyVersion') != 'forecast-net-edge-v1'
                or not isinstance(momentum, dict)
                or set(momentum) != {'version', 'confirmationAt', 'closeTimes', 'closes', 'eligible'}
                or momentum['version'] != 'closed-price-momentum-v1' or momentum['eligible'] is not True
                or momentum['confirmationAt'] != guard['candleBoundary']
                or not isinstance(momentum['closeTimes'], list) or len(momentum['closeTimes']) != 4
                or any(type(v) is not int for v in momentum['closeTimes'])
                or momentum['closeTimes'] != [guard['candleBoundary'] - (3-i)*300000 - 1 for i in range(4)]
                or not isinstance(momentum['closes'], list) or len(momentum['closes']) != 4):
            reject('MOMENTUM_IDENTITY')
        observed = [decimal(value, True) for value in momentum['closes']]
        if observed[-1] != origin:
            reject('MOMENTUM_IDENTITY')
        if any((origin <= observed[i] if side == 'long' else origin >= observed[i]) for i in (0, 2)):
            reject('MOMENTUM_DIRECTION')
    if any((value <= origin if side == 'long' else value >= origin) for value in closes):
        reject('DIRECTION_PATH')
    with localcontext() as context:
        context.prec = 40
        fraction = decimal(guard['targetFraction'], True)
        target_atr = 3 if plan.get('entryPolicyVersion') in ('trend-pullback-model-v1', 'trend-pullback-flow-v1') else 2
        if (decimal(guard['targetAtr'], True) != target_atr or fraction > 1
                or fraction != decimal(plan.get('targetFraction'), True)
                or abs(target_atr * decimal(guard['atr15'], True) / origin - fraction) > Decimal('1e-12')):
            reject('ATR_TARGET_IDENTITY')
    decimal(guard['maxPriceMoveBps'])
    leverage = decimal(guard['leverage'], True)
    if leverage < 1 or leverage > 3 or (mode == 'demo' and leverage != 1):
        reject('LEVERAGE_INVALID')
    timestamp(guard['issuedAt'])
    timestamp(guard['quoteFetchedAt'])
    return guard



def _read_kev_json(path, limit):
    try:
        with path.open('rb') as source:
            raw = source.read(limit + 1)
        if len(raw) > limit:
            reject('KEV_EVIDENCE_SIZE')
        value = json.loads(raw, parse_constant=lambda _: reject('KEV_EVIDENCE_INVALID'))
        if not isinstance(value, dict):
            reject('KEV_EVIDENCE_INVALID')
        return value, raw
    except (OSError, ValueError, TypeError, UnicodeError):
        reject('KEV_EVIDENCE_UNREADABLE')


def _kev_costs(plan, guard, mode, pair, side, snapshot, market, reviewed_state, now):
    """Recompute host cost arithmetic from read-only facts and the fresh book.

    Snapshot spread belongs to the earlier Kev request. The executable book is
    a separate, existing bridge artifact; substituting the old spread here can
    reject valid entries or understate the amount used for native risk sizing.
    This is the original conservative risk estimate, not realized fill PnL.
    """
    config, _ = _read_kev_json(ROOT / 'config/costs.json', 8192)
    keys = {'version', 'maxAgeSeconds', 'slippageBpsPerSide', 'priceSpaceBufferBps', 'fundingReserveEvents'}
    if (set(config) != keys or type(config.get('version')) is not int or config['version'] != 1
            or type(config.get('maxAgeSeconds')) is not int or not 30 <= config['maxAgeSeconds'] <= 900
            or type(config.get('fundingReserveEvents')) is not int or not 1 <= config['fundingReserveEvents'] <= 12
            or any(type(config.get(k)) not in (int, float) for k in ('slippageBpsPerSide', 'priceSpaceBufferBps'))
            or not 0 <= decimal(config['slippageBpsPerSide']) <= 100
            or not 30 <= decimal(config['priceSpaceBufferBps']) <= 1000):
        reject('KEV_COST_CONFIG')
    source = 'https://demo-api.binance.com' if mode == 'demo' else 'https://demo-fapi.binance.com'
    method = 'standard_plus_tax_plus_special_no_bnb_discount' if mode == 'demo' else 'symbol_taker_rate'
    facts = snapshot.get('costFacts')
    if (not isinstance(facts, dict) or type(facts.get('schemaVersion')) is not int or facts['schemaVersion'] != 1
            or facts.get('mode') != mode or facts.get('kind') != 'costs' or facts.get('readOnly') is not True
            or facts.get('source') != source or not isinstance(facts.get('rates'), list)):
        reject('KEV_COST_FACTS')
    if not 0 <= now - timestamp(facts.get('observedAt')) <= config['maxAgeSeconds'] * 1000:
        reject('KEV_COST_STALE')
    matches = [row for row in facts['rates'] if isinstance(row, dict) and row.get('pair') == pair]
    if (len(matches) != 1 or matches[0].get('status') != 'ok' or matches[0].get('method') != method
            or any(not isinstance(matches[0].get(k), str) or not matches[0][k].strip() for k in ('buyRate', 'sellRate'))):
        reject('KEV_COST_RATES')
    buy, sell = (decimal(matches[0][key]) for key in ('buyRate', 'sellRate'))
    if max(buy, sell) > Decimal('.1'):
        reject('KEV_COST_RATES')

    def components(quote):
        if (not isinstance(quote, dict) or quote.get('pair') != pair or quote.get('mode') != mode
                or quote.get('source') != source or quote.get('timeframe') != 'order-flow'
                or quote.get('verifiedSpot' if mode == 'demo' else 'verifiedFutures') is not True
                or type(quote.get('spreadBps')) not in (int, float)):
            reject('KEV_COST_QUOTE')
        bid, ask = decimal(quote.get('bid'), True), decimal(quote.get('ask'), True)
        if ask < bid:
            reject('KEV_COST_QUOTE')
        spread = decimal(quote['spreadBps'])
        with localcontext() as context:
            context.prec = 40
            exact_spread = (ask - bid) / bid * 10000
            # The market producer serializes spread as a JS Number. Allow one
            # binary64 ULP only; it is not an additional trading-cost allowance.
            if abs(spread - exact_spread) > Decimal(str(math.ulp(float(quote['spreadBps'])))):
                reject('KEV_COST_SPREAD')
        if mode == 'demo-futures':
            if not isinstance(quote.get('fundingRate'), str) or not quote['fundingRate'].strip():
                reject('KEV_COST_FUNDING')
            funding_rate = abs(decimal(quote['fundingRate'], signed=True))
        else:
            funding_rate = Decimal(0)
        # decimal.js uses 20 significant digits for this unchanged host formula.
        # Match its operation order while independently deriving every operand.
        with localcontext() as context:
            context.prec = 20
            fees = (buy + sell) * 10000
            funding = funding_rate * 10000 * config['fundingReserveEvents']
            total = fees + spread + decimal(config['slippageBpsPerSide']) * 2 + funding
            required = total + decimal(config['priceSpaceBufferBps'])
        return dict(buyRate=buy, sellRate=sell, roundTripFeeBps=fees, spreadBps=spread,
            slippageBpsPerSide=decimal(config['slippageBpsPerSide']), fundingReserveBps=funding,
            fundingReserveEvents=Decimal(config['fundingReserveEvents']),
            estimatedRoundTripCostBps=total, requiredPriceSpaceBps=required)

    recorded = market.get('entryCost')
    expected = components(market)
    if (not isinstance(recorded, dict) or recorded.get('status') != 'ok' or recorded.get('pair') != pair
            or recorded.get('mode') != mode or recorded.get('source') != source or recorded.get('method') != method
            or recorded.get('observedAt') != facts['observedAt']
            or any(decimal(recorded.get(key)) != value for key, value in expected.items())):
        reject('KEV_COST_SNAPSHOT')
    reviewed_markets = reviewed_state.get('markets')
    reviewed = [row for row in reviewed_markets if isinstance(row, dict) and row.get('pair') == pair] if isinstance(reviewed_markets, list) else []
    reviewed_cost = reviewed[0].get('costs') if len(reviewed) == 1 else None
    reviewed_keys = ('estimatedRoundTripCostBps', 'requiredPriceSpaceBps', 'roundTripFeeBps',
                     'slippageBpsPerSide', 'fundingReserveBps')
    if (not isinstance(reviewed_cost, dict) or reviewed_cost.get('observedAt') != facts['observedAt']
            or any(decimal(reviewed_cost.get(key)) != expected[key] for key in reviewed_keys)):
        reject('KEV_COST_REVIEW')
    stem = guard['snapshotId']
    if plan.get('executionPolicyVersion'):
        stem += '.' + _entry_tag(plan, pair).removeprefix('codex-')
    quote, _ = _read_kev_json(ROOT / 'local' / mode / 'runs' / (stem + '.execution-quote.json'), 8 * 1024 * 1024)
    if (quote.get('fetchedAt') != guard['quoteFetchedAt']
            or not 0 <= now - timestamp(quote.get('fetchedAt')) <= 15000):
        reject('KEV_COST_QUOTE_TIME')
    fresh = components(quote)
    if decimal(quote['bid' if side == 'short' else 'ask'], True) != decimal(guard['bridgeQuotePrice'], True):
        reject('KEV_COST_QUOTE_PRICE')
    with localcontext() as context:
        context.prec = 20
        expected_fraction = fresh['estimatedRoundTripCostBps'] / 10000
    cost = decimal(plan.get('riskCostFraction'))
    ulp = Decimal(str(math.ulp(float(plan['riskCostFraction']))))
    if (abs(cost - expected_fraction) > ulp
            or decimal(guard['requiredPriceSpaceBps']) != fresh['requiredPriceSpaceBps']):
        reject('KEV_COST_PLAN')
    # Bind every pre-send rate to the original price Kev saw. Neither the
    # bridge quote nor a large legacy maxPriceMoveBps gets a second allowance.
    # This limits decision quote drift; a market fill can still differ.
    if (reviewed[0].get('quoteObservedAt') != market.get('fetchedAt')
            or any(decimal(reviewed[0].get(key), True) != decimal(market.get(key), True) for key in ('bid', 'ask'))):
        reject('KEV_DECISION_QUOTE_IDENTITY')
    timestamp(market.get('fetchedAt'))
    with localcontext() as context:
        context.prec = 40
        anchor = decimal(market['bid' if side == 'short' else 'ask'], True)
        headroom = decimal(plan['targetFraction'], True) * 10000 - max(expected['requiredPriceSpaceBps'], fresh['requiredPriceSpaceBps'])
        if headroom < 0:
            reject('KEV_DECISION_QUOTE_BUDGET')
        cap = min(decimal(guard['maxPriceMoveBps']), decimal(config['slippageBpsPerSide']),
                  decimal(plan['stopFraction'], True) * 10000, headroom)
        if abs(decimal(guard['bridgeQuotePrice'], True) - anchor) * 10000 > anchor * cap:
            reject('KEV_DECISION_QUOTE_MOVED')
    return dict(referencePrice=anchor, maxMoveBps=cap)


def _kev_review(plan, guard, mode, pair, side):
    """Bind the exact persisted host decision and source data, without model I/O."""
    folder = ROOT / 'local' / mode / 'runs'
    review, raw = _read_kev_json(folder / (guard['snapshotId'] + '.kev-review.json'), 262144)
    if sha256(raw).hexdigest() != guard['kevReviewSha256']:
        reject('KEV_REVIEW_HASH')
    receipt = plan['entryEvidence'].get('kevReview')
    action = 'buy' if mode == 'demo' else 'open-short' if side == 'short' else 'open-long'
    decisions, request, response = review.get('decisions'), review.get('request'), review.get('response')
    if (review.get('version') != 'kev-codex-entry-v1' or review.get('enabled') is not True
            or review.get('status') != 'reviewed' or review.get('decisionMode') != 'autonomous'
            or review.get('invoked') is not True or review.get('requestAttempted') is not True
            or review.get('mode') != mode or review.get('snapshotId') != guard['snapshotId']
            or not isinstance(review.get('actualModel'), str) or not review['actualModel']
            or not isinstance(review.get('requestId'), str) or not review['requestId']
            or any(not isinstance(review.get(k), str) or not _HEX.fullmatch(review[k])
                   for k in ('proofSha256', 'snapshotSha256', 'configSha256'))
            or not isinstance(decisions, list) or not decisions
            or not isinstance(request, dict) or not isinstance(response, dict)
            or review.get('approvedPairs') != [pair]
            or any(not isinstance(d, dict) or type(d.get('approved')) is not bool for d in decisions)):
        reject('KEV_REVIEW_IDENTITY')
    approved = [d for d in decisions if d['approved']]
    if len(approved) != 1 or (approved[0].get('pair'), approved[0].get('action'), approved[0].get('choice')) != (pair, action, 'select'):
        reject('KEV_SELECTION')
    state, backend = request.get('state'), response.get('backend')
    if (request.get('model') != 'kev-codex' or response.get('model') != 'kev-codex'
            or not isinstance(state, dict) or state.get('mode') != mode
            or state.get('snapshotId') != guard['snapshotId'] or state.get('decisionMode') != 'autonomous'
            or not isinstance(backend, dict) or backend.get('name') != 'codex-cli'
            or backend.get('actual_model') != review['actualModel']
            or backend.get('weights_loaded') is not False or backend.get('probabilities_calibrated') is not False
            or type(backend.get('cli_calls')) is not int or backend['cli_calls'] != 1
            or response.get('request_id') != review['requestId']):
        reject('KEV_REVIEW_IDENTITY')
    candidates, answers, selection = state.get('candidates'), response.get('answers'), review.get('selection')
    if (not isinstance(candidates, list) or not 1 <= len(candidates) <= 32
            or any(not isinstance(c, dict) or c.get('id') != 'q' + str(i) for i, c in enumerate(candidates))
            or len(decisions) != len(candidates) or not isinstance(answers, dict) or set(answers) != {'entry'}
            or not isinstance(answers['entry'], dict) or answers['entry'].get('type') != 'choice'
            or not isinstance(selection, dict) or set(selection) != {'choice', 'probabilities'}
            or selection != {k: answers['entry'].get(k) for k in ('choice', 'probabilities')}):
        reject('KEV_SELECTION')
    choice, probabilities = selection['choice'], selection['probabilities']
    choices = [c['id'] for c in candidates] + ['hold']
    if (choice not in choices[:-1] or not isinstance(probabilities, dict) or set(probabilities) != set(choices)
            or any(type(p) not in (int, float) or not math.isfinite(p) or not 0 <= p <= 1 for p in probabilities.values())
            or abs(sum(probabilities.values()) - 1) > .011
            or any(probabilities[choice] <= p for key, p in probabilities.items() if key != choice)):
        reject('KEV_SELECTION')
    for candidate, decision in zip(candidates, decisions):
        chosen = candidate['id'] == choice
        if (decision != dict(pair=candidate.get('pair'), action=candidate.get('action'), approved=chosen,
                             choice='select' if chosen else 'hold', probabilities=probabilities)
                or chosen and (candidate.get('pair'), candidate.get('action')) != (pair, action)):
            reject('KEV_SELECTION')
    expected = dict(version=review['version'], decisionMode='autonomous', provider='codex-cli', model=review['actualModel'],
        requestId=review['requestId'], snapshotId=review['snapshotId'], snapshotSha256=review['snapshotSha256'],
        configSha256=review['configSha256'], proofSha256=review['proofSha256'], completedAt=review.get('completedAt'), expiresAt=review.get('expiresAt'),
        decision=approved[0], selection=selection, probabilitiesCalibrated=False)
    if receipt != expected:
        reject('KEV_RECEIPT_IDENTITY')
    started, completed, expires = [timestamp(review.get(k)) for k in ('startedAt', 'completedAt', 'expiresAt')]
    if (not guard['decisionBoundary'] <= started <= completed <= timestamp(plan.get('createdAt')) < expires
            or expires != guard['entryDeadline'] or expires > completed + 60000):
        reject('KEV_REVIEW_TIME')
    snapshot, _ = _read_kev_json(folder / (guard['snapshotId'] + '.snapshot.json'), 8 * 1024 * 1024)
    markets = snapshot.get('markets')
    if (snapshot.get('id') != guard['snapshotId'] or snapshot.get('mode') != mode
            or snapshot.get('timeframe') != 'order-flow'
            or any(snapshot.get(key) != guard[key] for key in _CADENCE_KEYS)
            or any(key in snapshot for key in ('candleBoundary', 'candles', 'model'))
            or not isinstance(markets, list)):
        reject('KEV_SNAPSHOT_IDENTITY')
    selected = [m for m in markets if isinstance(m, dict) and m.get('pair') == pair]
    if len(selected) != 1 or selected[0].get('orderFlow') != plan['entryConfirmation']['orderFlow']:
        reject('KEV_SNAPSHOT_FLOW')
    return _kev_costs(plan, guard, mode, pair, side, snapshot, selected[0], state, wall_ms())


def _kev_guard(plan, mode, pair, side):
    g, c, evidence = plan.get('nativeEntryGuard'), plan.get('entryConfirmation'), plan.get('entryEvidence')
    keys = {'version', 'snapshotId', 'mode', 'pair', 'side', 'decisionCadenceVersion', 'decisionIntervalMs',
            'decisionBoundary', 'entryDeadline', 'requiredPriceSpaceBps', 'bridgeQuotePrice', 'quoteFetchedAt',
            'maxPriceMoveBps', 'leverage', 'clock', 'kevReviewSha256'}
    forbidden = {'candleBoundary', 'atrTimeframe', 'model', 'adaptiveParameters', 'atr15', 'targetAtr', 'forecastCloses', 'modelDeadline'}
    if (not isinstance(g, dict) or set(g) != keys or g.get('version') != KEV_GUARD_VERSION
            or (g.get('mode'), g.get('pair'), g.get('side')) != (mode, pair, side)
            or plan.get('ruleVersion') != KEV_RULE_VERSION or plan.get('entryPolicyVersion') != KEV_RULE_VERSION
            or plan.get('entrySignalEngine') != 'kev_order_flow' or plan.get('purpose') != 'strategy'
            or plan.get('timeframe') != 'order-flow' or any(k in plan for k in forbidden)
            or not isinstance(g.get('snapshotId'), str) or not _UUID.fullmatch(g['snapshotId'])
            or g['snapshotId'] != plan.get('snapshotId') or plan.get('tag') != _entry_tag(plan, pair)
            or any(key not in plan or plan[key] != g.get(key) or type(plan[key]) is not type(g.get(key)) for key in _CADENCE_KEYS)
            or g.get('decisionCadenceVersion') != 'flow-minute-v1'
            or type(g.get('decisionIntervalMs')) is not int or g['decisionIntervalMs'] != 60000
            or type(g.get('decisionBoundary')) is not int or g['decisionBoundary'] <= 0 or g['decisionBoundary'] % 60000
            or type(g.get('entryDeadline')) is not int or g['entryDeadline'] != g['decisionBoundary'] + 60000
            or not isinstance(g.get('kevReviewSha256'), str) or not _HEX.fullmatch(g['kevReviewSha256'])
            or not isinstance(c, dict) or set(c) != {'version', 'orderFlow', 'quotePrice'} or c['version'] != 'kev-flow-confirmation-v1'
            or not isinstance(evidence, dict) or set(evidence) != {'version', 'snapshotId', 'usedForEntryDecision', 'proofSha256', 'kevReview'}
            or evidence.get('version') != 'kev-order-flow-evidence-v1' or evidence.get('snapshotId') != g['snapshotId']
            or evidence.get('usedForEntryDecision') is not True
            or not isinstance(evidence.get('proofSha256'), str) or not _HEX.fullmatch(evidence['proofSha256'])
            or decimal(plan.get('stopFraction'), True) != Decimal('.005') or decimal(plan.get('targetFraction'), True) != Decimal('.015')
            or type(plan.get('maxHoldingSeconds')) is not int or plan['maxHoldingSeconds'] != 900
            or type(plan.get('maxHoldingBars')) is not int or plan['maxHoldingBars'] != 0
            or plan.get('profitProtection') != dict(version='net-profit-trail-v1', triggerNetUsdt=.5, givebackNetUsdt=.25, riskMultiple=.5)):
        reject('KEV_GUARD_IDENTITY')
    raw = json.dumps(c['orderFlow'], separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    if sha256(raw.encode()).hexdigest() != evidence['proofSha256']:
        reject('FLOW_PROOF_HASH')
    if decimal(g['bridgeQuotePrice'], True) != decimal(c['quotePrice'], True):
        reject('KEV_GUARD_IDENTITY')
    cost = decimal(plan.get('riskCostFraction'))
    ulp = Decimal(str(math.ulp(float(plan['riskCostFraction']))))
    if decimal(g['requiredPriceSpaceBps']) < (cost - ulp) * 10000 + 30:
        reject('COST_BUFFER_IDENTITY')
    if decimal(g['leverage'], True) != 1:
        reject('LEVERAGE_INVALID')
    decimal(g['maxPriceMoveBps'])
    timestamp(g['quoteFetchedAt'])
    price_guard = _kev_review(plan, g, mode, pair, side)
    # Derived in memory from persisted source evidence; never trust a host-
    # supplied audit result or add these fields to historical entry plans.
    return dict(g, _decisionQuote=price_guard)


def _validate_kev(permit, now):
    plan, mode = permit['plan'], permit['mode']
    _validate_risk(permit)
    g = _kev_guard(plan, mode, permit['pair'], permit['side'])
    try:
        validate_flow(plan['entryConfirmation']['orderFlow'], mode, permit['pair'], permit['side'], now, data_only=True)
    except Exception:
        reject('FLOW_EVIDENCE')
    lower, upper = clock_range(g['clock'], mode, now)
    boundary, deadline = g['decisionBoundary'], g['entryDeadline']
    if lower < boundary or upper >= deadline:
        reject('DEADLINE')
    created = timestamp(plan['createdAt'])
    recorded_lower = g['clock']['serverTime']
    recorded_upper = recorded_lower + g['clock']['receivedAt'] - g['clock']['requestStartedAt']
    if (created + lower - now < boundary or created + upper - now >= deadline
            or recorded_lower < boundary or recorded_upper >= deadline):
        reject('DECISION_MINUTE_IDENTITY')
    if not 0 <= now - timestamp(g['quoteFetchedAt']) <= 15000:
        reject('QUOTE_STALE')
    with localcontext() as context:
        context.prec = 40
        target, stop, cost = decimal(plan['targetFraction'], True), decimal(plan['stopFraction'], True), decimal(plan['riskCostFraction'])
        if target * 10000 < decimal(g['requiredPriceSpaceBps']):
            reject('KEV_PRICE_SPACE')
        if target - cost <= stop + cost:
            reject('NET_REWARD_RISK')
        if abs(decimal(permit['rate'], True) / decimal(g['bridgeQuotePrice'], True) - 1) * 10000 > decimal(g['maxPriceMoveBps']):
            reject('PRICE_MOVED')
        anchor, cap = g['_decisionQuote']['referencePrice'], g['_decisionQuote']['maxMoveBps']
        if abs(decimal(permit['rate'], True) - anchor) * 10000 > anchor * cap:
            reject('KEV_DECISION_QUOTE_MOVED')


def _flow_guard(plan, mode, pair, side):
    g, c, evidence = plan.get('nativeEntryGuard'), plan.get('entryConfirmation'), plan.get('entryEvidence')
    keys = {'version','snapshotId','mode','pair','side','candleBoundary','entryDeadline','requiredPriceSpaceBps','bridgeQuotePrice','atr15','targetAtr','targetFraction','quoteFetchedAt','maxPriceMoveBps','leverage','clock'}
    current = isinstance(g, dict) and g.get('version') in _MINUTE_VERSIONS
    if current:
        keys |= _CADENCE_KEYS
        if (any(key not in plan or plan[key] != g.get(key) or type(plan[key]) is not type(g.get(key)) for key in _CADENCE_KEYS)
                or g.get('decisionCadenceVersion') != 'flow-minute-v1'
                or type(g.get('decisionIntervalMs')) is not int or g['decisionIntervalMs'] != 60000
                or type(g.get('decisionBoundary')) is not int or g['decisionBoundary'] <= 0
                or g['decisionBoundary'] % 60000
                or g.get('candleBoundary') != g['decisionBoundary'] // 300000 * 300000
                or not isinstance(plan.get('adaptiveParameters'), dict)):
            reject('FLOW_CADENCE_IDENTITY')
    elif any(key in plan or isinstance(g, dict) and key in g for key in _CADENCE_KEYS | {'adaptiveParameters'}):
        reject('FLOW_CADENCE_IDENTITY')
    confirmation_keys = {'version','entryRoute','orderFlow','confirmationAt','quotePrice','atr15','targetAtr','targetFraction'}
    if mode in ('demo', 'demo-futures'):
        confirmation_keys.add('executionContinuation')
    if (not isinstance(g, dict) or set(g) != keys or g['version'] not in (*_MINUTE_VERSIONS, LEGACY_VERSION)
            or (g['mode'],g['pair'],g['side']) != (mode,pair,side)
            or plan.get('purpose') != 'strategy' or plan.get('ruleVersion') != RULE_VERSION
            or plan.get('entrySignalEngine') not in ('sampled_order_flow','sampled_order_flow+kronos_advisory')
            or plan.get('model') is not None
            or not isinstance(g['snapshotId'],str) or not _UUID.fullmatch(g['snapshotId'])
            or g['snapshotId'] != plan.get('snapshotId') or plan.get('tag') != _entry_tag(plan,pair)
            or not isinstance(evidence,dict) or evidence.get('version') != 'order-flow-evidence-v1'
            or evidence.get('snapshotId') != g['snapshotId'] or evidence.get('usedForEntryDecision') is not True
            or not isinstance(evidence.get('proofSha256'),str) or not _HEX.fullmatch(evidence['proofSha256'])
            or not isinstance(c,dict) or set(c) != confirmation_keys
            or c['version'] != 'order-flow-atr-v1' or c['entryRoute'] != 'order-flow'
            or type(g['candleBoundary']) is not int or g['candleBoundary'] <= 0 or g['candleBoundary'] % 300000
            or type(g['entryDeadline']) is not int or g['entryDeadline'] != g['decisionBoundary' if current else 'candleBoundary']+60000
            or c['confirmationAt'] != g['candleBoundary'] or plan.get('atrTimeframe') != '15m'
            or current and plan.get('timeframe') != '5m'):
        reject('FLOW_GUARD_IDENTITY')
    ai = evidence.get('aiAssist')
    if plan.get('entrySignalEngine') == 'sampled_order_flow+kronos_advisory' and not isinstance(ai, dict):
        reject('MODEL_ASSIST_IDENTITY')
    # JSON property order is preserved from the host; proof fields contain only
    # integer timestamps/IDs and string prices/quantities, matching JSON.stringify.
    raw = json.dumps(c['orderFlow'], separators=(',',':'), ensure_ascii=False)
    if sha256(raw.encode()).hexdigest() != evidence['proofSha256']:
        reject('FLOW_PROOF_HASH')
    if ai is not None:
        _validate_model_assist(ai, mode, pair, side, g['snapshotId'])
    try:
        validate_flow(c['orderFlow'],mode,pair,side,timestamp(g['quoteFetchedAt']))
    except Exception:
        reject('FLOW_EVIDENCE')
    reference=decimal(g['bridgeQuotePrice'],True)
    if mode in ('demo', 'demo-futures'):
        continuation = c['executionContinuation']
        if mode == 'demo':
            if (plan.get('executionQualityVersion') != QUALITY_VERSION
                    or not isinstance(continuation, dict) or set(continuation) != {'version', 'originAsk'}
                    or continuation['version'] != 'flow-price-continuation-v1'
                    or decimal(continuation['originAsk'], True) != decimal(c['orderFlow']['books'][0]['asks'][0][0], True)):
                reject('FLOW_CONTINUATION_IDENTITY')
            rank = plan.get('flowStrength')
            if (plan.get('flowExit') != FLOW_EXIT_POLICY or not isinstance(rank, dict)
                    or set(rank) != {'version', 'delta'} or rank.get('version') != 'depth-change-rank-v1'
                    or abs(decimal(rank.get('delta'), signed=True)-flow_strength(c['orderFlow'])) > Decimal('1e-12')):
                reject('FLOW_STRENGTH_EXIT_CONTRACT')
            if reference <= decimal(continuation['originAsk'], True):
                reject('FLOW_PRICE_NOT_CONTINUED')
        else:
            if (not isinstance(continuation, dict) or set(continuation) != {'version', 'long', 'originPrice', 'quotePrice'}
                    or continuation['version'] != 'flow-futures-price-continuation-v1'
                    or type(continuation['long']) is not bool
                    or continuation['long'] != (g['side'] == 'long')
                    or decimal(continuation['originPrice'], True) != decimal(c['orderFlow']['books'][0]['asks' if continuation['long'] else 'bids'][0][0], True)
                    or decimal(continuation['quotePrice'], True) != reference):
                reject('FLOW_CONTINUATION_IDENTITY')
            if (continuation['long'] and reference <= decimal(continuation['originPrice'], True)) or (not continuation['long'] and reference >= decimal(continuation['originPrice'], True)):
                reject('FLOW_PRICE_NOT_CONTINUED')
    elif any(k in plan for k in ('executionQualityVersion','flowStrength','flowExit')):
        reject('FLOW_CONTINUATION_MODE')
    if reference != decimal(c['quotePrice'],True) or any(decimal(g[k],True) != decimal(c[k],True) for k in ('atr15','targetAtr','targetFraction')):
        reject('FLOW_GUARD_IDENTITY')
    adaptive = None
    if current:
        adaptive = _adaptive(plan, c, mode, pair, side)
        try:
            validate_flow(c['orderFlow'], mode, pair, side, timestamp(g['quoteFetchedAt']), adaptive['minTakerShare'])
        except Exception:
            reject('FLOW_EVIDENCE')
    with localcontext() as context:
        context.prec=40
        fraction=decimal(g['targetFraction'],True)
        if decimal(g['targetAtr'],True) != 3 or fraction > 1 or fraction != decimal(plan.get('targetFraction'),True) or abs(3*decimal(g['atr15'],True)/reference-fraction)>Decimal('1e-12'):
            reject('ATR_TARGET_IDENTITY')
        if abs(decimal(plan.get('stopFraction'),True)-min(decimal(g['atr15'],True)/reference,Decimal('.02')))>Decimal('1e-12'):
            reject('ATR_STOP_IDENTITY')
        cost=plan.get('riskCostFraction')
        buffer = decimal(adaptive['costBufferBps']) if adaptive else Decimal(30)
        if decimal(g['requiredPriceSpaceBps']) < (decimal(cost)-Decimal(str(math.ulp(float(cost)))))*10000+buffer:
            reject('COST_BUFFER_IDENTITY')
    if decimal(g['leverage'],True) != 1:
        reject('LEVERAGE_INVALID')
    decimal(g['maxPriceMoveBps'])
    timestamp(g['quoteFetchedAt'])
    return g


def _adaptive(plan, confirmation, mode, pair, side):
    profile = plan.get('adaptiveParameters')
    try:
        native = plan['nativeEntryGuard']
        current = native['version'] == VERSION
        if profile.get('version') != ('live-flow-adaptive-v2' if current else 'live-flow-adaptive-v1'):
            reject('ADAPTIVE_IDENTITY')
        volatility = profile['inputs'].get('volatility')
        if (current and (not isinstance(volatility, dict) or volatility.get('candleBoundary') != native['candleBoundary'])
                or not current and volatility is not None):
            reject('ADAPTIVE_IDENTITY')
        # Cost fractions are persisted as IEEE-754 numbers; tolerate one ULP
        # only for that serialization, not an additional cost/risk allowance.
        cost = profile['inputs']['estimatedRoundTripCostBps']
        with localcontext() as context:
            context.prec = 40
            serialized = decimal(plan.get('riskCostFraction'))
            if abs(decimal(cost) / 10000 - serialized) > Decimal(str(math.ulp(float(plan['riskCostFraction'])))):
                reject('ADAPTIVE_COST_IDENTITY')
        expected = derive_adaptive_parameters(confirmation['orderFlow'], mode, pair, side,
            confirmation['atr15'], confirmation['quotePrice'], cost, volatility)
        if (json.dumps(profile, sort_keys=True, separators=(',', ':')) != json.dumps(expected, sort_keys=True, separators=(',', ':'))
                or decimal(plan.get('riskBudgetUsdt'), True) != decimal(expected['riskBudgetUsdt'], True)):
            reject('ADAPTIVE_IDENTITY')
    except PermissionDenied:
        raise
    except Exception:
        reject('ADAPTIVE_IDENTITY')
    return expected


def _pullback(proof, boundary, side, origin, allow_flow=False):
    if (not isinstance(proof, dict) or set(proof) != {'version','confirmationAt','closeTimes','bars','eligible','checks'}
            or proof['version'] != 'trend-pullback-model-v1' or proof['confirmationAt'] != boundary
            or type(proof['eligible']) is not bool or (not allow_flow and proof['eligible'] is not True) or not isinstance(proof['closeTimes'], list)
            or any(type(x) is not int for x in proof['closeTimes'])
            or proof['closeTimes'] != [boundary-(24-i)*300000-1 for i in range(25)]
            or not isinstance(proof['bars'], list) or len(proof['bars']) != 25):
        reject('PULLBACK_IDENTITY')
    bars=[]
    for values in proof['bars']:
        if not isinstance(values,list) or len(values)!=4:
            reject('PULLBACK_IDENTITY')
        b=[decimal(v, True) for v in values]
        if b[1] < max(b) or b[2] > min(b):
            reject('PULLBACK_IDENTITY')
        bars.append(b)
    closes=[b[3] for b in bars]
    if closes[-1] != origin:
        reject('PULLBACK_IDENTITY')
    aligned=lambda a,b: a>b if side=='long' else a<b
    with localcontext() as context:
        context.prec=40
        current=sum(closes[-20:]); prior=sum(closes[:20]); last=closes[-1]
        checks=dict(trend=aligned(last*20,current) and aligned(current,prior) and aligned(last,closes[-13]),
                    pullback=any(aligned(closes[i-1],closes[i]) for i in (21,22,23)),
                    reclaim=aligned(last,bars[23][1 if side=='long' else 2]))
    if (not isinstance(proof['checks'], dict) or set(proof['checks']) != set(checks)
            or any(type(v) is not bool for v in proof['checks'].values()) or proof['checks'] != checks):
        reject('PULLBACK_IDENTITY')
    if proof['eligible'] != all(checks.values()):
        reject('PULLBACK_IDENTITY')
    if not allow_flow and not all(checks.values()):
        reject('PULLBACK_SIGNAL')
    return checks

def _validate_risk(permit):
    """Check again at callback, context entry and wire time, using actual amount/rate.

    50 bps of entry notional covers the spot 0.995 stop-limit interval before
    favorable sell-price tick rounding. Original estimated costs remain separate.
    Market gaps/non-fills and emergency market exits are not bounded by this.
    """
    plan, mode = permit['plan'], permit['mode']
    expected = dict(version=RISK_POLICY_VERSION, mode=mode,
                    stopLimitRatio='0.995' if mode == 'demo' else None,
                    reserveFraction='0.005' if mode == 'demo' else '0')
    if plan.get('riskPolicy') != expected:
        reject('RISK_POLICY')
    with localcontext() as context:
        context.prec = 40
        stop = decimal(plan.get('stopFraction'), True)
        cost = decimal(plan.get('riskCostFraction'))
        cap = decimal(plan.get('maxEntryNotionalUsdt'), True)
        notional = decimal(permit['amount'], True) * decimal(permit['rate'], True)
        risk = notional * (stop + cost + decimal(expected['reserveFraction']))
        budget = decimal(plan.get('riskBudgetUsdt'), True)
        adaptive = plan.get('nativeEntryGuard', {}).get('version') in _MINUTE_VERSIONS
        if (stop > Decimal('.02') or cost > 1 or (not Decimal('.25') <= budget <= 1 if adaptive else budget != 1)
                or notional > cap + Decimal('1e-8') or risk > budget + Decimal('1e-8')):
            reject('RISK_BUDGET')


def _validate(permit, now, mono):
    plan = permit['plan']
    if plan.get('entryPolicyVersion') in ('trend-pullback-flow-v1','order-flow-only-v1') and plan.get('entryConfirmation', {}).get('entryRoute') == 'order-flow':
        try:
            profile = plan.get('adaptiveParameters')
            validate_flow(plan['entryConfirmation']['orderFlow'], permit['mode'], permit['pair'], permit['side'], now,
                          profile.get('minTakerShare', '.55') if isinstance(profile, dict) else '.55')
        except Exception:
            reject('FLOW_EVIDENCE')
    mode, plan = permit['mode'], permit['plan']
    model = plan['ruleVersion'] == RULE_VERSION
    ai_assist = plan.get('entryEvidence', {}).get('aiAssist') if isinstance(plan.get('entryEvidence'), dict) else None
    _stopped(mode, model and (plan.get('entryPolicyVersion') != 'order-flow-only-v1' or isinstance(ai_assist, dict)))
    if abs((now - permit['wall']) - (mono - permit['mono'])) > 250:
        reject('CLOCK_JUMP')
    if not 0 <= now - timestamp(plan['createdAt']) <= 120000:
        reject('PLAN_EXPIRED')
    if (plan.get('ruleVersion') == KEV_RULE_VERSION or plan.get('entryPolicyVersion') == KEV_RULE_VERSION
            or plan.get('nativeEntryGuard', {}).get('version') == KEV_GUARD_VERSION):
        _validate_kev(permit, now)
        return
    if not model:
        return
    _validate_risk(permit)
    guard = _guard(plan, mode, permit['pair'], permit['side'])
    lower, upper = clock_range(guard['clock'], mode, now)
    flow_only = plan.get('entryPolicyVersion') == 'order-flow-only-v1'
    boundary = guard.get('decisionBoundary', guard['candleBoundary'])
    if lower < boundary or upper >= guard['entryDeadline' if flow_only else 'modelDeadline']:
        reject('DEADLINE')
    if flow_only and guard['version'] in _MINUTE_VERSIONS:
        created = timestamp(plan['createdAt'])
        recorded_lower = guard['clock']['serverTime']
        recorded_upper = recorded_lower + guard['clock']['receivedAt'] - guard['clock']['requestStartedAt']
        if (created + lower - now < boundary or created + upper - now >= guard['entryDeadline']
                or recorded_lower < boundary or recorded_upper >= guard['entryDeadline']):
            reject('DECISION_MINUTE_IDENTITY')
    if not flow_only and not 0 <= now - timestamp(guard['issuedAt']) <= 60000:
        reject('PREDICTION_STALE')
    if not 0 <= now - timestamp(guard['quoteFetchedAt']) <= 15000:
        reject('QUOTE_STALE')
    with localcontext() as context:
        context.prec = 40
        rate, reference = decimal(permit['rate'], True), decimal(guard['bridgeQuotePrice'], True)
        # Recheck the callback's offered rate at each native boundary. MARKET
        # orders have no guaranteed fill price, and wire does not fetch a quote.
        if flow_only and mode == 'demo' and rate <= decimal(plan['entryConfirmation']['executionContinuation']['originAsk'], True):
            reject('FLOW_PRICE_NOT_CONTINUED')
        if flow_only and mode == 'demo-futures':
            continuation = plan['entryConfirmation']['executionContinuation']
            origin = decimal(continuation['originPrice'], True)
            if (continuation['long'] and rate <= origin) or (not continuation['long'] and rate >= origin):
                reject('FLOW_PRICE_NOT_CONTINUED')
        edge = None if flow_only else (decimal(guard['forecastClose'], True) / rate - 1) * (10000 if permit['side'] == 'long' else -10000)
        if not flow_only and edge <= 0:
            reject('FORECAST_DIRECTION_PRICE')
        if decimal(guard['targetFraction'], True) * 10000 < decimal(guard['requiredPriceSpaceBps']):
            reject('ATR_PRICE_SPACE')
        if plan.get('entryPolicyVersion') in ('trend-pullback-model-v1', 'trend-pullback-flow-v1', 'order-flow-only-v1'):
            cost = decimal(plan.get('riskCostFraction'))
            reserve = decimal(plan['riskPolicy']['reserveFraction'])
            if decimal(guard['targetFraction'], True) - cost < decimal(plan.get('stopFraction'), True) + cost + reserve:
                reject('NET_REWARD_RISK')
        elif edge <= decimal(guard['requiredPriceSpaceBps']):
            reject('FORECAST_COST_SHORTFALL')
        if abs(rate / reference - 1) * 10000 > decimal(guard['maxPriceMoveBps']):
            reject('PRICE_MOVED')


def clear_entry_permit():
    _pending.set(None)


def record_callback_rejection(plan, mode, pair, tag, reason):
    """Best-effort evidence of one callback rejection, never an order outcome.

    Only the callback failure branch calls this, before a permit was granted.
    A host must additionally bind the timestamp/PID to its current one-shot RPC
    attempt. An old or missing receipt cannot resolve an unknown submission.
    """
    temporary = None
    try:
        if (_pending.get() is not None or _active.get() is not None
                or mode not in ('demo', 'demo-futures') or not isinstance(plan, dict)
                or not isinstance(tag, str) or not re.fullmatch(r'codex-[a-f0-9]{32}', tag)
                or plan.get('tag') != tag or plan.get('pair') != pair
                or not isinstance(plan.get('snapshotId'), str) or not _UUID.fullmatch(plan['snapshotId'])
                or not isinstance(reason, str)
                or not re.fullmatch(r'DEMO_NATIVE_MODEL_[A-Z_]+|ENTRY_CALLBACK_REJECTED', reason)):
            return False
        native = plan.get('nativeEntryGuard')
        if (not isinstance(native, dict) or native.get('mode') != mode
                or native.get('pair') != pair or native.get('snapshotId') != plan['snapshotId']
                or native.get('version') not in (*_MINUTE_VERSIONS, LEGACY_VERSION, KEV_GUARD_VERSION)):
            return False
        boundary = plan.get('decisionBoundary', native.get('candleBoundary'))
        if type(boundary) is not int or boundary <= 0:
            return False
        timestamp(plan.get('createdAt'))
        folder = ROOT / 'local' / mode
        raw = (folder / 'entry-plans' / (tag + '.json')).read_bytes()
        # Hash the exact host bytes, only if they still describe the rejected
        # callback plan. Replacing the file during evaluation gives no receipt.
        canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)
        if canonical(json.loads(raw)) != canonical(plan):
            return False
        receipt = dict(schemaVersion=1, phase='callback_before_order', tag=tag,
            snapshotId=plan['snapshotId'], pair=pair, mode=mode, decisionBoundary=boundary,
            nativeEntryGuardVersion=native['version'], planCreatedAt=plan['createdAt'],
            planSha256=sha256(raw).hexdigest(), reason=reason, processId=os.getpid(),
            rejectedAt=datetime.fromtimestamp(wall_ms()/1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))
        destination = folder / 'entry-rejections'
        destination.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='\n',
                prefix=tag + '.', suffix='.tmp', dir=destination, delete=False) as output:
            temporary = Path(output.name)
            json.dump(receipt, output, separators=(',', ':'), allow_nan=False)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination / (tag + '.json'))
        temporary = None
        return True
    except Exception:
        # Failure to persist evidence never changes a rejection into permission.
        return False
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def authorize_entry(exchange, plan, mode, pair, side, amount, rate, order_type):
    """Called only after valid_plan and the existing risk/identity checks pass."""
    clear_entry_permit()
    if (exchange is None or mode not in ('demo', 'demo-futures') or side not in ('long', 'short')
            or (mode == 'demo' and side != 'long') or order_type != 'market'
            or plan.get('pair') != pair or plan.get('isShort') is not (side == 'short')
            or not re.fullmatch(r'codex-[a-f0-9]{32}', plan.get('tag', ''))):
        reject('ENTRY_IDENTITY')
    decimal(amount, True)
    decimal(rate, True)
    if plan.get('ruleVersion') == PROBE_VERSION:
        if (plan.get('purpose') != 'execution_probe' or (mode, pair, side) not in
                (('demo', 'ETH/USDT', 'long'), ('demo-futures', 'ETH/USDT:USDT', 'short'))
                or plan.get('stopFraction') != .005 or plan.get('targetFraction') != .005
                or plan.get('maxHoldingSeconds') != 90 or plan.get('maxHoldingBars') != 1
                or decimal(plan.get('maxEntryNotionalUsdt'), True) > 25):
            reject('PROBE_IDENTITY')
    elif plan.get('ruleVersion') not in (RULE_VERSION, KEV_RULE_VERSION):
        reject('ENTRY_VERSION')
    permit = dict(owner=exchange, mode=mode, pair=pair, side=side, amount=amount, rate=rate,
                  plan=copy.deepcopy(plan), wall=wall_ms(), mono=monotonic_ms(), wireSent=False)
    _validate(permit, wall_ms(), monotonic_ms())
    _pending.set(permit)
    return True


@contextmanager
def order_context(exchange, *, pair, side, amount, rate, leverage, reduce_only, initial_order, order_type):
    """Consume a callback grant once; an exit is an explicit, separate context."""
    mode = exchange._protection_mode
    permit = _pending.get()
    clear_entry_permit()
    if (mode not in ('demo', 'demo-futures') or type(initial_order) is not bool
            or type(reduce_only) is not bool):
        reject('ORDER_IDENTITY')
    if initial_order:
        if (reduce_only or not permit or permit['owner'] is not exchange
                or permit['pair'] != pair or ('sell' if permit['side'] == 'short' else 'buy') != side
                or decimal(permit['amount'], True) != decimal(amount, True)
                or decimal(permit['rate'], True) != decimal(rate, True)
                or order_type != 'market'):
            reject('PERMIT_REQUIRED_OR_MISMATCH')
        expected_leverage = (permit['plan']['nativeEntryGuard']['leverage']
                             if permit['plan']['ruleVersion'] in (RULE_VERSION, KEV_RULE_VERSION) else 1)
        if decimal(leverage, True) != decimal(expected_leverage, True):
            reject('LEVERAGE_MISMATCH')
        _validate(permit, wall_ms(), monotonic_ms())
        state = permit
    else:
        if (mode == 'demo' and (side != 'sell' or reduce_only)
                or mode == 'demo-futures' and (not reduce_only or side not in ('buy', 'sell'))):
            reject('EXIT_IDENTITY')
        state = dict(owner=exchange, mode=mode, pair=pair, side=side, exit=True, wireSent=False)
    # Bind the final quantity to the exact precision conversion used by Freqtrade.
    state['wireQuantity'] = decimal(exchange.amount_to_precision(pair, exchange._amount_to_contracts(pair, amount)), True)
    state['wireSide'] = side.upper()
    state['wireType'] = order_type.upper()
    state['reduceOnly'] = reduce_only
    token = _active.set(state)
    try:
        yield state
    finally:
        _active.reset(token)
        clear_entry_permit()


def guard_order_wire(exchange, url, method='GET', body=None):
    """Called by the existing CCXT fetch wrapper AFTER CCXT's rate limiter.

    Data and leverage requests are unaffected. STOP orders keep their existing
    dedicated protected-stop context. Ordinary orders require an active context.
    """
    parsed = urlsplit(str(url))
    mode = exchange._protection_mode
    order_path = '/api/v3/order' if mode == 'demo' else '/fapi/v1/order'
    if str(method).upper() != 'POST' or parsed.path != order_path:
        return
    try:
        if body is not None and not isinstance(body, (str, bytes)):
            reject('WIRE_IDENTITY')
        encoded = body.decode('utf-8') if isinstance(body, bytes) else body or ''
        selected = {}
        for key, value in parse_qsl(parsed.query, keep_blank_values=True) + parse_qsl(encoded, keep_blank_values=True):
            if key in ('symbol', 'side', 'type', 'quantity', 'quoteOrderQty', 'reduceOnly'):
                if key in selected:
                    reject('WIRE_IDENTITY')
                selected[key] = value
        state = _active.get()
        if not state:
            # Spot STOP_LOSS_LIMIT uses /api/v3/order but never opens exposure.
            stop = getattr(exchange, '_active_demo_stop', None)
            if (mode == 'demo' and isinstance(stop, dict) and selected.get('type') == 'STOP_LOSS_LIMIT'
                    and selected.get('side') == 'SELL' and stop.get('side') == 'sell'
                    and selected.get('symbol') == stop.get('pair', '').replace('/', '')):
                return
            reject('WIRE_CONTEXT_REQUIRED')
        if state['owner'] is not exchange or state.get('wireSent'):
            reject('WIRE_CONTEXT_REQUIRED')
        if selected.get('reduceOnly', 'false').lower() not in ('true', 'false'):
            reject('WIRE_IDENTITY')
        if (selected.get('symbol') != state['pair'].split(':')[0].replace('/', '')
                or selected.get('side') != state['wireSide'] or selected.get('type') != state['wireType']
                or 'quoteOrderQty' in selected or decimal(selected.get('quantity'), True) != state['wireQuantity']
                or (selected.get('reduceOnly', 'false').lower() == 'true') is not state['reduceOnly']):
            reject('WIRE_IDENTITY')
        if not state.get('exit'):
            _validate(state, wall_ms(), monotonic_ms())
        state['wireSent'] = True  # Any second mutation attempt is rejected, even after a lost reply.
    except (ValueError, TypeError, UnicodeError, AttributeError):
        reject('WIRE_IDENTITY')
