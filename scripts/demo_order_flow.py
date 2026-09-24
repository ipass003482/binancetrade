"""Recompute sampled Demo flow proof at the native order boundary. No I/O."""
from decimal import Decimal, localcontext, ROUND_DOWN, ROUND_HALF_EVEN


class FlowValidationError(ValueError):
    def __init__(self, reason):
        super().__init__('FLOW_INVALID')
        self.reason = reason


def validate_flow(proof, mode, pair, side, now, min_taker_share='.55', *, data_only=False):
    def need(ok, reason='data_invalid'):
        if not ok:
            raise FlowValidationError(reason)

    def integer(v):
        return type(v) is int and abs(v) <= 9007199254740991

    def positive(v):
        need(type(v) in (str, int, float))
        d = Decimal(str(v))
        need(d.is_finite() and d > 0 and abs(d.adjusted()) <= 50)
        return d

    need(isinstance(proof, dict) and mode in ('demo', 'demo-futures') and side in ('long', 'short'), 'data_missing_or_invalid')
    need(proof.get('version') == 'sampled-demo-flow-v1' and proof.get('mode') == mode and proof.get('pair') == pair, 'identity_invalid')
    need(proof.get('source') == ('https://demo-api.binance.com' if mode == 'demo' else 'https://demo-fapi.binance.com'), 'source_invalid')
    books, trades = proof.get('books'), proof.get('trades')
    start, end = proof.get('startTime'), proof.get('endTime')
    need(isinstance(books, list) and len(books) == 3 and isinstance(trades, list) and 3 <= len(trades) < 1000, 'data_incomplete')
    need(integer(start) and integer(end) and end - start == 60000 and integer(now), 'window_invalid')
    with localcontext() as context:
        context.prec = 40
        context.rounding = ROUND_HALF_EVEN
        share = positive(min_taker_share)
        need(Decimal('.55') <= share <= Decimal('.60'), 'taker_threshold_invalid')
        mids, depth = [], []
        for i, book in enumerate(books):
            need(isinstance(book, dict))
            at, update = book.get('at'), book.get('updateId')
            need(integer(at) and integer(update) and update >= 0 and 0 <= now-at <= 90000, 'book_time_invalid')
            if i:
                need(5000 <= at-books[i-1]['at'] <= 20000 and update >= books[i-1]['updateId'], 'book_gap')
            sides = []
            for j, key in enumerate(('bids', 'asks')):
                levels = book.get(key)
                need(isinstance(levels, list) and len(levels) == 5)
                values = []
                for row in levels:
                    need(isinstance(row, list) and len(row) == 2)
                    p, q = map(positive, row)
                    if values:
                        need(p < values[-1][0] if j == 0 else p > values[-1][0])
                    values.append((p, q))
                sides.append(values)
            need(sides[0][0][0] < sides[1][0][0])
            totals = [sum(p*q for p, q in rows) for rows in sides]
            depth.append(totals[0] > totals[1] if side == 'long' else totals[0] < totals[1])
            mids.append((sides[0][0][0]+sides[1][0][0])/2)
        latest = books[-1]['at']
        need(now-latest <= 45000 and 0 <= latest-end <= 5000 and books[2]['at']-books[0]['at'] >= 15000, 'book_stale_or_window_mismatch')
        buy, sell, prior = Decimal(0), Decimal(0), None
        for trade in trades:
            need(isinstance(trade, dict))
            aid, stamp, maker = trade.get('a'), trade.get('T'), trade.get('m')
            need(integer(aid) and aid >= 0 and integer(stamp) and type(maker) is bool and start <= stamp <= end, 'trade_invalid')
            if prior:
                need(aid == prior['a']+1 and stamp >= prior['T'], 'trade_gap')
            n = positive(trade.get('p'))*positive(trade.get('q'))
            if maker:
                sell += n
            else:
                buy += n
            prior = trade
        need(end-trades[-1]['T'] <= 15000, 'tape_stale')
        directional = buy if side == 'long' else sell
        # Kev chooses direction from valid data. Historical deterministic plans
        # retain their original directional filters without any relaxation.
        if not data_only:
            need(directional >= share*(buy+sell), 'taker_not_opposing')
            need(all(depth), 'depth_not_opposing')
            need(mids[2] > mids[0] if side == 'long' else mids[2] < mids[0], 'price_not_opposing')
    return True


def _closed_volatility(volatility, number, fixed):
    """Recompute recent volatility from 15 immutable, closed five-minute rows."""
    def need(ok):
        if not ok:
            raise FlowValidationError('volatility_invalid')

    need(isinstance(volatility, dict) and set(volatility) == {'version', 'candleBoundary', 'candles'})
    boundary, rows = volatility.get('candleBoundary'), volatility.get('candles')
    need(volatility.get('version') == 'closed5m-volatility-v1'
         and type(boundary) is int and 0 < boundary <= 9007199254740991 and boundary % 300000 == 0
         and isinstance(rows, list) and len(rows) == 15)
    values = []
    for i, row in enumerate(rows):
        expected_open = boundary - (15 - i) * 300000
        need(isinstance(row, dict) and set(row) == {'openTime', 'closeTime', 'high', 'low', 'close'}
             and type(row.get('openTime')) is int and row['openTime'] == expected_open and expected_open >= 0
             and type(row.get('closeTime')) is int and row['closeTime'] == expected_open + 299999
             and all(isinstance(row.get(key), str) for key in ('high', 'low', 'close')))
        high, low, close = [number(row[key]) for key in ('high', 'low', 'close')]
        need(low <= close <= high)
        values.append((high, low, close))
    ranges = [max(high - low, abs(high - values[i - 1][2]), abs(low - values[i - 1][2]))
              for i, (high, low, _) in enumerate(values) if i]
    fast = sum(ranges[-7:], Decimal(0)) / 7
    slow = sum(ranges, Decimal(0)) / 14
    need(slow > 0 or fast == 0)
    ratio = fast / slow if slow else Decimal(1)
    multiplier = min(Decimal(1), slow / fast) if fast else Decimal(1)
    evidence = dict(fastPeriod=7, slowPeriod=14, fastAtr=fixed(fast), slowAtr=fixed(slow),
                    ratio=fixed(ratio), riskMultiplier=fixed(multiplier), lastClosedAt=boundary - 1)
    return multiplier, evidence


def derive_adaptive_parameters(proof, mode, pair, side, atr15, quote_price, cost_bps, volatility=None):
    """Pure prospective bounds, recomputed from the same immutable flow evidence.

    No samples, files or performance feedback can silently relax these bounds.
    Fixed outputs match host Decimal(40, HALF_EVEN).toFixed(12, ROUND_DOWN).
    """
    try:
        validate_flow(proof, mode, pair, side, proof['books'][-1]['at'])

        def number(value, zero=False):
            if type(value) not in (int, float, str):
                raise ValueError()
            result = Decimal(str(value))
            if not result.is_finite() or abs(result.adjusted()) > 50 or (result < 0 if zero else result <= 0):
                raise ValueError()
            return result

        def canonical(value):
            result = format(value, 'f')
            return result.rstrip('0').rstrip('.') if '.' in result else result

        def fixed(value):
            with localcontext() as output:
                output.prec = max(40, value.adjusted() + 14)
                return format(value.quantize(Decimal('.000000000001'), rounding=ROUND_DOWN), 'f')

        with localcontext() as context:
            context.prec = 40
            context.rounding = ROUND_HALF_EVEN
            atr, price, cost = number(atr15), number(quote_price), number(cost_bps, zero=True)
            fraction = atr / price
            atr_bps = fraction * 10000
            latest = proof['books'][-1]
            bid, ask = number(latest['bids'][0][0]), number(latest['asks'][0][0])
            spread = (ask - bid) / ((ask + bid) / 2) * 10000
            contra = 'asks' if side == 'long' else 'bids'
            depth = min(sum((number(p) * number(q) for p, q in book[contra]), Decimal(0)) for book in proof['books'])
            stake = Decimal(1) / (min(fraction, Decimal('.02')) + cost / 10000 + (Decimal('.005') if mode == 'demo' else Decimal(0)))
            spread_pressure = min(Decimal(1), spread / atr_bps)
            cost_pressure = min(Decimal(1), cost / (3 * atr_bps))
            liquidity_pressure = min(Decimal(1), stake / depth)
            base_scale = Decimal(1) / (1 + spread_pressure + cost_pressure + liquidity_pressure)
            scale = base_scale
            volatility_evidence = None
            if volatility is not None:
                multiplier, volatility_evidence = _closed_volatility(volatility, number, fixed)
                scale = max(Decimal('.25'), base_scale * multiplier)
            result = {
                'version': 'live-flow-adaptive-v2' if volatility is not None else 'live-flow-adaptive-v1', 'calibration': 'prospective_rule_not_fitted',
                'minTakerShare': fixed(Decimal('.55') + Decimal('.03') * spread_pressure + Decimal('.02') * liquidity_pressure),
                'costBufferBps': fixed(30 + 10 * spread_pressure), 'riskScale': fixed(scale), 'riskBudgetUsdt': fixed(scale),
                'inputs': {'mode': mode, 'long': side == 'long', 'atr15': canonical(atr), 'quotePrice': canonical(price),
                           'estimatedRoundTripCostBps': canonical(cost)},
                'evidence': {**{key: fixed(value) for key, value in {
                    'atrBps': atr_bps, 'spreadBps': spread, 'minContraDepthUsdt': depth,
                    'theoreticalStakeUsdt': stake, 'spreadPressure': spread_pressure,
                    'costPressure': cost_pressure, 'liquidityPressure': liquidity_pressure}.items()}, 'flowSampledAt': latest['at']},
            }
            if volatility is not None:
                # JSON round-trips are unnecessary: inputs contain only primitives.
                result['inputs']['volatility'] = {**volatility, 'candles': [dict(row) for row in volatility['candles']]}
                result['evidence']['baseRiskScale'] = fixed(base_scale)
                result['evidence']['volatility'] = volatility_evidence
            return result
    except Exception as error:
        if isinstance(error, FlowValidationError):
            raise
        raise FlowValidationError('adaptive_invalid') from None
