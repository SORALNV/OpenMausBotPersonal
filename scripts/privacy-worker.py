"""Local stdio detector. stdout is a bounded JSON protocol; input and spans are never logged."""
import json
import os
from pathlib import Path
import resource
import socket
import sys
import time
from privacy_cache import DetectionCache

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
# Pinned OPF defaults to CUDA/Triton off CPU; the Metal adapter replaces its MoE projections.
os.environ["OPF_MOE_TRITON"] = "0"
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "0"


def deny_network(*args, **kwargs):
    raise RuntimeError("network disabled in local detector")


socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
socket.socket.sendto = deny_network
socket.create_connection = deny_network
socket.getaddrinfo = deny_network

try:
    import torch
    from opf import OPF
    checkpoint = Path(os.environ["OMB_PRIVACY_CHECKPOINT"]).resolve(strict=True)
    if not (checkpoint / "config.json").is_file() or not list(checkpoint.glob("*.safetensors")):
        raise RuntimeError("checkpoint missing")
    torch.set_num_threads(4)
    requested_device = os.environ.get("OMB_PRIVACY_DEVICE", "auto")
    if requested_device not in ("auto", "cpu", "mps"):
        raise ValueError("invalid local device")
    device = "mps" if requested_device == "auto" and torch.backends.mps.is_available() else requested_device
    if device == "auto":
        device = "cpu"
    if device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("Apple GPU unavailable")

    def sync():
        if device == "mps":
            torch.mps.synchronize()

    def metrics():
        return {"rssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                "mpsAllocatedBytes": torch.mps.current_allocated_memory() if device == "mps" else 0,
                "mpsDriverBytes": torch.mps.driver_allocated_memory() if device == "mps" else 0}

    started = time.perf_counter()
    model = OPF(model=str(checkpoint), device=device, context_window_length=4096)
    runtime, _ = model.get_prediction_components()
    if device == "mps":
        from privacy_metal import install_metal_moe
        install_metal_moe(runtime.model)
    sync()
    cache = DetectionCache()

    def infer(text):
        result = model.redact(text)
        if result.warning or result.text != text:
            raise ValueError("token roundtrip mismatch")
        # OPF uses Unicode code points; JavaScript uses UTF-16 offsets.
        offset = lambda p: len(text[:p].encode("utf-16-le")) // 2
        return [{"start": offset(s.start), "end": offset(s.end), "label": s.label}
                for s in result.detected_spans]

    print(json.dumps({"ready": True, "device": device, "moe": "metal-direct" if device == "mps" else "torch",
                      "loadMs": round((time.perf_counter() - started) * 1000), **metrics()}), flush=True)
    for line in sys.stdin:
        started = time.perf_counter()
        try:
            request = json.loads(line)
            texts = request["texts"]
            if not isinstance(texts, list) or len(texts) > 512 or any(not isinstance(t, str) for t in texts) or sum(map(len, texts)) > 100_000:
                raise ValueError("input limit")
            results, stats = cache.detect(texts, infer)
            sync()
            print(json.dumps({"spans": results, "elapsedMs": round((time.perf_counter() - started) * 1000),
                              **stats, **metrics()}), flush=True)
        except Exception:
            print('{"error":"local detection failed"}', flush=True)
except Exception:
    print('{"error":"local detector initialization failed"}', flush=True)
    sys.exit(1)
