# Shipping CatGo iOS to the App Store (no Mac)

The iOS app is the **STATIC_ONLY web build** in a WKWebView (`ios-build.yml` sets
`VITE_STATIC_ONLY=1`). It builds, signs, and uploads to TestFlight from GitHub's
macOS runners — **no local Mac needed**. This is the runbook for taking a build
from TestFlight to a public App Store release, done entirely from Linux + the
App Store Connect API.

First public release: **CatGo: HPC & Chemistry** (`org.catgo.app`), app id
`6777090974`, submitted as **1.4.0** on 2026-06-26.

---

## 0. Signing certificates (one-time, already done)

iOS and macOS desktop need **different** certificate types and must use
**different** GitHub secrets — sharing one breaks the other:

| Pipeline | Cert type | Secrets |
|---|---|---|
| `ios-build.yml` | **Apple Distribution** | `APPLE_CERTIFICATE` / `_PASSWORD` / `_SIGNING_IDENTITY` |
| `tauri-build.yml` (macOS) | **Developer ID Application** | `MACOS_CERTIFICATE` / `_PASSWORD` / `_SIGNING_IDENTITY` |

Both certs can be created on **Linux with OpenSSL** (no Keychain): `openssl
genrsa` → `openssl req` (CSR) → upload CSR at developer.apple.com → download
`.cer` → `openssl pkcs12 -export -legacy` to a `.p12`. Notarization (macOS) +
TestFlight upload (iOS) both use the App Store Connect API key
(`APPLE_API_KEY_ID` / `APPLE_API_ISSUER_ID` / `APPLE_API_KEY_P8`).

## 1. Build + upload to TestFlight

```bash
gh workflow run ios-build.yml -R Hello-QM/catgo-LRG -r main -f signed=true -f upload=true
gh run watch <run_id> -R Hello-QM/catgo-LRG --exit-status
```

The build's `CFBundleVersion` = `github.run_number`; its **marketing version**
(`CFBundleShortVersionString`) comes from `src-tauri/tauri.conf.json`. The App
Store version string **must match that marketing version** to attach the build —
so submit `1.4.0` against a `1.4.0` build; a different number needs a fresh
build (bump tauri.conf first).

Pre-submission gate: make sure no backend-only surface is reachable in the
STATIC_ONLY UI (it 503s / shows a "download desktop" prompt → App Store
rejection, Guideline 2.1). See the Analysis-button / Doping-tab gating in
`StructureToolbar.svelte` + `BuildPane.svelte`.

## 2. App Store Connect API key (local)

Build the JSON deliver/scripts expect from the `.p8` + the two IDs. **Keep it out
of git.**

```bash
python3 - <<'PY'
import json
open('/path/to/asc_api_key.json','w').write(json.dumps({
  "key_id": "<APPLE_API_KEY_ID>",
  "issuer_id": "<APPLE_API_ISSUER_ID>",      # appstoreconnect.apple.com/access/integrations/api
  "key": open('/path/to/AuthKey_<KEYID>.p8').read(),
  "in_house": False,
}))
PY
chmod 600 /path/to/asc_api_key.json
```

## 3. Screenshots → exact App Store sizes

App Store Connect validates by **exact pixel size**. Device captures are usually
wrong (6.1" iPhone, 11" iPad). Pad them (no distortion):

```bash
python3 deploy/ios/scripts/pad_screenshots.py <src>/Mobile <out>/Mobile iphone67   # 1290x2796
python3 deploy/ios/scripts/pad_screenshots.py <src>/Pad    <out>/Pad    ipad129    # 2048x2732
```

Max **10 per device**; portrait only. Stage all into one folder
`fastlane/screenshots/en-US/` — `deliver` detects device by image size.

## 4. Push metadata + screenshots

Text metadata lives in `fastlane/metadata/en-US/*.txt` (name, subtitle,
description, keywords, promotional_text, marketing_url, support_url,
primary/secondary_category). Limits: name ≤30, subtitle ≤30, keywords ≤100,
promo ≤170, description ≤4000.

```bash
export PATH="$HOME/.local/share/gem/ruby/<ver>/bin:$PATH"   # if fastlane is user-installed

# Screenshots — deliver works fine for these:
fastlane deliver --api_key_path ./asc_api_key.json --app_identifier org.catgo.app \
  --screenshots_path ./fastlane/screenshots --skip_binary_upload true \
  --skip_metadata true --overwrite_screenshots true \
  --submit_for_review false --run_precheck_before_submit false --force

# Text metadata — deliver 2.236 crashes here (fetch_app_store_review_detail "No data"),
# so use the API directly instead:
ASC_API_KEY=./asc_api_key.json \
PRIVACY_URL="https://github.com/Hello-QM/catgo-LRG/blob/main/PRIVACY.md" \
python3 deploy/ios/scripts/asc_push_metadata.py org.catgo.app ./fastlane/metadata
```

Gotchas baked into the script: **don't** set `name` (globally unique — "CatGo"
is taken; the registered name is "CatGo: HPC & Chemistry"); **don't** set
`whatsNew` on a first release (not editable → 409).

## 5. Version string + attach the build (API)

If the editable version was auto-created with the wrong number, rename it and
attach the VALID build whose marketing version matches:

```python
# PATCH /v1/appStoreVersions/{id}  {"attributes":{"versionString":"1.4.0"}}
# PATCH /v1/appStoreVersions/{id}/relationships/build  {"data":{"type":"builds","id":<build_id>}}
```

(Find the build via `/v1/builds?filter[app]=<id>&sort=-uploadedDate`; its
`/preReleaseVersion` gives the marketing version. `CFBundleVersion` == the
`github.run_number` of the build run.)

## 6. The web-only steps (must be done in App Store Connect by you)

Everything above is scriptable; these are not (legal / declarations / final
submit). From `https://appstoreconnect.apple.com/apps/6777090974/distribution`:

1. **Agreements** (`/agreements`) — accept the updated Apple Developer Program
   License Agreement (the yellow banner). Free app → ignore the Paid Apps
   Agreement. DSA: declare **non-trader** (no EU, keeps your address private) or
   **trader** (EU, contact shown).
2. **Contact Information** (App Review Information on the version page).
3. **App Privacy** → "No, we do not collect data" (**Data Not Collected** — no
   analytics/accounts/backend; SSH creds + API keys stay on-device).
4. **Content Rights** (App Information) → "does not contain third-party content".
5. **Pricing** → **Free**.
6. **Age Rating** → all None → **4+**.
7. **Add for Review** → Export Compliance → **Exempt** (standard HTTPS/SSH) →
   **Submit**.

Verify state any time:

```bash
ASC_API_KEY=./asc_api_key.json python3 - <<'PY'
import jwt,time,json,os,requests
k=json.load(open(os.environ["ASC_API_KEY"]))
t=jwt.encode({"iss":k["issuer_id"],"iat":int(time.time()),"exp":int(time.time())+600,"aud":"appstoreconnect-v1"},k["key"],algorithm="ES256",headers={"kid":k["key_id"]})
H={"Authorization":f"Bearer {t}"}; B="https://api.appstoreconnect.apple.com/v1"
a=requests.get(f"{B}/apps",headers=H,params={"filter[bundleId]":"org.catgo.app"}).json()["data"][0]
v=requests.get(f"{B}/apps/{a['id']}/appStoreVersions",headers=H).json()["data"][0]["attributes"]
print(a["attributes"]["name"], v["versionString"], v["appStoreState"])
PY
```
