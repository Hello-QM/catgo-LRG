# CatGo — Android build

Build the CatGo Android APK from this repository.

> **Toolchain required.** These commands only work on a machine with the Android
> SDK + NDK + JDK 17 installed. CI/dev boxes without the SDK should NOT run
> `tauri android init` — it generates `src-tauri/gen/android/` against a missing
> SDK and leaves a broken Gradle project behind. Nothing in this repo is
> committed under `src-tauri/gen/android/`; it is generated locally per machine.

## What already works (no build needed)

The Rust side is mobile-ready and compiles for desktop unchanged:

- **`bundle.identifier`** in `src-tauri/tauri.conf.json` is `com.catgo.app` — a
  valid reverse-DNS application id, which mobile targets require. No mobile-only
  config is needed; the desktop build is unaffected.
- **`#[cfg(desktop)]` gating (#194)** excludes the Python/Node sidecars
  (`externalBin`) and the local PTY (`portable-pty`) from the Android build.
  Desktop-only crates are pinned to
  `cfg(not(any(target_os = "android", target_os = "ios")))` in
  `src-tauri/Cargo.toml`, so Cargo never pulls them on mobile.
- **`#[cfg_attr(mobile, tauri::mobile_entry_point)]`** in `src-tauri/src/lib.rs`
  provides the JNI entry point used by the generated Android project.
- **russh transport (#195)** is compiled on every target (not feature-gated).
  At runtime the frontend selects it via `isMobile()`
  (`src/lib/api/transport/index.ts`): on Android the Rust `ssh` module owns the
  SSH connection and the webview drives it over Tauri `invoke`, instead of the
  desktop HTTP/Python-sidecar path.

## 1. Prerequisites (one-time, per machine)

### JDK 17

```bash
# Debian/Ubuntu
sudo apt install openjdk-17-jdk
java -version          # must report 17.x
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
```

### Android SDK + NDK

Install via Android Studio (SDK Manager) **or** the standalone command-line
tools. Command-line route:

```bash
# 1. cmdline-tools — download from https://developer.android.com/studio#command-line-tools-only
export ANDROID_HOME="$HOME/Android/Sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"
unzip commandlinetools-linux-*.zip -d "$ANDROID_HOME/cmdline-tools"
mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# 2. accept licenses + install the SDK platform, build-tools, platform-tools, NDK
sdkmanager --licenses
sdkmanager "platform-tools" \
           "platforms;android-34" \
           "build-tools;34.0.0" \
           "ndk;26.1.10909125"
```

### Environment variables

Tauri's Android tooling reads these (add to your shell profile):

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
# NDK_HOME points at the exact NDK version installed above
export NDK_HOME="$ANDROID_HOME/ndk/26.1.10909125"
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

Verify:

```bash
sdkmanager --version    # SDK present
adb --version           # platform-tools present
ls "$NDK_HOME"          # NDK present
echo "$ANDROID_HOME" "$NDK_HOME"   # both must be non-empty
```

### Rust Android targets

```bash
rustup target add \
  aarch64-linux-android \
  armv7-linux-androideabi \
  i686-linux-android \
  x86_64-linux-android
```

### JS dependencies

```bash
# from the repo root
pnpm install
```

## 2. Initialise the Android project (one-time)

This generates `src-tauri/gen/android/` (the Gradle/Kotlin wrapper project).
Run it once per checkout; it requires the SDK/NDK from step 1 to be present.

```bash
# from the repo root
pnpm tauri android init
```

`src-tauri/gen/android/` is machine-local and is not committed — re-run
`init` after a fresh clone. The reverse-DNS application id is taken from
`bundle.identifier` (`com.catgo.app`).

## 2b. Post-init native patches (REQUIRED — re-apply after every `init`)

`tauri android init` regenerates the native project from the CLI templates, so
the two edits below must be re-applied after each `init`. Without them the soft
keyboard covers the terminal's input line on a real device (the desktop/emulator
path can mask it). Both are grounded in the upstream keyboard-inset issues:
tauri-apps/tauri [#7868] / [#10631] and the official manifest fix [PR #13277].

[#7868]: https://github.com/tauri-apps/tauri/issues/7868
[#10631]: https://github.com/tauri-apps/tauri/issues/10631
[PR #13277]: https://github.com/tauri-apps/tauri/pull/13277

**(1) `app/src/main/AndroidManifest.xml`** — add `windowSoftInputMode` to the
`.MainActivity` `<activity>` (matches upstream PR #13277):

```xml
<activity
    android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
    android:windowSoftInputMode="adjustResize"
    android:launchMode="singleTask"
    ...
```

**(2) `app/src/main/java/com/catgo/app/MainActivity.kt`** — `adjustResize` alone
does NOT resize the window because the Tauri template calls `enableEdgeToEdge()`
(`setDecorFitsSystemWindows(false)`), so the IME is drawn over the WebView.
Consume the IME inset as bottom padding so the WebView shrinks above the
keyboard; the frontend (`MobileShell.svelte`) then re-fits xterm via
`visualViewport`:

```kotlin
package com.catgo.app

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      // Pad TOP by the status-bar inset (header/tabs clear the clock & battery)
      // and BOTTOM by whichever is larger of the IME or nav-bar inset.
      // env(safe-area-inset-*) is unreliable in the Android WebView.
      v.setPadding(0, bars.top, 0, maxOf(ime, bars.bottom))
      insets
    }
  }
}
```

## 2c. Regenerate the launcher icon (REQUIRED — re-apply after every `init`)

`tauri android init` writes the **default Tauri icon** (the cyan/yellow "8")
into `src-tauri/gen/android/app/src/main/res/mipmap-*/`. Those mipmaps are
machine-local (under the gitignored `src-tauri/gen/`), so the desktop icon work
in `src-tauri/icons/` does NOT propagate to them — the APK ships the default
icon unless you regenerate after each `init`.

`scripts/generate-icons.js` only covers the desktop/Windows/macOS sizes; it does
**not** touch Android. Run the Tauri icon command to (re)generate the Android
mipmaps from the CatGo cat logo so the launcher icon matches desktop:

```bash
# from the repo root — regenerates src-tauri/icons/* AND the Android mipmaps
pnpm tauri icon desktop/logo.png
```

Verify `mipmap-xxxhdpi/ic_launcher.png` now shows the navy cat "C" mark, not the
default "8".

## 2d. Release signing for Play Store (REQUIRED — re-apply after every `init`)

`tauri android init` writes a stock `app/build.gradle.kts` with **no signing
config**, so a release build is `*-release-unsigned.{apk,aab}` — Play rejects it.
The upload keystore itself lives OUTSIDE the repo (machine-local); only the wiring
below has to be re-applied after each `init` (`gen/` is gitignored).

**Upload keystore (one-time, keep it forever — back it up offline):**

```bash
keytool -genkeypair -v -keystore ~/.catgo-keys/catgo-upload.jks -storetype PKCS12 \
  -alias catgo-upload -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=CatGo, O=CatGo, OU=CatGo, C=US"
```

Losing this file/password means you can no longer push updates with the same
upload key (Play App Signing lets you *reset* the upload key via support, but the
app signing key Google holds is permanent). Never commit it.

**(1) `app/keystore.properties`** (gitignored under `gen/`) — points at the key:

```properties
storeFile=/home/<you>/.catgo-keys/catgo-upload.jks
storePassword=<store password>
keyAlias=catgo-upload
keyPassword=<key password>
```

**(2) `app/build.gradle.kts`** — load it and wire a release `signingConfig`. Add a
`keystoreProperties` loader next to the existing `tauriProperties` one, a
`signingConfigs { create("release") { … } }` block inside `android {}` that reads
those four keys, and `signingConfig = signingConfigs.getByName("release")` in
`buildTypes.getByName("release")`. Guard each on `storeFile` being present so a
keyless checkout/CI still builds (unsigned) instead of failing.

**Build the signed AAB for Play (internal testing → production):**

```bash
pnpm tauri android build --aab true   # → app/build/outputs/bundle/universalRelease/app-universal-release.aab
```

Verify it is signed with your upload key (not the debug key):

```bash
jarsigner -verify -certs app-universal-release.aab   # Owner should be CN=CatGo, not CN=Android Debug
```

## 3. Run on an emulator / device (dev)

```bash
# start an emulator (or plug in a device with USB debugging) first
adb devices              # confirm a device/emulator is listed

# from the repo root
pnpm tauri android dev
```

This builds the SvelteKit desktop frontend (`pnpm desktop:build` runs via
`beforeBuildCommand`), compiles the Rust lib for the device's ABI, and installs
+ launches the debug app with live reload. On Android the Python/Node sidecars
and local PTY are absent (gated out at compile time); HPC features run through
the russh transport.

## 4. Build a release APK

```bash
# from the repo root
pnpm tauri android build --apk
```

Output APKs (per-ABI and universal) are written to:

```
src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
src-tauri/gen/android/app/build/outputs/apk/<abi>/release/app-<abi>-release-unsigned.apk
```

To produce an Android App Bundle instead of an APK use `--aab`. A release
artifact is **unsigned** unless you configure a signing key in
`src-tauri/gen/android/app/build.gradle.kts` (or the
`src-tauri/gen/android/keystore.properties` Tauri generates); sign with the
standard `apksigner`/Play App Signing flow before distribution.

## SSH-key passwordless login — private-key at-rest protection

The mobile passwordless-login flow (`KeySetup.svelte` → Rust `ssh::keygen`)
generates an ed25519 keypair ON THE DEVICE, installs the **public** key into the
cluster's `~/.ssh/authorized_keys` over the live session, and persists the
**private** key wrapped at rest. The private key never leaves the phone in the
clear.

### What is implemented today (software fallback)

`src-tauri/src/ssh/keygen.rs` wraps the private key with **AES-256-GCM**. The
data-encryption key (DEK) is generated from the OS CSPRNG (`getrandom`) and
stored alongside the ciphertext in a JSON envelope under the app data dir
(`<app_data_dir>/ssh_keys/<endpoint>.json`, `0600` on Unix). Commands:

- `ssh_keygen` → `{ public_openssh, private_openssh }`
- `ssh_install_pubkey(session_id, public_openssh)` → idempotent `authorized_keys`
  append (`grep -qF` guard, `~/.ssh` 700 / `authorized_keys` 600)
- `ssh_key_store(endpoint_key, private_openssh)` / `ssh_key_load(endpoint_key)`

> **Security caveat.** This protects the key from casual at-rest disclosure but
> the DEK is software-held next to the ciphertext, so it is **NOT hardware-bound**
> and **NOT** resistant to an attacker with root/full filesystem access. It is a
> portable fallback, not the production hardening target.

### Intended hardening (AndroidKeyStore — NOT yet wired)

On Android the DEK should be generated and held inside the **AndroidKeyStore**
(hardware-backed / StrongBox where available, non-exportable), so the raw DEK
never exists in app-readable storage. A small Kotlin Tauri plugin would expose
`encrypt`/`decrypt` over a Keystore-held `AES/GCM/NoPadding` key:

```kotlin
// Generate once, hardware-backed, non-exportable:
val kpg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
kpg.init(
  KeyGenParameterSpec.Builder("catgo_ssh_dek",
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
    .setKeySize(256)
    // .setUserAuthenticationRequired(true)  // optional: gate on biometric/PIN
    // .setIsStrongBoxBacked(true)           // when the device has a secure element
    .build())
val key = kpg.generateKey()
// Cipher.getInstance("AES/GCM/NoPadding") with that key wraps/unwraps the
// OpenSSH private key; only the GCM IV + ciphertext are persisted.
```

The Rust surface is shaped so this is a localized swap: `wrap_dek()` /
`unwrap_dek()` in `keygen.rs` are the single seam where the DEK source changes
from `getrandom` to a Keystore-plugin `invoke`. The envelope format
(`KeyEnvelope`, versioned via `v`) would drop the `dek_b64` field and instead
store the Keystore IV. **This Kotlin plugin is documented here but is not built
or verified in this change** — the host CI box has no Android SDK (see the
toolchain warning at the top), so only the Rust software fallback is compiled and
checked.

## Notes

- `pnpm tauri ...` routes through `scripts/tauri-dev.mjs`, which passes every
  subcommand except `dev` straight to the Tauri CLI; for `android` subcommands
  it is a transparent pass-through.
- Keep the JDK at 17 — the Android Gradle Plugin used by Tauri 2 rejects newer
  JDKs in some configurations.
- If `init` was run against the wrong SDK and the Gradle project is broken,
  delete `src-tauri/gen/android/` and re-run step 2 with a valid `ANDROID_HOME`
  / `NDK_HOME`.
