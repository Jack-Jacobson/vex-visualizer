import os
import subprocess
import sys
import time
import traceback

BASE = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE)
sys.path.insert(0, BASE)
LOG = os.path.join(BASE, "watcher.log")


def log(msg):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except OSError:
        pass


from drives import list_drives

proc = None
known = set()
log("watcher started")

while True:
    try:
        current = {d["root"] for d in list_drives(removable_only=True)}
        if current - known and (proc is None or proc.poll() is not None):
            proc = subprocess.Popen([sys.executable, os.path.join(BASE, "main.py")], cwd=BASE)
            log("drive detected, launched visualizer")
        known = current
    except Exception:
        log("error: " + traceback.format_exc())
    time.sleep(3)
