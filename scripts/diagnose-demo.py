"""Safe Demo Spot diagnostics. Never prints credentials and never submits orders."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("demo_check", ROOT / "scripts/demo-check.py")
demo_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo_check)


def safe_reason(error):
    message = str(error)
    allowed = {
        "DEMO_CREDENTIALS_UNAVAILABLE: run configure-demo.ps1 locally": "credential_decryption_failed",
        "DEMO_CREDENTIALS_INVALID": "credential_format_invalid",
        "Demo spot trading permission required": "spot_trading_permission_missing",
    }
    return allowed.get(message, type(error).__name__)


try:
    result = demo_check.check()
    print(json.dumps({
        "status": "passed",
        "mode": result["mode"],
        "accountType": result["accountType"],
        "canTrade": result["canTrade"],
        "ordersSubmitted": 0,
    }))
except Exception as error:
    print(json.dumps({
        "status": "failed",
        "reason": safe_reason(error),
        "ordersSubmitted": 0,
    }))
    raise SystemExit(1)
