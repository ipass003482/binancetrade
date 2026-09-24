"""Demo-only native protective stops; never a strategy entry surface.

The bridge owns entries. Freqtrade attaches these reduce/exit orders to its actual
trades. A persisted request and client id prevent blind retries after lost replies.
No credential, signed request, or raw exchange error is stored here.
"""
import json
import math
import os
import uuid
import logging
from time import sleep
from datetime import datetime, timezone
from pathlib import Path
from ccxt import ROUND_DOWN, ROUND_UP

from freqtrade.exceptions import InvalidOrderException, InsufficientFundsError, TemporaryError
from demo_model_guard import order_context, VERSION as NATIVE_ENTRY_GUARD_VERSION, RISK_POLICY_VERSION, KEV_GUARD_VERSION

ROOT = Path(__file__).resolve().parents[1]
PROTECTION_VERSION = 'demo-native-stop-v1'
ENGINE_VERSION = 'demo-rule-exits-v12'
CANCEL_RECONCILIATION_VERSION = 'terminal-read-v2'
# Bounded read-only backoff after ONE cancel request; never resend a mutation.
CANCEL_READ_DELAYS_SECONDS = (0, .25, .5, 1, 2)
# Windows can briefly deny an atomic replace while a read-only consumer closes
# the readiness file.  Retry the metadata publication only; this never repeats
# an exchange mutation and still fails closed when the lock persists.
PROTECTION_REPLACE_RETRY_DELAYS_SECONDS = (0, .05, .1, .25, .5, 1, 2)


def pin_demo_exit_config(config, futures=False):
    config.update(minimal_roi={}, trailing_stop=False, use_custom_stoploss=True)
    config['order_types'] = dict(entry='market', exit='market', emergency_exit='market',
        force_entry='market', force_exit='market', stoploss='market' if futures else 'limit',
        stoploss_on_exchange=True, stoploss_on_exchange_interval=15)
    if futures:
        config['order_types']['stoploss_price_type'] = 'last'
    else:
        config['order_types']['stoploss_on_exchange_limit_ratio'] = .995


def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


class GuardedDemoStops:
    """Mixin before Binance in the MRO; all HTTP remains behind its URL guards."""

    @property
    def _protection_mode(self):
        return 'demo-futures' if self._config.get('trading_mode') == 'futures' else 'demo'

    @property
    def _protection_path(self):
        return ROOT / 'local' / self._protection_mode / 'protection-readiness.json'

    def _read_protection(self):
        try:
            state = json.loads(self._protection_path.read_text(encoding='utf-8'))
            if (state.get('version') != PROTECTION_VERSION or state.get('mode') != self._protection_mode
                    or not isinstance(state.get('attempts'), list)):
                raise ValueError()
            return state
        except FileNotFoundError:
            return dict(version=PROTECTION_VERSION, mode=self._protection_mode, attempts=[])
        except (OSError, ValueError, TypeError):
            raise TemporaryError('DEMO_PROTECTION_STATE_INVALID') from None

    def _write_protection(self, state):
        state['activeStops'] = [dict(pair=a['pair'], orderId=a['orderId'], side=a['side'],
            amount=a['acceptedAmount'], stopPrice=a['stopPrice'], observedAt=a.get('observedAt', a.get('confirmedAt')))
            for a in state['attempts'] if a.get('status') == 'confirmed' and a.get('orderStatus') == 'open']
        state['unresolvedStops'] = sum(a.get('status') in ('pending', 'unknown') for a in state['attempts'])
        state['protectionStatus'] = ('reconciliation_required' if state['unresolvedStops'] else
            'active_order_observed' if state['activeStops'] else 'no_active_order_observed')
        state.update(engineVersion=ENGINE_VERSION, asOf=datetime.now(timezone.utc).isoformat(),
                     processId=os.getpid(), cancelReconciliationVersion=CANCEL_RECONCILIATION_VERSION,
                     nativeEntryGuardVersion=NATIVE_ENTRY_GUARD_VERSION, kevEntryGuardVersion=KEV_GUARD_VERSION, riskPolicyVersion=RISK_POLICY_VERSION,
                     stopPriceVersion='stable-unarmed-stop-v1',
                     stopLimitRatio=(self._config.get('order_types', {}).get('stoploss_on_exchange_limit_ratio')
                                     if self._protection_mode == 'demo' else None))
        path = self._protection_path
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix('.' + uuid.uuid4().hex + '.tmp')
        try:
            with temp.open('w', encoding='utf-8') as handle:
                json.dump(state, handle, allow_nan=False)
                handle.flush()
                os.fsync(handle.fileno())
            replace_error = None
            for wait_seconds in PROTECTION_REPLACE_RETRY_DELAYS_SECONDS:
                if wait_seconds:
                    sleep(wait_seconds)
                try:
                    os.replace(temp, path)
                    replace_error = None
                    break
                except PermissionError as error:
                    replace_error = error
            if replace_error is not None:
                raise replace_error
        finally:
            temp.unlink(missing_ok=True)

    def _pause_entries(self, reason):
        path = self._protection_path.parent / 'STOP'
        try:
            with path.open('x', encoding='utf-8') as handle:
                handle.write(reason + '\n')
        except FileExistsError:
            pass  # Never replace an operator's stop reason.

    def _native_order_telemetry(self, event):
        try:
            path = self._protection_path.parent / 'native-orders.jsonl'
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('a', encoding='utf-8') as handle:
                handle.write(json.dumps(event, allow_nan=False) + '\n')
                handle.flush()
                os.fsync(handle.fileno())
        except (OSError, TypeError, ValueError):
            # Telemetry failure must not turn a successful broker receipt into
            # an ambiguous retry or prevent the engine from closing a trade.
            logging.getLogger(__name__).warning('DEMO_NATIVE_ORDER_TELEMETRY_UNAVAILABLE')

    def create_order(self, *, pair, ordertype, side, amount, rate, leverage=1.0, reduceOnly=False, **kwargs):
        request_id = uuid.uuid4().hex
        event = dict(version=1, mode=self._protection_mode, source='freqtrade-demo', requestId=request_id,
            event='request', requestedAt=datetime.now(timezone.utc).isoformat(), pair=pair, side=side,
            orderType=ordertype, requestedAmount=amount, referenceRate=rate,
            referenceRateSource='native_engine_order_reference', exchangePreOrderQuote=None,
            leverage=leverage, reduceOnly=reduceOnly)
        self._native_order_telemetry(event)
        try:
            with order_context(self, pair=pair, side=side, amount=amount, rate=rate, leverage=leverage,
                    reduce_only=reduceOnly, initial_order=kwargs.get('initial_order', True), order_type=ordertype):
                order = super().create_order(pair=pair, ordertype=ordertype, side=side, amount=amount,
                    rate=rate, leverage=leverage, reduceOnly=reduceOnly, **kwargs)
        except Exception as error:
            self._native_order_telemetry(dict(event, event='request_failed_or_unknown',
                responseAt=datetime.now(timezone.utc).isoformat(), errorClass=type(error).__name__))
            raise
        receipt = order if isinstance(order, dict) else {}
        def number(key):
            value = receipt.get(key)
            return value if type(value) in (int, float) and math.isfinite(value) else None
        self._native_order_telemetry(dict(event, event='order_receipt',
            responseAt=datetime.now(timezone.utc).isoformat(), orderId=str(receipt.get('id') or '') or None,
            orderStatus=receipt.get('status'), filledAmount=number('filled'), average=number('average'),
            cost=number('cost')))
        return order

    def demo_protection_capabilities(self):
        futures = self._protection_mode == 'demo-futures'
        native_type, raw_type = ('market', 'STOP_MARKET') if futures else ('limit', 'STOP_LOSS_LIMIT')
        native = self._ft_has.get('stoploss_order_types', {}).get(native_type)
        native_ok = (self._ft_has.get('stoploss_on_exchange') is True
            and native == ('stop_market' if futures else 'stop_loss_limit'))
        transport_ok = getattr(self, 'demo_futures_destination_guard' if futures else 'demo_destination_guard', False) is True
        api_ok = all(self._api.has.get(name) is True for name in ('createOrder', 'fetchOrder', 'cancelOrder'))
        pairs = {}
        for pair in self._config.get('exchange', {}).get('pair_whitelist', []):
            market = self.markets.get(pair, {})
            types = market.get('info', {}).get('orderTypes', [])
            identity = (market.get('linear') is True and market.get('swap') is True
                        if futures else market.get('spot') is True and market.get('contract') is not True)
            supported = native_ok and transport_ok and api_ok and identity and raw_type in types
            pairs[pair] = dict(status='capability_validated' if supported else 'unsupported_or_unverified',
                orderType=raw_type, destination='demo-fapi.binance.com' if futures else 'demo-api.binance.com',
                reduceOnly=futures)
        state = self._read_protection()
        state.update(configured=self._config.get('order_types', {}).get('stoploss_on_exchange') is True,
                     capabilities=pairs, protectionEvidence='actual_order_ack_required')
        self._write_protection(state)
        return state

    def demo_entry_protection_allowed(self, pair):
        state = self.demo_protection_capabilities()
        return (state['configured'] and state['capabilities'].get(pair, {}).get('status') == 'capability_validated'
                and not any(a.get('status') in ('pending', 'unknown') for a in state['attempts']))

    def _get_stop_params(self, side, ordertype, stop_price):
        params = super()._get_stop_params(side, ordertype, stop_price)
        attempt = getattr(self, '_active_demo_stop', None)
        if not attempt:
            raise TemporaryError('DEMO_STOP_REQUEST_CONTEXT_REQUIRED')
        # CCXT maps this to clientAlgoId for linear conditional orders.
        params['clientOrderId'] = attempt['clientOrderId']
        return params

    def _stop_proof(self, order, attempt):
        if not isinstance(order, dict):
            return False
        info = order.get('info') or {}
        client_id = order.get('clientOrderId') or info.get('clientAlgoId') or info.get('clientOrderId')
        stop = order.get('stopPrice') or order.get('triggerPrice')
        pair = attempt['pair']
        expected_amount = self._contracts_to_amount(pair,
            self.amount_to_precision(pair, self._amount_to_contracts(pair, attempt['amount'])))
        expected_stop = self.price_to_precision(pair, attempt['requestedStopPrice'],
            rounding_mode=ROUND_DOWN if attempt['side'] == 'buy' else ROUND_UP)
        return (isinstance(order.get('id'), str) and bool(order['id'])
            and client_id == attempt['clientOrderId'] and order.get('symbol') == attempt['pair']
            and order.get('side') == attempt['side'] and positive(order.get('amount'))
            and math.isclose(order['amount'], expected_amount, rel_tol=1e-10, abs_tol=1e-10)
            and positive(stop) and math.isclose(stop, expected_stop, rel_tol=1e-10, abs_tol=1e-10)
            and order.get('status') in ('open', 'closed', 'canceled', 'cancelled', 'triggered'))

    def _save_stop_result(self, state, attempt, order, reconciled=False):
        attempt.update(status='confirmed', orderId=order['id'], orderStatus=order['status'],
                       acceptedAmount=order['amount'], stopPrice=order.get('stopPrice') or order.get('triggerPrice'),
                       protectionStatus='active' if order['status'] == 'open' else 'resolved',
                       reconciled=reconciled, confirmedAt=datetime.now(timezone.utc).isoformat(),
                       observedAt=datetime.now(timezone.utc).isoformat())
        state['lastResult'] = 'exchange_order_confirmed'
        self._write_protection(state)

    def create_stoploss(self, pair, amount, stop_price, order_types, side, leverage):
        state = self.demo_protection_capabilities()
        futures = self._protection_mode == 'demo-futures'
        if (not state['configured'] or state['capabilities'].get(pair, {}).get('status') != 'capability_validated'
                or side not in (('buy', 'sell') if futures else ('sell',))
                or not all(positive(v) for v in (amount, stop_price, leverage)) or leverage != 1
                or order_types.get('stoploss_on_exchange') is not True
                or order_types.get('stoploss') != ('market' if futures else 'limit')):
            state['lastResult'] = 'protection_preflight_rejected'
            self._write_protection(state)
            self._pause_entries('DEMO_PROTECTION_UNAVAILABLE')
            raise TemporaryError('DEMO_PROTECTION_PREFLIGHT_REJECTED')
        unresolved = [a for a in state['attempts'] if a.get('status') in ('pending', 'unknown')]
        if unresolved:
            attempt = unresolved[0]
            if attempt['pair'] == pair:
                try:
                    params = {'clientOrderId': attempt['clientOrderId'], **({'stop': True} if futures else {})}
                    order = self._order_contracts_to_amount(self._api.fetch_order(None, pair, params))
                    if self._stop_proof(order, attempt):
                        self._save_stop_result(state, attempt, order, reconciled=True)
                        return order
                except Exception:
                    pass  # Missing or failed reads never prove a submission failed.
            self._pause_entries('DEMO_PROTECTION_ORDER_UNCERTAIN')
            raise TemporaryError('DEMO_PROTECTION_RECONCILIATION_REQUIRED')
        attempt = dict(clientOrderId='codex-sl-' + uuid.uuid4().hex[:24], pair=pair, side=side,
                       amount=amount, requestedStopPrice=stop_price, status='pending',
                       createdAt=datetime.now(timezone.utc).isoformat())
        state['attempts'].append(attempt)
        self._write_protection(state)  # Durable before the only create_order call.
        self._active_demo_stop = attempt
        creation_returned = False
        try:
            order = super().create_stoploss(pair, amount, stop_price, order_types, side, leverage)
            creation_returned = True
            if not self._stop_proof(order, attempt):
                # Some venues acknowledge only an id. Enrich with a read, never
                # another create. Identity/amount/trigger must all be proved.
                order_id = order.get('id') if isinstance(order, dict) else None
                if isinstance(order_id, str) and order_id:
                    attempt['acknowledgedOrderId'] = order_id
                    self._write_protection(state)
                    order = super().fetch_stoploss_order(order_id, pair)
                if not self._stop_proof(order, attempt):
                    raise TemporaryError('DEMO_STOP_ACK_INCOMPLETE')
            self._save_stop_result(state, attempt, order)
            return order
        except (InvalidOrderException, InsufficientFundsError):
            if creation_returned:
                # A lookup failure after a create receipt is never a definitive
                # create rejection. Keep the exact request for reconciliation.
                attempt['status'] = 'unknown'
                state['lastResult'] = 'exchange_stop_unknown'
                self._write_protection(state)
                self._pause_entries('DEMO_PROTECTION_ORDER_UNCERTAIN')
                raise TemporaryError('DEMO_PROTECTION_RECONCILIATION_REQUIRED') from None
            attempt['status'] = 'rejected'
            state['lastResult'] = 'exchange_stop_rejected'
            self._write_protection(state)
            self._pause_entries('DEMO_PROTECTION_REJECTED')
            raise  # Native Freqtrade handles definitive invalid orders with emergency exit.
        except Exception:
            attempt['status'] = 'unknown'
            state['lastResult'] = 'exchange_stop_unknown'
            self._write_protection(state)
            self._pause_entries('DEMO_PROTECTION_ORDER_UNCERTAIN')
            raise TemporaryError('DEMO_PROTECTION_RECONCILIATION_REQUIRED') from None
        finally:
            self._active_demo_stop = None

    def _record_stop_observation(self, order_id, pair, order):
        # A cancel receipt may still report NEW/open. Record exactly what was
        # returned, and let cancel-with-result obtain a terminal exchange read.
        if (not isinstance(order, dict) or order.get('id') != order_id or order.get('symbol') != pair
                or order.get('status') not in ('open', 'closed', 'canceled', 'cancelled', 'triggered', 'expired', 'rejected')):
            raise TemporaryError('DEMO_STOP_OBSERVATION_UNVERIFIED')
        state = self._read_protection()
        for attempt in state['attempts']:
            if attempt.get('orderId') == order_id and attempt.get('pair') == pair:
                attempt.update(orderStatus=order.get('status'),
                    protectionStatus='active' if order.get('status') == 'open' else 'resolved',
                    observedAt=datetime.now(timezone.utc).isoformat())
        self._write_protection(state)

    def fetch_stoploss_order(self, order_id, pair, params=None):
        order = super().fetch_stoploss_order(order_id, pair, params)
        self._record_stop_observation(order_id, pair, order)
        return order

    def cancel_stoploss_order(self, order_id, pair, params=None):
        order = super().cancel_stoploss_order(order_id, pair, params)
        if (isinstance(order, dict) and order.get('id') == order_id and order.get('symbol') == pair
                and order.get('status') in ('open', 'closed', 'canceled', 'cancelled', 'triggered', 'expired', 'rejected')):
            self._record_stop_observation(order_id, pair, order)
        return order

    def cancel_stoploss_order_with_result(self, order_id, pair, amount):
        # Installed Freqtrade can fabricate a canceled result when lookup fails.
        # The guarded adapter requires a real terminal receipt/read instead.
        try:
            order = self.cancel_stoploss_order(order_id, pair)
        except Exception:
            # Timeout, missing order, or an incomplete cancellation response:
            # only an identity-checked terminal read can resolve the outcome.
            # In particular, a timeout does not authorize another DELETE.
            order = None
        terminal = ('closed', 'canceled', 'cancelled', 'triggered', 'expired', 'rejected')
        if (isinstance(order, dict) and order.get('id') == order_id and order.get('symbol') == pair
                and order.get('status') in terminal and self.is_cancel_order_result_suitable(order)):
            return order
        for delay in CANCEL_READ_DELAYS_SECONDS:
            if delay:
                sleep(delay)
            try:
                order = self.fetch_stoploss_order(order_id, pair)
            except Exception:
                continue  # Retry a read, not the cancel or a replacement order.
            if (isinstance(order, dict) and order.get('id') == order_id
                    and order.get('symbol') == pair and order.get('status') in terminal):
                return order
        self._pause_entries('DEMO_STOP_CANCEL_UNCONFIRMED')
        raise TemporaryError('DEMO_STOP_CANCEL_UNCONFIRMED') from None

    def refresh_demo_stop_observations(self):
        """Read-only recovery for stale active receipts, even after a trade closed.

        Normal open trades are queried by Freqtrade every loop. Query only stale
        records here, or all active records once after restart. The query result
        supplies status; elapsed time or a flat portfolio never implies canceled.
        """
        state = self._read_protection()
        initial = not getattr(self, '_protection_observations_initialized', False)
        now = datetime.now(timezone.utc)
        for attempt in state['attempts']:
            if attempt.get('status') != 'confirmed' or attempt.get('orderStatus') != 'open':
                continue
            try:
                observed = datetime.fromisoformat(attempt.get('observedAt', '').replace('Z', '+00:00'))
                stale = (now - observed).total_seconds() >= 15
            except (ValueError, TypeError):
                stale = True
            if not initial and not stale:
                continue
            try:
                self.fetch_stoploss_order(attempt['orderId'], attempt['pair'])
            except Exception:
                # Failed lookup leaves the prior observation untouched and
                # therefore stale at bridge preflight. Never invent a cancel.
                current = self._read_protection()
                current['lastObservationError'] = 'DEMO_STOP_READ_UNAVAILABLE'
                current['lastObservationAttemptAt'] = now.isoformat()
                self._write_protection(current)
        self._protection_observations_initialized = True
