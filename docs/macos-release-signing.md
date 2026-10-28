# macOS release signing readiness

## Assessment

**Not ready for signed public distribution.** This is a source-level assessment;
repository/organization secrets, Apple membership, certificates and private keys
have not been inspected or assumed available. No signing or notarization was run.
Existing releases must not be described as Developer ID signed or notarized.

The current path is:

- `.github/workflows/release.yml` builds on `macos-14` with `bun run build:desktop`.
- `scripts/build-desktop.ts` prepares the app, then invokes Electron Builder with
  `apps/desktop/electron-builder.json` and `--publish never`.
- That configuration sets `mac.identity` to `null`, explicitly disabling signing.
  Supplying a certificate alone will not enable this path.
- `scripts/prepare-desktop.ts` puts compiled Bun helpers (`demesne-host`, its
  `demesne-desktop-host` compatibility copy, and `demesned`) plus native image
  dependencies under `Contents/Resources/backend`, outside ASAR.
- The workflow checks those files exist, then immediately uses `ditto` to zip
  `mac-arm64/Demesne.app`. It has no certificate import, notarization, stapling,
  signature verification or Gatekeeper assessment step. Checksums only establish
  archive integrity, not publisher identity. The release job publishes these
  artifacts and marks the release latest; it is not a signed-public-release gate.

## Credentials to arrange with the release owner

Do not put credentials in source, logs or build artifacts. Confirm availability
and access policy with the owner, without requesting secret values in chat.

- An active Apple Developer Program team and a **Developer ID Application**
  certificate with its matching private key (not merely a `.cer`, and not a
  Developer ID Installer or Apple Development certificate).
- For Electron Builder's certificate-import route, a password-protected PKCS#12
  export supplied through protected CI secrets as `CSC_LINK` and
  `CSC_KEY_PASSWORD`. A base64-encoded certificate can be used for `CSC_LINK`.
  Alternatively, explicitly import into a temporary runner keychain and select
  that identity. Configure cleanup on failure as well as success.
- The expected signing identity and team ID, so verification can reject the wrong
  signer. Team ID is not itself a secret.
- One notarization authentication route: an App Store Connect API key (`.p8`,
  key ID and issuer ID for a team key), or an Apple ID, app-specific password and
  team ID. Provision these as protected secrets for the chosen implementation;
  the workflow currently wires neither route. A local keychain profile does not
  automatically exist on a hosted runner.

Secret names above describe Electron Builder's certificate interface, not secrets
confirmed to exist in this repository. Restrict signing credentials to trusted
release runs; do not expose them to pull-request code.

## Implementation blockers and acceptance checklist

- [ ] Replace/override `mac.identity: null` only for the signed release path and
      make that path fail closed if the expected identity or credentials are
      missing. Preserve intentionally unsigned local builds.
- [ ] Configure and validate hardened runtime and entitlements for Electron and
      the compiled Bun executables. Account for JIT requirements without broadly
      disabling runtime protections. Do not assume Electron's defaults suffice
      for Bun or that nested binaries inherit the outer app's entitlements.
- [ ] Ensure inside-out signing covers Electron helpers/frameworks, both Bun host
      copies, the daemon, and all native libraries/addons (including sharp's
      dependencies). Inspect the actual bundle; do not use `codesign --deep` as a
      substitute for explicitly signing nested code.
- [ ] Submit the signed app archive with `xcrun notarytool submit ... --wait`,
      require an Accepted result, and retrieve the notarization log on failure
      without leaking authentication material.
- [ ] Staple the ticket to `Demesne.app`, validate it, then create the final zip
      with `ditto`. ZIP files themselves cannot be stapled. Generate the legacy
      alias and both checksums only from that final stapled bundle.
- [ ] Gate artifact upload/public release on the checks below. Test the downloaded
      archive on a clean Mac with quarantine/Gatekeeper in effect, including
      launching the app, host, daemon and native image operations.

On the final app (and again after extracting the final archive), require:

```sh
app=apps/desktop/release/mac-arm64/Demesne.app
codesign --verify --deep --strict --verbose=2 "$app"
codesign --display --verbose=4 "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=4 "$app"
```

Check the displayed Authority and TeamIdentifier against the expected Developer
ID identity; also verify nested executables' signatures and runtime entitlements.
A successful build, ad-hoc signature, or local launch alone is not acceptance.
This checklist is a readiness plan, not an implemented signing pipeline.
