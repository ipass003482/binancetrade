"""Native v12 path direction / ATR target across callbacks and CCXT throttling."""
import copy
from decimal import Decimal
import json
from hashlib import sha256
import importlib.util
import sys
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import ccxt
import pytest
from freqtrade.enums import RunMode
from demo_model_guard_support import guard, isolate, add_guard, NOW, TAG, MS, BOUNDARY, fake_exchange

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'freqtrade/strategies'))
from RuleExits import RuleExits, valid_plan


def plan(short=False):
    return add_guard(dict(ruleVersion='kronos-direction-v12', purpose='strategy', timeframe='5m', atrTimeframe='15m',
        pair='ETH/USDT:USDT' if short else 'ETH/USDT', isShort=short, tag=TAG,
        stopFraction=.005, targetFraction=.02, maxHoldingBars=48, maxHoldingSeconds=14400,
        riskBudgetUsdt=1, riskCostFraction=.002, maxEntryNotionalUsdt=25, createdAt=NOW.isoformat(),
        profitProtection={'version':'net-profit-trail-v1','triggerNetUsdt':.5,'givebackNetUsdt':.25,'riskMultiple':.5}))


@pytest.fixture
def frozen(tmp_path, monkeypatch):
    return isolate(monkeypatch, tmp_path)


def authorize(exchange, value, amount=.25, rate=100):
    return guard.authorize_entry(exchange, value, 'demo-futures' if value['isShort'] else 'demo',
        value['pair'], 'short' if value['isShort'] else 'long', amount, rate, 'market')


def advance(clock, elapsed):
    clock['wall'] += elapsed
    clock['mono'] += elapsed


@pytest.mark.parametrize('short', [False, True])
def test_per_pair_identity_reaches_native_authorization_and_rejects_wrong_tag(frozen, short):
    value = plan(short)
    value['executionPolicyVersion'] = 'per-pair-cycle-v1'
    payload = json.dumps(['per-pair-cycle-v1', value['snapshotId'], value['pair']], separators=(',', ':'))
    value['tag'] = 'codex-' + sha256(payload.encode()).hexdigest()[:32]
    exchange = fake_exchange('demo-futures' if short else 'demo')
    assert authorize(exchange, value)
    value['tag'] = TAG
    with pytest.raises(ccxt.PermissionDenied):
        authorize(exchange, value)
    value['tag'] = guard._entry_tag(value, value['pair'])
    value['executionPolicyVersion'] = 'unknown'
    with pytest.raises(ccxt.PermissionDenied):
        authorize(exchange, value)


@pytest.mark.parametrize('short', [False, True])
def test_native_callback_requires_model_proof_but_preserves_persisted_exit_plan(frozen, short):
    strategy = RuleExits()
    strategy.config = {'trading_mode': 'futures' if short else 'spot'}
    strategy.dp = SimpleNamespace(_exchange=fake_exchange('demo-futures' if short else 'demo'))
    value = plan(short)
    strategy._entry_plan = lambda *args: value
    args = dict(pair=value['pair'], order_type='market', amount=.25, rate=100,
                time_in_force='GTC', current_time=NOW, entry_tag=TAG, side='short' if short else 'long')
    assert strategy.entry_risk_allowed(**args)
    value.pop('nativeEntryGuard')
    assert not strategy.entry_risk_allowed(**args)
    assert valid_plan(value, value['pair'], short, TAG) is value
    trade = SimpleNamespace(pair=value['pair'], is_short=short, enter_tag=TAG,
        get_custom_data=lambda **kwargs: value, open_rate=100, open_date_utc=NOW, leverage=1)
    assert strategy.custom_exit(value['pair'], trade, NOW + timedelta(hours=4), 100, 0) == 'rules_time'


@pytest.mark.parametrize('short', [False, True])
def test_native_quote_requires_forecast_to_cover_full_costs_and_buffer(frozen, short):
    value, exchange = plan(short), fake_exchange('demo-futures' if short else 'demo')
    assert authorize(exchange, value)
    for target in (99.99 if short else 100.01, 99.5 if short else 100.5):
        for proof in (value['nativeEntryGuard'], value['entryConfirmation']):
            proof['forecastClose'] = str(target)
            proof['forecastCloses'] = [str(target)] * 3
        with pytest.raises(ccxt.PermissionDenied, match='FORECAST_COST_SHORTFALL'):
            authorize(exchange, value)
    value = plan(short)
    with pytest.raises(ccxt.PermissionDenied, match='PRICE_MOVED'):
        authorize(exchange, value, amount=.24, rate=101 if short else 99)


@pytest.mark.parametrize('short', [False, True])
def test_native_atr_target_exact_cost_boundary_and_no_false_target_amplification(frozen, short):
    exchange = fake_exchange('demo-futures' if short else 'demo')
    value = plan(short)
    value['nativeEntryGuard']['requiredPriceSpaceBps'] = '200'
    assert authorize(exchange, value)
    value['nativeEntryGuard']['requiredPriceSpaceBps'] = '200.0000000001'
    with pytest.raises(ccxt.PermissionDenied, match='ATR_PRICE_SPACE'):
        authorize(exchange, value)
    value = plan(short)
    for proof in (value['nativeEntryGuard'], value['entryConfirmation']):
        proof['targetFraction'] = .03
    value['targetFraction'] = .03
    with pytest.raises(ccxt.PermissionDenied, match='ATR_TARGET_IDENTITY'):
        authorize(exchange, value)


@pytest.mark.parametrize('short', [False, True])
@pytest.mark.parametrize('close', ['100', '99', '101'])
def test_native_requires_every_forecast_close_strictly_on_the_declared_side(frozen, short, close):
    value = plan(short)
    for proof in (value['nativeEntryGuard'], value['entryConfirmation']):
        proof['forecastCloses'][0] = close
    if float(close) == 100 or (float(close) > 100) == short:
        with pytest.raises(ccxt.PermissionDenied, match='DIRECTION_PATH'):
            authorize(fake_exchange('demo-futures' if short else 'demo'), value)
    else:
        assert authorize(fake_exchange('demo-futures' if short else 'demo'), value)


@pytest.mark.parametrize('mutation', [
    lambda p: p['nativeEntryGuard'].update(forecastCloses=['101', '101']),
    lambda p: p['nativeEntryGuard']['forecastCloses'].__setitem__(1, 'NaN'),
    lambda p: p['nativeEntryGuard'].update(originClose='101'),
    lambda p: p['nativeEntryGuard'].update(atr15=0),
    lambda p: p['nativeEntryGuard'].update(targetAtr=3),
    lambda p: p['nativeEntryGuard'].update(targetFraction=.03),
    lambda p: p['entryConfirmation'].update(atr15=.5),
    lambda p: p['nativeEntryGuard'].update(requiredPriceSpaceBps='19.999999'),
    lambda p: p.update(atrTimeframe='5m'),
])
def test_native_v12_rejects_malformed_path_atr_or_uncovered_cost_proof(frozen, mutation):
    value = plan(); mutation(value)
    with pytest.raises(ccxt.PermissionDenied):
        authorize(fake_exchange(), value)


def test_native_float_compatible_atr_proof_has_tight_tolerance(frozen):
    value = plan()
    for proof in (value['nativeEntryGuard'], value['entryConfirmation']):
        proof['atr15'] = 1.0000000000000002
    assert authorize(fake_exchange(), value)
    for proof in (value['nativeEntryGuard'], value['entryConfirmation']):
        proof['atr15'] = 1.00000001
    with pytest.raises(ccxt.PermissionDenied, match='ATR_TARGET_IDENTITY'):
        authorize(fake_exchange(), value)


@pytest.mark.parametrize('mutation', [
    lambda p: p.pop('model'), lambda p: p['nativeEntryGuard'].update(snapshotId='11111111-1111-4111-8111-111111111112'),
    lambda p: p.update(tag='codex-'+'a'*32), lambda p: p['nativeEntryGuard'].update(extra=True),
    lambda p: p['nativeEntryGuard'].update(modelDeadline=BOUNDARY+60001),
    lambda p: p['nativeEntryGuard'].update(requiredPriceSpaceBps='NaN'),
    lambda p: p['nativeEntryGuard'].update(leverage=4),
    lambda p: p['nativeEntryGuard']['clock'].update(mode='demo-futures'),
    lambda p: p['nativeEntryGuard']['clock'].update(source='https://api.binance.com/api/v3/time'),
    lambda p: p['nativeEntryGuard']['clock'].update(serverTime=MS+2001),
    lambda p: p['nativeEntryGuard']['clock'].update(requestStartedAt=MS-1501),
])
def test_native_guard_rejects_malformed_or_misbound_proof(frozen, mutation):
    value = plan(); mutation(value)
    with pytest.raises(ccxt.PermissionDenied):
        authorize(fake_exchange(), value)


def test_native_guard_rejects_60s_boundary_using_exchange_upper_bound_not_host_alone(frozen):
    value = plan(); frozen.update(wall=BOUNDARY+59995, mono=frozen['mono']+39995)
    value['createdAt'] = NOW.isoformat()
    # Clock's upper offset is +10ms, so local 59.995s is already beyond deadline.
    with pytest.raises(ccxt.PermissionDenied, match='DEADLINE'):
        authorize(fake_exchange(), value)


def test_entry_permit_is_exact_one_use_and_cannot_cross_exchange_owner(frozen):
    value, exchange = plan(), fake_exchange()
    authorize(exchange, value)
    kwargs = dict(pair=value['pair'], side='buy', amount=.25, rate=100, leverage=1,
                  reduce_only=False, initial_order=True, order_type='market')
    with pytest.raises(ccxt.PermissionDenied, match='PERMIT_REQUIRED'):
        with guard.order_context(fake_exchange(), **kwargs):
            pass
    # Even a rejected/misbound consume burns the one-use grant.
    with pytest.raises(ccxt.PermissionDenied, match='PERMIT_REQUIRED'):
        with guard.order_context(exchange, **kwargs):
            pass
    authorize(exchange, value)
    with guard.order_context(exchange, **kwargs):
        body = 'symbol=ETHUSDT&side=BUY&type=MARKET&quantity=0.250'
        guard.guard_order_wire(exchange, 'https://demo-api.binance.com/api/v3/order', 'POST', body)
        with pytest.raises(ccxt.PermissionDenied, match='WIRE_CONTEXT'):
            guard.guard_order_wire(exchange, 'https://demo-api.binance.com/api/v3/order', 'POST', body)
    with pytest.raises(ccxt.PermissionDenied, match='WIRE_CONTEXT'):
        guard.guard_order_wire(exchange, 'https://demo-api.binance.com/api/v3/order', 'POST', body)


@pytest.mark.parametrize('field,value', [('initial_order', None), ('initial_order', 'false'),
                                         ('reduce_only', 0), ('reduce_only', 'false')])
def test_order_context_rejects_non_boolean_entry_exit_selectors(frozen, field, value):
    exchange, value_plan = fake_exchange(), plan()
    authorize(exchange, value_plan)
    kwargs = dict(pair=value_plan['pair'], side='buy', amount=.25, rate=100, leverage=1,
                  reduce_only=False, initial_order=True, order_type='market')
    kwargs[field] = value
    with pytest.raises(ccxt.PermissionDenied, match='ORDER_IDENTITY'):
        with guard.order_context(exchange, **kwargs):
            pytest.fail('invalid entry/exit selector accepted')


@pytest.mark.parametrize('body', [
    'symbol=ETHUSDT&side=SELL&type=MARKET&quantity=0.25',
    'symbol=ETHUSDT&side=BUY&type=MARKET&quantity=0.26',
    'symbol=ETHUSDT&side=BUY&type=MARKET&quantity=0.25&reduceOnly=garbage',
    'symbol=ETHUSDT&side=BUY&type=MARKET&quantity=0.25&quantity=0.25',
])
def test_final_wire_requires_exact_side_quantity_and_reduce_only(frozen, body):
    exchange, value = fake_exchange(), plan()
    authorize(exchange, value)
    with guard.order_context(exchange, pair=value['pair'], side='buy', amount=.25, rate=100,
                             leverage=1, reduce_only=False, initial_order=True, order_type='market'):
        with pytest.raises(ccxt.PermissionDenied, match='WIRE_IDENTITY'):
            guard.guard_order_wire(exchange, 'https://demo-api.binance.com/api/v3/order', 'POST', body)


@pytest.fixture(params=[False, True], ids=['spot', 'futures'])
def native(request, tmp_path, monkeypatch):
    frozen = isolate(monkeypatch, tmp_path)
    short = request.param
    name = 'demo-futures-engine' if short else 'demo-engine'
    spec = importlib.util.spec_from_file_location(name+'_model_guard_test', ROOT/'scripts'/f'{name}.py')
    adapter = importlib.util.module_from_spec(spec); spec.loader.exec_module(adapter)
    import demo_protection
    monkeypatch.setattr(demo_protection, 'ROOT', tmp_path)
    cls = adapter.DemoFuturesBinance if short else adapter.DemoBinance
    monkeypatch.setattr(cls, 'additional_exchange_init', lambda self: None)
    wire, raw_failure = [], []
    # Patch the parent's raw transport BEFORE constructing the guarded adapter;
    # its real _init_ccxt fetch wrapper remains active around this stub.
    def raw_fetch(self, url, method='GET', headers=None, body=None):
        values = {k:v[0] for k,v in parse_qs(body or urlsplit(url).query).items()}
        wire.append({k:values.get(k) for k in ('symbol','side','type','quantity','reduceOnly')})
        if raw_failure:
            raise raw_failure.pop()
        return dict(orderId='42', symbol='ETHUSDT', side=values['side'], type='MARKET', status='FILLED',
            origQty=values['quantity'], executedQty=values['quantity'], cummulativeQuoteQty='25',
            avgPrice='100', price='0', transactTime=MS, updateTime=MS, timeInForce='GTC')
    monkeypatch.setattr(ccxt.binance, 'fetch', raw_fetch)
    pair = 'ETH/USDT:USDT' if short else 'ETH/USDT'
    config = dict(dry_run=False, runmode=RunMode.LIVE, trading_mode='futures' if short else 'spot',
        margin_mode='isolated' if short else '', stake_currency='USDT',
        exchange=dict(name='binance', demo_trading=True, enable_ws=False, pair_whitelist=[pair],
            key='unit-test-key', secret='unit-test-secret', ccxt_config={'options':{'defaultType':'future' if short else 'spot',
                'fetchMarkets':{'types':['linear'] if short else ['spot']}, 'fetchCurrencies':False}}))
    demo_protection.pin_demo_exit_config(config, short)
    exchange = cls(config, validate=False)
    market = dict(id='ETHUSDT', symbol=pair, base='ETH', quote='USDT', settle='USDT' if short else None,
        baseId='ETH', quoteId='USDT', settleId='USDT' if short else None,
        type='swap' if short else 'spot', spot=not short, swap=short, future=False, option=False,
        contract=short, linear=short, inverse=False, active=True, contractSize=1 if short else None,
        precision={'amount':.001,'price':.01}, limits={'amount':{'min':.001,'max':10000},
        'price':{'min':.01,'max':100000},'cost':{'min':5,'max':None},'leverage':{'min':1,'max':3}},
        info={'orderTypes':['MARKET','LIMIT','STOP_MARKET' if short else 'STOP_LOSS_LIMIT']})
    exchange._api.set_markets([market]); exchange._markets = exchange._api.markets
    exchange._lev_prep = lambda *args, **kwargs: None
    exchange._api.throttle = lambda cost: None
    value = SimpleNamespace(exchange=exchange, short=short, pair=pair, plan=plan(short), wire=wire,
                            frozen=frozen, tmp=tmp_path, raw_failure=raw_failure)
    try:
        yield value
    finally:
        exchange.close()
        guard.clear_entry_permit()


def create(native, amount=.25, **kwargs):
    return native.exchange.create_order(pair=native.pair, ordertype='market', side='sell' if native.short else 'buy',
        amount=amount, rate=100, leverage=1, reduceOnly=False, **kwargs)


def test_actual_freqtrade_ccxt_entry_keeps_precision_and_consumes_only_one_grant(native):
    native.plan['maxEntryNotionalUsdt'] = 25.09
    authorize(native.exchange, native.plan, amount=.2509)
    order = create(native, amount=.2509)
    assert order['id'] == '42' and order['amount'] == .25
    assert len(native.wire) == 1 and native.wire[0]['quantity'] == '0.25'
    with pytest.raises(ccxt.PermissionDenied, match='PERMIT_REQUIRED'):
        create(native, amount=.2509)
    assert len(native.wire) == 1


@pytest.mark.parametrize('change', [
    {'reserveFraction': '0'}, {'reserveFraction': .005}, {'stopLimitRatio': '0.999'},
    {'version': 'unknown'}, {'mode': 'demo-futures'}, {'extra': 'unverified'},
])
def test_spot_native_rejects_missing_or_forged_stress_reserve(frozen, change):
    value = plan()
    value['riskPolicy'].update(change)
    with pytest.raises(ccxt.PermissionDenied, match='RISK_POLICY'):
        authorize(fake_exchange(), value)


def test_spot_stress_risk_rejects_amount_that_old_budget_accepted(frozen):
    value = plan()
    value['maxEntryNotionalUsdt'] = 150
    # 100 * (.005 + .002) = .70 old; 100 * (.005 + .002 + .005) = 1.20 new.
    with pytest.raises(ccxt.PermissionDenied, match='RISK_BUDGET'):
        authorize(fake_exchange(), value, amount=1)
    assert authorize(fake_exchange(), value, amount=.83)
    value.pop('riskPolicy')
    with pytest.raises(ccxt.PermissionDenied, match='RISK_POLICY'):
        authorize(fake_exchange(), value)
    assert valid_plan(value, value['pair'], False, TAG) is value  # old exits preserved


def test_actual_wire_rechecks_stress_budget_after_throttle(native):
    authorize(native.exchange, native.plan)
    def throttle(cost):
        state = guard._active.get()
        state['plan']['riskPolicy']['reserveFraction'] = 'forged'
    native.exchange._api.throttle = throttle
    with pytest.raises(Exception, match='RISK_POLICY'):
        create(native)
    assert native.wire == []


@pytest.mark.parametrize('fault,reason', [('deadline','DEADLINE'),('quote','QUOTE_STALE'),('clock_jump','CLOCK_JUMP'),
                                        ('mode_stop','STOPPED'),('model_stop','STOPPED')])
def test_actual_ccxt_fetch_guard_rechecks_after_rate_limit_delay(native, fault, reason):
    authorize(native.exchange, native.plan)
    def throttle(cost):
        if fault == 'deadline': advance(native.frozen, 45000)
        elif fault == 'quote': advance(native.frozen, 16000)
        elif fault == 'clock_jump': native.frozen['wall'] += 300
        else:
            folder = native.tmp/'local'/('model-research' if fault == 'model_stop' else 'demo-futures' if native.short else 'demo')
            folder.mkdir(parents=True, exist_ok=True); (folder/'STOP').write_text('test stop')
    native.exchange._api.throttle = throttle
    with pytest.raises(Exception, match=reason):
        create(native)
    assert native.wire == []


def test_actual_order_exit_remains_available_with_mode_and_model_stop(native):
    for name in ('model-research', 'demo-futures' if native.short else 'demo'):
        folder = native.tmp/'local'/name; folder.mkdir(parents=True, exist_ok=True); (folder/'STOP').write_text('test')
    native.exchange.create_order(pair=native.pair, ordertype='market', side='buy' if native.short else 'sell',
        amount=.25, rate=100, leverage=1, reduceOnly=native.short, initial_order=False)
    assert len(native.wire) == 1


def test_lost_transport_reply_does_not_preserve_reusable_entry_permission(native):
    authorize(native.exchange, native.plan)
    native.raw_failure.append(ccxt.RequestTimeout('unit test transport failure'))
    with pytest.raises(Exception): create(native)
    with pytest.raises(ccxt.PermissionDenied, match='PERMIT_REQUIRED'): create(native)
    assert len(native.wire) == 1


def test_probe_exception_is_explicit_and_does_not_ignore_mode_stop(native):
    value = dict(ruleVersion='demo-execution-probe-v1', purpose='execution_probe', timeframe='5m',
        pair=native.pair, isShort=native.short, tag='codex-'+'c'*32, stopFraction=.005,targetFraction=.005,
        maxHoldingBars=1,maxHoldingSeconds=90,riskBudgetUsdt=1,riskCostFraction=.002,
        maxEntryNotionalUsdt=25,createdAt=NOW.isoformat())
    folder=native.tmp/'local/model-research'; folder.mkdir(parents=True); (folder/'STOP').write_text('test')
    authorize(native.exchange,value); create(native)
    assert len(native.wire)==1
    folder=native.tmp/'local'/('demo-futures' if native.short else 'demo'); folder.mkdir(parents=True,exist_ok=True); (folder/'STOP').write_text('test')
    with pytest.raises(ccxt.PermissionDenied,match='STOPPED'): authorize(native.exchange,value)
    bad=copy.deepcopy(value); bad['pair']='BTC/USDT:USDT' if native.short else 'BTC/USDT'
    with pytest.raises(ccxt.PermissionDenied,match='PROBE_IDENTITY'): authorize(native.exchange,bad)


@pytest.mark.parametrize('short', [False, True])
@pytest.mark.parametrize('mutation', ['missing', 'flat5', 'opposed15', 'future', 'origin', 'version'])
def test_native_momentum_proof_blocks_conflicting_or_missing_evidence(frozen, short, mutation):
    value = plan(short)
    proof = value['entryConfirmation']['priceConfirmation']
    if mutation == 'missing':
        value['entryConfirmation'].pop('priceConfirmation')
    elif mutation == 'flat5':
        proof['closes'][2] = proof['closes'][-1]
    elif mutation == 'opposed15':
        proof['closes'][0] = '99' if short else '101'
    elif mutation == 'future':
        proof['closeTimes'][-1] += 300000
    elif mutation == 'origin':
        proof['closes'][-1] = '99'
    else:
        value['entryPolicyVersion'] = 'unknown'
    with pytest.raises(ccxt.PermissionDenied, match='MOMENTUM'):
        authorize(fake_exchange('demo-futures' if short else 'demo'), value)


def test_momentum_is_rechecked_after_rpc_grant_and_old_exit_remains_valid(frozen):
    value, exchange = plan(), fake_exchange()
    authorize(exchange, value)
    guard._pending.get()['plan']['entryConfirmation']['priceConfirmation']['closes'][2] = '101'
    with pytest.raises(ccxt.PermissionDenied, match='MOMENTUM_DIRECTION'):
        with guard.order_context(exchange, pair=value['pair'], side='buy', amount=.25, rate=100,
                                 leverage=1, reduce_only=False, initial_order=True, order_type='market'):
            pytest.fail('must reject before wire')
    value.pop('entryPolicyVersion')
    value['entryConfirmation'].pop('priceConfirmation')
    assert valid_plan(value, value['pair'], False, TAG) is value


@pytest.mark.parametrize('short', [False, True])
def test_old_entry_policy_cannot_bypass_new_gate_but_old_exit_plan_remains_valid(frozen, short):
    value=plan(short)
    value['entryPolicyVersion']='closed-price-momentum-v1'
    with pytest.raises(ccxt.PermissionDenied, match='MOMENTUM_IDENTITY'):
        authorize(fake_exchange('demo-futures' if short else 'demo'), value)
    assert valid_plan(value, value['pair'], short, TAG) is value


def test_actual_wire_recomputes_forecast_cost_gate_after_throttle(native):
    authorize(native.exchange, native.plan)
    def throttle(cost):
        state = guard._active.get()
        target = '99.99' if native.short else '100.01'
        for proof in (state['plan']['nativeEntryGuard'],state['plan']['entryConfirmation']):
            proof['forecastClose']=target
            proof['forecastCloses']=[target]*3
    native.exchange._api.throttle=throttle
    with pytest.raises(Exception,match='FORECAST_COST_SHORTFALL'):
        create(native)
    assert native.wire==[]


# New prospective price-triggered policy; historical net-edge tests above stay intact.
def pullback_plan(short=False):
    value=plan(short)
    bars=[]
    for i in range(25):
        p=100 if i==24 else 99.7 if i==23 else 99.8 if i==22 else 99.9 if i==21 else 97+i*.1
        c=200-p if short else p
        bars.append([str(c),str(c+.05),str(c-.05),str(c)])
    value['entryPolicyVersion']='trend-pullback-model-v1'
    value['nativeEntryGuard']['requiredPriceSpaceBps']='150'
    value['targetFraction']=.03
    for proof in (value['nativeEntryGuard'],value['entryConfirmation']):
        proof['targetAtr']=3
        proof['targetFraction']=.03
    value['stopFraction']=.01
    value['entryConfirmation']['priceConfirmation']=dict(version='trend-pullback-model-v1',confirmationAt=BOUNDARY,
        closeTimes=[BOUNDARY-(24-i)*300000-1 for i in range(25)],bars=bars,eligible=True,
        checks=dict(trend=True,pullback=True,reclaim=True))
    for proof in (value['nativeEntryGuard'],value['entryConfirmation']):
        proof['forecastClose']='99.99' if short else '100.01'
        proof['forecastCloses']=[proof['forecastClose']]*3
    return value


@pytest.mark.parametrize('short',[False,True])
def test_pullback_callback_context_and_wire_allow_small_positive_forecast_only_with_price_and_net_risk_proof(frozen,short):
    value=pullback_plan(short); mode='demo-futures' if short else 'demo'; exchange=fake_exchange(mode)
    strategy=RuleExits();strategy.config={'trading_mode':'futures' if short else 'spot'}
    strategy.dp=SimpleNamespace(_exchange=exchange);strategy._entry_plan=lambda *args:value
    assert strategy.entry_risk_allowed(pair=value['pair'],order_type='market',amount=.25,rate=100,time_in_force='GTC',current_time=NOW,entry_tag=TAG,side='short' if short else 'long')
    with guard.order_context(exchange,pair=value['pair'],side='sell' if short else 'buy',amount=.25,rate=100,
            leverage=1,reduce_only=False,initial_order=True,order_type='market'):
        url='https://demo-fapi.binance.com/fapi/v1/order' if short else 'https://demo-api.binance.com/api/v3/order'
        guard.guard_order_wire(exchange,url,'POST','symbol=ETHUSDT&side='+('SELL' if short else 'BUY')+'&type=MARKET&quantity=0.25')


@pytest.mark.parametrize('change',['future','ohlc','origin','checks','trend','missing'])
def test_pullback_native_rejects_forged_price_proof(frozen,change):
    value=pullback_plan(); proof=value['entryConfirmation']['priceConfirmation']
    if change=='future':proof['closeTimes'][-1]+=1
    elif change=='ohlc':proof['bars'][-1][1]='90'
    elif change=='origin':proof['bars'][-1]=['101','101.1','100.9','101']
    elif change=='checks':proof['checks']['trend']=1
    elif change=='trend':proof['bars'][0]=['200','201','199','200']
    elif change=='missing':proof['bars'].pop()
    with pytest.raises(ccxt.PermissionDenied,match='PULLBACK'):
        authorize(fake_exchange(),value)


def test_pullback_native_recomputes_cost_geometry_at_context_and_wire(frozen):
    value=pullback_plan(); value['riskCostFraction']=.009
    with pytest.raises(ccxt.PermissionDenied,match='NET_REWARD_RISK'):
        authorize(fake_exchange(),value)
    value=pullback_plan();exchange=fake_exchange();assert authorize(exchange,value)
    pending=guard._pending.get();pending['plan']['riskCostFraction']=.009
    with pytest.raises(ccxt.PermissionDenied,match='NET_REWARD_RISK'):
        with guard.order_context(exchange,pair=value['pair'],side='buy',amount=.25,rate=100,leverage=1,reduce_only=False,initial_order=True,order_type='market'):pass
    assert authorize(exchange,value)
    with guard.order_context(exchange,pair=value['pair'],side='buy',amount=.25,rate=100,leverage=1,reduce_only=False,initial_order=True,order_type='market'):
        guard._active.get()['plan']['riskCostFraction']=.009
        with pytest.raises(ccxt.PermissionDenied,match='NET_REWARD_RISK'):
            guard.guard_order_wire(exchange,'https://demo-api.binance.com/api/v3/order','POST','symbol=ETHUSDT&side=BUY&type=MARKET&quantity=0.25')


@pytest.mark.parametrize('field',['stop','buffer'])
def test_pullback_native_rejects_changed_stop_derivation_or_missing_original_buffer(frozen,field):
    value=pullback_plan()
    if field=='stop':value['stopFraction']=.009
    else:value['nativeEntryGuard']['requiredPriceSpaceBps']='49.999'
    with pytest.raises(ccxt.PermissionDenied,match='ATR_STOP_IDENTITY|COST_BUFFER_IDENTITY'):
        authorize(fake_exchange(),value)


def test_actual_decimal_cost_serialization_roundoff_does_not_erase_original_30bps_buffer(frozen):
    value=pullback_plan();value['riskCostFraction']=0.0019317769259796231
    value['nativeEntryGuard']['requiredPriceSpaceBps']='49.31776925979623'
    assert authorize(fake_exchange(),value)
    value['nativeEntryGuard']['requiredPriceSpaceBps']='49.31776925879623'
    with pytest.raises(ccxt.PermissionDenied,match='COST_BUFFER_IDENTITY'):
        authorize(fake_exchange(),value)


def flow_plan(short=False):
    value=pullback_plan(short)
    mode='demo-futures' if short else 'demo'
    value['entryPolicyVersion']='trend-pullback-flow-v1'
    confirmation=value['entryConfirmation'];confirmation['entryRoute']='order-flow'
    price=confirmation['priceConfirmation']
    price['bars'][23][2 if short else 1]='99' if short else '101'
    price['eligible']=False;price['checks']['reclaim']=False
    books=[]
    for i in range(3):
        mid=(100.1 if short else 100)+(-1 if short else 1)*i*.001
        books.append(dict(at=MS-20000+i*10000,updateId=i+1,
            bids=[[str(mid-.001-k*.001),'1' if short else '3'] for k in range(5)],
            asks=[[str(mid+.001+k*.001),'3' if short else '1'] for k in range(5)]))
    confirmation['orderFlow']=dict(version='sampled-demo-flow-v1',mode=mode,pair=value['pair'],
        source='https://demo-fapi.binance.com' if short else 'https://demo-api.binance.com',
        books=books,startTime=MS-61500,endTime=MS-1500,
        trades=[dict(a=i+1,T=MS-55000+i*25000,p='100',q='1',m=short) for i in range(3)])
    if short:
        confirmation['executionContinuation']=dict(version='flow-futures-price-continuation-v1',long=False,
            originPrice=books[0]['bids'][0][0],quotePrice=confirmation['quotePrice'])
    return value


@pytest.mark.parametrize('short',[False,True])
def test_flow_actual_native_callback_context_and_wire(frozen,short):
    value=flow_plan(short);mode='demo-futures' if short else 'demo';exchange=fake_exchange(mode)
    strategy=RuleExits();strategy.config={'trading_mode':'futures' if short else 'spot'}
    strategy.dp=SimpleNamespace(_exchange=exchange);strategy._entry_plan=lambda *args:value
    assert strategy.entry_risk_allowed(pair=value['pair'],order_type='market',amount=.25,rate=100,time_in_force='GTC',current_time=NOW,entry_tag=TAG,side='short' if short else 'long')
    with guard.order_context(exchange,pair=value['pair'],side='sell' if short else 'buy',amount=.25,rate=100,leverage=1,reduce_only=False,initial_order=True,order_type='market'):
        url='https://demo-fapi.binance.com/fapi/v1/order' if short else 'https://demo-api.binance.com/api/v3/order'
        guard.guard_order_wire(exchange,url,'POST','symbol=ETHUSDT&side='+('SELL' if short else 'BUY')+'&type=MARKET&quantity=0.25')


@pytest.mark.parametrize('change',['stale','gap','maker','source','book','route','trend'])
def test_flow_bad_evidence_cannot_create_native_entry(frozen,change):
    value=flow_plan();c=value['entryConfirmation'];p=c['orderFlow']
    if change=='stale':
        for b in p['books']:b['at']-=50000
        p['startTime']-=50000;p['endTime']-=50000
        for t in p['trades']:t['T']-=50000
    elif change=='gap':p['trades'][1]['a']=99
    elif change=='maker':
        for t in p['trades']:t['m']=True
    elif change=='source':p['source']='https://api.binance.com'
    elif change=='book':p['books'][2]['bids'][0][1]='0'
    elif change=='route':c['entryRoute']='pullback'
    else:c['priceConfirmation']['checks']['trend']=False
    with pytest.raises(ccxt.PermissionDenied,match='FLOW|PULLBACK'):
        authorize(fake_exchange(),value)


def test_flow_expiration_rechecked_after_callback(frozen):
    value=flow_plan();exchange=fake_exchange();assert authorize(exchange,value)
    frozen['wall']+=46000;frozen['mono']+=46000
    with pytest.raises(ccxt.PermissionDenied,match='FLOW_EVIDENCE'):
        with guard.order_context(exchange,pair=value['pair'],side='buy',amount=.25,rate=100,leverage=1,reduce_only=False,initial_order=True,order_type='market'):pass


def flow_only_plan(short=False):
    value=flow_plan(short)
    value.pop('model')
    value['entryPolicyVersion']='order-flow-only-v1'
    value['entrySignalEngine']='sampled_order_flow'
    old=value['entryConfirmation']
    value['entryConfirmation']={k:old[k] for k in ('entryRoute','orderFlow','confirmationAt','quotePrice','atr15','targetAtr','targetFraction')}
    value['entryConfirmation']['version']='order-flow-atr-v1'
    if not short:
        for book in old['orderFlow']['books']:
            for levels in (book['bids'], book['asks']):
                for row in levels: row[0] = str(Decimal(row[0])-Decimal('.01'))
        value['executionQualityVersion']='flow-confirmed-exit-v2'
        from demo_flow_exit import POLICY, strength
        value['flowExit']=dict(POLICY)
        value['flowStrength']={'version':'depth-change-rank-v1','delta':str(strength(old['orderFlow']))}
        value['entryConfirmation']['executionContinuation']=dict(version='flow-price-continuation-v1',originAsk=old['orderFlow']['books'][0]['asks'][0][0])
    else:
        value['entryConfirmation']['executionContinuation']=dict(version='flow-futures-price-continuation-v1',long=False,
            originPrice=old['orderFlow']['books'][0]['bids'][0][0],quotePrice=value['entryConfirmation']['quotePrice'])
    value['entryEvidence']=dict(version='order-flow-evidence-v1',snapshotId=value['snapshotId'],usedForEntryDecision=True,
        proofSha256=sha256(json.dumps(old['orderFlow'],separators=(',',':'),ensure_ascii=False).encode()).hexdigest())
    g=value['nativeEntryGuard']
    for k in ('modelFingerprint','predictionSha256','issuedAt','forecastClose','forecastCloses','originClose'):
        g.pop(k)
    g['entryDeadline']=g.pop('modelDeadline')
    return value


@pytest.mark.parametrize('short',[False,True])
def test_flow_only_native_callback_context_wire_without_model(frozen,short):
    value=flow_only_plan(short);mode='demo-futures' if short else 'demo';exchange=fake_exchange(mode)
    observer_stop=guard.ROOT/'local/model-research/STOP';observer_stop.parent.mkdir(parents=True,exist_ok=True);observer_stop.write_text('observer test')
    strategy=RuleExits();strategy.config={'trading_mode':'futures' if short else 'spot','dry_run':False}
    strategy.dp=SimpleNamespace(_exchange=exchange);strategy._entry_plan=lambda *args:copy.deepcopy(value)
    assert strategy.entry_risk_allowed(pair=value['pair'],order_type='market',amount=.25,rate=100,time_in_force='GTC',current_time=NOW,entry_tag=TAG,side='short' if short else 'long')
    with guard.order_context(exchange,pair=value['pair'],side='sell' if short else 'buy',amount=.25,rate=100,leverage=1,reduce_only=False,initial_order=True,order_type='market'):
        guard.guard_order_wire(exchange,'https://demo-fapi.binance.com/fapi/v1/order' if short else 'https://demo-api.binance.com/api/v3/order','POST','symbol=ETHUSDT&side='+('SELL' if short else 'BUY')+'&type=MARKET&quantity=0.25')


@pytest.mark.parametrize('change',['hash','direction','stale','source','model','stop','cost','leverage','deadline'])
def test_flow_only_native_rejects_invalid_proof_and_preserves_risk(frozen,change):
    value=flow_only_plan()
    if change=='hash':value['entryEvidence']['proofSha256']='a'*64
    elif change=='direction':value['entryConfirmation']['orderFlow']['trades'][0]['m']=True
    elif change=='stale':value['entryConfirmation']['orderFlow']['books'][-1]['at']-=46000
    elif change=='source':value['entryConfirmation']['orderFlow']['source']='https://api.binance.com'
    elif change=='model':value['model']={'usedForEntryDecision':True}
    elif change=='stop':value['stopFraction']=.0001
    elif change=='cost':value['nativeEntryGuard']['requiredPriceSpaceBps']='49'
    elif change=='leverage':value['nativeEntryGuard']['leverage']=2
    elif change=='deadline':value['nativeEntryGuard']['entryDeadline']+=1
    with pytest.raises(ccxt.PermissionDenied):authorize(fake_exchange(),value)


def test_flow_only_native_wire_rechecks_elapsed_flow(frozen):
    value=flow_only_plan();exchange=fake_exchange();assert authorize(exchange,value)
    with guard.order_context(exchange,pair=value['pair'],side='buy',amount=.25,rate=100,leverage=1,reduce_only=False,initial_order=True,order_type='market'):
        advance(frozen,46000)
        with pytest.raises(ccxt.PermissionDenied,match='FLOW_EVIDENCE'):
            guard.guard_order_wire(exchange,'https://demo-api.binance.com/api/v3/order','POST','symbol=ETHUSDT&side=BUY&type=MARKET&quantity=0.25')


@pytest.mark.parametrize('change',['missing','version','origin','extra','quality'])
def test_continuation_proof_cannot_be_omitted_or_forged(frozen,change):
    value=flow_only_plan();c=value['entryConfirmation']
    if change=='missing':c.pop('executionContinuation')
    elif change=='version':c['executionContinuation']['version']='unknown'
    elif change=='origin':c['executionContinuation']['originAsk']='1'
    elif change=='extra':c['executionContinuation']['ignored']=True
    elif change=='quality':value.pop('executionQualityVersion')
    with pytest.raises(ccxt.PermissionDenied):authorize(fake_exchange(),value)


@pytest.mark.parametrize('offset',['0','-.001'])
def test_continuation_native_rejects_callback_rate_at_or_below_origin(frozen,offset):
    value=flow_only_plan()
    rate=float(Decimal(value['entryConfirmation']['executionContinuation']['originAsk'])+Decimal(offset))
    with pytest.raises(ccxt.PermissionDenied,match='FLOW_PRICE_NOT_CONTINUED'):
        authorize(fake_exchange(),value,rate=rate)


@pytest.mark.parametrize('stage',['context','wire'])
def test_continuation_is_rechecked_after_callback(frozen,stage):
    value=flow_only_plan();exchange=fake_exchange();assert authorize(exchange,value)
    def corrupt(state):state['plan']['entryConfirmation']['executionContinuation']['originAsk']='1'
    kwargs=dict(pair=value['pair'],side='buy',amount=.25,rate=100,leverage=1,reduce_only=False,initial_order=True,order_type='market')
    if stage=='context':
        corrupt(guard._pending.get())
        with pytest.raises(ccxt.PermissionDenied,match='FLOW_CONTINUATION_IDENTITY'):
            with guard.order_context(exchange,**kwargs):pass
    else:
        with guard.order_context(exchange,**kwargs) as state:
            corrupt(state)
            with pytest.raises(ccxt.PermissionDenied,match='FLOW_CONTINUATION_IDENTITY'):
                guard.guard_order_wire(exchange,'https://demo-api.binance.com/api/v3/order','POST','symbol=ETHUSDT&side=BUY&type=MARKET&quantity=0.25')


@pytest.mark.parametrize('change',['missing','version','side','origin','quote','extra'])
def test_futures_continuation_proof_cannot_be_omitted_or_forged(frozen,change):
    value=flow_only_plan(True);c=value['entryConfirmation']['executionContinuation']
    if change=='missing':value['entryConfirmation'].pop('executionContinuation')
    elif change=='version':c['version']='unknown'
    elif change=='side':c['long']=True
    elif change=='origin':c['originPrice']='1'
    elif change=='quote':c['quotePrice']='100.001'
    elif change=='extra':c['ignored']=True
    with pytest.raises(ccxt.PermissionDenied,match='FLOW_(?:GUARD|CONTINUATION)_IDENTITY'):
        authorize(fake_exchange('demo-futures'),value)


@pytest.mark.parametrize('rate_offset', [0, .001])
def test_futures_short_continuation_rejects_callback_at_or_above_origin(frozen,rate_offset):
    value=flow_only_plan(True)
    rate=float(Decimal(value['entryConfirmation']['executionContinuation']['originPrice'])+Decimal(str(rate_offset)))
    with pytest.raises(ccxt.PermissionDenied,match='FLOW_PRICE_NOT_CONTINUED'):
        authorize(fake_exchange('demo-futures'),value,amount=.2,rate=rate)


@pytest.mark.parametrize('change',['quality','exit_missing','exit_extra','exit_window','rank_missing','rank_forged'])
def test_strength_and_exit_entry_contract_cannot_be_changed(frozen,change):
    value=flow_only_plan()
    if change=='quality':value['executionQualityVersion']='flow-price-continuation-v1'
    elif change=='exit_missing':value.pop('flowExit')
    elif change=='exit_extra':value['flowExit']['ignore']=True
    elif change=='exit_window':value['flowExit']['minSeparationMs']=0
    elif change=='rank_missing':value.pop('flowStrength')
    else:value['flowStrength']['delta']='0.9'
    with pytest.raises(ccxt.PermissionDenied):authorize(fake_exchange(),value)


def fading_flow_plan():
    value=flow_only_plan();proof=value['entryConfirmation']['orderFlow']
    for row in proof['books'][0]['bids']:row[1]='6'
    from demo_flow_exit import strength
    value['flowStrength']['delta']=str(strength(proof))
    assert Decimal(value['flowStrength']['delta'])<0
    value['entryEvidence']['proofSha256']=sha256(json.dumps(proof,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
    return value


def test_negative_strength_is_ranking_not_new_native_gate(frozen):
    value=fading_flow_plan();exchange=fake_exchange()
    strategy=RuleExits();strategy.config={'trading_mode':'spot','dry_run':False}
    strategy.dp=SimpleNamespace(_exchange=exchange);strategy._entry_plan=lambda *args:copy.deepcopy(value)
    assert strategy.entry_risk_allowed(pair=value['pair'],order_type='market',amount=.25,rate=100,time_in_force='GTC',current_time=NOW,entry_tag=TAG,side='long')
    with guard.order_context(exchange,pair=value['pair'],side='buy',amount=.25,rate=100,leverage=1,reduce_only=False,initial_order=True,order_type='market'):
        guard.guard_order_wire(exchange,'https://demo-api.binance.com/api/v3/order','POST','symbol=ETHUSDT&side=BUY&type=MARKET&quantity=0.25')


@pytest.mark.parametrize('bad',['-0.99','-NaN','-Infinity','-1e100',True,None,{},''])
def test_signed_strength_still_requires_finite_matching_raw_proof(frozen,bad):
    value=fading_flow_plan();value['flowStrength']['delta']=bad
    with pytest.raises(ccxt.PermissionDenied):authorize(fake_exchange(),value)


def test_negative_amounts_costs_and_prices_remain_invalid():
    for negative in [-1,-.01,'-0.05042724446987871517']:
        with pytest.raises(ccxt.PermissionDenied,match='NUMBER_INVALID'):guard.decimal(negative)
        with pytest.raises(ccxt.PermissionDenied,match='NUMBER_INVALID'):guard.decimal(negative,True)
