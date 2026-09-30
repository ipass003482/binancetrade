"""Pure native mirror of the frozen coherent-flow entry hypothesis. No I/O."""
from decimal import Decimal, localcontext, ROUND_HALF_EVEN
from demo_order_flow import validate_flow, FlowValidationError


KEV_ENTRY_SIGNAL_POLICY = dict(
    version='kev-coherent-flow-v1', originalWindowMs=60000, minimumCommonWindowMs=15000,
    minimumTradeCount=3, minimumTradesPerHalf=1, minimumDirectionalShare='0.55',
    minimumHalfDirectionalShareExclusive='0.5', minimumSignedMidChangeBps='0.25',
    maximumAbsoluteDepthImbalance='0.7')


def valid_kev_entry_signal_policy(value):
    return (type(value) is dict and set(value) == set(KEV_ENTRY_SIGNAL_POLICY)
            and all(type(value[key]) is type(expected) and value[key] == expected
                    for key, expected in KEV_ENTRY_SIGNAL_POLICY.items()))


def _text(value):
    if value == 0:
        return '0'
    result = format(value, 'f')
    return result.rstrip('0').rstrip('.') if '.' in result else result


def _tape(trades, long):
    buy, sell = Decimal(0), Decimal(0)
    for trade in trades:
        notional = Decimal(str(trade['p'])) * Decimal(str(trade['q']))
        if trade['m']:
            sell += notional
        else:
            buy += notional
    total, directional = buy + sell, buy if long else sell
    return dict(buy=buy, sell=sell, total=total, directional=directional, view=dict(
        tradeCount=len(trades), buyNotional=_text(buy), sellNotional=_text(sell),
        totalNotional=_text(total), directionalNotional=_text(directional),
        buyShare=_text(buy / total) if total else None,
        directionalShare=_text(directional / total) if total else None))


def assess_kev_entry_signal(proof, mode, pair, long, now):
    """Validate the whole original proof before selecting the common tape window."""
    base = dict(version=KEV_ENTRY_SIGNAL_POLICY['version'], policy=dict(KEV_ENTRY_SIGNAL_POLICY),
                mode=mode, pair=pair, long=long,
                requestedDirection='buy' if long is True else 'sell' if long is False else None)

    def unavailable(reason, **extra):
        return dict(base, status='unavailable', eligible=False, reason=reason, reasons=[reason],
                    **dict(dict(validationReason=None, window=None, overall=None, halves=None,
                                quoteResponse=None, bookImbalances=None, sampledAt=None), **extra))

    try:
        # Use a valid direction for the original direction-independent check,
        # matching validateOrderFlowData; check the requested type afterwards.
        validate_flow(proof, mode, pair, 'long', now, data_only=True)
    except Exception as error:
        mapping = dict(data_missing_or_invalid='FLOW_IDENTITY', identity_invalid='FLOW_IDENTITY',
                       source_invalid='FLOW_SOURCE', data_incomplete='FLOW_INCOMPLETE',
                       window_invalid='FLOW_WINDOW', book_time_invalid='FLOW_BOOK_TIME',
                       book_gap='FLOW_BOOK_GAP', book_stale_or_window_mismatch='FLOW_STALE',
                       trade_invalid='FLOW_TRADE_GAP', trade_gap='FLOW_TRADE_GAP', tape_stale='FLOW_TAPE_STALE')
        reason = mapping.get(getattr(error, 'reason', None), 'FLOW_DATA_INVALID')
        if type(now) is not int or abs(now) > 9007199254740991:
            reason = 'FLOW_IDENTITY'
        if isinstance(error, FlowValidationError) and error.reason == 'data_invalid':
            try:
                if any(Decimal(str(b['bids'][0][0])) >= Decimal(str(b['asks'][0][0])) for b in proof['books']):
                    reason = 'FLOW_CROSSED_BOOK'
            except Exception:
                pass
        return unavailable('KEV_SIGNAL_PROOF_INVALID', validationReason=reason)
    if type(long) is not bool:
        return unavailable('KEV_SIGNAL_DIRECTION_INVALID')
    try:
        with localcontext() as context:
            context.prec, context.rounding = 40, ROUND_HALF_EVEN
            policy, books = KEV_ENTRY_SIGNAL_POLICY, proof['books']
            start, middle, end = books[0]['at'], books[1]['at'], proof['endTime']
            window = dict(originalStartTime=proof['startTime'], originalEndTime=proof['endTime'],
                          startTime=start, middleTime=middle, endTime=end, durationMs=end-start,
                          firstHalfBounds='[start,middle)', secondHalfBounds='[middle,end]')
            if not start < middle < end or end-start < policy['minimumCommonWindowMs']:
                return unavailable('KEV_SIGNAL_COMMON_WINDOW_INVALID', window=window, sampledAt=books[-1]['at'])
            common = [t for t in proof['trades'] if start <= t['T'] <= end]
            overall = _tape(common, long)
            halves = [_tape([t for t in common if t['T'] < middle], long),
                      _tape([t for t in common if t['T'] >= middle], long)]
            reasons = []
            if len(common) < policy['minimumTradeCount']:
                reasons.append('KEV_SIGNAL_COMMON_TAPE_INCOMPLETE')
            if any(h['view']['tradeCount'] < policy['minimumTradesPerHalf'] for h in halves):
                reasons.append('KEV_SIGNAL_HALF_TAPE_INCOMPLETE')
            if overall['total'] > 0 and overall['directional'] < overall['total'] * Decimal(policy['minimumDirectionalShare']):
                reasons.append('KEV_SIGNAL_TAKER_SHARE_BELOW_MINIMUM')
            if any(h['total'] > 0 and h['directional'] <= h['total'] * Decimal(policy['minimumHalfDirectionalShareExclusive']) for h in halves):
                reasons.append('KEV_SIGNAL_HALF_DIRECTION_NOT_CONFIRMED')
            bids, asks = [[Decimal(str(b[key][0][0])) for b in books] for key in ('bids', 'asks')]
            sign = Decimal(1 if long else -1)
            def move(before, after):
                return (after / before - 1) * 10000
            intervals = []
            for i in (0, 1):
                bid_move, ask_move = move(bids[i], bids[i+1]), move(asks[i], asks[i+1])
                # Raw comparisons must not hide a tiny adverse price move in
                # a 40-digit rounded ratio. Same rule as the host validator.
                non_adverse = (bids[i+1] >= bids[i] and asks[i+1] >= asks[i] if long
                               else bids[i+1] <= bids[i] and asks[i+1] <= asks[i])
                intervals.append(dict(fromTime=books[i]['at'], toTime=books[i+1]['at'],
                    bidMoveBps=_text(bid_move), askMoveBps=_text(ask_move),
                    signedBidMoveBps=_text(bid_move*sign), signedAskMoveBps=_text(ask_move*sign), nonAdverse=non_adverse))
            bid_move, ask_move = move(bids[0], bids[2]), move(asks[0], asks[2])
            mids = [(bid+ask)/2 for bid, ask in zip(bids, asks)]
            mid_move = move(mids[0], mids[2])
            final = bids[2] > bids[0] and asks[2] > asks[0] if long else bids[2] < bids[0] and asks[2] < asks[0]
            imbalances = []
            for book in books:
                totals = [sum((Decimal(str(p))*Decimal(str(q)) for p, q in book[key]), Decimal(0)) for key in ('bids', 'asks')]
                imbalances.append(_text((totals[0]-totals[1])/(totals[0]+totals[1])))
            depth_ok = all(abs(Decimal(v)) <= Decimal(policy['maximumAbsoluteDepthImbalance']) for v in imbalances)
            if any(not i['nonAdverse'] for i in intervals):
                reasons.append('KEV_SIGNAL_QUOTE_INTERVAL_ADVERSE')
            if not final:
                reasons.append('KEV_SIGNAL_FINAL_QUOTES_NOT_CONFIRMED')
            if mid_move*sign < Decimal(policy['minimumSignedMidChangeBps']):
                reasons.append('KEV_SIGNAL_MID_MOVE_NOT_CONFIRMED')
            if not depth_ok:
                reasons.append('KEV_SIGNAL_BOOK_IMBALANCE_TOO_LARGE')
            return dict(base, status='ok', eligible=not reasons, reason=reasons[0] if reasons else None,
                reasons=reasons, validationReason=None, window=window, overall=overall['view'],
                halves=[dict(h['view'], startTime=start if i == 0 else middle,
                             endTime=middle if i == 0 else end, endInclusive=i == 1) for i, h in enumerate(halves)],
                quoteResponse=dict(intervals=intervals, bidMoveBps=_text(bid_move), askMoveBps=_text(ask_move),
                    signedBidMoveBps=_text(bid_move*sign), signedAskMoveBps=_text(ask_move*sign), finalFavorable=final,
                    midChangeBps=_text(mid_move), signedMidChangeBps=_text(mid_move*sign)),
                bookImbalances=imbalances, depthWithinBounds=depth_ok, midChangeBps=_text(mid_move),
                sampledAt=books[-1]['at'], tradeCount=len(common))
    except Exception:
        return unavailable('KEV_SIGNAL_DATA_INVALID')
