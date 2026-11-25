import atexit
import os
import re
import shutil
import tempfile

import webview

from drives import list_drives, save_selected, selected_drive

THREE_PIN_LABEL = "3Pin"
EXCLUDED_PROJECTS = {"jackauto"}
SKIPPED_DIRS = {"$recycle.bin", "system volume information"}
MAX_DEPTH = 2
BASE = os.path.dirname(os.path.abspath(__file__))
PROJECTS_DIR = os.environ.get("VISUALIZER_PROJECTS_DIR") or os.path.dirname(BASE)

_trash_dir = None
_trash_stack = []


def _get_trash():
    global _trash_dir
    if _trash_dir is None:
        _trash_dir = tempfile.mkdtemp(prefix="visualizer_trash_")
        atexit.register(shutil.rmtree, _trash_dir, True)
    return _trash_dir


def _check_drive_csv(path):
    root = selected_drive()
    if not root:
        return None, None, "No external drive found"
    p = os.path.abspath(path)
    if not os.path.normcase(p).startswith(os.path.normcase(root)):
        return None, None, "File is not on the selected drive"
    if not p.lower().endswith(".csv") or not os.path.isfile(p):
        return None, None, "Not a CSV file"
    return p, root, None


def _natural_key(name):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


class Api:
    _window = None

    def list_drives(self):
        drives = list_drives()
        return {"ok": True, "drives": drives, "selected": selected_drive(drives)}

    def select_drive(self, root):
        drives = list_drives()
        if root not in [d["root"] for d in drives]:
            return {"ok": False, "error": "Drive not available"}
        save_selected(root)
        return {"ok": True, "selected": root}

    def delete_file(self, path):
        p, _root, err = _check_drive_csv(path)
        if err:
            return {"ok": False, "error": err}
        try:
            dest = os.path.join(_get_trash(), f"{len(_trash_stack)}_{os.path.basename(p)}")
            shutil.move(p, dest)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        _trash_stack.append((p, dest))
        return {"ok": True, "undo": len(_trash_stack)}

    def undo_delete(self):
        if not _trash_stack:
            return {"ok": False, "error": "Nothing to undo", "undo": 0}
        orig, dest = _trash_stack[-1]
        if os.path.exists(orig):
            return {"ok": False, "error": f"{os.path.basename(orig)} already exists", "undo": len(_trash_stack)}
        try:
            os.makedirs(os.path.dirname(orig), exist_ok=True)
            shutil.move(dest, orig)
        except OSError as e:
            return {"ok": False, "error": str(e), "undo": len(_trash_stack)}
        _trash_stack.pop()
        return {"ok": True, "name": os.path.basename(orig), "undo": len(_trash_stack)}

    def undo_count(self):
        return len(_trash_stack)

    def rename_file(self, path, new_name):
        p, root, err = _check_drive_csv(path)
        if err:
            return {"ok": False, "error": err}
        new_name = (new_name or "").strip()
        if not new_name.lower().endswith(".csv"):
            new_name += ".csv"
        if new_name.lower() == ".csv" or re.search(r'[\\/:*?"<>|]', new_name):
            return {"ok": False, "error": "Invalid file name"}
        target = os.path.join(os.path.dirname(p), new_name)
        if os.path.normcase(target) != os.path.normcase(p) and os.path.exists(target):
            return {"ok": False, "error": f"{new_name} already exists"}
        try:
            os.rename(p, target)
        except OSError as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "path": target, "name": os.path.relpath(target, root)}

    def load_drive(self):
        root = selected_drive()
        if not root:
            return {"ok": False, "error": "No external drive found"}
        files = []
        for dp, dn, fn in os.walk(root):
            depth = dp[len(root):].count(os.sep)
            dn[:] = [d for d in dn if d.lower() not in SKIPPED_DIRS] if depth < MAX_DEPTH - 1 else []
            for name in fn:
                if name.lower().endswith(".csv"):
                    path = os.path.join(dp, name)
                    files.append({"name": os.path.relpath(path, root), "path": path})
        files.sort(key=lambda f: _natural_key(f["name"]))
        return {"ok": True, "root": root, "files": files}

    def read_file(self, path):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return {"ok": True, "name": os.path.basename(path), "text": f.read()}
        except OSError as e:
            return {"ok": False, "error": str(e)}

    def load_paths(self):
        out = []
        if not os.path.isdir(PROJECTS_DIR):
            return out
        for proj in sorted(os.listdir(PROJECTS_DIR)):
            if proj.lower() in EXCLUDED_PROJECTS:
                continue
            f = os.path.join(PROJECTS_DIR, proj, "src", "paths.cpp")
            if not os.path.isfile(f):
                continue
            try:
                with open(f, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                continue
            for m in re.finditer(r"Point\s+(nw)?[pP]ath(\d+)\s*\[\s*\]\s*=\s*\{(.*?)\};", text, re.S):
                nums = re.findall(r"\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}", m.group(3))
                pts = [[float(a), float(b)] for a, b in nums]
                if pts:
                    n = int(m.group(2))
                    group = THREE_PIN_LABEL if m.group(1) else proj
                    out.append({"project": group, "name": f"Path {n}", "num": n, "points": pts})
        return out

    def pick_file(self):
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG, file_types=("CSV files (*.csv)", "All files (*.*)")
        )
        if not result:
            return {"ok": False, "error": "cancelled"}
        return self.read_file(result[0])


if __name__ == "__main__":
    api = Api()
    api._window = webview.create_window(
        "Telemetry Visualizer",
        os.path.join(BASE, "web", "index.html"),
        js_api=api,
        width=1280,
        height=820,
        min_size=(900, 600),
        background_color="#121212",
    )
    webview.start()
