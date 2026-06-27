#!/usr/bin/env python3
"""Push App Store listing metadata via the App Store Connect API.

Used instead of `fastlane deliver` for text metadata because deliver 2.236 + an
API key crashes on `fetch_app_store_review_detail` ("No data") while uploading.
The raw API PATCHes are simple and avoid that path. Screenshots still go through
`fastlane deliver --skip_metadata true` (its multipart upload works fine).

Credentials come from an App Store Connect API key JSON (NEVER commit it):
    {"key_id": "...", "issuer_id": "...", "key": "<AuthKey .p8 contents>"}

Usage:
    ASC_API_KEY=/path/to/asc_api_key.json \
    asc_push_metadata.py <bundle_id> <metadata_dir>

<metadata_dir> holds fastlane-style files (en-US/description.txt, keywords.txt,
promotional_text.txt, marketing_url.txt, support_url.txt, subtitle.txt). It edits
the single editable App Store version's en-US localization and sets the privacy
policy URL. It does NOT set name (globally unique — leave it), does NOT set
whatsNew (not editable on a first release), and does NOT submit.

Set PRIVACY_URL env to also write the privacy policy URL.
"""
import jwt, time, json, os, sys, requests

BASE = "https://api.appstoreconnect.apple.com/v1"
EDITABLE = {"PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED",
            "METADATA_REJECTED", "INVALID_BINARY"}


def load_key():
    p = os.environ.get("ASC_API_KEY")
    if not p or not os.path.exists(p):
        sys.exit("set ASC_API_KEY=/path/to/asc_api_key.json")
    return json.load(open(p))


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    bundle, md = sys.argv[1], sys.argv[2]
    loc_dir = os.path.join(md, "en-US")
    k = load_key()

    def tok():
        return jwt.encode(
            {"iss": k["issuer_id"], "iat": int(time.time()),
             "exp": int(time.time()) + 1100, "aud": "appstoreconnect-v1"},
            k["key"], algorithm="ES256", headers={"kid": k["key_id"]})

    def H():
        return {"Authorization": f"Bearer {tok()}", "Content-Type": "application/json"}

    def rd(name):
        p = os.path.join(loc_dir, name)
        return open(p, encoding="utf-8").read() if os.path.exists(p) else None

    def patch(url, attrs, typ, rid):
        r = requests.patch(url, headers=H(),
                           data=json.dumps({"data": {"type": typ, "id": rid, "attributes": attrs}}))
        if r.status_code >= 300:
            print("  PATCH FAIL", r.status_code, r.text[:300])
        else:
            print("  set:", list(attrs.keys()))
        return r

    apps = requests.get(f"{BASE}/apps", headers=H(),
                        params={"filter[bundleId]": bundle}).json()["data"]
    assert apps, "app not found: " + bundle
    aid = apps[0]["id"]
    print("app:", apps[0]["attributes"]["name"], "| id", aid)

    vers = requests.get(f"{BASE}/apps/{aid}/appStoreVersions", headers=H()).json()["data"]
    ed = [v for v in vers if v["attributes"]["appStoreState"] in EDITABLE]
    assert ed, "no editable App Store version (create one first)"
    vid = ed[0]["id"]
    print("version:", ed[0]["attributes"]["versionString"], ed[0]["attributes"]["appStoreState"])

    locs = requests.get(f"{BASE}/appStoreVersions/{vid}/appStoreVersionLocalizations",
                        headers=H()).json()["data"]
    vloc = ([l for l in locs if l["attributes"]["locale"] == "en-US"] or locs)[0]
    vattr = {k2: v2 for k2, v2 in {
        "description": rd("description.txt"), "keywords": rd("keywords.txt"),
        "promotionalText": rd("promotional_text.txt"),
        "marketingUrl": rd("marketing_url.txt"), "supportUrl": rd("support_url.txt"),
    }.items() if v2}
    print("version localization:")
    patch(f"{BASE}/appStoreVersionLocalizations/{vloc['id']}", vattr,
          "appStoreVersionLocalizations", vloc["id"])

    info_id = requests.get(f"{BASE}/apps/{aid}/appInfos", headers=H()).json()["data"][0]["id"]
    ilocs = requests.get(f"{BASE}/appInfos/{info_id}/appInfoLocalizations",
                         headers=H()).json()["data"]
    iloc = ([l for l in ilocs if l["attributes"]["locale"] == "en-US"] or ilocs)[0]
    iattr = {k2: v2 for k2, v2 in {
        "subtitle": rd("subtitle.txt"),
        "privacyPolicyUrl": os.environ.get("PRIVACY_URL"),
    }.items() if v2}
    print("app info localization:")
    patch(f"{BASE}/appInfoLocalizations/{iloc['id']}", iattr,
          "appInfoLocalizations", iloc["id"])
    print("\nDONE — metadata pushed, no submit.")


if __name__ == "__main__":
    main()
