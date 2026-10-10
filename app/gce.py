"""Control the GCE GPU instance for Chatterbox-Turbo TTS on demand.

Ensures the GPU VM runs ONLY while synthesizing audio (~12-14 minutes per day),
costing ~$0.15/day (~$4.50/month) instead of $500/month 24/7 or $21/month with a 1-hour window.

Features dynamic IP resolution directly via Google Compute Engine API so hardcoded IPs
never break even if the VM is assigned a new IP or recreated.
"""
from __future__ import annotations

import contextlib
import logging
import os
import subprocess
import time
import httpx

log = logging.getLogger(__name__)


def get_access_token() -> str | None:
    """Obtain an access token for Google Cloud APIs (works in Cloud Run and locally via gcloud)."""
    # 1. Metadata server (inside Cloud Run / GCP)
    try:
        resp = httpx.get(
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
            headers={"Metadata-Flavor": "Google"},
            timeout=2.0,
        )
        if resp.status_code == 200:
            token = resp.json().get("access_token")
            if token:
                return token
    except Exception:
        pass

    # 2. Local gcloud CLI fallback
    try:
        out = subprocess.check_output(
            ["gcloud", "auth", "print-access-token"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        if out:
            return out
    except Exception:
        pass

    return None


def get_instance_ip(project: str, zone: str, instance: str, token: str) -> str | None:
    """Read the active external IP of the GCE VM directly from the Compute Engine API.
    
    This eliminates brittle hardcoded IP addresses — if the VM IP ever changes,
    the system dynamically discovers the new address at runtime.
    """
    url = f"https://compute.googleapis.com/compute/v1/projects/{project}/zones/{zone}/instances/{instance}"
    try:
        resp = httpx.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=10.0)
        if resp.status_code == 200:
            data = resp.json()
            net_interfaces = data.get("networkInterfaces", [])
            if net_interfaces:
                access_configs = net_interfaces[0].get("accessConfigs", [])
                if access_configs:
                    return access_configs[0].get("natIP")
    except Exception as exc:
        log.warning("Could not dynamically resolve IP for instance %s: %s", instance, exc)
    return None


def is_service_healthy(url: str, timeout: float = 3.0) -> bool:
    """Check if the Chatterbox-Turbo voice service is responding."""
    try:
        resp = httpx.get(f"{url.rstrip('/')}/health", timeout=timeout)
        return resp.status_code == 200
    except Exception:
        return False


def start_vm(project: str, zone: str, instance: str, token: str) -> bool:
    """Send an asynchronous start request to Google Compute Engine API."""
    url = f"https://compute.googleapis.com/compute/v1/projects/{project}/zones/{zone}/instances/{instance}/start"
    try:
        resp = httpx.post(url, headers={"Authorization": f"Bearer {token}"}, timeout=30.0)
        return resp.status_code in (200, 204)
    except Exception as exc:
        log.warning("Failed to call GCE start API: %s", exc)
        return False


def stop_vm(project: str, zone: str, instance: str, token: str) -> bool:
    """Send an asynchronous stop request to Google Compute Engine API."""
    url = f"https://compute.googleapis.com/compute/v1/projects/{project}/zones/{zone}/instances/{instance}/stop"
    try:
        resp = httpx.post(url, headers={"Authorization": f"Bearer {token}"}, timeout=30.0)
        return resp.status_code in (200, 204)
    except Exception as exc:
        log.warning("Failed to call GCE stop API: %s", exc)
        return False


@contextlib.contextmanager
def voice_vm_session(cfg):
    """Context manager that starts the GCE GPU VM if needed, resolves its IP dynamically,
    waits for Chatterbox-Turbo, and unconditionally stops the VM in the finally block.
    
    Yields the active voice service URL (e.g. 'http://34.67.158.112:8090').
    """
    voice_url = (getattr(cfg, "voice_url", "") or "").rstrip("/")
    if voice_url.lower() in ("auto", "dynamic", "none"):
        voice_url = ""

    if not getattr(cfg, "gce_manage_vm", True) or not getattr(cfg, "gce_instance", None):
        yield voice_url
        return

    token = get_access_token()

    # Dynamically resolve external IP of the GCE instance if token is available
    if token and cfg.gce_instance:
        discovered_ip = get_instance_ip(cfg.gcp_project, cfg.gce_zone, cfg.gce_instance, token)
        if discovered_ip:
            dynamic_url = f"http://{discovered_ip}:8090"
            if dynamic_url != voice_url:
                log.info("Discovered active GCE VM IP dynamically: %s (was configured: %s)", dynamic_url, voice_url or "unset")
                voice_url = dynamic_url

    if not voice_url:
        log.warning("VOICE_SERVICE_URL could not be determined; proceeding with empty URL")
        yield voice_url
        return

    # Check if voice service is already healthy
    if is_service_healthy(voice_url):
        log.info("Chatterbox-Turbo voice service is already running at %s", voice_url)
        try:
            yield voice_url
        finally:
            pass
        return

    if not token:
        log.warning("No GCP access token available to manage GCE instance %s; proceeding directly", cfg.gce_instance)
        yield voice_url
        return

    log.info(
        "Starting GCE GPU VM '%s' (%s/%s) for Chatterbox-Turbo...",
        cfg.gce_instance,
        cfg.gcp_project,
        cfg.gce_zone,
    )
    if not start_vm(cfg.gcp_project, cfg.gce_zone, cfg.gce_instance, token):
        log.warning("Failed to send start command to %s", cfg.gce_instance)

    # Re-check dynamically resolved IP once started if it was empty
    if not voice_url or "auto" in voice_url:
        time.sleep(5)
        fresh_ip = get_instance_ip(cfg.gcp_project, cfg.gce_zone, cfg.gce_instance, token)
        if fresh_ip:
            voice_url = f"http://{fresh_ip}:8090"

    # Wait for Chatterbox-Turbo to become healthy (up to 90 seconds, polling every 3s)
    log.info("Waiting for Chatterbox-Turbo voice service at %s to report healthy...", voice_url)
    ready = False
    start_time = time.monotonic()
    timeout = 90.0
    while time.monotonic() - start_time < timeout:
        if is_service_healthy(voice_url):
            ready = True
            log.info(
                "✓ Chatterbox-Turbo voice service is online and ready (took %.1fs)!",
                time.monotonic() - start_time,
            )
            break
        time.sleep(3)

    if not ready:
        log.error(
            "Chatterbox-Turbo voice service did not become healthy within %.0fs. Shutting down VM immediately...",
            timeout,
        )
        stop_vm(cfg.gcp_project, cfg.gce_zone, cfg.gce_instance, token)
        raise RuntimeError(f"Chatterbox-Turbo service at {voice_url} did not respond within {timeout}s")

    try:
        yield voice_url
    finally:
        log.info("Shutting down GCE GPU VM '%s' immediately to save costs...", cfg.gce_instance)
        fresh_token = get_access_token() or token
        stop_vm(cfg.gcp_project, cfg.gce_zone, cfg.gce_instance, fresh_token)
        log.info("✓ VM stop signal sent successfully.")
