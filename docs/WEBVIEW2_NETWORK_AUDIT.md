# WebView2 and runtime network audit

Date: 2026-09-12. Build tested: Vellum 0.4.0 (`0.4.0+f0bc670`), the release build in `dist\Vellum` (the same
files as the published installer). A practical runtime test: the app was run, driven through every
phase, and everything it and its WebView2 runtime did on the network was recorded.

## Summary

- **Document processing is local.** Opening, rendering (a 173-page PDF), editing and saving worked in
  every run, including one where WebView2 could not resolve any hostname and Vellum's updater had no
  working connection. No document content, file name or path appeared in anything that was sent.
- **Vellum's own code connects only to GitHub, and only for updates** (`Vellum.exe` → `api.github.com`,
  seen only during the update check).
- **The WebView2 runtime connects to Microsoft on its own** whenever Vellum runs: SmartScreen checks
  Vellum's own start page, Edge's configuration service, the component updater (checks plus downloads
  through Windows BITS), and two connections from the runtime's browser process to
  `substrate.office.com` whose purpose isn't documented. None of it is needed for Vellum to work.
- **One lookup is caused by Vellum's design:** at each launch WebView2 asks DNS for `app.vellum` (Vellum's
  internal origin) before Vellum serves the page itself. It carries no user data and fails (NXDOMAIN).
- The claim "local-first/offline for document processing, with GitHub used only for the in-app updater"
  is accurate about documents and about Vellum's code, but needs one clarification about WebView2
  (see the last section).

## Test environment

| | |
|---|---|
| OS | Windows 11 Pro, build 26200 |
| WebView2 Runtime | 152.0.4191.66 (Evergreen, per machine) |
| WebView2 SDK in Vellum | 1.0.4191.47 |
| Vellum | 0.4.0+f0bc670, Release, self-contained .NET 10 |
| Policies | No WebView2 or Edge group policies set |
| Windows diagnostic data | Optional (`AllowTelemetry` = 3); not changed |
| Network | Home LAN, DNS through the router (192.168.1.1), no IPv6 |
| Account | Standard user, not elevated |
| Vellum updates | Automatic check switched off in this user's settings; one manual check was triggered in run 3 |

## How traffic was observed

Nothing in Vellum or in Windows was changed. All instrumentation was set through environment variables
on the test process only.

- **WebView2's own network log (Chromium NetLog)**, enabled with
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--log-net-log=<file>`. It records every hostname lookup, request
  and connection made by WebView2's network stack, with the "traffic annotation" of the feature that made
  it. In runs 3 and 5 the `Everything` capture mode also recorded the plaintext of what was sent (before
  TLS), which was searched for document data.
- **A socket monitor**, polling every ~150 ms, recorded every TCP connection and UDP socket owned by
  `Vellum.exe` and by every `msedgewebview2.exe` of the test profile, and their child processes. This catches
  traffic that doesn't go through Chromium: .NET's `HttpClient` or Windows' HTTP stack.
- **Supporting evidence:** the Windows DNS cache, polled every ~1.5 s (to name IP addresses); BITS jobs
  created in the user's account; processes started anywhere on the PC; the modules loaded in the WebView2
  browser process (to rule out injected third-party code).
- **Isolation:** each run used its own scratch WebView2 profile (`WEBVIEW2_USER_DATA_FOLDER`), never the
  user's. Test PDFs were copies in a scratch folder. The app was driven over a loopback DevTools port
  (9222), which exists only in these tests.

**Limitations.**
- There was no packet capture, because it needs admin rights. So the content and TLS server name of
  connections made outside Chromium's stack (the `substrate.office.com` pair) couldn't be seen.
- Such connections shorter than ~150 ms could be missed. Chromium's own traffic has no such gap.
- Activity of Windows services or other apps isn't attributed to Vellum, except BITS jobs created during
  the run by WebView2's component updater.
- One PC and one runtime version. WebView2's behaviour can change with runtime updates, Windows settings
  and policies.

## Tests performed

| Run | Scenario | Result |
|---|---|---|
| 1 | Fresh profile (stopped at the edit step: a bug in the test script, not the app) | Consistent with run 2; not used further |
| 2 | Fresh profile (first use): start → Home 120 s → open a 173-page PDF → render every other page → edit a line → save → idle 20 s → close | All steps passed |
| 3 | Warm profile (second use): as run 2, plus a manual update check and 180 s idle with documents open; plaintext capture | All steps passed |
| 4 | Offline simulation, fresh profile: every WebView2 hostname unresolvable (`--host-resolver-rules="MAP * ~NOTFOUND"`), Vellum's HTTP pointed at a dead proxy (`HTTPS_PROXY=http://127.0.0.1:9`) | All steps passed; the update check failed with its normal "Couldn't reach GitHub" message |
| 5 | Double-click, fresh profile: the PDF passed on the command line at launch; plaintext capture | All steps passed |

Not run: a build with SmartScreen switched off (recommendation A below). Building it was blocked by
this session's safety checks, so that recommendation's network effect is untested.

## What happened in each phase

Seconds are measured from launch; runs 2, 3 and 5 agree.

| Phase | Observed |
|---|---|
| Starting (0–3 s) | Edge configuration requests (+0.8 s); SmartScreen check of `https://app.vellum/index.html` (+2.8–3.0 s); DNS lookup of `app.vellum` (+0.06 s); proxy auto-discovery (`wpad`) on the LAN; the browser process opens two connections to `substrate.office.com` (+2.7–3.4 s, open about 108 s) |
| Home screen, idle | SmartScreen settings and telemetry (+3.3–3.7 s); component-update checks from +60.8 s; 4–6 component downloads through BITS (+61 to +146 s) |
| Opening a local PDF | Nothing new |
| Rendering pages | Nothing |
| Editing | Nothing |
| Saving | Nothing (run 2's update checks that fell in this phase were on the updater's own timer) |
| Manual update check | `Vellum.exe` → `api.github.com:443` (run 3 only) |
| Closing | Nothing new; connections close; no request started during or after exit |

No traffic is triggered by opening, rendering, editing, saving or closing. WebView2's traffic follows
the runtime's own timers from the moment it starts. Opening a PDF at launch (run 5) produced the same
startup traffic as starting on the Home screen.

## Observed connections and destinations

| # | Destination | Made by | What it is | Category | Started by Vellum? | Needed by Vellum? |
|---|---|---|---|---|---|---|
| 1 | `config.edge.skype.com` `/config/v1/Edge/152.0.4191.66` (4 GET) | WebView2 network service | Edge configuration and experimentation service (feature settings for the runtime). Sends a client ID, OS version, `client=webview`, channel | WebView2 runtime behaviour | No | No |
| 2 | `nav-edge.smartscreen.microsoft.com` `/api/browser/edge/navigate/3` (2 POST) | WebView2 network service | Microsoft Defender SmartScreen reputation check of the page being opened: Vellum's own start page. Sends its address, page title ("Vellum"), favicon address, user agent, a device GUID and a device identity ticket | Windows security (SmartScreen) | Indirectly: Vellum's navigation to its own page triggers it | No |
| 3 | `data-edge.smartscreen.microsoft.com` `/api/browser/edge/data/settings/3` | WebView2 network service | SmartScreen settings and list refresh | Security | No | No |
| 4 | `telem-edge.smartscreen.microsoft.com` `/api/browser/edge/telemetry/3` | WebView2 network service | SmartScreen telemetry | Security / diagnostics | No | No |
| 5 | `edge.microsoft.com` `/componentupdater/api/v1/update` (10–14 POST) | WebView2 network service | Component update checks (component IDs, versions, update cohort) | Runtime updates | No | No |
| 6 | `msedge.b.tlu.dl.delivery.mp.microsoft.com` `/filestreamingservice/files/…` | Windows BITS service, in jobs named "Edge Component Updater" created in the user's account | Component downloads. The profile then holds CertificateRevocation, PKIMetadata, SmartScreen, Trust Protection Lists, Subresource Filter, OriginTrials, hyphenation data, Speech Recognition and others | Runtime updates, including security data | No | No |
| 7 | `substrate.office.com` (CNAME `shed.outlook.acdc.tm.svc.cloud.microsoft`, 40.104.x.x), 2 TCP connections | The WebView2 **browser process**, through Windows' HTTP stack (WinHTTP/WinINet), not Chromium's; absent from NetLog, and still made when Chromium's DNS was blocked | Not documented. Content not visible (TLS, outside NetLog). The process loads only Microsoft/runtime modules, including the runtime's `telclient.dll` | WebView2 runtime behaviour; purpose could not be determined (plausibly diagnostics or service configuration) | No | No |
| 8 | DNS lookup of `app.vellum` (A and HTTPS queries to the router, one more through Windows' resolver) → NXDOMAIN from the root servers | WebView2 network service | At the first navigation, WebView2 prepares a normal connection for Vellum's internal origin before Vellum's handler serves the page. About 65 page requests per run were all served in-process | Caused by Vellum's choice of origin name | Yes, indirectly | No |
| 9 | DNS `wpad` and WPAD via DHCP | WebView2 network service | Windows proxy auto-discovery ("Automatically detect settings") | Windows / WebView2 proxy behaviour, LAN only | No | No |
| 10 | UDP "connect" to `2603:1020:201:10::10f:443` | WebView2 network service | IPv6 reachability probe: a socket is connected, no packet is sent | Runtime behaviour | No | No |
| 11 | `api.github.com` (TCP 443) | `Vellum.exe` (.NET `HttpClient`) | Vellum's updater, only when checking for updates | Update-related | Yes | Only for updates |

**Not observed:**
- no traffic from the renderer or GPU processes;
- no traffic caused by a PDF: pdf.js loads its worker, fonts, CMaps and wasm from `app.vellum`, served in-process;
- no connections from the Vellum process tree to `*.events.data.microsoft.com`;
- no crash uploads: the runtime's crash handler runs, but uploads only after a crash.

## What was sent

Runs 3 and 5 recorded all plaintext WebView2 sent. It was searched for:
- the test file names;
- the edited text;
- the Windows user name, `Documents`, the scratch folder name;
- `.pdf` and `%PDF`.

**None were found.** The only Vellum-specific data is what SmartScreen receives: the start-page
address, the page title "Vellum" and the favicon address, together with a device GUID and a device
identity ticket. So Microsoft can see that Vellum was started on this device, but not what it opened.
Vellum's page title is fixed ("Vellum" in `index.html`) and its address never contains a file name.
A PDF opened at launch (run 5) didn't change what was sent.

## What Vellum can and cannot control

### Can control (documented WebView2 settings, Vellum only, no system change)

**A. SmartScreen inside Vellum's WebView**: set `CoreWebView2Settings.IsReputationCheckingRequired = false`.
The setting is available in the SDK Vellum uses. It would remove items 2–4. That effect is **not yet
verified**; see "Tests performed".

- **Security trade-off:** SmartScreen protects the WebView against malicious sites and downloads. Vellum's
  WebView only ever shows Vellum's own bundled page:
  - any other navigation is cancelled and opened in the user's browser, which applies its own SmartScreen;
  - the WebView downloads nothing (saving goes through Vellum's host).
- So here SmartScreen only ever evaluates Vellum's own start page. Windows SmartScreen for downloaded
  files and apps, and Microsoft Defender, are unaffected.
- **Exact change:** in `MainWindow.InitializeWebViewAsync`, next to the other `settings.*` lines and
  before the first `Navigate`, add `settings.IsReputationCheckingRequired = false;`. The setting applies
  to the whole WebView2 profile folder. Then re-run this audit.

**B. Tracking prevention**: set `CoreWebView2EnvironmentOptions.EnableTrackingPrevention = false`.

- Microsoft documents this as appropriate when an app only renders content known to be safe. It is a
  browsing-privacy feature with nothing to do on local content.
- Its effect on traffic wasn't measured, and the component updater may keep fetching the lists anyway.
  Optional; not a network fix by itself.

**C. The `app.vellum` lookup** (item 8) comes from Vellum's choice of origin name.

- **Keep it:** it's harmless, a fixed name that fails, with no data.
- **Or, in a later release:** serve Vellum's page through a WebView2 custom scheme
  (`CoreWebView2CustomSchemeRegistration`), which isn't resolved through DNS. This changes the page's
  origin, so the appearance settings kept in `localStorage` would need migrating. Module loading would
  need re-testing, and the change would need this audit re-run.
- Adding a hostname-blocking rule instead would only hide the symptom, so it isn't recommended.

**D. The updater** already has its own setting. Its default (on for new installs) is a separate open
decision.

### Cannot responsibly control (Windows / WebView2)

- Edge's configuration service (1), component updates and BITS downloads (5, 6), the
  `substrate.office.com` connections (7), SmartScreen's list refresh while SmartScreen is on (3),
  proxy auto-discovery (9) and crash reporting have **no documented WebView2 setting**.
- Chromium command-line switches such as `--disable-component-update`, `--disable-background-networking`
  and `--no-proxy-server` exist, but they aren't supported WebView2 settings and can change without
  notice.
- The component updater also delivers security data: the certificate revocation list, PKI metadata and
  SmartScreen lists. So using those switches is **not recommended**.
- This behaviour is governed by the runtime itself, by Windows' diagnostic-data settings, and by
  WebView2/Edge group policies set by the PC's owner or IT. Vellum shouldn't change any of those.

## Recommended action

**Decision (2026-09-12):** the findings are accepted and WebView2 stays exactly as it is. SmartScreen
stays on, no unsupported switches are used, and no Windows settings are changed. The automatic updater
behaviour is unchanged. Options A–C above are not being implemented. The privacy wording is recorded
in ARCHITECTURE_GUIDELINES.md ("Offline and privacy").

The recommendations as made at the time of the audit:

1. **No change is needed for document privacy.** The offline-first design holds: documents never leave the PC.
2. **Decide on A** (SmartScreen in Vellum's WebView). Recommended as a small, separate change,
   verified by re-running this audit. It stops Vellum's start page, a device GUID and an identity ticket
   being sent to Microsoft at every launch, at very little security cost given Vellum's locked-down
   WebView. It is a security setting, so it needs explicit approval.
3. **Leave the WebView2 runtime's own traffic alone**, and describe it plainly in user-facing wording.
4. **Optionally, later:** move Vellum's internal origin to a custom scheme to remove the `app.vellum` lookup (C).
5. **Re-run this audit** after any change to the WebView2 setup, and after a major WebView2 runtime update.

## Can Vellum be described as "local-first/offline for document processing, with GitHub used only for the in-app updater"?

**Accurate, with one clarification.**

- **"Local-first/offline for document processing"** is true. The offline run proves every document task
  works without a network, and no document data was found in any traffic.
- **"GitHub used only for the in-app updater"** is true of Vellum's own code. But the sentence can be read
  as "the only internet traffic is GitHub". That isn't true while Vellum runs, because the WebView2
  runtime contacts Microsoft on its own.

Suggested wording:

> Vellum processes your documents entirely on your computer: no document, file name or document content
> leaves your PC. Vellum itself goes online only to check for updates, from GitHub. Its display engine,
> Microsoft Edge WebView2 (part of Windows), makes its own connections to Microsoft, such as SmartScreen
> security checks and component updates, as it does in every app that uses it.

## Test hygiene

- Vellum wasn't installed, and the user's own copy wasn't running (each launch was guarded).
- No Windows setting, policy or firewall rule was changed. No production code was changed.
- Every run used a scratch WebView2 profile; the user's own WebView2 profile wasn't used.
- Test PDFs were copies in a scratch folder.
- Test files were taken off the recent list with Vellum's own `recent.remove`. Run 1 stopped early, so
  its two entries were removed afterwards the same way. The recent list is back to its three earlier
  entries.
- Vellum wrote one thing itself: the manual update check in run 3 set `lastUpdateCheck` in its settings.
  The automatic-check setting stayed off.

## Reproducing this audit

Set these variables for the test process only; they change nothing permanently:

```
WEBVIEW2_USER_DATA_FOLDER=<scratch profile>
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 --log-net-log=<file> [--net-log-capture-mode=Everything]
```

- **Offline simulation:** add `--host-resolver-rules="MAP * ~NOTFOUND"` to the WebView2 arguments, and set
  `HTTPS_PROXY=http://127.0.0.1:9` for `Vellum.exe`.
- **Scripts:** the monitor, driver and analyser used here are kept outside the repository, in the session's
  scratch folder. They can be added under `tools/` if wanted.
