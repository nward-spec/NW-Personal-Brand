# Project Organisation Convention

This repository is one of three sibling projects kept **uniform across every
surface** — GitHub, the Claude app, and the Claude web browser — so the same
three projects appear identically wherever you are, on any device.

## The three canonical projects

| Canonical name     | GitHub repo                     |
|--------------------|---------------------------------|
| Dialled-In-Pod     | nward-spec/Dialled-In-Pod       |
| Ernest-Performance | nward-spec/Ernest-Performance   |
| NW-Personal-Brand  | nward-spec/NW-Personal-Brand    |

## The rule: one name, four surfaces

For each project, use the **exact same canonical name** on all of these, and
nowhere else:

1. **GitHub repo** — the repo above.
2. **Chat Project** (claude.ai) — a Project with the canonical name.
3. **Cowork Project** — a Cowork Project with the canonical name.
4. **Cowork chats** — always created *inside* the matching Cowork Project,
   never left loose at the top level.

Because the names match everywhere, the app and the web browser both show the
same three projects, in the same order, with nothing orphaned.

## Steps to keep it uniform (do these once, in the claude.ai UI)

These cannot be automated from a coding session — they are UI actions only you
can take:

1. **Chat Projects:** Create or rename a Project for each canonical name. Move
   any loose chats into their matching Project. Archive/delete duplicate
   Projects that use a different spelling of the same name.
2. **Cowork Projects:** Same — one Cowork Project per canonical name.
3. **Cowork chats:** Open each loose Cowork chat and move it into its matching
   Cowork Project.
4. **Repos:** Nothing to do — the three repos above are already the canonical
   set. Do not create new repos that reuse these names.

## Why the collisions happened

The same names were used across GitHub repos and local/Cowork projects, but the
items lived in different places, so they looked like duplicates. Enforcing "one
canonical name, only on the four surfaces above" removes the ambiguity and gives
you the most autonomous, self-navigating structure.
