import ctypes
import json
import os
import string

DRIVE_REMOVABLE = 2
DRIVE_FIXED = 3
DRIVE_REMOTE = 4
SETTINGS_PATH = os.path.join(os.path.expanduser("~"), ".telemetry-visualizer.json")


def system_root():
    return os.environ.get("SystemDrive", "C:").upper().rstrip("\\") + "\\"


def volume_label(root):
    buf = ctypes.create_unicode_buffer(261)
    ok = ctypes.windll.kernel32.GetVolumeInformationW(root, buf, 261, None, None, None, None, 0)
    return buf.value if ok else ""


def list_drives(removable_only=False):
    system = system_root()
    kinds = (DRIVE_REMOVABLE,) if removable_only else (DRIVE_REMOVABLE, DRIVE_FIXED, DRIVE_REMOTE)
    out = []
    for letter in string.ascii_uppercase:
        root = f"{letter}:\\"
        if root == system:
            continue
        kind = ctypes.windll.kernel32.GetDriveTypeW(root)
        if kind not in kinds or not os.path.exists(root):
            continue
        out.append({"root": root, "label": volume_label(root), "removable": kind == DRIVE_REMOVABLE})
    return out


def _load_settings():
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _normalize(value):
    value = (value or "").strip().upper()
    return value[:1] + ":\\" if value[:1].isalpha() else ""


def save_selected(root):
    settings = _load_settings()
    settings["drive"] = root
    try:
        with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(settings, f)
    except OSError:
        pass


def selected_drive(drives=None):
    drives = list_drives() if drives is None else drives
    roots = [d["root"] for d in drives]
    for wanted in (_load_settings().get("drive"), os.environ.get("VISUALIZER_DRIVE")):
        root = _normalize(wanted)
        if root in roots:
            return root
    for d in drives:
        if d["removable"]:
            return d["root"]
    return roots[0] if roots else None


def find_drive():
    return selected_drive()
