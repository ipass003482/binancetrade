"""Download pinned public Kronos source/weights. No accounts, keys or training."""
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen, Request

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "local/model-research"
COMMIT = "67b630e67f6a18c9e9be918d9b4337c960db1e9a"
SOURCE_HASHES = {
    "model/__init__.py": "f8f856ca3fedadcaac97e196be23d1aeda1c3c9ffe8903d66d43ea3bcac6240c",
    "model/kronos.py": "0a5f90282e2039c2de0771473419715c845def154896dbd0f5747837e6241032",
    "model/module.py": "a07edbadc0e96804c8158c021bbc6063bb7cc43b34d7fc470d5c8ff2005a409f",
    "LICENSE": "acb2d194d378204e5f2be4dcd24d39ecac437903620c790c3315a96dab388fdc",
}
CHECKPOINTS = {
    "model": ("NeoQuasar/Kronos-small", "901c26c1332695a2a8f243eb2f37243a37bea320",
              "b082dfcbd8e8c142a725c8bbb99781802f38fec81210e13479effb32b3c3e020"),
    "tokenizer": ("NeoQuasar/Kronos-Tokenizer-base", "0e0117387f39004a9016484a186a908917e22426",
                  "59d85f6af76a2c3b8240ea06cb21db4213b4eeca053f246b23e29cf832fc6bee"),
}


def download(url, destination, expected=None):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and expected and hashlib.sha256(destination.read_bytes()).hexdigest() == expected:
        return expected
    with urlopen(Request(url, headers={"User-Agent": "binancetrade-model-setup/1"}), timeout=60) as response:
        data = response.read(200_000_001)
    if len(data) > 200_000_000:
        raise ValueError("MODEL_ARTIFACT_TOO_LARGE")
    digest = hashlib.sha256(data).hexdigest()
    if expected and digest != expected:
        raise ValueError("MODEL_ARTIFACT_HASH_MISMATCH")
    if destination.suffix == ".json":
        json.loads(data)
    temporary = destination.with_suffix(destination.suffix + ".part")
    temporary.write_bytes(data)
    temporary.replace(destination)
    return digest


def main():
    files = []
    for relative, digest in SOURCE_HASHES.items():
        path = BASE / "vendor/Kronos" / relative
        url = f"https://raw.githubusercontent.com/shiyu-coder/Kronos/{COMMIT}/{relative}"
        files.append({"path": path.relative_to(BASE).as_posix(), "sha256": download(url, path, digest), "source": url})
    for role, (repo, revision, digest) in CHECKPOINTS.items():
        for name in ["config.json", "model.safetensors"]:
            path = BASE / "weights" / role / name
            url = f"https://huggingface.co/{repo}/resolve/{revision}/{name}"
            files.append({"path": path.relative_to(BASE).as_posix(),
                          "sha256": download(url, path, digest if name.endswith("safetensors") else None), "source": url})
    manifest = {"schemaVersion": 1, "model": "NeoQuasar/Kronos-small", "sourceCommit": COMMIT,
                "license": "MIT", "pretrained": True, "fineTuned": False, "files": files}
    path = BASE / "artifacts.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "downloaded_and_verified", "manifest": str(path), "files": len(files)}))


if __name__ == "__main__":
    main()
