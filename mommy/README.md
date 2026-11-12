# Mommy: a recitation and dictation tutor (prototype)

Mommy is a web prototype of a tutor that stands in for a parent while a child (6 to 18
years old) practises school lessons in **Arabic, English or French**:

- **Prepare a page.** The parent photographs a textbook page (read by Claude when it is
  configured) or types or pastes the text, then confirms it.
- **Recite.** The child reads the text aloud. *Strict* mode checks it word by word;
  *contextual* mode checks that the meaning is right. Mistakes are highlighted and the
  feedback can be spoken.
- **Dictation.** The app reads the text out slowly, one phrase at a time, and the child
  writes on paper. The parent then photographs the page or types what the child wrote.
  The result goes to the parent to confirm before the child sees it.
- **Quran.** A separate section for Quran recitation (Hafs), checked strictly against
  the verbatim Tanzil text, with a "where am I?" search for recitation from memory.
  It uses no AI model and no synthetic voice.

It is an AI, not a person, and the app says so at the start of each session.

How it works, in one paragraph: the browser records 16 kHz WAV and resizes photos; the
FastAPI backend (`backend/mommy`) runs speech recognition locally (Whisper through
sherpa-onnx), compares words with deterministic code (`align.py`), and speaks with local
Piper voices. Claude, when configured, only reads images, judges meaning in contextual
mode and words the feedback. Module boundaries, the HTTP API and the hard rules are in
[`docs/CONTRACT.md`](docs/CONTRACT.md).

## Privacy rules

- **The recogniser is never given the expected text** (no prompt, no hotwords). Whether
  a word is wrong is decided by code, never by an AI model.
- **Handwriting is read blind.** The model that reads the child's paper is never shown
  the expected text; code compares, and the parent confirms.
- **Audio and photos stay in memory.** Uploads are never written to disk: request bodies
  are size-limited before they are parsed, and the upload parser's spill-to-disk
  threshold is raised above that limit (checked by `tests/test_api.py`). They are never
  logged; of an upload, the logs carry only its size, duration and timings.
- **Photos are cleaned.** The browser resizes them (long edge at most 2000 px) and
  re-encodes them as JPEG, which drops EXIF data such as a GPS position. The server
  decodes and re-encodes every image again, in memory, as a new JPEG of at most 2000 px
  with no metadata at all (EXIF, XMP, IPTC, ICC profile, comments, PNG text, data after
  the image), so a client that bypasses the web page cannot pass any on either.
- **Local by default.** The server listens on `127.0.0.1` only, answers only to its own
  host names (`MOMMY_ALLOWED_HOSTS`, default `127.0.0.1,localhost,::1`, which blocks
  DNS-rebinding pages) and refuses cross-origin writes to the API and framing by other
  sites. The web client makes no external requests: no analytics, no third-party
  scripts, no web fonts from CDNs. Putting it online is a separate, deliberate step,
  behind an access code ("Run it online" below).
- **Claude is optional.** Only when it is configured are page photos, handwriting photos
  and texts sent to the Claude API, and only after the parent ticks the AI consent box: a
  box of its own under the notice of what goes to Claude, shown only while Claude is
  configured. The notice names everything Claude gets (the photos, the page text and a
  transcript in meaning mode, the words the child got wrong with the score, the
  language and the child's age band); when it changes, every family is asked again. A
  consent given while Claude was not configured never covers it. The server decides it
  for each request: it calls Claude only for a request that carries `ai_consent=1`, which
  the web client sends only with a consent that counts; any other request (no consent,
  an older tab, another client) is answered without Claude. Until that box is ticked,
  reading photos stays off, and recitations and dictations are checked without Claude
  (fixed feedback templates; by meaning, only an approximate check). The Batch and
  Files APIs are never used.
- **Consent first.** A parent must tick a consent box before the camera or microphone is
  used. The family document (the children's nicknames, age bands and languages, their
  tasks, stars and rewards, the consent and the hashed parent PIN) is kept in the
  browser's `localStorage` (`mommy.data.v2`) on this device only; there are no accounts.
  It holds scores, never recordings, photos or what the child said. "Save a copy" (parent
  area, Settings) writes the family part of it to a file, made in the browser and never
  sent to the server, without the PIN record or any consent, where the browser saves
  downloads (usually the Downloads folder; on an iPhone the Files app, which may be
  iCloud Drive). The family data line of the app says so too (`fam_privacy_line`).
- **Quran.** Text comes only from the verbatim Tanzil files in `data/quran/`. No AI
  model and no synthetic voice is used on any Quran path, and feedback uses fixed
  templates. A text that *is* Quran (whole ayat, framing formulas and labels left out)
  is refused by the general endpoints (`422 quran_text`) and belongs to the Quran
  section. A school text that *includes* Quran keeps its **Quran parts**, which the
  server finds itself: they are checked word by word against the mushaf, read by a
  grown-up (never the voice) in a dictation, never judged by meaning, and their mistakes
  get fixed template feedback that is never written by Claude.

## Quick start

Requirements: Python 3.13, `curl`, `tar` with bzip2, about 1 GB of disk for the models,
about 5 GB of RAM with the three recognisers loaded (peaks stay under 6 GB), and a
recent browser.

```sh
cd mommy
python3 -m venv .venv
.venv/bin/pip install --require-hashes -r requirements.lock   # every package pinned and hashed
scripts/download_models.sh     # Whisper turbo (537 MB) + Piper voices ar/en/fr (64 MB each)
./run.sh                       # serves the API and the web client
```

Then open <http://127.0.0.1:8080>. Browsers allow the microphone on `127.0.0.1` and
`localhost` without HTTPS.

- `PORT=9000 ./run.sh` uses another port.
- `scripts/download_models.sh --small` also fetches Whisper small (609 MB); select it
  with `MOMMY_ASR_MODEL=small`. `--check` only checks that the download URLs answer.
  The script skips models that are already in `models/` (a symlink is fine).
- Turbo is the default recogniser: on a 4-core CPU it is as fast as small once loaded
  (about 1.5 s for a 5 s clip), and markedly better on Arabic and on French homophones
  (small heard "dort" as "d'or"); it needs about 1 GB more RAM per loaded language
  (server RSS about 5.0 GB with turbo, 3.2 GB with small). If the configured model's
  files are missing but the other model is present, the other one is used, logged, and
  reported by `/api/health` as `asr_model`.
- `requirements.txt` lists the direct dependencies; `requirements.lock` pins and hashes
  every package, and `requirements-runtime.lock` the same without the ones marked
  `# tests only` (what the container image installs). After changing `requirements.txt`,
  install it and run `.venv/bin/python scripts/lock_requirements.py` (it reads the
  hashes from PyPI and writes both; `--check` only compares).
- `GET /api/health` shows which parts are available.

### Speech synthesis needs espeak-ng

sherpa-onnx 2.x no longer bundles the espeak-ng phonemizer that the Piper voices need.
Without one, `/api/health` reports `"tts": false`, and the UI disables the spoken
dictation and spoken feedback. `requirements.txt` therefore installs
`espeakng-loader==0.2.4`, a wheel that bundles libespeak-ng 1.52 (GPL-3.0-or-later). It
was tested end to end here: all three voices speak, slow dictation phrases pass the
recogniser check, and `tests/test_speech.py` runs the espeak-ng back end. The system
library works too:

```sh
sudo apt install libespeak-ng1          # instead of the wheel
```

## Tasks and rewards

A parent gives each child study tasks and rewards (the full spec and every decision made
while building it are in [`docs/REWARDS.md`](docs/REWARDS.md)):

- **Setting it up.** On the first run the start screen is the family setup: the AI
  disclosure, the consent box (with Claude configured, also the AI consent box), the
  parent PIN (typed twice) and the first child
  (nickname, age band, language, avatar). After that, every session starts on "Who is
  learning?", with a small "For parents" button. In the parent area (behind the PIN) a
  parent adds children, creates tasks (recite, dictation or Quran, with a pass level,
  stars and an optional reward), reviews the tasks a child passed ("Confirm", or "Not
  yet" with a note), sets star goals, gives surprises, and changes the settings. A task
  is only marked done, and its stars and reward unlocked, when a grown-up confirms it.
- **The PIN is a child lock, not security.** It keeps the parent area for the grown-ups
  on a shared device: after 5 wrong tries it pauses (30 seconds, doubling up to 15
  minutes), "Forgot the PIN?" asks a multiplication question for grown-ups (wrong
  answers count toward the same pause) and keeps the old PIN until a new one is saved,
  and the parent area then shows that the PIN was reset. The parent area locks again
  when it is left, when the app goes to the background and after 3 minutes without use.
  Anyone who can open the browser's developer tools can read or change the data.
- **The family data stays in this browser on this device.** Everything is one document
  in `localStorage`, and the server stores none of it. What a check needs travels with
  it: to check a text or read it out, the Mommy server gets the text and its language,
  and for a recitation or dictation check also the child's age band; a Quran check sends
  the surah and ayat numbers instead. The server checks them in memory and keeps neither
  the texts nor the age band, but its log notes the language, the kind of check and the
  ayat numbers (the log of a `docker compose` install is kept, up to 30 MB). With Claude
  configured and the AI consent given, Claude also gets the language and the age band
  with the text or with the words the child got wrong (the Claude notice lists it all).
  Another browser, another device or a private window has its own (empty) data.
  **Clearing the browser's
  data for this site deletes it** (the children, tasks, stars and rewards), and so does
  "Delete all data on this device" in the parent area's Settings.
- **A copy of the family list.** The list belongs to one browser and one address (a
  quick tunnel's new address after a restart starts empty), so Settings has "Save a
  copy": a file `mommy-family-YYYY-MM-DD.json`, made in the browser (nothing is sent),
  with the children, tasks, stars and rewards, without the PIN's hash and salt and
  without any consent (a 4-digit PIN's hash is easy to break from a file, and a consent
  belongs to the address and the mode where it was given). It is not encrypted. Save a
  copy before a restart or an update, then load it at the new link: "Load a copy" on
  the first-run setup (the consents and a PIN are given there, as for a new family), or
  in Settings, which replaces this browser's list after showing what the copy holds
  (the PIN and the consents of this browser stay). A file that is not a copy, a damaged
  copy, one over 2 MB, one from a newer version or a copy with no child is refused with
  the reason; a loaded copy is checked like stored data. When the browser's storage is
  full, the copy is not used and the page says so.

## Offline mode

With no Claude configuration the app runs fully offline:

- the parent types the page text and what the child wrote (a photo of the child's
  writing gets `501 needs_manual`);
- contextual mode uses a content-word overlap heuristic, marked `"approximate": true`;
  Prepare and the task form say so under the mode choice ("Without the online AI, the
  meaning check is only approximate."), except for a text with Quran words, which is
  recited word by word only;
- feedback comes from fixed, age-adapted templates in each language.

If the Whisper or Piper files are missing, `/api/health` says so and the UI hides those
features; the server still starts.

## Enabling Claude

```sh
export ANTHROPIC_API_KEY=...       # your API key; never commit it
export MOMMY_VISION_MODEL=<a vision-capable Claude model id from the Claude docs>
export MOMMY_TEXT_MODEL=<a Claude model id from the Claude docs>
export MOMMY_EFFORT=low            # low (default), medium, high, xhigh or max
./run.sh
```

All three of the key and the two model variables must be set; otherwise the app stays
offline. Model ids are never written in this repository: pick current ones from the
Claude documentation. If a Claude call fails, the app falls back to the offline
behaviour for that request.

Output ceilings: `max_tokens` is 16000 for reading images and 4000 for text calls. On
current models adaptive thinking is on by default and its tokens count toward
`max_tokens` even when they are not returned, so lower caps could cut off a dense page
and force the offline fallback; the ceiling is not a cost (billing is for tokens used).
No `thinking` parameter is sent.

Other settings: `MOMMY_ASR_MODEL` (`turbo`, default, or `small`), `MOMMY_ASR_THREADS`
(default 4), `MOMMY_ALLOWED_HOSTS` (default `127.0.0.1,localhost,::1`),
`MOMMY_ACCESS_CODE` (unset by default: no access gate; see the next section),
`MOMMY_REQUIRE_ACCESS_CODE` (set in the container image: no start without a code),
`MOMMY_LOG_LEVEL` (default `INFO`), `PORT` (default 8080).

## Run it on your own computer and share it (Docker + Cloudflare)

The free way to let a friend use the app from anywhere: Docker Desktop (Windows, macOS
on Intel or Apple Silicon, or Docker on Linux) runs the same image as the Space below,
and a free Cloudflare quick tunnel (an `https://<random words>.trycloudflare.com`
address, no account) carries the HTTPS requests to it, behind the access code. In this
folder:

```sh
docker compose up -d --build                           # start (the first build downloads the models)
docker compose exec mommy python -m mommy.share_link   # the link to send: https://<name>.trycloudflare.com/#code=<code>
```

**[SELF_HOST.md](SELF_HOST.md)** has the exact steps for a non-expert (installing Docker
Desktop, memory, getting the files, daily use, a new code, troubleshooting, what leaves
the computer). The setup is `compose.yaml`: the app (`MOMMY_ACCESS_CODE_FILE`: the code
is made at the first start and kept in a Docker volume; `MOMMY_ALLOWED_HOSTS` with the
suffix entry `.trycloudflare.com`; its port only on `127.0.0.1:8080`, which asks for the
same code) and `cloudflared`, pinned by digest, whose metrics server tells `share_link`
the tunnel's address (it changes when the tunnel restarts; the code does not, but the
family data a friend's browser keeps is per address, so a new address starts empty
until the friend loads a copy of the family list saved before: save a copy before a
restart or an update, then load it at the new link).
`compose.test.yaml` is only for testing the kit without downloading the models (see its
header). Local use with `./run.sh` does not change.

**Always on, without your own computer: [deploy/oracle/ORACLE.md](deploy/oracle/ORACLE.md)**
runs the same kit for free on an Oracle Cloud "Always Free" Ampere VM (Ubuntu 24.04,
arm64), from signing up to the link, for Windows and Mac users: on the VM, one command,
`bash ~/mommy-app/mommy/deploy/oracle/setup.sh`, installs Docker, starts Mommy and prints
the link (the quick tunnel), and `--stable` switches to a permanent
`https://<IP with dashes>.sslip.io` link served by Caddy with a Let's Encrypt
certificate.

## Run it online (Hugging Face Spaces)

To let a friend use the app from anywhere, it can run as a Hugging Face Docker Space,
behind an access code. Local use does not change: `./run.sh` still listens on
`127.0.0.1` only, with no gate.

**First, the plan.** Hugging Face's documentation says that creating a Docker Space needs
a paid plan: **PRO for a personal account** (Team or Enterprise for an organization),
even though the "CPU basic" hardware it runs on has no hourly cost. Without PRO,
`deploy.py` stops before creating anything (`--try-anyway` tries all the same, in case
that rule changes); another host would then be needed.

- **Where it runs.** A public Docker Space, `<user>/mommy`, on the free "CPU basic"
  hardware (2 vCPU, 16 GB RAM), at `https://<user>-mommy.hf.space` over HTTPS.
  Hugging Face builds the image from the `Dockerfile` (the models are downloaded during
  the build, 729 MB, and each archive is checked against its pinned sha256) and runs it
  as uid 1000 on port 7860.
- **Who can use it.** Only people with the link: every page and API call needs the
  access cookie, which the access code gives (`POST /api/access`). Anyone else gets
  the code page and `401` on the API. The container refuses to start without a code
  (`MOMMY_REQUIRE_ACCESS_CODE=1` in the image, checked by the app's own settings).
- **Wrong codes.** After 10 wrong codes in 10 minutes from one address (an IPv6
  address counts as its /64 network), that address waits (`429`). The address is the one
  Hugging Face's proxy saw, read from the right end of `X-Forwarded-For`: what a visitor
  writes in that header does not change its count, and nobody can use up another
  person's tries. This limit is a second line of defence, not the protection itself:
  the code has 12 characters out of 31 (about 59 bits), far beyond guessing.

### What the owner does

1. A Hugging Face account with a PRO plan (see above).
2. An access token with write access (<https://huggingface.co/settings/tokens>).
3. Install the Hub client in a virtual environment of its own (it is not an app
   dependency), and deploy:

   ```sh
   python3 -m venv ~/.venvs/hf
   ~/.venvs/hf/bin/pip install huggingface_hub
   read -rs HF_TOKEN && export HF_TOKEN       # paste the token (kept out of the shell history)
   ~/.venvs/hf/bin/python deploy/huggingface/deploy.py --dry-run   # what would be uploaded
   ~/.venvs/hf/bin/python deploy/huggingface/deploy.py
   ```

   The script creates or updates the Space, sets its variable `MOMMY_ALLOWED_HOSTS` to
   the Space's host name (only when it changes) and its secret `MOMMY_ACCESS_CODE`, and
   uploads the Space card (`deploy/huggingface/README.md`), the `Dockerfile`,
   `.dockerignore`, `requirements-runtime.lock`, `backend/`, `web/`, `data/quran/` and
   the two scripts the image uses (never `.venv`, `models/`, `tests/` or `docs/`). Files
   of the Space that are not in the upload are deleted. It refuses to deploy a checkout
   without the access gate. Run it again after every change to the app: the access code
   is kept.
4. On the first run it prints the **share link**,
   `https://<user>-mommy.hf.space/#code=<code>`, as soon as the code is set, before the
   upload: if a later step fails, run the script again, and the link stays valid. The
   code is 12 letters and digits (no i, l, o, 0 or 1); it is printed only then, and kept
   only as the Space's secret (no file on this computer holds it: keep the link
   somewhere safe, or make a new code later).
5. The first build takes several minutes; follow it in the Space's "Logs" tab. Then open
   the link yourself: the code page, then the app. The Space page on huggingface.co
   shows an empty frame, because the app refuses to be shown inside another site: use
   the `hf.space` link.
6. Shortly before the friend uses it, open `https://<user>-mommy.hf.space/` (or the
   Space page) so that a sleeping Space is awake, then send the link privately, with a
   note such as:

   - en: "Open this link in Safari or Chrome (not inside a messaging app). If a Hugging
     Face page appears instead of Mommy, wait until it says Running, then open the link
     again."
   - fr: « Ouvrez ce lien dans Safari ou Chrome (pas dans une application de
     messagerie). Si une page de Hugging Face s’affiche à la place de Mommy, attendez
     qu’elle indique Running, puis rouvrez le lien. »
   - ar: «يُرجى فتح هذا الرابط في Safari أو Chrome (لا داخل تطبيق مراسلة). إذا ظهرت صفحة
     من Hugging Face بدلًا من Mommy، يُرجى الانتظار حتى تظهر كلمة Running، ثم فتح الرابط
     من جديد.»

   A messaging app's own browser keeps its cookies apart and may not allow the
   microphone.

**On the friend's side.** The page removes the code from the address bar at once (it is
in the `#` part, which the browser never sends to a server, so it reaches no log), and
the browser keeps the access cookie for 180 days; after that,
`https://<user>-mommy.hf.space/` is enough. The browser's history list still holds the
full link: on a shared device, delete that entry, or make a new code. In another
browser, a private window or after clearing the site's data, the link is needed again
(or the code can be typed on the code page, also with Arabic-Indic digits). If the app
is restarting, the code page says so and tries the link's code again by itself.

**A new code** (a lost link, or to shut out everyone who had it):
`deploy.py --new-code`. It prints the new link at once. When no file changed (so no new
build), the script restarts the Space itself; the old link and every browser that used
it stop working once the Space shows "Running" again (the cookie is derived from the
code and the host name, so no old cookie opens the app, and a cookie of another host,
such as `localhost`, opens nothing here). An open app then reloads to the code page. This
is the only way to take access back: the cookie is the same for everyone who has the
code, and a copied cookie works until the code changes.

**Claude (optional).** Without it the Space runs offline, as locally. To turn it on,
add `ANTHROPIC_API_KEY` as a **secret** in the Space's settings ("Variables and
secrets"; `deploy.py` never handles the key), and pass the models once:
`deploy.py --anthropic-model-vision <a vision-capable Claude model id>
--anthropic-model-text <a Claude model id>` (ids from the Claude documentation; they
become the Space variables `MOMMY_VISION_MODEL` and `MOMMY_TEXT_MODEL`). The script
reports whether Claude is configured.

**Stopping it.** "Pause" in the Space's settings stops it until it is restarted;
deleting the Space removes it.

### What to expect

- **Sleep and cold start.** On CPU basic, a Space that nobody uses for 48 hours goes
  to sleep; the next visit wakes it up (no rebuild). Hugging Face then starts the
  container again, which can take a minute or more; the app itself answers 3 to 5 s
  after the container starts. Online, the app then loads the three recognisers and
  voices in the background, one language at a time (7 to 40 s for the first after a
  cold start, about 3 s for each other one), while the friend is on the code page and
  the family setup; a recording made before its language is loaded waits for it.
- **Speed on 2 vCPU** (measured in the container limited to 2 CPUs, warm): a recording
  is checked in about half its length or a little more: 2.8 s for a 3.4 s French clip,
  3.4 to 3.8 s for a 5.3 s Arabic one, 3.3 to 3.5 s for a 6.6 s English one, 7.4 to
  8.5 s for a 16.7 s one. The voice answers in 0.2 to 0.4 s; slow dictation phrases
  (checked by the recogniser) take 1.4 to 3.5 s in French and 2 to 4 s in Arabic. With
  the three languages loaded the server uses about 5 GB of RAM (peaks under 6 GB).
- **One user at a time.** It is the same single-process prototype: one recognition runs
  at a time, so recordings sent together queue (about 3.5 s more for each one ahead).
- **Each browser has its own family data.** Children, tasks, stars and rewards stay in
  the friend's browser (`localStorage`), as locally; nothing of it is on the Space. To
  move it to another browser or address, "Save a copy" and "Load a copy" in Settings.

### What leaves the device

- **Audio and photos go to the Space over HTTPS**, together with the texts typed or
  checked. Hugging Face's servers carry this traffic and end the HTTPS connection; the
  app then processes the audio and photos in memory and never stores them (the same
  rules as locally: nothing is written to disk, and the logs, which the Space's owner
  can read in the "Logs" tab, hold sizes and timings, the language and kind of each
  check and the ayat numbers of a Quran check, never the audio, the photos or the
  texts). Uvicorn's access log is off,
  so client addresses and paths are not logged either. The access cookie is always
  `Secure` online and the app sends `Strict-Transport-Security`, so browsers reach it
  over HTTPS only. A restart of the Space keeps nothing.
- **With Claude configured,** page photos, handwriting photos and texts also go from
  the Space to the Claude API, as they do from a local server, and only after the
  parent's AI consent (its own box, under the notice of what goes to Claude): the
  server calls Claude only for a request that carries it (`ai_consent=1`).
- **The consent text adapts:** online (`/api/health` `"online": true`) it says that the
  recordings, photos and texts go to the Mommy server, never "nothing leaves this
  computer".
- **Public, private.** The Space's files are public (they are this repository's code),
  and so are its variables (the host name and the model ids). Its secrets (the access
  code, the API key) reach only the running app; the Space's settings and the Hub API
  never show their values.

### Test the image locally

Docker can run the same image here without downloading the models into it:

```sh
docker build --build-arg SKIP_MODELS=1 -t mommy-space .
read -rs MOMMY_ACCESS_CODE && export MOMMY_ACCESS_CODE   # any code of 8 characters or more
docker run --rm -p 127.0.0.1:7860:7860 -e MOMMY_ACCESS_CODE -e MOMMY_ALLOWED_HOSTS=localhost \
  -v "$(readlink -f models/sherpa-onnx-whisper-turbo)":/home/user/app/models/sherpa-onnx-whisper-turbo:ro \
  -v "$(readlink -f models/vits-piper-ar_JO-kareem-medium)":/home/user/app/models/vits-piper-ar_JO-kareem-medium:ro \
  -v "$(readlink -f models/vits-piper-en_US-lessac-medium)":/home/user/app/models/vits-piper-en_US-lessac-medium:ro \
  -v "$(readlink -f models/vits-piper-fr_FR-siwis-medium)":/home/user/app/models/vits-piper-fr_FR-siwis-medium:ro \
  mommy-space
```

Then open <http://localhost:7860> and type the code: over plain http the gate works on
`localhost` only (anywhere else the cookie is `Secure`, so it needs HTTPS). The image is
about 0.5 GB without the models and 1.7 GB with them; it installs
`requirements-runtime.lock` (no test tools) and starts from a `python:3.13-slim` pinned
by digest. `deploy.py --dry-run --out DIR` assembles exactly what would be uploaded, for
`docker build DIR`.

### If something is wrong

- **`400 bad_host`**: the request's host name is not one the app answers to. It always
  answers to `SPACE_HOST` (set by Hugging Face) and to `MOMMY_ALLOWED_HOSTS`; the log
  names the host that was refused.
- **The Space does not start**: its log says why (for example a missing or blank
  `MOMMY_ACCESS_CODE`).
- **The log says "an access code came from a private or unknown client address"**:
  Hugging Face's proxy did not pass the visitor's address in a way the app trusts, so
  every visitor may share one count of wrong codes (10 wrong codes by anyone would then
  pause everyone's first entry for 10 minutes; a browser that has the cookie is never
  affected). A quick check from two networks (for example a computer and a phone on
  mobile data): 10 wrong codes from the first, then one from the second should still
  say "wrong code", not "too many tries". If it does not, set the Space variable
  `MOMMY_FORWARDED_ALLOW_IPS` to the proxy's networks, or, as a last resort, to `*`
  (every visitor then has a count of its own, but one a visitor can reset at will;
  the code itself stays the protection).

## API notes

The endpoints are listed in [`docs/CONTRACT.md`](docs/CONTRACT.md). Errors are
`{"error": <code>, "message": <text>}`; every `/api/*` response has
`Cache-Control: no-store`. Limits: audio 10 MB and 120 s at 8-96 kHz, images 8 MB (JPEG
or PNG, at most 4096 x 4096 pixels, 50 MP for a JPEG), text fields 20 000 characters
and 3 000 words, `/api/tts` 400 characters, 50 ayat per Quran request. At most two image
or audio decodes run at once (`503 busy` after 30 s). Beyond the contract:

- `/api/health` also returns `tts_languages`, `asr_model` (the Whisper model in use),
  `reasons` (why the recogniser or the voices are unavailable) and `online` (the access
  gate is on, or an allowed host is not a loopback one).
- `/api/recite/check` returns a top-level `say_again`; results carry
  `say_again_reason` (`empty` or `error_rate`), `stopped_at_exp_index` (where the child
  stopped early) and `n_unreadable`. `/api/page/read` returns `contains_quran`
  (decided by the server from the text read: true for a page that is Quran, false for a
  school page that quotes ayat), `quran_parts`, `mushaf_text`, `quran_range`,
  `unreadable_marks` (`[?]` where a word could not be read) and, when Claude failed,
  `brain_error`; `/api/dictation/check` returns `legible`, accepts an optional
  `strict_tashkeel` field, and lists `[?]` in `uncertain_words` when a written word
  could not be read (it is shown as a substitution, never as a skipped word).
- Text refused on the general endpoints: `400 unreadable_text` (the text still has `[?]`
  marks), `400 bad_text` (a lone UTF-16 surrogate), `422 lang_mismatch` (an Arabic text
  with `lang` en/fr, or a text without Arabic letters with `lang` ar: the recogniser
  would translate the speech).
- `400 bad_host` for an unknown `Host` header, `403 bad_origin` for a cross-origin
  write; responses carry `X-Frame-Options: DENY` and `Content-Security-Policy:
  frame-ancestors 'none'`.
- `/api/quran/check` returns the extra fields of `Quran.check` (`words` for
  highlighting, `tolerated`, `n_expected`, `n_errors`, `word_accuracy`), plus
  `quality`, `riwaya`, `attribution` and `source_url`; `/api/quran/surahs` includes the
  Tanzil `licence` text.
- Slow `/api/tts` speech (dictation) is transcribed back, unprompted, to check that it
  says exactly the phrase (up to two takes); the `X-Speech-Check` header says `passed`,
  `failed` or `skipped`.
- `POST /api/text/check` (`{"text", "lang", "mode"?}`, mode `strict` by default,
  `contextual` or `dictation`) runs the text checks of the recite and dictation
  endpoints, in their order and with their error codes, without audio, voice or AI, and
  answers `{"ok": true, "words": n, "dictation": bool, "contextual": bool,
  "quran_parts": [...], "mushaf_text": str}`: one call tells "Confirm text" and task
  creation whether the text can be recited word by word, by meaning, and dictated, and
  where its Quran parts are. It answers `503 quran_unavailable` only when the Tanzil
  text is missing and the text is Arabic.
- Quran in school texts (`backend/mommy/guard.py`, numbers in `docs/CONTRACT.md`):
  - A text that **is** Quran: once the framing formulas (قال تعالى, صدق الله العظيم, the
    isti'adha, a basmala at the start) and the surah and ayah labels (سورة الإخلاص, (1),
    [البقرة: 255]) are left out, what remains is whole ayat in mushaf order. Every
    general endpoint refuses it with `422 quran_text`, with `quran_range` (`{surah, from,
    to}`) when it is one range of one surah. So does a word in the Uthmani script that
    cannot be placed in the mushaf.
  - A school text that **includes** Quran (a lesson quoting an ayah or part of one, a
    text starting with the basmala, a short ayah inside a sentence, a partial ayah on
    its own) is accepted. `/api/text/check`, `/api/page/read`, `/api/dictation/phrases`,
    `/api/recite/check` (strict) and `/api/dictation/check` return its `quran_parts`:
    token span, character offsets (also in UTF-16 units), reference, mushaf words in
    Uthmani and Simple-Clean, differences from the mushaf, reading chunks. The server
    recomputes them from the text every time; a client's list is never used.
  - The parts are found with the guard rules (runs of 5 Quran words, runs of 3 next to a
    framing formula, whole ayat, whole short ayat of 3-4 words inside a sentence, the
    90% `locate` rule on the text, its lines and its sentences) and a near match for an
    ayah with a changed, dropped or misread word (one-letter OCR errors, a missing
    hamza). The parent sees the differences, and `mushaf_text` (or a part's
    `replacement`) puts the mushaf words back in one tap; diacritics and the Uthmani or
    standard spelling are not differences.
  - Recitation compares a Quran part with the mushaf words exactly as `/api/quran/check`
    does (no numbers by value, no joined words, letters of the disjoined openings by
    name), and the rest of the text with the usual speech tolerances. Recitation by
    meaning is refused for such a text (`contextual: false`).
  - Dictation: `/api/dictation/phrases` also returns `readers` (`voice` or `grown_up`),
    `read_text` (the vowelled Uthmani chunk a grown-up reads aloud) and `parts`; a Quran
    part is cut into its own chunks of at most six words, never across an ayah. The
    child's writing of a Quran word is accepted in its Uthmani or Simple-Clean spelling
    only. The checks always use the mushaf words, so a child is never corrected towards
    a misquoted ayah. The `"scope": "phrase"` refusal is gone.
  - Feedback about a mistake inside a Quran part comes from fixed, respectful templates
    that quote the mushaf word (`feedback_is_quran: true`: shown, never spoken). When a
    result has any mistake in a Quran part, Claude is not called for its feedback at
    all, so it never receives a Quran word to write about.
  - `/api/tts` still refuses Quran (a whole ayah, a contained short ayah, a run of Quran
    words) and now also a short ayah with one misread or dropped word, a short ayah whose
    first word carries و or ف, and Quran words joined by a hyphen, an apostrophe, a
    tatweel or an invisible character. A refusal by meaning says so (`"reason":
    "meaning"`): the text can be recited word by word. The framed-run rule now counts only next to its formula
    (it starts at most four words after قال تعالى or ends at most four before صدق الله
    العظيم) and leaves the everyday formulas out there: a sentence with the isti'adha no
    longer makes إن شاء الله elsewhere count as Quran.
- Contained-ayah rule: the voice also refuses a phrase that holds a whole ayah of 3 or
  4 words among other words (`قل هو الله أحد` followed by a name, a sentence ending
  with `مالك يوم الدين`), so a short ayah is never spoken inside a sentence. Two-word
  ayat such as `ثم نظر` are ordinary Arabic and count only as a phrase of their own, and
  8 three-word ayat that are everyday Arabic (`فيها كتب قيمة`) are listed by number in
  `quran.EVERYDAY_AYAT`. K = 3 was chosen on 324 ordinary sentences in
  `tests/arabic_school_sentences.txt`: K = 2 refuses 32 of them, K = 3 none (11 without
  the list), and K = 4 lets 1:4 through (numbers in `docs/CONTRACT.md`).
- Recitation by meaning (contextual mode) also refuses a run of 4 consecutive Quran
  words (word by word keeps 5) that does not pass through an everyday formula (بسم
  الله, إن شاء الله, لا إله إلا الله, ...), and a whole ayah of 3 or 4 words anywhere in
  the text, because the meaning of Quran text is never judged by AI. On the 324
  sentences, runs of 3, 4 and 5 refuse 35, 8 and 0 (22, 2 and 0 with the formulas left
  out).

What counts as the same word:

- Speech (recitation and the slow-dictation audio check): a number in digits matches
  the same number in words, 0 to 100 (`12` / twelve / douze / اثنا عشر, `21` / vingt et
  un / واحد وعشرون / إحدى وعشرين, `1er` / premier); British spellings match American ones
  (colour / color, centre / center, realise / realize) and contractions match their full
  form (they're / they are); same-sound Arabic hamza spellings match (رءوف / رؤوف, مسئول /
  مسؤول, مائة / مئة). Among alignments of equal cost, the one that keeps the most words
  matched is reported.
- Speech, Arabic numbers in words: they are compared by value on both sides, so the
  gender and case variants of one number match each other (اثنتا عشرة / اثنا عشر / إثنى
  عشر / اثني عشر, ثلاثة / ثلاث, عشرون / عشرين, واحد وعشرون / إحدى وعشرين, the accusative
  واحدًا / واحد and أربعًا / أربعة, also with و: وأربع / وأربعة). The speech key already
  ignores case endings (tashkeel is dropped), and Whisper writes numbers in the gender it
  prefers, so these differences cannot be put down to the child. Different values still
  differ (ثلاثة / أربعة), and a number of two or three words is matched as a whole (اثنتا
  عشرة never matches اثنا alone); a shorter number inside it is a number of its own
  (ثلاثة عشر heard as ثلاث: عشر is reported as skipped). Some number words are also
  other words: سبع (a beast of prey), خمس (a fifth), تسع (the verb "holds"), عشر (a
  tenth), صفر (the month). On a page with vowel marks that rule the number out (سَبُع,
  خُمُس, تَسَعُ, عُشْر, صَفَر) the word is compared like any other, so سَبُع read as سبعة
  is a mistake; without vowel marks the page cannot tell, the word is taken as the
  number, and such a misreading is accepted. Only number words are affected: measured
  on the Tanzil text, no speech key of its 14,868 distinct Simple-Clean (and 18,994
  Uthmani) words changed, and of 31,179 pairs of ayat (each against itself, the next
  ayah and three random one-word edits) none changed its result. The Quran check does
  not use this: an ayah's number said in another gender stays a mistake.
- Dictation: spelling counts, so all of these are differences (only Arabic-Indic and
  Western digits are the same).
- Feedback follows the result: one mistake or several ("a few words were not right, the
  first one is ..."), where the child stopped early, and "say it louder" only when
  nothing usable was heard (a clear recording far from the text is asked to read again
  from the start; a misspelled dictation is never "unclear").
- Arabic feedback suits a girl or a boy: no imperatives, encouragement as "هيا" with a
  "we" verb (هيا نُحاوِل مِن جَدِيد!), past-tense praise whose last letter carries no vowel
  (أَحْسَنْت). The words the Arabic voice misreads without vowel marks carry them inside
  the word (never on the last letter, where the gender would show), and no spoken message
  ends a word with the suffix ـك, which the voice reads as masculine.

## Tests

```sh
.venv/bin/python -m pytest -q
```

The suite covers every module and every endpoint (fakes for speech and Claude, the real
Quran text). Integration tests with the real Whisper and Piper models skip cleanly when
the models are missing. The Quran guards and the Quran parts are measured on two
fixtures, `tests/arabic_school_sentences.txt` and `tests/quran_parts_texts.txt`, whose
Quran words all come from Tanzil placeholders filled by `tests/quran_fixtures.py` (no
Quran word is typed in them; misquotes are made by code). The online deployment has
tests of its own: `tests/test_access.py` (the access gate), `tests/test_space_image.py`
(the start script, the model checksums, the Dockerfile) and `tests/test_deploy.py`
(`deploy.py` against a fake Hub). The web client has four test files, which need
Node.js (the browser ones also Playwright with Chromium); the first three start no
backend, `access.cjs` starts the real app with fake speech components, and once more
with a fake Claude brain for the server's part in the AI consent (see
`tests/web/README.md`):

```sh
node tests/web/rewards.test.cjs   # web/rewards.js in Node: tasks, stars, goals, PIN, validation, family copies
node tests/web/smoke.cjs          # the screens through a fake API, Quran in school texts, wording checks
node tests/web/family.cjs         # the family UI: setup, parent area, tasks, rewards, PIN, storage, copies
node tests/web/access.cjs         # the access gate of an online deployment, in en, fr and ar
```

`smoke.cjs` also compares the fake API's Quran parts with the server's
`guard.find_quran_parts` through `.venv/bin/python` when it is there.

## Limitations

- **Arabic speech recognition is weak.** Whisper turbo has a word error rate of about
  40% on public Arabic benchmarks, and small is worse. Expect words reported as wrong
  that the child said correctly, and treat Arabic word-level results as hints for the
  parent. Clips with more than 60% errors (not counting the words after the point
  where the child stopped) are answered with "read it again from the start".
- **Not tested on children.** The recognisers were trained mostly on adult speech; no
  evaluation with children's voices has been done.
- **Voice licences.** The Arabic Piper voice (`ar_JO-kareem-medium`) gives its dataset
  licence only as "See URL" (<https://github.com/AliMokhammad/arabicttstrain/>): check it
  before any public use. The English voice (`en_US-lessac-medium`) uses the Blizzard 2013
  Lessac data under its own licence
  (<https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html>);
  the French voice (`fr_FR-siwis-medium`) data is CC BY 4.0. See each `MODEL_CARD` in
  `models/`.
- **Quran.**
  - Hafs only (Tanzil Uthmani and Simple-Clean text, version 1.1). The check is word by
    word: it does not judge tajwid or pronunciation beyond what the recogniser writes.
  - The Quran module needs review by qualified religious scholars before any public
    release.
  - The Quran parts of a school text are found by measured rules, not by reading the
    text. A short ayah (3 to 7 words) with one changed letter or one dropped inner word is
    found framed or not (measured on every such ayah of Juz' Amma at every word position:
    99.7% framed and 98.3% unframed with a changed letter, 99.0% and 99.5% with a dropped
    word; no hit on the ordinary sentences, 5,000 random pairs of them or the app's Arabic
    strings). Not found: a three-word ayah whose changed word has two letters, outside a
    framing formula or quotation marks; a three-word ayah with a dropped word; two errors
    in one short ayah; a two-word ayah inside a sentence. Such a text is used as ordinary
    text, and only the voice guard (which refuses a misquoted short ayah on its own)
    stands between it and the voice. Everyday formulas (لا إله إلا الله, حسبنا الله ونعم
    الوكيل, ...) stay ordinary words: a dictation joins a formula the voice refuses on its
    own with a neighbouring phrase; only a text that is nothing but a formula has it read
    by a grown-up. On 3,000 random pairs of ordinary sentences, 1 gained a part (a run of
    5 Quran words across the sentence end). Texts with Quran are measured on
    `tests/quran_parts_texts.txt` (102 quotations and 28 misquotes, all found).
  - The Quran-text guard on the general endpoints is a heuristic. Its thresholds and
    the everyday formulas and ayat it leaves out were measured on a fixture of 341
    sentences (`tests/arabic_school_sentences.txt`); an ordinary sentence that uses
    another short ayah as everyday Arabic can still be refused for dictation or for
    recitation by meaning; word-by-word recitation keeps its earlier guard.
- **Speech synthesis** needs an espeak-ng phonemizer (see above). The voice output is
  random, so a take can be unclear; slow dictation speech is checked by the recogniser
  for that reason.
- **One user at a time.** The models run on the CPU, one recognition at a time, and at
  most two image or audio decodes at once; this is a single-machine prototype, not a
  hosted service. The Hugging Face Space is for a small private test (a few people
  with the link), on 2 vCPU.
- **Quran.** The disjoined letters that open 29 surahs (الم, يس, ...) are accepted when
  recited by their letter names (ألف لام ميم), joined or apart; this was checked with
  typed text only, not with recordings of real recitations.

## Credits and licences

- **Quran text:** Tanzil Project (<https://tanzil.net>), Hafs, Uthmani v1.1 and
  Simple-Clean v1.1, CC BY 3.0, used verbatim. Surah names and ayah counts come from the
  Tanzil metadata file `data/quran/quran-data.js` ("Quran Metadata (ver 1.0), Copyright
  (C) 2008-2009 Tanzil.info", CC BY 3.0). The app shows "Hafs (Tanzil)" with the
  attribution and a link to tanzil.net. The copyright block of `quran-uthmani.txt`,
  verbatim (`quran-simple-clean.txt` carries the same block with its own title line):

  ```text
  # PLEASE DO NOT REMOVE OR CHANGE THIS COPYRIGHT BLOCK
  #====================================================================
  #
  #  Tanzil Quran Text (Uthmani, Version 1.1)
  #  Copyright (C) 2007-2026 Tanzil Project
  #  License: Creative Commons Attribution 3.0
  #
  #  This copy of the Quran text is carefully produced, highly 
  #  verified and continuously monitored by a group of specialists 
  #  at Tanzil Project.
  #
  #  TERMS OF USE:
  #
  #  - Permission is granted to copy and distribute verbatim copies 
  #    of this text, but CHANGING IT IS NOT ALLOWED.
  #
  #  - This Quran text can be used in any website or application, 
  #    provided that its source (Tanzil Project) is clearly indicated, 
  #    and a link is made to tanzil.net to enable users to keep
  #    track of changes.
  #
  #  - This copyright notice shall be included in all verbatim copies 
  #    of the text, and shall be reproduced appropriately in all files 
  #    derived from or containing substantial portion of this text.
  #
  #  Please check updates at: http://tanzil.net/updates/
  #
  #====================================================================
  ```

- **Speech:** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache 2.0), OpenAI
  Whisper models (MIT) as exported by sherpa-onnx, Piper voices (licences above), and
  the espeak-ng phonemizer (GPL-3.0-or-later; bundled by `espeakng-loader`).

## Layout

```text
mommy/
  README.md  requirements.txt  requirements.lock  run.sh
  requirements-runtime.lock    the app's part of requirements.lock (no test tools): what the image installs
  Dockerfile  .dockerignore    the Hugging Face Space image (models downloaded at build time)
  compose.yaml  SELF_HOST.md   the same image on one's own computer behind a Cloudflare quick tunnel
  compose.test.yaml            testing that setup only (no models in the image; they are mounted)
  .gitattributes               LF line endings for the scripts and build files on every checkout
  deploy/huggingface/          README.md (the Space card) and deploy.py (creates or updates the Space)
  deploy/oracle/               ORACLE.md and setup.sh: the self-hosting kit on an Oracle Cloud Always Free VM;
                               compose.oracle.yaml (both link modes), compose.stable.yaml and Caddyfile (the permanent link)
  scripts/download_models.sh   fetches the Whisper model(s) and Piper voices into models/ (sha256 checked)
  scripts/space_start.sh       the image's start command: checks the access code, runs uvicorn
  scripts/lock_requirements.py regenerates both lock files (development only)
  scripts/refresh_pins.py      shows or moves the pinned images (cloudflared, Caddy, Python) to newer digests (development only)
  docs/CONTRACT.md             module boundaries, HTTP API, hard rules
  data/quran/                  verbatim Tanzil text and metadata (read-only)
  models/                      git-ignored: downloaded models
  backend/mommy/               config, textnorm, align, phrases, feedback, quran, guard, asr, tts, llm, app
  web/                         index.html, app.js, recorder.js, styles.css, rewards.js (tasks and
                               rewards logic), family.js (the family UI), access.html and
                               access.js (the code page of an online deployment)
  tests/                       pytest suite; tests/web/ has the web client's tests
```
