# Physical receipts — prefilled

Companion to [PHYSICAL-ACCEPTANCE-RUNBOOK.md](PHYSICAL-ACCEPTANCE-RUNBOOK.md), which remains
authoritative on what passes. This file exists so the tester never has to work out how to reach a
screen: everything a machine could fill in is filled in, and the blanks are only the observations a
person has to make.

Ordered to minimise setup changes — both phones once, then both people once, then the screen reader.

## Before you start

```bash
cd /Users/km/Desktop/games/101
npm run build      # note the build id it prints
npm run start      # production server, port 3000
```

| Field | Value |
| --- | --- |
| Commit | `ae60272` |
| Build id | printed by `npm run build` as `Stamped dist/client/sw.js with build <id>` — the run this file was prepared against was `12d6a0b382d026cd`; **write down the one your build prints** |
| Laptop URL | `http://127.0.0.1:3000/` |
| Phone URL | `http://192.168.0.143:3000/` — the laptop's address on this network. Re-check with `ipconfig getifaddr en0` if it has moved; both phones must be on the same Wi-Fi. |

A phone camera will not start over plain `http://` on a LAN address, because getUserMedia requires a
secure context. That affects only the **phone** inference case (E2); everything else on a phone is
touch and networking and works over http. The laptop is `127.0.0.1`, which counts as secure, so the
laptop camera cases are unaffected.

Fill one row per attempt. A skipped case stays pending — it does not become a pass.

| Field | Record |
| --- | --- |
| Tester, date | |
| Browser + version | |
| OS + version | |
| Device model | |
| Result | pass / fail / pending |
| If failed, what you saw | |

---

## Block A — Both phones, one setup (runbook §"Phone controller and touch")

Have the iPhone and the Android phone on the same Wi-Fi. On the laptop open
`http://127.0.0.1:3000/` and start any game, then use the pairing action it shows.

### A1 · Pair and drive — iPhone

| Step | Expected | Observed |
| --- | --- | --- |
| Open `http://192.168.0.143:3000/controller` and pair | A role is assigned; controls replace the "Ready to connect" panel | |
| Perform the role's basic actions | The game on the laptop visibly responds | |
| Rotate to landscape, then back | Every required control stays reachable; nothing is cut off; no page scrolling | |
| Switch apps, then return | Reconnects to the same session, or shows a visible recovery path | |
| Press and release, then switch away mid-press | No action stays held | |

### A2 · Pair and drive — Android
Same five steps as A1.

### A3 · Haptics — both phones

| Step | Expected | Observed |
| --- | --- | --- |
| Press a face button | A short tick | |
| Step the d-pad | A lighter tick than the button | |
| Trigger a warning/impact cue from the game | Clearly different from both | |
| Overall | The three are **distinguishable by feel**, not just by code | |

The three patterns are implemented and differ in `app/controller/Controller.tsx` (`LOCAL_HAPTICS`).
Whether a human can tell them apart on real hardware is exactly what is unverified.

### A4 · Installed controller PWA — one phone (runbook §"Installed controller update and offline recovery")

Do this while the phones are already out.

| Step | Expected | Observed |
| --- | --- | --- |
| Open the controller URL and use the browser's "Add to Home Screen" | It offers to install, and the name is **101 Link** (not "101") | |
| Open the installed app | Runs without browser chrome | |
| Keep it open. On the laptop: `npm run build` again, note the new build id, restart `npm run start` | — | |
| Open a second controller page so the update can download | — | |
| With the first page still open, turn the phone's networking off | The open controller and its assets still work | |
| Reopen the installed app | It comes up on the newer build | |

**Read this before A4.** Until commit `ae60272` the manifest link was rendered into the page body
instead of the head, so no browser applied it and the controller was not installable at all. That is
fixed and asserted in `tests/rendered-html.test.mjs`, but the fix has only been verified as
"the right link is in the head". Whether iOS and Android actually offer the install is this case's
whole point, and it has never been observed on a device.

---

## Block B — Two people, one camera setup (runbook §"Camera walkthrough and two-person games")

Laptop only, at `http://127.0.0.1:3000/`. Phones not needed. Do B1–B3 alone, then bring the second
person in for B4.

### B1 · The happy path, BodyDodge then Shadow Arena

| Step | Expected | Observed |
| --- | --- | --- |
| Choose the camera option; allow permission | Setup opens on "Camera" | |
| If more than one camera, pick each in turn | The preview changes | |
| Follow the placement step | The frame fills in when you are standing correctly | |
| Raise both hands above your head | It advances to "Ready" | |
| Play a run, then restart | Camera still tracks after restart | |

### B2 · Every way it can go wrong

| Step | Expected | Observed |
| --- | --- | --- |
| Deny camera permission | "The browser didn't give us the camera" + how to allow it | |
| Choose retry, then allow | Setup continues from the camera step | |
| Unplug / disable the camera **during setup** | A message naming what happened, and a way back | |
| Unplug it **during a game** | The game says the camera stopped; it does not silently freeze | |
| Finish setup with a chosen camera, disconnect it, start a new run | Falls back to another camera rather than failing | |
| Cover the lens | "We can't see anything through the camera" | |
| Turn the lights down | "It's too dark in here to see you" | |
| Stand with a bright window behind you | "The light behind you is too strong" — **not** the too-dark message | |

The last two are worth doing carefully. Backlighting is the most common bad camera in a home and it
is the one a brightness threshold alone gets wrong, so it has its own message and its own arithmetic.

### B3 · The eight-second alternative

| Step | Expected | Observed |
| --- | --- | --- |
| Reach the confirmation step and wait without doing the gesture | After about 8s it offers a step to either side | |
| Take a step sideways | It confirms | |
| Walk out of frame, then take a step | It does **not** confirm — it returns to the check | |

### B4 · Two people (second person joins here)

| Step | Expected | Observed |
| --- | --- | --- |
| Both stand in frame | Two distinct numbered players | |
| Cross over each other | Numbers do **not** swap | |
| One leaves, then comes back | Same number as before | |
| A third person steps in | Handled without scrambling the first two | |
| Play a run through all of that | Controls stay with the intended person | |

### B5 · Camera off, conventional controls

| Step | Expected | Observed |
| --- | --- | --- |
| Play each game once with its keyboard/gamepad fallback | Fully playable without a camera | |
| At the end of a run | The result is announced and focus lands on **Play again** | |

---

## Block C — Screen reader (runbook §"Keyboard and screen reader")

The keyboard-only half has been walked locally: focus is visible on every control on the launcher
(`:focus-visible`, solid 2px outline), and the camera setup has a focus target per beat with
keyboard cancel, skip and retry. That is pre-flight, not this case.

| Step | Expected | Observed |
| --- | --- | --- |
| Turn on VoiceOver or NVDA. Record which, and the browser | — | |
| Move through the chooser | Headings and options announced in a usable order | |
| Choose the camera option | The camera option is offered, not hidden | |
| Move through every setup beat | Placement guidance, failures, retry, skip and the alternate step are all announced | |
| Pick a conventional control path instead | Possible at any point | |

---

## Block D — Laptop inference (runbook §"Inference and throttling")

### D1 · 120 samples, laptop body camera

Studio → Vision Lab → enable the body camera → wait for **Samples** to reach 120.

| Field | Record |
| --- | --- |
| Camera used | |
| Mean / median / P95 / range | |

One receipt is one source and one run: the readout resets when the mode or the source changes.

### D2 · Fourfold CPU throttle, laptop

Open the browser's performance tools, set CPU throttling to 4x, then run the body-camera walkthrough.

| Field | Record |
| --- | --- |
| Throttle profile | 4x CPU |
| Completed placement? | |
| Completed a real gesture confirmation? | |
| Vision Lab distribution under throttle | |

---

## Block E — Phone inference (runbook §"Inference and throttling")

### E1 · 120 samples, phone body camera — **read the note first**

A phone reaching the laptop over `http://192.168.0.143:3000` is not a secure context, so the phone's
camera will not start there. Before recording this case you need one of:

- the site served over https on the LAN with a certificate the phone trusts, or
- a tunnel that terminates TLS, which is a form of publishing and is **not** permitted here without
  the owner's say-so, or
- the phone's browser configured to treat that origin as secure.

Whichever you choose, record it in the receipt — it is part of the environment.

| Field | Record |
| --- | --- |
| How the origin was made secure | |
| Device model | |
| Mean / median / P95 / range | |

---

## What is already closed, and by what

| Case | Status |
| --- | --- |
| Production Lighthouse audit of the launcher | **Closed.** [LIGHTHOUSE-2026-09-12.md](LIGHTHOUSE-2026-09-12.md) — Performance 67, Accessibility 100, Best Practices 96, SEO 100, with the full environment recorded. |
| Controller layout across landscape and portrait | **Pre-flight only.** Emulated viewports at six landscape and two portrait sizes; see [CONTROLLER-UX.md](CONTROLLER-UX.md). An emulated viewport is not a phone. |
| Controller on real iOS Safari, unassigned state | **Pre-flight only.** iPhone 17 simulator: connection guidance shown, no inactive controls, content clear of the Dynamic Island. A simulator is not a phone, and it cannot receive a role from the laptop's lab, so the deck itself was not reachable there. |
| Keyboard focus visibility on the launcher | **Pre-flight only.** Real Tab presses; every control reports `:focus-visible` with a solid 2px outline. |
| Everything else in this file | **Pending.** Needs the device, the second person, or the screen reader named in its block. |
