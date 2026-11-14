"""Common scoring of word-level mistake detection on sets.json.

A system's output per item is a set of flagged expected-word indices plus a count of
insertions. For a recogniser transcript this comes from the app's own comparison
(mommy.align.check_recitation: sub/del -> flagged expected word, ins -> insertion).

Metrics per (lang, style, cond):
  caught   misread sentences whose changed word is flagged            (true positives)
  FA       flagged words that were read correctly: all flags in correct sentences plus
           flags at other positions in misread sentences                (false alarms)
  FA/100w  false alarms per 100 correctly read words
  okSent   correct sentences with no flag at all
  ins      insertions reported (not tied to an expected word; listed separately)
usage (library): from score import flags_from_transcript, table
"""
import json, os, sys
from collections import defaultdict
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend"))
from mommy.align import check_recitation
from mommy.textnorm import tokenize

HERE = os.path.dirname(os.path.abspath(__file__))

def load_sets():
    return json.load(open(os.path.join(HERE, "sets.json")))

def flags_from_transcript(expected, heard, lang):
    r = check_recitation(expected, heard, lang)
    flagged = {o.exp_index for o in r.ops if o.kind in ("sub", "del")}
    ins = sum(1 for o in r.ops if o.kind == "ins")
    return flagged, ins

def score(items, outputs):
    """outputs: id -> (flagged:set, ins:int). Returns dict key -> counters."""
    agg = defaultdict(lambda: defaultdict(int))
    for it in items:
        if it["id"] not in outputs:
            continue
        flagged, ins = outputs[it["id"]]
        n = len(tokenize(it["expected"], it["lang"]))
        for key in ((it["lang"], it["style"], it["cond"]), (it["lang"], "ALL", "ALL"), ("ALL", it["style"], it["cond"]), ("ALL", "ALL", "ALL")):
            a = agg[key]
            a["ins"] += ins
            if it["kind"] == "mis":
                a["n_mis"] += 1
                a["caught"] += it["pos"] in flagged
                a["fa"] += len(flagged - {it["pos"]})
                a["ok_words"] += n - 1
            else:
                a["n_ok"] += 1
                a["fa"] += len(flagged)
                a["ok_words"] += n
                a["ok_clean_sent"] += not flagged and not ins
    return agg

def fmt_row(key, a):
    lang, style, cond = key
    caught = f"{a['caught']}/{a['n_mis']}" if a["n_mis"] else "-"
    fa100 = 100 * a["fa"] / a["ok_words"] if a["ok_words"] else 0
    oks = f"{a['ok_clean_sent']}/{a['n_ok']}" if a["n_ok"] else "-"
    return f"{lang:3s} {style:6s} {cond:5s} | caught {caught:>6s} | FA {a['fa']:3d} ({fa100:4.1f}/100w) | ok sentences clean {oks:>6s} | ins {a['ins']:3d}"

def table(items, outputs, title, detail=True):
    agg = score(items, outputs)
    lines = [f"== {title}"]
    order = sorted(agg, key=lambda k: (k[0] == "ALL", k[0], k[1] == "ALL", k[1], k[2]))
    for k in order:
        if detail or "ALL" in k:
            lines.append("  " + fmt_row(k, agg[k]))
    return "\n".join(lines), agg
