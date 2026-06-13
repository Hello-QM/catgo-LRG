# Open VSX namespace verification

## The warning

On the Open VSX listing (used by Cursor / VSCodium / Theia) the CatGo extension shows:

> This version of the "CatGo" extension was published by **RedStar-Iron**. That user
> account is not a verified publisher of the namespace **"Guangsheng"** of this
> extension.

## Actual state (confirmed via the Open VSX public API, 2026-06-13)

`GET https://open-vsx.org/api/Guangsheng` and `.../Guangsheng/catgo`:

```json
{ "name": "Guangsheng", "verified": false, "access": "restricted" }
{ "namespace": "Guangsheng", "name": "catgo", "version": "1.1.15",
  "verified": false, "namespaceAccess": "restricted",
  "publishedBy": { "loginName": "RedStar-Iron", "provider": "github" } }
```

So the namespace is **not** ownerless:

- `access: restricted` + RedStar-Iron successfully publishes ⇒ **RedStar-Iron is already a
  member (contributor)** of the `Guangsheng` namespace.
- The warning is purely because **`verified: false`** — the namespace has no *verified
  owner*. `ovsx create-namespace` does **not** help here (it errors "already exists"); it
  only matters for a brand-new namespace.

To clear the warning the namespace must become **verified**, which requires an *owner*
role granted by the Open VSX / Eclipse admins through a one-time claim request.

## What the repo already does (PR #330)

- `extensions/vscode/package.json` — `repository` is the object form with `.git`, the
  link the Eclipse reviewers check to approve the claim.
- `.github/workflows/vsix-publish.yml` — idempotent `ovsx create-namespace` step (a
  harmless no-op now; correct safety net if the namespace is ever recreated fresh).

## The fix — one-time manual claim (requires the RedStar-Iron GitHub account)

This is the only step that removes the warning, and it can only be done by a human with
the publishing GitHub identity — it cannot be automated from CI or a token.

1. Sign in to <https://github.com> as **RedStar-Iron** (the account that owns `OVSX_PAT`).
2. Open the claim form:
   <https://github.com/EclipseFdn/open-vsx.org/issues/new?template=claim-namespace-ownership.yml>
3. Fill it in (our evidence is the strongest "VS Code Publisher with Repo" path — should be
   approved quickly):

   - **Title:** `Claiming namespace Guangsheng`
   - **Namespace:** `Guangsheng`
   - **Claim evidence:** check **"VS Code Publisher with Repo"** — justified because:
     - `Guangsheng` is a VS Code Marketplace publisher:
       <https://marketplace.visualstudio.com/items?itemName=Guangsheng.catgo> (HTTP 200).
     - That extension's `package.json` declares a GitHub repo:
       `https://github.com/Hello-QM/catgo-LRG.git`.
   - **Account Age:** RedStar-Iron (github.com/RedStar-Iron, id 49940294) was created
     2019-04-24 → well over the 12-month public-history requirement.

4. After Eclipse grants ownership, re-run the publish so a new version inherits the
   verified namespace:

   ```bash
   gh workflow run vsix-publish.yml --ref main
   ```

The warning disappears on the next published version. VS Code Marketplace (`vsce`) has no
namespace-verification concept and is unaffected.

## Alternative (only if the claim is rejected)

Change `publisher` in `extensions/vscode/package.json` to a namespace RedStar-Iron can
self-verify. This changes the extension's Open VSX identity (URL / install id) and loses
continuity with existing installs — do it deliberately, not as a shortcut.
