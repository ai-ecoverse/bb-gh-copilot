# bb-gh-copilot — release procedure

## Identity

Everything below is repo-specific. Three sibling ACP provider plugins live next
to this one (`bb-droid`, `bb-auggie`); do not copy values between them.

| Thing | Value |
| --- | --- |
| GitHub repo | `ai-ecoverse/bb-gh-copilot` (the local checkout dir is still `bb-copilot`) |
| Package name | `bb-plugin-gh-copilot` (**not published to npm**; `npm view` 404s) |
| bb plugin id | `gh-copilot` (derived from the package name) |
| Provider id | `acp-gh-copilot` |
| CLI command | `bb gh-copilot status` |
| Marketplace entry | `entries/gh-copilot.json` in `get-bb/marketplace` |
| Entry range | `^0.4.0` |
| Entry icon | `./icons/gh-copilot-bbc37c3b.svg` |
| Entry owner | `author.github: trieloff` |
| Listed via | get-bb/marketplace PR #118, merged `75e8f3d` (2026-08-31) |

This repo was renamed. The plugin id `copilot` is claimed by an unrelated
community plugin (`balazstasi/bb-plugin-copilot`, marketplace PR #95, still
open). **Changing any identity value again — id, display name, description,
tags, icon, source URL — requires a new reviewed marketplace PR.** Tagging
alone cannot change it.

Verify the live catalog rather than trusting this table:

```sh
curl -s https://getbb.app/marketplace/v1/marketplace.json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify((JSON.parse(s).plugins).find(p=>p.id==='gh-copilot'),null,2)))"
```

## The routine update path: tag, do not PR

The marketplace entry uses a semver `range` git source. bb lists `refs/tags`,
keeps tags named `vX.Y.Z` that parse as semver, and installs the highest one the
range allows (node-semver `maxSatisfying`). bb records **the tag it selected and
the commit that tag pointed at**; if that tag later points at another commit, bb
refuses to resolve it and names both commits. Users must remove and reinstall to
accept the new commit.

**Never move, delete, or re-cut a published tag. Always publish a new version.**

## The range trap

`^0.4.0` on a `0.x` version pins the *minor*. Verified with node-semver 7.8.5:

```sh
node -e "const s=require('semver');const t=['0.1.0','0.2.0','0.4.0','0.4.1','0.4.9','0.5.0','1.0.0'];
console.log('^0.4.0 matches', t.filter(v=>s.satisfies(v,'^0.4.0')).join(' '), '| max', s.maxSatisfying(t,'^0.4.0'))"
# ^0.4.0 matches 0.4.0 0.4.1 0.4.9 | max 0.4.9
# 0.5.0 and 1.0.0 do NOT match.
```

So, with the entry at `^0.4.0`:

- **Patch bump (0.4.0 → 0.4.1): ships by tagging alone.** No marketplace PR.
- **Minor bump (0.4.0 → 0.5.0): invisible to existing users** until a
  marketplace PR widens or moves the range. Tagging alone is not enough.
- Any change to `id`, `displayName`, `description`, `tags`, `icon`, or
  `source.git.url` also needs a PR. `author.github` (`trieloff`) gates who may
  change the entry.

If you do not want a marketplace PR per release, stay on `0.4.x`.

## Pre-release checklist

Run from the repo root, on a clean tree, at the commit you intend to tag.

```sh
npm run typecheck        # tsc --noEmit
npm test                 # vitest run  -> 4 files, 57 tests
bb plugin build .        # writes dist/server.js, .map, server.meta.json, app.js, app.css, app.meta.json, package.json
git diff --quiet -- dist/ || { echo "STALE dist/ — commit the rebuild"; exit 1; }
```

All four pass on `153a012`. The build is byte-reproducible here: `git status
--porcelain` was empty before and after `bb plugin build .`.

On `dist/`: it *is* committed (7 files tracked). It is **not** what marketplace
users run. A git-source install runs `npm install` and recompiles both bundles,
and a committed `dist/` is always replaced by the bundles bb builds. So a stale
`dist/` does not ship broken code to marketplace users — but a build that
*fails* at the tagged commit fails their install. The `git diff --quiet --
dist/` gate is still worth running: it proves the tree you are about to tag
actually compiles and that the committed artifacts match the sources, which is
what anyone reading the tag will assume.

`dist/server.meta.json` stamps the identity — check it before tagging:

```sh
cat dist/server.meta.json   # pluginId: gh-copilot, pluginVersion must equal package.json version
```

## Local verification before tagging

```sh
bb plugin install . --yes          # path install; keeps existing settings
bb plugin list | grep -A3 '^gh-copilot'
bb gh-copilot status
bb gh-copilot usage                # quota via copilot_internal/user; exit 0 when readable
bb provider list | grep -i copilot
bb plugin logs gh-copilot -n 30
```

Expected, as observed on `153a012`:

```
gh-copilot@0.4.0  running
  source: path:/Users/trieloff/Developer/ai-ecoverse/bb-copilot
  command: bb gh-copilot — Manage the GitHub Copilot ACP provider.

CLI: /opt/homebrew/bin/copilot
ACP customAgents entry: present
legacy config.json entry: absent
bb provider acp-gh-copilot: registered

acp-gh-copilot  GitHub Copilot
```

Clean logs are `info` lines only (`acp-gh-copilot is already configured`).
Repeated `warn: Could not read provider-acp customAgents: HTTP 404` lines are
the boot-time retry loop and are benign *only* if an `info` line follows them.
A tail that ends on the 404 warn means provisioning never completed — do not
tag.

`bb plugin install .` without `--yes` only prints the full-trust warning and
refuses; it does not install.

## Cutting the release

**Use `/opt/homebrew/bin/gh`, not the `gh` on PATH.** The PATH `gh`
(`~/.local/bin/gh`) is the as-a-bot wrapper: it classifies `gh release
view|list|download` as safe and passes them through, but treats every other
`release` subcommand as a write and swaps in a GitHub App token. That token
cannot administer the repository (403 on operations like renaming), and it
attributes the release to the bot. `/opt/homebrew/bin/gh` is the user's own
authenticated CLI (`trieloff`, scopes `gist, read:org, repo, workflow`).

1. Bump `version` in `package.json` (and nothing else — bb derives the id from
   `name`). Commit and push to `main`.
2. Re-run the pre-release checklist on the pushed commit.
3. Create the release, which creates the tag:

```sh
/opt/homebrew/bin/gh release create v0.4.1 \
  --repo ai-ecoverse/bb-gh-copilot \
  --target "$(git rev-parse HEAD)" \
  --title v0.4.1 \
  --notes "What changed in this release."
```

`--target` takes a full commit SHA; pin it explicitly rather than relying on the
default branch. Add `--verify-tag` instead of `--target` if you tagged by hand
first and want `gh` to abort when the tag is not already on the remote.

## After the release

```sh
git ls-remote --tags https://github.com/ai-ecoverse/bb-gh-copilot.git 'refs/tags/v*'
```

This is the exact command the marketplace liveness check runs. The new tag must
appear. Lightweight and annotated tags both work (`v0.4.0` is lightweight;
`v0.1.0` and `v0.2.0` are annotated, so they also show a `^{}` peeled line).

Then confirm the range still resolves to the tag you just cut:

```sh
node -e "const s=require('semver');console.log(s.maxSatisfying(['0.1.0','0.2.0','0.4.0'],'^0.4.0'))"
# 0.4.0
```

Finally, in the marketplace checkout (`get-bb/marketplace`):

```sh
npm ci && npm run check    # validate + git ls-remote liveness for every entry
```

Two caveats, both observed:

- `npm run check` validates the **whole catalog** and reports every problem it
  finds. A failure on an unrelated entry (currently `ports`, whose repo
  `ramaaudra/bb-plugin-ports` is gone) is not your regression — read the entry
  id in the error before reacting.
- Liveness only checks that *some* `vX.Y.Z` tag exists at the URL. It does
  **not** check that the range is satisfiable. An entry pointing at `^0.5.0`
  with only `v0.4.0` published passes `npm run check` and still installs
  nothing. Verify the range with the `maxSatisfying` one-liner above.

## Worked example A — patch release, tagging only

Ship 0.4.0 → 0.4.1. Entry stays at `^0.4.0`; no marketplace PR.

```sh
# 1. bump
sed -i '' 's/"version": "0.4.0"/"version": "0.4.1"/' package.json
npm run typecheck && npm test && bb plugin build .
git diff --quiet -- dist/ || echo "commit the dist rebuild"
git add -A && git commit -m "Release v0.4.1" && git push origin main

# 2. verify locally
bb plugin install . --yes && bb gh-copilot status && bb plugin logs gh-copilot -n 30

# 3. release
/opt/homebrew/bin/gh release create v0.4.1 --repo ai-ecoverse/bb-gh-copilot \
  --target "$(git rev-parse HEAD)" --title v0.4.1 --notes "Fixes X."

# 4. confirm
git ls-remote --tags https://github.com/ai-ecoverse/bb-gh-copilot.git 'refs/tags/v*'
node -e "const s=require('semver');console.log(s.maxSatisfying(['0.4.0','0.4.1'],'^0.4.0'))"  # 0.4.1
```

Users see it on the next catalog refresh via `bb plugin outdated`. bb installs
nothing automatically; applying the update is manual.

## Worked example B — minor release, tag *plus* marketplace PR

Ship 0.4.x → 0.5.0. `^0.4.0` will not match it, so tagging alone reaches nobody.

1. Steps 1–4 of example A, with `0.5.0` / `v0.5.0`. Confirm the tag is live.
2. Then open a PR against `get-bb/marketplace` editing **only**
   `entries/gh-copilot.json`:

   ```json
   "source": { "git": { "url": "https://github.com/ai-ecoverse/bb-gh-copilot.git", "range": "^0.5.0" } }
   ```

   Use `"^0.4.0 || ^0.5.0"` instead if 0.4.x users should keep receiving 0.4.x
   patches; verified: `maxSatisfying(['0.4.0','0.4.1','0.5.0'], '^0.4.0 || ^0.5.0')` → `0.5.0`.
3. Tag first, PR second. Liveness runs `git ls-remote` against the published
   tags, and a reviewer resolving the new range needs it to exist.
4. Open the PR from an account matching `author.github` (`trieloff`); that field
   gates entry changes.
5. A maintainer reviews. Approval covers the listing, not each release.

## Do not

- Move, delete, or force-push a `vX.Y.Z` tag. bb refuses a tag whose commit
  changed and names both commits; users must remove and reinstall.
- Publish a prerelease expecting it to ship. Prereleases are excluded unless the
  range itself names one.
- Use the PATH `gh` for `release create` — the bot token lands on the release.
- Change the plugin id, provider id, or repo URL without a marketplace PR.
