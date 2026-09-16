"""Release custom-data sessions at the end of Demo order RPC requests.

Process-local only: installed Freqtrade and broker behavior are unchanged.
Native set_custom_data commits its own writes; remove closes the remaining read
transaction. Scope ownership must still match the request before cleanup.
"""
from functools import wraps
import hashlib
import logging
import os
from pathlib import Path


def request_session_cleanup(function):
    from freqtrade.persistence.custom_data import _CustomData
    from freqtrade.persistence.models import _request_id_ctx_var

    @wraps(function)
    def wrapped(*args, **kwargs):
        request_id = _request_id_ctx_var.get()
        try:
            return function(*args, **kwargs)
        finally:
            # Never touch a background engine thread's transaction. No session
            # is created for calls which did not access custom data.
            if (request_id is not None and _request_id_ctx_var.get() == request_id
                    and _CustomData.session.registry.has()):
                _CustomData.session.remove()

    wrapped.demo_request_cleanup = True
    return wrapped


def install_rpc_session_cleanup():
    from freqtrade.rpc.rpc import RPC

    for name in ('_rpc_force_entry', '_rpc_force_exit', '_rpc_cancel_open_order'):
        original = getattr(RPC, name)
        if not getattr(original, 'demo_request_cleanup', False):
            setattr(RPC, name, request_session_cleanup(original))
    logging.getLogger(__name__).warning(
        'DEMO_RPC_SESSION_CLEANUP_READY pid=%s sha256=%s',
        os.getpid(), hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
