# netdash for Android

The Android app for netdash. Install and features: see the [main README](../README.md#android-app).

```sh
./gradlew assembleDebug   # app/build/outputs/apk/debug/
```

- Version: `VERSION` in `backend/main.py` (or `NETDASH_VERSION` from the release workflow).
- Release signing: environment variables `NETDASH_KEYSTORE` (path), `NETDASH_KEYSTORE_PASSWORD`, optionally
  `NETDASH_KEY_ALIAS` (default `netdash`). The keystore never goes into the repository (`signing/` is ignored).
- `app/src/main/assets/inject.js` runs in every netdash page. It uses the frontend's `.login form`, `.mnav`, `--bg` and
  `--bg-2`; keep it in sync when those change.
