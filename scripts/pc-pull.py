#!/usr/bin/env python3
"""PC nightly pull: SFTP Pi snapshots -> D:\\PiBackUp, sha256 verify, manifest log.
Runs on PC via Task Scheduler (key auth, no passwords). Exit 0 ok / 1 fail."""
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

import paramiko

HOST = os.environ.get("PI_HOST", "169.254.77.10")
USER = os.environ.get("PI_USER", "antifield")
KEY = os.environ.get("PI_KEY", os.path.expanduser("~/.ssh/id_ed25519"))
DEST_BASE = os.environ.get("PI_BACKUP_DEST", r"D:\PiBackUp")
REMOTE_BASE = "/var/lib/workbench/backups"


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    log: list[str] = []
    ok = True
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        c.connect(HOST, username=USER, key_filename=KEY, timeout=20, banner_timeout=20)
    except Exception as ex:
        print(f"PULL_FAIL connect: {ex!r}")
        return 1
    try:
        sftp = c.open_sftp()
        try:
            remote_dirs = sorted(d for d in sftp.listdir(REMOTE_BASE) if not d.startswith("."))
        except FileNotFoundError:
            print("PULL_FAIL: no remote snapshot dir yet");
            return 1
        have = {d for d in os.listdir(DEST_BASE) if os.path.isdir(os.path.join(DEST_BASE, d)) and not d.startswith("retire")}
        for ts in remote_dirs:
            dest = os.path.join(DEST_BASE, ts)
            if ts in have and os.path.exists(os.path.join(dest, "sha256sums.txt")):
                log.append(f"{ts}: already pulled, skip")
                continue
            os.makedirs(dest, exist_ok=True)
            try:
                for f in sftp.listdir(f"{REMOTE_BASE}/{ts}"):
                    sftp.get(f"{REMOTE_BASE}/{ts}/{f}", os.path.join(dest, f))
            except Exception as ex:
                ok = False
                log.append(f"{ts}: download FAIL {ex!r}")
                continue
            # verify sha256sums
            bad = []
            sums_path = os.path.join(dest, "sha256sums.txt")
            with open(sums_path, encoding="utf-8") as sf:
                for line in sf:
                    parts = line.strip().split()
                    if len(parts) < 2:
                        continue
                    expect, name = parts[0], parts[1].lstrip("*")
                    actual = sha256_file(os.path.join(dest, name))
                    if actual != expect:
                        bad.append(name)
            if bad:
                ok = False
                log.append(f"{ts}: SHA MISMATCH {bad}")
            else:
                log.append(f"{ts}: ok ({len(open(sums_path, encoding='utf-8').readlines())} files verified)")
        sftp.close()
    finally:
        c.close()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(os.path.join(DEST_BASE, "manifest.log"), "a", encoding="utf-8") as mf:
        mf.write(f"[{stamp}] {'OK' if ok else 'FAIL'} " + "; ".join(log) + "\n")
    print("\n".join(log))
    print("PULL_OK" if ok else "PULL_FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
