"""GCP Compute Engine voice service lifecycle manager.

Automates starting the GPU instance before generation, waiting for the FastAPI
container to be healthy, and stopping it immediately after to prevent idle charges.
"""
from __future__ import annotations

import logging
import subprocess
import time
import urllib.request

log = logging.getLogger(__name__)

INSTANCE_NAME = "morning-brief-voice"
ZONE = "us-central1-c"
PROJECT = "project-67937e0a-4d2d-43ea-9ba"
HEALTH_URL = "http://34.61.73.242:8090/health"


def get_instance_status() -> str:
    """Returns 'RUNNING', 'TERMINATED', or 'UNKNOWN'."""
    try:
        res = subprocess.run(
            [
                "gcloud", "compute", "instances", "describe", INSTANCE_NAME,
                f"--zone={ZONE}", f"--project={PROJECT}",
                "--format=get(status)",
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        )
        return res.stdout.strip()
    except Exception as exc:
        log.warning("Could not check instance status: %s", exc)
        return "UNKNOWN"


def start_voice_instance(wait_healthy: bool = True, timeout_sec: int = 120) -> bool:
    """Start the GPU instance if stopped, and optionally wait for /health."""
    status = get_instance_status()
    if status == "RUNNING":
        log.info("Voice instance %s is already RUNNING", INSTANCE_NAME)
    else:
        log.info("Starting voice instance %s (was %s)...", INSTANCE_NAME, status)
        try:
            subprocess.run(
                [
                    "gcloud", "compute", "instances", "start", INSTANCE_NAME,
                    f"--zone={ZONE}", f"--project={PROJECT}",
                ],
                check=True,
                timeout=60,
            )
        except Exception as exc:
            log.error("Failed to start instance: %s", exc)
            return False

    if not wait_healthy:
        return True

    log.info("Waiting for voice service to respond at %s...", HEALTH_URL)
    start_time = time.monotonic()
    while time.monotonic() - start_time < timeout_sec:
        try:
            req = urllib.request.Request(HEALTH_URL, headers={"User-Agent": "MorningBrief/1.0"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                if resp.status == 200:
                    log.info("Voice service is healthy!")
                    return True
        except Exception:
            pass
        time.sleep(3)

    log.error("Voice service did not become healthy within %ds", timeout_sec)
    return False


def stop_voice_instance() -> bool:
    """Stops the GPU instance immediately to halt billing."""
    log.info("Stopping voice instance %s to prevent idle charges...", INSTANCE_NAME)
    try:
        subprocess.run(
            [
                "gcloud", "compute", "instances", "stop", INSTANCE_NAME,
                f"--zone={ZONE}", f"--project={PROJECT}",
            ],
            check=True,
            timeout=60,
        )
        log.info("Voice instance stopped successfully (billing halted).")
        return True
    except Exception as exc:
        log.warning("Failed to stop instance: %s", exc)
        return False
