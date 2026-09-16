"""Prospective spot flow invalidation. Pure state transition, no broker calls."""
from copy import deepcopy
from decimal import Decimal, localcontext
from demo_order_flow import validate_flow, FlowValidationError

LEGACY_QUALITY_VERSION = 'flow-strength-exit-v1'
QUALITY_VERSION = 'flow-confirmed-exit-v2'
LEGACY_POLICY = {'version': 'sustained-opposite-flow-v1', 'windowMs': 60000,
          'minSeparationMs': 60000, 'maxSeparationMs': 90000,
          'maxObservationGapMs': 20000, 'oppositeTakerShare': '0.55'}
STATE_KEY = 'spot_flow_exit'


def strength(proof):
    with localcontext() as c:
        c.prec = 40
        imbalances = []
        for b in proof['books']:
            bid, ask = [sum(Decimal(str(p))*Decimal(str(q)) for p, q in b[k]) for k in ('bids', 'asks')]
            imbalances.append((bid-ask)/(bid+ask))
        return imbalances[-1]-imbalances[0]


def _valid_event(event, pair, opened, now):
    if not isinstance(event, dict) or type(event.get('checkedAt')) is not int:
        raise ValueError('FLOW_EXIT_EVENT')
    at, p = event['checkedAt'], event.get('proof')
    if not opened <= at <= now:
        raise ValueError('FLOW_EXIT_TIME')
    validate_flow(p, 'demo', pair, 'short', at)
    if p['startTime'] < opened:
        raise ValueError('FLOW_EXIT_PREENTRY')


def _separated(first, second):
    a, b = first['proof'], second['proof']
    return (LEGACY_POLICY['minSeparationMs'] <= b['endTime']-a['endTime'] <= LEGACY_POLICY['maxSeparationMs']
            and b['startTime'] >= a['endTime']
            and b['trades'][0]['a'] > a['trades'][-1]['a'])


def _advance_legacy(state, proof, *, pair, tag, opened_at, now):
    """Two nonoverlapping opposite windows, with continuous valid observations.

    Repeated snapshots cannot increase confirmation. Missing, stale, recovered or
    interrupted evidence resets the pending confirmation, not native protection.
    A confirmed decision is persisted and retried until the native exit fills.
    """
    if type(now) is not int or type(opened_at) is not int or now < opened_at:
        return None, False, 'invalid_time'
    identity = {'version': LEGACY_POLICY['version'], 'pair': pair, 'tag': tag, 'openedAt': opened_at}
    try:
        if state is not None:
            if not isinstance(state, dict) or any(state.get(k) != v for k, v in identity.items()):
                raise ValueError('FLOW_EXIT_STATE_IDENTITY')
            _valid_event(state['first'], pair, opened_at, now)
            if state.get('decision') is not None:
                _valid_event(state['decision'], pair, opened_at, now)
                if not _separated(state['first'], state['decision']):
                    raise ValueError('FLOW_EXIT_CONFIRMATION')
                return state, True, 'confirmed'
            for k in ('lastCheckedAt', 'lastSampleAt'):
                if type(state.get(k)) is not int or not opened_at <= state[k] <= now:
                    raise ValueError('FLOW_EXIT_STATE_TIME')
    except Exception:
        return None, False, 'invalid_state'
    event = {'checkedAt': now, 'proof': proof}
    try:
        _valid_event(event, pair, opened_at, now)
    except Exception as error:
        return None, False, failure_reason(error)
    sample = proof['books'][-1]['at']
    if state is not None:
        previous = state['lastSampleAt']
        if (sample < previous or now-state['lastCheckedAt'] > LEGACY_POLICY['maxObservationGapMs']
                or sample-previous > LEGACY_POLICY['maxObservationGapMs']
                or proof['endTime']-state['first']['proof']['endTime'] > LEGACY_POLICY['maxSeparationMs']):
            state = None
    if state is None:
        return {**identity, 'first': deepcopy(event), 'lastSampleAt': sample,
                'lastCheckedAt': now, 'decision': None}, False, 'watching_opposite'
    result = deepcopy(state)
    result.update(lastSampleAt=sample, lastCheckedAt=now)
    if sample > state['lastSampleAt'] and _separated(state['first'], event):
        result['decision'] = deepcopy(event)
        return result, True, 'confirmed'
    return result, False, 'watching_opposite'


POLICY = {'version': 'rolling-opposite-flow-v2', 'windowMs': 60000,
          'minConfirmationMs': 20000, 'minSamples': 3,
          'maxObservationGapMs': 20000, 'oppositeTakerShare': '0.55'}


def policy_for_plan(plan):
    for quality, policy in ((QUALITY_VERSION, POLICY), (LEGACY_QUALITY_VERSION, LEGACY_POLICY)):
        if plan.get('executionQualityVersion') == quality and plan.get('flowExit') == policy:
            return policy
    return None


def failure_reason(error):
    if isinstance(error, FlowValidationError):
        return error.reason
    if str(error) == 'FLOW_EXIT_PREENTRY':
        return 'preentry_window'
    return 'data_invalid'


def _fresh_successor(a, b):
    pa, pb = a['proof'], b['proof']
    return (b['checkedAt'] > a['checkedAt']
            and pb['books'][-1]['at'] > pa['books'][-1]['at']
            and pb['endTime'] > pa['endTime']
            and pb['trades'][-1]['a'] > pa['trades'][-1]['a']
            and pb['books'][-1]['updateId'] >= pa['books'][-1]['updateId'])


def _continuous(a, b):
    return (0 < b['checkedAt']-a['checkedAt'] <= POLICY['maxObservationGapMs']
            and 0 < b['proof']['books'][-1]['at']-a['proof']['books'][-1]['at'] <= POLICY['maxObservationGapMs'])


def _enough(events):
    # Overlapping rolling windows show persistence, NOT independent evidence.
    return (len(events) >= POLICY['minSamples']
            and events[-1]['proof']['endTime']-events[0]['proof']['endTime'] >= POLICY['minConfirmationMs']
            and events[-1]['checkedAt']-events[0]['checkedAt'] >= POLICY['minConfirmationMs'])


def advance(state, proof, *, pair, tag, opened_at, now, policy=None):
    policy = POLICY if policy is None else policy
    if policy == LEGACY_POLICY:
        return _advance_legacy(state, proof, pair=pair, tag=tag, opened_at=opened_at, now=now)
    if policy != POLICY:
        return None, False, 'policy_invalid'
    if type(now) is not int or type(opened_at) is not int or now < opened_at:
        return None, False, 'invalid_time'
    identity = {'version': POLICY['version'], 'pair': pair, 'tag': tag, 'openedAt': opened_at}
    try:
        if state is not None:
            if not isinstance(state, dict) or any(state.get(k) != v for k, v in identity.items()):
                raise ValueError('STATE_IDENTITY')
            events = state['events']
            if not isinstance(events, list) or not 1 <= len(events) <= 8:
                raise ValueError('STATE_EVENTS')
            for i, event in enumerate(events):
                _valid_event(event, pair, opened_at, now)
                if i and not (_fresh_successor(events[i-1], event) and _continuous(events[i-1], event)):
                    raise ValueError('STATE_CONTINUITY')
            if state.get('decision') is not None:
                if state['decision'] != events[-1] or not _enough(events):
                    raise ValueError('STATE_DECISION')
                return state, True, 'confirmed'
            if _enough(events):
                raise ValueError('STATE_UNCONFIRMED')
    except Exception:
        return None, False, 'invalid_state'
    event = {'checkedAt': now, 'proof': proof}
    try:
        _valid_event(event, pair, opened_at, now)
    except Exception as error:
        return None, False, failure_reason(error)
    reason = 'watching_opposite'
    if state is not None:
        last = state['events'][-1]
        if (now-last['checkedAt'] > POLICY['maxObservationGapMs']
                or proof['books'][-1]['at']-last['proof']['books'][-1]['at'] > POLICY['maxObservationGapMs']):
            state, reason = None, 'observation_gap_reset'
        elif (proof['books'][-1]['at'] < last['proof']['books'][-1]['at']
              or proof['endTime'] < last['proof']['endTime']
              or proof['books'][-1]['updateId'] < last['proof']['books'][-1]['updateId']
              or proof['trades'][-1]['a'] < last['proof']['trades'][-1]['a']):
            return None, False, 'sample_regressed'
        elif not _fresh_successor(last, event):
            return state, False, 'awaiting_fresh_sample'
    if state is None:
        return {**identity, 'events': [deepcopy(event)], 'decision': None}, False, reason
    result = deepcopy(state)
    result['events'].append(deepcopy(event))
    if _enough(result['events']):
        result['decision'] = deepcopy(event)
        return result, True, 'confirmed'
    return result, False, 'watching_opposite'
