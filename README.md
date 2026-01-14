# Environment variables (Next.js)

Create a file called `.env.local` in the project root and set:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Owner/admin (server-only):
- `OWNER_EMAIL` (your email address)
- `SUPABASE_SERVICE_ROLE_KEY` (Supabase Project Settings → API → service_role key)

# Choir Practice Tool

Ett webbaserat övningsverktyg för körsångare byggt med React, TypeScript och Vite.

## Kom igång

### Installation

```bash
npm install
```

### Utveckling

# Choir Practice Tool

A browser-based practice tool for choir singers, built with React + TypeScript + Vite.

Summary
- Display MusicXML / MXL scores and follow a playhead
- Playback with tempo control
- Microphone-based tuner/feedback with latency compensation
- Automatic latency calibration (speaker or headphones)
- Lightweight runtime benchmarks for the detection loop

Key features
- Score rendering in `#score-container` using OpenSheetMusicDisplay
- Playback and voice mixing via `ScorePlayer`
- Pitch detection in `src/audio/pitchDetection.ts` (switchable backend via env flag)
- Latency calibration utilities in `src/audio/latencyCalibration.ts` (speaker and headphone flows)

Quick start

1. Install dependencies

```bash
npm install
```

2. Start development server

```bash
npm run dev
```

Pitch detector selection (A/B testing)
- Default: `pitchy`
- To force NACF: set `VITE_PITCH_DETECTOR=nacf` before starting Vite (then restart dev server)

3. Open your browser at http://localhost:5173

Important files
- `src/components/ScorePlayerPage.tsx` — main UI and detection loop
- `src/audio/pitchDetection.ts` — pitch detection implementation (detectPitch)
- `src/audio/latencyCalibration.ts` — calibration helpers (speaker/headphones)
- `src/audio/ScorePlayer.ts` — audio playback and mixing

Supported input formats
- `.mxl` (zipped MusicXML)
- `.xml`, `.musicxml`

Usage notes
- Grant microphone permission when prompted.
- Load a MusicXML/MXL file using the file picker.
- Toggle the microphone with the "Aktivera mikrofon" button to enable tuner feedback.
- Use "Kalibrera (högtalare)" or "Kalibrera (hörlurar)" under Latency Compensation while the mic is active to auto-calibrate latency.

Performance and troubleshooting
- `ANALYSIS_INTERVAL_MS` and `FFT_SIZE` (in `ScorePlayerPage.tsx`) control analysis frequency and window size — these affect CPU usage and responsiveness.
- Current optimizations:
	- Reuse of internal Float32/Float64 buffers to avoid per-tick allocations
	- Per-voice index tracking to locate the current note in amortized O(1) time
	- `detectPitch` accepts an optional workspace for preallocated buffers to reduce GC pressure
- If the tuner shows "No stable pitch detected", verify mic access and that the input signal is strong enough.

Development tips
- For lower main-thread CPU load at high tempos, consider moving `detectPitch` to a WebWorker or AudioWorklet.
- For quick debugging, reduce `analyser.smoothingTimeConstant` in `handleMicToggle`.

AudioWorklet requirement
- Pitch detection now relies on **AudioWorklet only** (no Analyser/polling fallback). If the mic cannot be activated, verify that the browser supports AudioWorklet and that the page is served over HTTPS (or localhost).

License & contributing
This project is licensed under the GNU General Public License version 2 (GPL v2). Non-profit use is free provided the users comply with the terms of the GPL v2. If you or your organization want to use this code commercially (i.e., make money from it) and do not wish to comply with GPL v2, please contact babylonwizards@gmail.com to negotiate a commercial license.

See `LICENSE.md` for more information and the author's commercial license contact.

---
Updated: English README with usage, dev notes, and file locations.
npm install
```

2. Starta utvecklingsserver

```bash
npm run dev
```

3. Öppna webbläsaren på http://localhost:5173

Filer och var saker finns
- Huvudkomponent: src/components/ScorePlayerPage.tsx
- Pitch-detektion: src/audio/pitchDetection.ts
- Latency-kalibrering: src/audio/latencyCalibration.ts
- Score/Audio playback: src/audio/ScorePlayer.ts

Stöd för filformat
- .mxl (zippat MusicXML)
- .musicxml eller .xml

Vanliga åtgärder
- Ge webbläsaren tillgång till mikrofon när du uppmanas
- Ladda en MusicXML/MXL-fil via "Välj MusicXML/MXL-fil"
- Aktivera mikrofonen (`Aktivera mikrofon`) för tuner/feedback
- Använd `Kalibrera (högtalare)` eller `Kalibrera (hörlurar)` i Latency-kompensation (kräver att mikrofon är aktiv)

Prestanda och felsökning
- Analysintervallet och fönsterstorleken påverkar både latens och CPU. Se `ANALYSIS_INTERVAL_MS` och `FFT_SIZE` i `ScorePlayerPage.tsx`.
- För bättre prestanda vid höga tempo har projektet följande optimeringar:
	- Återanvänder interna buffrar istället för att allokera varje tick
	- Per-stämma indexspårning för målval (amortiserad O(1))
	- `detectPitch` kan nu återanvända workspace-buffrar för fönster och prefix-energi
- Om mikrofon visar "Ingen stabil pitch detekterad": kontrollera att mic-tillståndet är aktiverat i webbläsaren och att gain/omgivningsljud är tillräckligt.

Utvecklingstips
- Vill du flytta pitchdetektering av huvudtråden? Överväg WebWorker eller AudioWorklet för realtidskrav.
- För snabb debugging kan du minska `analyser.smoothingTimeConstant` i `handleMicToggle`.

Licens & bidrag
Det här är ett personligt projekt — inga särskilda licensvillkor medföljer här. Önskar du bidra, öppna en PR eller diskussion.

---
Uppdaterad: kort sammanfattning av nuvarande funktionalitet och var i koden funktionerna finns.
