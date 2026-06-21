"""
TFTP server — read-only firmware distribution only.

Security model:
  - GET firmware/<vendor>/<model>/<file>  ← allowed (devices pull firmware)
  - GET configs/...                       ← DENIED (use authenticated API: /config-backups/:id/download)
  - PUT anything                          ← DENIED (configs written by API via SSH pull, not by devices)

Directory layout on the shared volume:
  /tftp-root/
    firmware/<vendor>/<model>/<file>
    configs/<server-id>/<timestamp>.cfg   ← written by API only, not accessible via TFTP
"""
import os
import logging
import tftpy

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

TFTP_ROOT = os.environ.get('TFTP_ROOT', '/tftp-root')
PORT      = int(os.environ.get('TFTP_PORT', '69'))

os.makedirs(os.path.join(TFTP_ROOT, 'firmware'), exist_ok=True)
os.makedirs(os.path.join(TFTP_ROOT, 'configs'),  exist_ok=True)

FIRMWARE_ROOT = os.path.realpath(os.path.join(TFTP_ROOT, 'firmware'))

def path_hook(filename: str, rw: str) -> str:
    """
    Called by tftpy before each transfer.
    rw = 'r' for GET (download), 'w' for PUT (upload).
    """
    # Block all writes — configs are written by the API via SSH pull, never by devices
    if rw == 'w':
        raise tftpy.TftpException("Write access denied: use SSH to push configs to this server")

    # Sanitize path — strip traversal attempts
    safe = filename.lstrip('/').replace('..', '').replace('\\', '/')
    full = os.path.realpath(os.path.join(TFTP_ROOT, safe))

    # Must stay inside TFTP_ROOT
    if not full.startswith(os.path.realpath(TFTP_ROOT)):
        raise tftpy.TftpException(f"Access denied: {filename}")

    # Only serve files from firmware/ — configs/ is API-only
    if not full.startswith(FIRMWARE_ROOT):
        raise tftpy.TftpException(f"Access denied: only firmware/ is served via TFTP")

    return full


server = tftpy.TftpServer(TFTP_ROOT, path_hook)
logging.info(f"TFTP server starting on 0.0.0.0:{PORT}, root={TFTP_ROOT} (firmware read-only)")
server.listen('0.0.0.0', PORT)
