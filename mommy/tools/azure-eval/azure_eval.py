#!/usr/bin/env python3
"""Azure AI Speech pronunciation assessment (scripted, REST API for short audio) on the
Mommy mistake-detection material (sets.json), compared with the local pipeline.

What it does
  * every item of sets.json (en/fr/ar; correct and misread sentences; fluent and word-by-word;
    clean and noisy; plus the correct 4-sentence texts cut in phrases) is sent as 16 kHz mono
    PCM WAV with its expected sentence as ReferenceText
    (GradingSystem HundredMark, Granularity Phoneme, Dimension Comprehensive, EnableMiscue True);
  * each answer is cached in a JSONL file (re-running resumes, nothing is sent twice);
  * a word is flagged if ErrorType is Mispronunciation or Omission, or (sweep) its
    AccuracyScore < t; Insertion words are counted separately; prosody error types
    (UnexpectedBreak / MissingBreak / Monotone) are counted but never flag a word;
  * prints, per language / style / noise condition: misread words caught, false alarms on
    correctly read words, insertions, latency; then a threshold sweep; then the same table for
    the local pipeline (out_sherpa_turbo.json, out_sherpa_quick.json, out_prompt.json if present).

Authentication: the network proxy injects the real key into the Ocp-Apim-Subscription-Key
header, so this script only ever sends the placeholder "dummy" and never needs the key.

usage (mommy venv, from anywhere):
  AZURE_SPEECH_REGION=westeurope python azure_eval.py            # real run (sequential: F0 allows 1 concurrent request)
  python azure_eval.py --fake                                   # dry run, no network, simulated answers
  options: --limit N  --langs en,fr  --styles fluent,wbw,para  --conds clean,noisy
           --ar-locale ar-SA|ar-EG  --concurrency 1  --cache FILE  --prosody (en-US only)
           --endpoint URL  (instead of the regional one, e.g. https://<resource>.cognitiveservices.azure.com/stt/speech/recognition/conversation/cognitiveservices/v1)
Audio limit: pronunciation assessment via REST short audio takes at most 30 s per request
(longest clip here about 9 s)."""
import argparse, base64, io, json, os, random, ssl, statistics, sys, time, urllib.error, urllib.request, wave
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "backend"))
from mommy.align import recitation_key
from mommy.textnorm import tokenize
from score import load_sets, score, fmt_row, flags_from_transcript, table

LOCALES = {"en": "en-US", "fr": "fr-FR", "ar": "ar-SA"}
FLAG_TYPES = {"Mispronunciation", "Omission"}
PROSODY_TYPES = {"UnexpectedBreak", "MissingBreak", "Monotone"}


# ---------------------------------------------------------------- request side
KEY = "dummy"  # replaced by --key-stdin or AZURE_SPEECH_KEY; never printed
PACE_S = 3.2  # least time between two request starts (free tier: about 20 requests a minute)
_last_start = [0.0]
T0 = time.time()


def safe_headers(h):
    """The response headers, for diagnosis: cookies left out, anything equal to the key masked."""
    out = []
    for k, v in (h.items() if h else []):
        if k.lower() == "set-cookie":
            continue
        out.append(f"{k}: {'***' if KEY and KEY in v else v}")
    return "; ".join(out)


def audio_bytes(item):
    """The clip as sent: 16 kHz mono Ogg Opus (32 kb/s), and its length in seconds."""
    with open(os.path.join(HERE, item["file"]), "rb") as f:
        return f.read(), item["seconds"]


def pa_header(reference, prosody):
    p = {"ReferenceText": reference, "GradingSystem": "HundredMark", "Granularity": "Phoneme",
         "Dimension": "Comprehensive", "EnableMiscue": "True"}
    if prosody:
        p["EnableProsodyAssessment"] = "True"
    return base64.b64encode(json.dumps(p, ensure_ascii=False).encode("utf-8")).decode("ascii")


def ssl_context():
    for var in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        if os.environ.get(var) and os.path.exists(os.environ[var]):
            return ssl.create_default_context(cafile=os.environ[var])
    if os.path.exists("/root/.ccr/ca-bundle.crt"):
        return ssl.create_default_context(cafile="/root/.ccr/ca-bundle.crt")
    return ssl.create_default_context()


def call_azure(endpoint, locale, audio, reference, prosody, ctx, max_tries=8):
    """POST one clip. Retries 429 / 5xx / network errors with Retry-After or exponential backoff."""
    url = f"{endpoint}?language={locale}&format=detailed"
    headers = {"Ocp-Apim-Subscription-Key": KEY,
               "Content-Type": "audio/ogg; codecs=opus",
               "Accept": "application/json", "Pronunciation-Assessment": pa_header(reference, prosody)}
    delay = 1.0
    auth_waits = [float(x) for x in os.environ.get("AZ_AUTH_WAITS", "15,30,60,60,90,120").split(",")]  # an empty 401/403 seen after a burst: wait and retry
    for attempt in range(1, max_tries + 20):
        gap = PACE_S - (time.time() - _last_start[0])
        if gap > 0:
            time.sleep(gap)
        _last_start[0] = time.time()
        req = urllib.request.Request(url, data=audio, headers=headers, method="POST")
        t = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
                body = json.loads(r.read().decode("utf-8"))
            return body, time.perf_counter() - t, attempt
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "replace")[:300]
            if e.code in (429, 500, 502, 503, 504) and attempt < max_tries:
                print(f"   headers: {safe_headers(e.headers)}", file=sys.stderr)
                ra = e.headers.get("Retry-After")
                wait = float(ra) if ra and ra.replace(".", "").isdigit() else delay
                print(f"   HTTP {e.code}, retry {attempt} in {wait:.1f} s", file=sys.stderr)
                time.sleep(wait); delay = min(delay * 2, 30); continue
            if e.code in (401, 403):
                print(f"   HTTP {e.code} at {time.time() - T0:.0f} s, body {txt!r}; headers: {safe_headers(e.headers)}", file=sys.stderr)
                if auth_waits:
                    w = auth_waits.pop(0)
                    print(f"   waiting {w} s, then the same clip again", file=sys.stderr, flush=True)
                    time.sleep(w); continue
                raise SystemExit(f"HTTP {e.code} from Azure ({txt}) on every retry for about 6 minutes. "
                                 "Answers so far are kept in the cache; run the same command again later to go on.")
            raise SystemExit(f"HTTP {e.code}: {txt}")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt < max_tries:
                print(f"   network error {e}, retry {attempt} in {delay:.1f} s", file=sys.stderr)
                time.sleep(delay); delay = min(delay * 2, 30); continue
            raise


def fake_azure(item, seed):
    """Simulated answer with the real response shape (for --fake): the changed word is usually
    Mispronunciation; some correct words get low scores; word-by-word reading adds breaks."""
    rng = random.Random(f"{seed}|{item['id']}")
    exp_words = [w.strip(".,!?;:؟،") for w in item["expected"].split()]
    words = []
    for i, w in enumerate(exp_words):
        if item["kind"] == "mis" and i == item["pos"]:
            acc = rng.uniform(15, 70); et = "Mispronunciation" if acc < 60 else "None"
        else:
            acc = min(100.0, rng.gauss(90 if item["cond"] == "clean" else 82, 8)); et = "Mispronunciation" if acc < 60 else "None"
        if item["style"] == "wbw" and i and rng.random() < 0.3 and et == "None":
            et = "UnexpectedBreak"
        words.append({"Word": w.lower(), "Offset": 0, "Duration": 0, "AccuracyScore": round(acc, 1), "ErrorType": et})
    if rng.random() < 0.05:
        words.insert(rng.randrange(len(words) + 1), {"Word": "uh", "AccuracyScore": 0.0, "ErrorType": "Insertion"})
    lex = " ".join(w["Word"] for w in words if w["ErrorType"] != "Omission")
    return {"RecognitionStatus": "Success", "DisplayText": lex, "NBest": [{"Lexical": lex, "AccuracyScore": 85.0,
            "FluencyScore": 80.0, "CompletenessScore": 100.0, "PronScore": 84.0, "Words": words}]}


# ---------------------------------------------------------------- answer side
def word_map(item, words):
    """Map Azure's reference-side words (all but Insertion) onto mommy's expected tokens.
    Returns list of (exp_index or None, word dict)."""
    exp = tokenize(item["expected"], item["lang"])
    keys = [recitation_key(t, item["lang"]) for t in exp]
    ref_words = [w for w in words if w.get("ErrorType") != "Insertion"]
    akeys = [recitation_key(w.get("Word", ""), item["lang"]) for w in ref_words]
    if len(ref_words) == len(exp):
        return list(zip(range(len(exp)), ref_words))
    import difflib  # tokenisation differs (e.g. l'ecole split, o'clock): align by key
    sm = difflib.SequenceMatcher(a=keys, b=akeys, autojunk=False)
    out = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal" or (tag == "replace" and i2 - i1 == j2 - j1):
            out += [(i1 + k, ref_words[j1 + k]) for k in range(j2 - j1)]
        else:  # unequal block: each Azure word goes to the nearest expected token of the block
            for k in range(j2 - j1):
                out.append((min(i1 + k * max(1, i2 - i1) // max(1, j2 - j1), max(i1, i2 - 1)) if i2 > i1 else None, ref_words[j1 + k]))
    return out


def flags_from_azure(item, resp, t=None):
    """(flagged expected indices, n_insertions, prosody error counter) for threshold t."""
    if not resp or resp.get("RecognitionStatus") != "Success" or not resp.get("NBest"):
        n = len(tokenize(item["expected"], item["lang"]))
        return set(range(n)), 0, Counter({"no_result": 1})  # nothing recognised: every word unread
    words = resp["NBest"][0].get("Words", [])
    flagged, pros = set(), Counter()
    ins = sum(1 for w in words if w.get("ErrorType") == "Insertion")
    for idx, w in word_map(item, words):
        et = w.get("ErrorType", "None")
        acc = w.get("AccuracyScore", w.get("PronunciationAssessment", {}).get("AccuracyScore", 100.0))
        if et in PROSODY_TYPES:
            pros[et] += 1
        if idx is None:
            continue
        if et in FLAG_TYPES or (t is not None and et != "Omission" and acc < t):
            flagged.add(idx)
    return flagged, ins, pros


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fake", action="store_true"); ap.add_argument("--limit", type=int)
    ap.add_argument("--langs", default="en,fr,ar"); ap.add_argument("--styles", default="fluent,wbw,para")
    ap.add_argument("--conds", default="clean,noisy"); ap.add_argument("--ar-locale", default="ar-SA")
    ap.add_argument("--concurrency", type=int, default=1); ap.add_argument("--prosody", action="store_true")
    ap.add_argument("--endpoint"); ap.add_argument("--cache"); ap.add_argument("--seed", default="0")
    ap.add_argument("--region"); ap.add_argument("--pace", type=float, default=3.2, help="least seconds between requests"); ap.add_argument("--key-stdin", action="store_true", help="read the key from the first line of stdin")
    a = ap.parse_args()
    global KEY
    if a.key_stdin:
        KEY = sys.stdin.readline().strip().strip('"').strip("'")
    elif os.environ.get("AZURE_SPEECH_KEY"):
        KEY = os.environ["AZURE_SPEECH_KEY"].strip()
    if not a.fake and (not KEY or KEY == "dummy") and not os.path.exists("/root/.ccr/ca-bundle.crt"):
        raise SystemExit("no key: pass it on stdin with --key-stdin (see README.md)")
    LOCALES["ar"] = a.ar_locale
    items = [i for i in load_sets() if i["lang"] in a.langs.split(",") and i["style"] in a.styles.split(",")
             and i["cond"] in a.conds.split(",")]
    if a.limit:
        items = items[: a.limit]
    global PACE_S
    PACE_S = a.pace
    cache_dir = "/cache" if os.path.isdir("/cache") and os.access("/cache", os.W_OK) else "/tmp"
    if cache_dir == "/tmp" and not a.fake and not a.cache:
        print("note: no writable /cache folder: answers are lost when the container ends (see README.md)")
    cache = a.cache or os.path.join(cache_dir, "azure_fake.jsonl" if a.fake else "azure_responses.jsonl")
    done = {}
    if os.path.exists(cache):
        for line in open(cache, encoding="utf-8"):
            r = json.loads(line); done[r["id"]] = r
    endpoint = a.endpoint
    if not a.fake and not endpoint:
        region = a.region or os.environ.get("AZURE_SPEECH_REGION")
        if not region:
            raise SystemExit("set AZURE_SPEECH_REGION (e.g. westeurope) or pass --endpoint, or use --fake")
        endpoint = f"https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1"
    ctx = None if a.fake else ssl_context()
    todo = [i for i in items if i["id"] not in done]
    print(f"{len(items)} items, {len(todo)} to send ({'FAKE' if a.fake else endpoint}); cache {cache}")

    def one(it):
        audio, secs = audio_bytes(it)
        assert secs <= 30, f"{it['id']}: {secs:.1f} s > 30 s limit"
        if a.fake:
            resp, lat, tries = fake_azure(it, a.seed), 0.0, 1
        else:
            resp, lat, tries = call_azure(endpoint, LOCALES[it["lang"]], audio, it["expected"], a.prosody, ctx)
        return {"id": it["id"], "locale": LOCALES[it["lang"]], "audio_s": secs, "latency_s": lat, "tries": tries, "response": resp}

    with open(cache, "a", encoding="utf-8") as fo, ThreadPoolExecutor(max(1, a.concurrency)) as ex:
        for n, r in enumerate(ex.map(one, todo), 1):
            fo.write(json.dumps(r, ensure_ascii=False) + "\n"); fo.flush(); done[r["id"]] = r
            if n % 25 == 0 or n == len(todo):
                print(f"  sent {n}/{len(todo)} ({time.time() - T0:.0f} s)", flush=True)

    # --- Azure tables
    resp = {i["id"]: done[i["id"]]["response"] for i in items if i["id"] in done}
    out0 = {}
    pros_total, status = Counter(), Counter()
    for it in items:
        f, ins, pros = flags_from_azure(it, resp.get(it["id"]))
        out0[it["id"]] = (f, ins); pros_total += pros
        status[(resp.get(it["id"]) or {}).get("RecognitionStatus", "missing")] += 1
    txt, _ = table(items, out0, "Azure pronunciation assessment: flag = ErrorType Mispronunciation/Omission (service default: Mispronunciation when word AccuracyScore < 60)")
    print(txt)
    print(f"  RecognitionStatus: {dict(status)}; prosody error types seen (never flag): {dict(pros_total)}")
    lat = [done[i]["latency_s"] for i in done if i in resp]
    if lat and not a.fake:
        lat.sort()
        print(f"  latency per request: median {statistics.median(lat):.2f} s, p90 {lat[int(0.9 * (len(lat) - 1))]:.2f} s, max {lat[-1]:.2f} s;"
              f" retries {sum(done[i]['tries'] - 1 for i in resp)}")
    by_lang = defaultdict(list)
    for it in items:
        if it["id"] in done:
            by_lang[it["lang"]].append(done[it["id"]]["latency_s"] / max(done[it["id"]]["audio_s"], 0.1))
    print("  latency / audio second:", {k: round(statistics.median(v), 2) for k, v in by_lang.items()})

    # --- omissions / insertions handling (what Azure says at the changed word)
    at_pos = Counter()
    for it in items:
        r = resp.get(it["id"])
        if it["kind"] != "mis" or not r or not r.get("NBest"):
            continue
        for idx, w in word_map(it, r["NBest"][0].get("Words", [])):
            if idx == it["pos"]:
                at_pos[w.get("ErrorType")] += 1
    print("  ErrorType Azure gives the misread word:", dict(at_pos))

    # --- threshold sweep
    print("\n== threshold sweep: flag if ErrorType in {Mispronunciation, Omission} or word AccuracyScore < t")
    print("   t    | " + " | ".join(f"{l}: caught  FA/100w" for l in ("en", "fr", "ar", "ALL")))
    best = None
    for t in (None, 50, 60, 70, 75, 80, 85, 90, 95):
        outs = {}
        for it in items:
            f, ins, _ = flags_from_azure(it, resp.get(it["id"]), t)
            outs[it["id"]] = (f, ins)
        agg = score(items, outs)
        cells = []
        for l in ("en", "fr", "ar", "ALL"):
            g = agg.get((l, "ALL", "ALL"))
            if not g:
                cells.append(" " * 19); continue
            cells.append(f"{l}: {g['caught']:3d}/{g['n_mis']:<3d} {100 * g['fa'] / max(1, g['ok_words']):5.1f}")
        g = agg[("ALL", "ALL", "ALL")]
        j = g["caught"] / max(1, g["n_mis"]) - g["fa"] / max(1, g["ok_words"])  # Youden-style: recall - FA rate
        best = max(best or (j, t), (j, t), key=lambda x: x[0])
        print(f"   {str(t):5s}| " + " | ".join(cells) + f" | recall-FArate {j:.3f}")
    print(f"   best trade-off (max recall - FA rate): t = {best[1]}")

    # --- local pipeline, same items, same scoring
    print("\n== local pipeline on the same items (app comparison mommy.align.check_recitation on the transcript)")
    for label, fname, pref in (("Whisper turbo (sherpa-onnx, no prompt; app)", "out_sherpa_turbo.json", ""),
                               ("quick models (Moonshine en / Parakeet fr; app tries first)", "out_sherpa_quick.json", ""),
                               ("turbo via faster-whisper, no prompt (A)", "out_prompt.json", "A|"),
                               ("turbo via faster-whisper, expected text as initial_prompt (B)", "out_prompt.json", "B|")):
        p = os.path.join(HERE, fname)
        if not os.path.exists(p):
            print(f"  ({label}: {fname} missing)"); continue
        tr = json.load(open(p))
        outs = {it["id"]: flags_from_transcript(it["expected"], tr[pref + it["id"]]["heard"], it["lang"])
                for it in items if pref + it["id"] in tr}
        t2, _ = table(items, outs, label, detail=False)
        secs = [tr[pref + it["id"]]["secs"] for it in items if pref + it["id"] in tr]
        print(t2 + (f"\n  decode per clip: median {statistics.median(secs):.2f} s" if secs else ""))


if __name__ == "__main__":
    main()
