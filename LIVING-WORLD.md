# THE LIVING WORLD — v1.7 spec v2 (locked, build gate: ~20 logged sessions)

## Purpose (the one-sentence why)
The daily driver serves the workout. The world serves the hours between —
it is where motivation is built when training is not happening.

## The core mechanic: consequence, not dashboard
The world is a rendering of the event log. Everything visible is *earned state*:
- Streak & total sessions → restoration level (grass regrows, banners rehang,
  statues repair, birds return, stars brighten, the forge relights).
- Absence → gentle decay (fire dims, mist thickens). Truth, never punishment.
  Lumen on return: "I kept it lit as long as I could."
- Tomorrow's trial already waits on the board.
- PRs → permanent monuments (a blade on the wall per record).
- Recovery logs → the day's weather and light (the Twin made visible).

## THE CHAMPION (new — the figure who reflects your progress)
A single character standing in the world who *is* the user's arc made visible.

**Non-negotiable:** never procedural 3D humans. The blocky era is over, permanently.
The Champion is **authored 2D art** (stylized/anime), supplied by the owner as
generated images; the app computes which state he's in and gives him life
(idle breathing, crossfades between states, ambient light response).

**State is computed from the record, never chosen:**
- Tier 0 — Dormant (0 sessions / long absence): seated, hooded, fire low
- Tier 1 — Awakening (1–5): standing, looking up
- Tier 2 — Steady (6–15 or streak >= 5): training stance, defined
- Tier 3 — Ascendant (16–30 or streak >= 10): armored pieces earned, gold trim
- Tier 4 — Peak (30+ or longest-streak PB): full presence, cloak, light behind him

**Art brief (owner supplies, ~5 images to start):**
- One consistent character across all states (same face, build, palette)
- Stylized anime/cel look; dark + gold palette matching the brand
- Transparent PNG, 3/4 or front view, ~1024px tall, feet grounded
- Same camera angle/scale across states so crossfades feel like growth
Optional later: per-state variants (post-workout towel, evening blade, recovery tea).

## Art direction (unchanged)
Stylized cel-shade over the existing Sanctum geometry — bold outlines, flat
confident color. Stylization reads finished where procedural realism reads prototype.

## Rules carried over (non-negotiable)
- Reads the SAME event log via store-bridge. The world renders truth only.
- No tasks required inside it. Ten-second rule.
- Camera guides; no walking. Interaction = touching objects.
- The daily driver remains the fastest path to logging.
- Zero new mechanics beyond restoration/decay derived from existing events.

## Build gate
~20 completed trials. Every session logged before then renders retroactively —
training now IS building it. (v1.8 — structure freedom, profiles, Lumen intake —
shipped ahead of gate because it is product capability, not world visuals.)
