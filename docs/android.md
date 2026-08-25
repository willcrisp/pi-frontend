# The Android app

A sideloadable Android build of radius, boiled down to the part that is useful on
a phone: pick a chat, read it, send a prompt, steer it, answer the two things an
agent can block on. No settings, no providers, no usage, no sub-agent management,
no TrueFoundry.

It is a **second entry point over the same engine**, not a second app. Everything
in `src/stores/opencode/` — the SSE reducer, the run-end reconciliation, steering,
transcript normalization — is shared verbatim with the desktop build. Only the
component tree differs. A fix to the engine should never need doing twice.

## Where the files are

The mobile build is deliberately not one folder, because the useful half of it is
shared. Capacitor also pins two of these paths — `cap` resolves its config and the
native project from the repo root, and has no flag to move either.

| Path | What |
|---|---|
| `mobile/` | this build's own tooling: the entry document, its Vite config, the dist flattener, the proxy test |
| `src/mobile/` | the phone UI — sits beside `src/stores/` because that is what it imports |
| `android/` | the Gradle project and `LocalProxy.java`; **root-pinned by Capacitor** |
| `capacitor.config.json` | **root-pinned by Capacitor** |
| `src/stores/`, `src/lib/` | shared with the desktop build, unmodified |

The one file both builds change is `src/stores/ssh.js` (`apiBase()`), which is the
subject of the proxy note below.

## Build it

Needs the Android SDK (Android Studio, or `cmdline-tools` + `platform-tools`) and
a JDK 21. Everything else is committed, including the Gradle wrapper.

```sh
npm install
npm run android:sync                      # builds dist-mobile/ and copies it into android/
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

Copy the APK to the phone and open it. It is debug-signed, which is all sideloading
needs — you will have to allow "install unknown apps" for whatever opens it.

`npm run android:sync` is not optional after a web change: Gradle packages
`android/app/src/main/assets/public`, and only `cap sync` refreshes it.

## Run it against a server

On the machine running opencode2 — note `--hostname 0.0.0.0`, since the default
binds loopback and a phone is not loopback:

```sh
opencode2 serve --hostname 0.0.0.0 --port 4096
opencode2 service password
```

Then in the app: one address field, and the password. The field takes either
form and fills in the rest — what it resolved to is echoed underneath before you
connect.

**The phone needs a route to the machine**, and this is the part that doesn't come
in the APK. The desktop workflow tunnels with `ssh -L 5000:localhost:4096
ALF-UAT.coder` and points at localhost; a phone has no equivalent. Two that work:

- **A Coder port-forward URL** — forward 4096 out of the workspace and paste the
  URL in. This is the best of them: https from anywhere, including cellular, with
  nothing installed on the phone. It has to be **shared publicly** in Coder, or
  the app hits Coder's own login page instead of opencode2 — the app carries an
  opencode2 Basic-auth header, not a Coder session.
- **Tailscale** on both ends, using the machine's `100.x.y.z` or `*.ts.net` name.
  Plain http, and it works off-network too.
- **Same Wi-Fi** works for a LAN address with no extra software.

⚠️ A publicly-shared Coder port puts opencode2 on the open internet, where its
Basic-auth password is the only thing in front of an agent that can run shell
commands in your workspace. Use a long password and know that is the posture.

If the Coder deployment's certificate is issued by an internal CA rather than a
public one, the handshake fails on the device unless that CA is in Android's trust
store — the app reports it as `TLS handshake failed with <host>` rather than a
generic connection error, so it can be told apart from a wrong address.

## Developing without an APK

`npm run dev:mobile` serves the mobile entry on <http://127.0.0.1:5174> with the
same dev proxy the desktop uses, at the same URL shape the device serves
(`/`, not `/mobile/`). A desktop browser's device-emulation mode is enough for
everything except the WebView itself.

To drive the *production* bundle through the *real* proxy — the closest thing to
the APK short of installing it:

```sh
npm run build:mobile && npx cap sync android
javac -d /tmp/pt android/app/src/main/java/dev/radius/mobile/LocalProxy.java \
      mobile/proxy-test/ProxyTest.java mobile/proxy-test/ServeBundle.java
java -cp /tmp/pt dev.radius.mobile.ServeBundle android/app/src/main/assets
# -> http://127.0.0.1:47653
```

## Why there is a proxy inside the app

This is the whole reason the port is more than a wrapper, so it is worth stating
plainly.

**The opencode2 server sends no CORS headers on any route, and answers the
OPTIONS preflight with a 404.** Verified against a live server, on an
authenticated 200 as well as a 401:

```console
$ curl -sI -u opencode:$PW -H "Origin: http://localhost" http://127.0.0.1:4096/api/health
HTTP/1.1 200 OK
Content-Type: application/json      # ← no access-control-allow-origin, on a 200
$ curl -sI -X OPTIONS -H "Origin: http://localhost" http://127.0.0.1:4096/api/session
HTTP/1.1 404 Not Found
```

So a WebView can never call the server cross-origin — not with `fetch`, not with
`EventSource`. The usual escape hatch, a native HTTP bridge plugin, does not
stream, and **every message in this app arrives over SSE**, so that hatch is
closed too.

What works instead: serve the app itself from a proxy that also forwards `/api`,
making every request same-origin. That is `LocalProxy.java` — a small HTTP server
on `127.0.0.1:47653` that serves the bundled assets and forwards
`/api/<scheme>/<host>:<port>/…` to the real server. It is the same thing
`vite.config.js` does in development, and it reads the target off the URL in the
same format, so the JavaScript never has to tell either proxy anything (see
`apiBase()` in `src/stores/ssh.js`).

The scheme is part of the address because the two routes differ on it: a
tunnelled or LAN server is plain http, a Coder URL is https on 443. The proxy
terminates that TLS itself, which is also why the page it serves can stay plain
http on loopback with no mixed-content problem. Certificates are verified
properly, hostname included — `mobile/proxy-test` asserts that a certificate
issued for the wrong name is rejected, because wrapping an already-connected
socket does *not* turn hostname verification on by default and getting that
wrong would be silent.

Same-origin buys three more things for free: SSE keeps streaming, WebSocket
upgrades still work, and the PTY `connect-token`'s own same-origin check is
satisfied.

**A change to the `/api/<scheme>/<host>:<port>` prefix is a change in three files:**
`src/stores/ssh.js`, `vite.config.js`, `LocalProxy.java`.

### The 401 that hangs the app

Both proxies strip `WWW-Authenticate` off a 401, and this is not cosmetic.

A browser that sees `WWW-Authenticate: Basic` on a 401 opens its own credential
prompt and **leaves the fetch pending until that prompt is answered**. A WebView
shows no such prompt, so the promise never settles: one wrong password and the app
hangs on a spinner, with no error, forever. Verified in a real browser —
`credentials: "omit"` does not avoid it. With the header stripped the 401 arrives
as an ordinary response and the connect screen says "authentication failed".

## Testing the proxy

`LocalProxy.java` is the riskiest file in the port: the only new native code, on
the path of every request, and a bug in it looks from the phone like "the app
doesn't work" with no stack trace. So it carries **no Android imports** — assets
arrive through a one-method `AssetSource` interface — and is tested off-device
against a real upstream:

```sh
MOCK_PORT=4097 node test/mock-opencode.js &
javac -d /tmp/pt android/app/src/main/java/dev/radius/mobile/LocalProxy.java \
      mobile/proxy-test/ProxyTest.java
java -cp /tmp/pt dev.radius.mobile.ProxyTest 4097
```

20 checks: asset serving and content types, proxying, POST bodies, `Origin` not
forwarded, status passthrough, an unreachable upstream answering 502 rather than
dropping the socket, the `WWW-Authenticate` strip, **SSE arriving incrementally
rather than buffered**, a WebSocket upgrade with bytes spliced through after the
101, and — against a real HTTPS server with a generated certificate — a
successful TLS handshake plus **a certificate for the wrong hostname being
rejected**.

The TLS checks need a keystore, and skip themselves without one:

```sh
cd /tmp && keytool -genkeypair -alias localhost -keyalg RSA -validity 365 \
  -dname "CN=localhost" -ext "SAN=DNS:localhost" \
  -keystore server.p12 -storetype PKCS12 -storepass changeit -keypass changeit
keytool -exportcert -alias localhost -keystore server.p12 -storepass changeit -file server.crt
keytool -importcert -noprompt -alias localhost -file server.crt \
  -keystore trust.p12 -storetype PKCS12 -storepass changeit
keytool -genkeypair -alias other -keyalg RSA -validity 365 \
  -dname "CN=not-your-server.example" -ext "SAN=DNS:not-your-server.example" \
  -keystore wrong.p12 -storetype PKCS12 -storepass changeit -keypass changeit

java -Djavax.net.ssl.trustStore=/tmp/trust.p12 \
     -Djavax.net.ssl.trustStorePassword=changeit \
     -Djavax.net.ssl.trustStoreType=PKCS12 \
     -Dtest.keyStore=/tmp/server.p12 -Dtest.wrongKeyStore=/tmp/wrong.p12 \
     -cp /tmp/pt dev.radius.mobile.ProxyTest 4097
```

Keep this passing. It is the only test between a proxy change and a phone.

## Dictation

**Use the keyboard's own microphone key.** Gboard (and every other Android IME)
puts voice typing one tap from the composer, it is what people already reach for,
and it needs no code, no permission prompt and no plugin.

It works because the composer does nothing clever: no `inputmode` override, no
custom key handling, no controlled-input games. Voice typing commits text through
the IME as composition events rather than keystrokes, and Vue's `v-model` guards
on composition and syncs at `compositionend` — verified by driving that exact
event sequence at the real composer and watching the text land, autosize run, the
send button enable and the prompt reach the transcript.

The in-app alternatives were investigated and all are worse here:

| Approach | Verdict |
|---|---|
| Web Speech API (`webkitSpeechRecognition`) | Present in desktop Chrome, **not implemented by Android System WebView** — it is a Chrome feature, not a WebView one. Would appear to work in `dev:mobile` and fail on the device, which is the worst failure mode. |
| Capacitor speech-recognition plugin | Native `SpeechRecognizer`, so it works — but it needs the Capacitor bridge, a `RECORD_AUDIO` permission and a plugin dependency, to duplicate a button already on the keyboard. |
| `MediaRecorder` + transcription | The app IS a secure context (`http://127.0.0.1` counts as potentially trustworthy, so `getUserMedia` and `MediaRecorder` are both available — verified), but opencode2 has no transcription route, so this needs a third-party API and a key on the phone. |

No microphone permission is declared, deliberately: a sideloaded app asking for
one it never uses is a bad signal.

## Mobile conventions

Things a phone app is expected to do, and where each is handled:

| Behaviour | Where |
|---|---|
| Hardware back / back gesture goes up a screen | `App.vue` mirrors `screen` into the History API; a modal gate swallows the press instead of dismissing the screen under it |
| Keyboard doesn't cover the composer | `android:windowSoftInputMode="adjustResize"`, plus a re-stick to the bottom on focus so the message you're replying to doesn't slide behind it |
| Reconnect when you come back to the app | `visibilitychange` in `App.vue` — Android freezes the WebView and the SSE connection does not survive it |
| Jump to latest when scrolled up | `.to-bottom` in `ChatScreen.vue`, shown only when parked away from the bottom |
| Touch targets ≥ 44px | audited across both screens; the code-copy button extends its hit area with a pseudo-element since it can't grow inside a code block |
| System bars match the page | `styles.xml` — dark status and navigation bars, light icons, `postSplashScreenTheme` so the real theme actually applies |
| No white flash on launch | splash is a solid `appBackground`; the template's default splash PNGs were deleted |
| Text is selectable where it should be | `user-select: none` globally, opted back in for message bodies and inputs |
| No double-tap zoom or tap-highlight flash | viewport meta plus `touch-action: manipulation` |
| Safe areas | `viewport-fit=cover` and `env(safe-area-inset-*)` on every screen edge |

Back deserves a note: a WebView with no history entries sends the system back
straight to "close the app", so opening a chat and swiping back **quit the app**
rather than returning to the list. `screen` remains the source of truth and
history only mirrors it. `boot()` re-syncs the stack explicitly, because restoring
the last chat sets the screen while the watcher is suppressed — without that, a
restored chat had no list behind it and back closed the app again.

## What was left out, and what that costs

Cut because a phone is not where you do it: providers and TrueFoundry, usage
totals, sub-agent management, saved-permission review, the command palette, the
handover brief, file preview and annotation, the find bar, revert, model and agent
pickers, theming.

Cut because it cannot work: **everything reached over PTY** — git branch, `@` file
mentions, `/` local commands, sub-agent definitions, remote file read/write. Not a
CORS problem; those need a shell on the target and a WebSocket per command, which
is a poor fit for a device that suspends the moment it is pocketed. The app inherits
whatever agent and model the session already has, which is why there is no picker.

Known gaps worth naming:

- **The password is in `localStorage`**, as on the desktop. On a sideloaded app
  that is app-private storage, so it is roughly a saved password in a browser —
  fine for this, not fine if the app is ever shared.
- **"Allow always" cannot be revoked from the phone.** It writes a persisted
  server-side rule; the list that revokes it is a desktop screen. It stays
  available anyway, because approving every file read one at a time on a phone is
  unusable.
- **No background execution.** Android suspends the WebView when the app is
  backgrounded, so the SSE stream drops and reconnects on return. The run keeps
  going server-side — `GET /session/active` is what the app trusts on reconnect —
  so nothing is lost but live updates while away.
- **No push notifications.** A finished turn is visible when you open the app.
- **The proxy's port (47653) is fixed**, because `capacitor.config.json`'s
  `server.url` names it at build time. Nothing else should be on it; if something
  is, the app fails to start and says so in logcat.
