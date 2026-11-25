import math
import os
import random
import sys

DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web", "assets", "sample.csv")

WAYPOINTS = [(-1490, 146), (-1060, 70), (-1100, -700), (-600, -1300), (0, -900),
             (600, -1300), (1300, -700), (1300, 300), (600, 800), (0, 400),
             (-600, 900), (-1200, 600), (-1490, 146)]
DURATION_MS = 60000
STEP_MS = 50
AUTO_MS = 15000
    
DRIVE = ["fl", "ml", "bl", "fr", "mr", "br"]
LIFT = ["1", "2", "3"]

CYCLES = [
    (0.0, 0.3, 1.2, 3.5, 4.2, 4.5, 120),
    (9.0, 9.3, 11.0, 16.0, 17.0, 17.4, 270),
    (24.0, 24.3, 26.0, 32.0, 33.0, 33.4, 450),
    (40.0, 40.3, 42.0, 47.0, 48.0, 48.4, 270),
]


def pose(f):
    n = len(WAYPOINTS) - 1
    s = min(f * n, n - 1e-9)
    i = int(s)
    u = s - i
    (x0, y0), (x1, y1) = WAYPOINTS[i], WAYPOINTS[i + 1]
    th = math.degrees(math.atan2(y1 - y0, x1 - x0))
    return x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, th


def lift_claw(t):
    for grab, up0, up1, down0, down1, release, peak in CYCLES:
        if not (grab <= t < release):
            continue
        if t < up0:
            return 0.0, 1
        if t < up1:
            return peak * (t - up0) / (up1 - up0), 1
        if t < down0:
            return float(peak), 1
        if t < down1:
            return peak * (1 - (t - down0) / (down1 - down0)), 1
        return 0.0, 1
    return 0.0, 0


def temp_series(rng):
    temps = {f"drive_{m}": 24.0 + rng.uniform(0, 3) for m in DRIVE}
    temps.update({f"lift{m}": 23.0 + rng.uniform(0, 2) for m in LIFT})
    out = []
    prev_lift = 0.0
    for sec in range(DURATION_MS // 1000 + 1):
        lift, _ = lift_claw(sec)
        lifting = abs(lift - prev_lift) > 5
        prev_lift = lift
        for m in DRIVE:
            k = f"drive_{m}"
            temps[k] += (0.62 if m.endswith("l") else 0.5) + rng.uniform(-0.1, 0.1)
        for m in LIFT:
            k = f"lift{m}"
            temps[k] += (0.9 if lifting else 0.08) + rng.uniform(-0.05, 0.05)
        out.append({k: int(round(v / 5.0) * 5) for k, v in temps.items()})
    return out


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    rng = random.Random(7)
    temps = temp_series(rng)
    names = [f"drive_{m}" for m in DRIVE] + [f"lift{m}" for m in LIFT]
    with open(out, "w", newline="") as f:
        f.write("t_ms,x,y,theta,lift,claw,period," + ",".join("temp_" + n for n in names) + "\n")
        for t in range(0, DURATION_MS + 1, STEP_MS):
            x, y, th = pose(t / DURATION_MS)
            lift, claw = lift_claw(t / 1000)
            if 0 < lift:
                lift += rng.uniform(-1.5, 1.5)
            tm = temps[t // 1000]
            period = "auto" if t < AUTO_MS else "driver"
            f.write(
                f"{t},{x:.1f},{y:.1f},{th:.1f},{lift:.1f},{claw},{period},"
                + ",".join(str(tm[n]) for n in names)
                + "\n"
            )
    print("wrote", out)


if __name__ == "__main__":
    main()
