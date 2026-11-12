"""The Quran parts of school texts (``mommy.guard.find_quran_parts``), measured on fixtures.

The product owner's decisions (``docs/CONTRACT.md``, hard rule 4): a text that *is* Quran
(Q1: whole ayat in mushaf order once framing formulas and labels are left out) belongs to
the Quran section; a school text that *includes* Quran (Q2) is a school text with Quran
parts, checked against the mushaf words, never read by the voice and never judged by
meaning. The counts asserted here are the ones quoted in ``docs/CONTRACT.md``.

Fixtures (no Quran word typed; ``tests/quran_fixtures.py`` fills the placeholders from
Tanzil and makes the misquotes by code): ``tests/arabic_school_sentences.txt`` (ordinary
sentences and short quotations) and ``tests/quran_parts_texts.txt`` (lessons, Q1 texts,
partial ayat, misquotes and hard misquotes).
"""

from __future__ import annotations

import random
import time
from pathlib import Path

import pytest

import quran_fixtures as qf
from mommy.align import check_recitation, check_writing, recitation_key
from mommy.guard import (
    CHUNK_MAX_WORDS,
    QURAN_GUARD_FRAMED_GAP_WORDS,
    QuranAnalysis,
    dictation_speaks_quran,
    find_quran_parts,
    framed_runs,
    is_misread,
    is_quran_phrase,
    looks_like_quran,
)
from mommy.quran import EVERYDAY_AYAT, Quran, is_pause_mark_token
from mommy.textnorm import tokenize
from mommy.tts import is_quranic_script


@pytest.fixture(scope="module")
def quran(quran_dir: Path) -> Quran:
    return Quran(quran_dir)


@pytest.fixture(scope="module")
def parts_texts(quran: Quran) -> dict[str, list[tuple[str, list[qf.Quote]]]]:
    return qf.filled_sections(quran, qf.PARTS_TEXTS)


@pytest.fixture(scope="module")
def sentences(quran: Quran) -> dict[str, list[str]]:
    return {name: [qf.fill(quran, s)[0] for s in lines] for name, lines in qf.read_sections(qf.SENTENCES).items()}


@pytest.fixture(scope="module")
def analyses(quran: Quran, parts_texts, sentences) -> dict[str, list[QuranAnalysis]]:
    out = {name: [find_quran_parts(t, "ar", quran) for t, _ in items] for name, items in parts_texts.items()}
    for name, texts in sentences.items():
        out["sentences_" + name] = [find_quran_parts(t, "ar", quran) for t in texts]
    return out


def words(quran: Quran, surah: int, first: int, last: int | None = None) -> list[str]:
    return [w for a in quran.ayat(surah, first, last or first) for w in a.match_words]


def kind(a: QuranAnalysis) -> str:
    return "Q1" if a.is_quran else "Q2" if a.parts else "ordinary"


# ---------------------------------------------------------------------------
# The fixtures
# ---------------------------------------------------------------------------


class TestFixtures:
    def test_sizes(self) -> None:
        raw = qf.read_sections(qf.PARTS_TEXTS)
        assert tuple(raw) == ("lessons", "q1", "partial", "misquoted_q2", "misquoted_q1", "hard")
        assert len(raw["lessons"]) >= 30 and len(raw["q1"]) >= 20 and len(raw["partial"]) >= 10
        assert len(raw["misquoted_q2"]) + len(raw["misquoted_q1"]) >= 20
        everything = [line for lines in raw.values() for line in lines]
        assert len(everything) == len(set(everything)), "duplicate texts"

    def test_quran_words_come_only_from_placeholders(self, quran: Quran) -> None:
        # With the placeholders taken out, nothing in the fixture is Quran text.
        for lines in qf.read_sections(qf.PARTS_TEXTS).values():
            for line in lines:
                assert qf.PLACEHOLDER.search(line), line
                bare = qf.PLACEHOLDER.sub(" ", line)
                assert not find_quran_parts(bare, "ar", quran).parts, line
                assert not is_quranic_script(bare), line

    def test_every_misquote_has_one_edit(self, parts_texts) -> None:
        for name in ("misquoted_q2", "misquoted_q1"):
            for text, quotes in parts_texts[name]:
                assert sum(q.edit is not None for q in quotes) == 1, text

    def test_edits_are_ocr_like(self, quran: Quran, parts_texts) -> None:
        for name in ("misquoted_q2", "misquoted_q1", "hard"):
            for text, quotes in parts_texts[name]:
                for quote in quotes:
                    if quote.edit and quote.edit[0] == "sub":
                        _, mushaf, typed = quote.edit
                        assert typed != mushaf and len(typed) == len(mushaf)
                        assert sum(x != y for x, y in zip(typed, mushaf)) == 1


# ---------------------------------------------------------------------------
# Q3: the measured boundary between Q1, Q2 and ordinary text
# ---------------------------------------------------------------------------


class TestConfusionTable:
    def test_table(self, analyses) -> None:
        """Rows: what a fixture section is; columns: what the server finds."""
        rows = {
            "ordinary sentences": analyses["sentences_ordinary"] + analyses["sentences_quranic"],
            "sentences with a Quran phrase ([split])": analyses["sentences_split"],
            "sentences quoting a short ayah ([quotes])": analyses["sentences_quotes"],
            "lessons quoting ayat": analyses["lessons"],
            "partial ayat on their own": analyses["partial"],
            "lessons with a misquoted ayah": analyses["misquoted_q2"],
            "hard misquotes": analyses["hard"],
            "whole ayat (Q1)": analyses["q1"],
            "whole ayat with a misquote (Q1)": analyses["misquoted_q1"],
        }
        table = {row: tuple(sum(kind(a) == k for a in items) for k in ("ordinary", "Q2", "Q1")) for row, items in rows.items()}
        assert table == {
            "ordinary sentences": (318, 0, 0),
            "sentences with a Quran phrase ([split])": (6, 0, 0),
            "sentences quoting a short ayah ([quotes])": (0, 17, 0),
            "lessons quoting ayat": (0, 35, 0),
            "partial ayat on their own": (0, 12, 0),
            "lessons with a misquoted ayah": (0, 20, 0),
            "hard misquotes": (1, 5, 0),
            "whole ayat (Q1)": (0, 0, 22),
            "whole ayat with a misquote (Q1)": (0, 0, 8),
        }

    def test_no_uthmani_outside_and_the_voice_is_safe(self, analyses) -> None:
        for items in analyses.values():
            for a in items:
                assert not a.uthmani_outside and a.voice_safe, a.text

    def test_every_quote_is_found_with_its_reference(self, quran: Quran, parts_texts, analyses) -> None:
        for name in ("lessons", "q1", "partial", "misquoted_q2", "misquoted_q1"):
            for (text, quotes), a in zip(parts_texts[name], analyses[name]):
                found = [p for p in a.parts_json()]
                for quote in quotes:
                    match = [
                        p for p in found
                        if (p["surah"], p["ayah_from"], p["ayah_to"]) == (quote.surah, quote.first, quote.last)
                    ]
                    assert len(match) == 1, (name, text)
                    part = match[0]
                    if quote.words:
                        assert (part["word_from"], part["word_to"]) == (quote.words[0] - 1, quote.words[1]), text
                        assert part["whole"] is False
                    else:
                        assert part["whole"] is True, text
                assert len(found) == len(quotes), (name, text)

    def test_ordinary_sentences_gain_no_quran_part(self, quran: Quran, sentences, analyses) -> None:
        """No ordinary sentence gains a part beyond what the earlier guards already flagged."""
        assert not any(a.parts for a in analyses["sentences_ordinary"])
        assert not any(a.parts for a in analyses["sentences_quranic"])
        # [split]: the plain phrase cut isolates an everyday formula, an everyday ayah or
        # a two-word ayah, which the voice refuses as a phrase of its own (the earlier
        # dictation guard). The cut now joins it with a neighbour the voice accepts, so
        # these stay ordinary words (2026-11-11, RL-5): no part, every phrase spoken.
        for text, a in zip(sentences["split"], analyses["sentences_split"]):
            assert dictation_speaks_quran(text, "ar", quran), text
            assert a.parts == [] and a.voice_safe, text
            plan = a.dictation_plan()
            assert {p["reader"] for p in plan} == {"voice"}
            assert not any(is_quran_phrase(p["phrase"], quran) for p in plan), text


class TestNearMatch:
    """Recall: a misquoted ayah is still found, with its difference reported. Precision:
    no difference is reported where nothing differs, and only the edit where it does."""

    @staticmethod
    def reported(a: QuranAnalysis) -> list[tuple[str, str | None, str | None]]:
        return [(d["op"], d["typed"], d["mushaf_clean"]) for p in a.parts_json() for d in p["differences"]]

    def test_recall_and_precision_on_misquotes(self, parts_texts, analyses) -> None:
        found = total = 0
        for name in ("misquoted_q2", "misquoted_q1"):
            for (text, quotes), a in zip(parts_texts[name], analyses[name]):
                [edit] = [q.edit for q in quotes if q.edit]
                op, mushaf, typed = edit
                total += 1
                if self.reported(a) == [(op, typed, mushaf)]:
                    found += 1
        assert (found, total) == (28, 28)

    def test_hard_misquotes(self, parts_texts, analyses) -> None:
        # The short ayat with one misread or dropped word are found with exactly their
        # edit (near_short_ayat); the two-word ayah inside a sentence stays ordinary.
        results = []
        for (text, quotes), a in zip(parts_texts["hard"], analyses["hard"]):
            edits = [q.edit for q in quotes if q.edit]
            results.append(bool(edits) and self.reported(a) == [(op, typed, mushaf) for op, mushaf, typed in edits])
        assert results == [True, True, True, True, False, True]
        assert analyses["hard"][4].parts == []

    def test_no_difference_where_nothing_differs(self, analyses) -> None:
        for name in ("lessons", "q1", "partial", "sentences_split", "sentences_quotes"):
            for a in analyses[name]:
                assert self.reported(a) == [], a.text
                assert a.mushaf_text() == a.text

    def test_misreads(self) -> None:
        assert is_misread("اثقوا", "اتقوا") and is_misread("حقرة", "حفرة")
        assert not is_misread("والله", "الله") and not is_misread("فقال", "قال")  # a clitic makes another word
        assert not is_misread("كتاب", "قلم") and not is_misread("ب", "ت")
        assert is_misread("الصابرين", "الصابرون")  # one letter in a long word
        assert is_misread("الصابرينا", "الصابرون")  # two letters from six on


# ---------------------------------------------------------------------------
# The parts: chunks, the dictation plan, the mushaf text, determinism
# ---------------------------------------------------------------------------


def random_mixes(quran: Quran, ordinary: list[str], count: int, seed: int) -> list[str]:
    """Ordinary sentences with whole ayat, ranges and partial ayat put in (some framed)."""
    rng = random.Random(seed)
    texts = []
    for _ in range(count):
        pieces = [rng.choice(ordinary) for _ in range(rng.randint(1, 4))]
        for _ in range(rng.randint(1, 3)):
            surah = rng.randint(1, 114)
            n = quran.ayah_count(surah)
            first = rng.randint(1, n)
            last = min(n, first + rng.choice((0, 0, 1, 2)))
            quote = words(quran, surah, first, last)
            if rng.random() < 0.3 and len(quote) > 8:
                start = rng.randrange(len(quote) - 6)
                quote = quote[start : start + rng.randint(5, 8)]
            framing = rng.choice(("", "", "قال تعالى: ", "قال الله تعالى في كتابه: "))
            closing = rng.choice(("", "", " صدق الله العظيم."))
            pieces.insert(rng.randint(0, len(pieces)), framing + " ".join(quote) + closing)
        texts.append(rng.choice((" ", "\n")).join(pieces))
    return texts


def check_plan(quran: Quran, a: QuranAnalysis) -> None:
    """The dictation invariants: the voice never meets a phrase it refuses, every
    phrase it refuses is read by a grown-up, and the phrases are the expected words."""
    plan = a.dictation_plan()
    for entry in plan:
        flagged = is_quran_phrase(entry["phrase"], quran)
        if flagged:
            assert entry["reader"] == "grown_up", (a.text, entry["phrase"])
        if entry["reader"] == "grown_up":
            assert entry["read_text"] and entry["part"] is not None
            assert len([w for w in entry["read_text"].split() if not is_pause_mark_token(w)]) <= CHUNK_MAX_WORDS
        else:
            assert entry["read_text"] is None and entry["part"] is None
    spoken = [w for e in plan for w in tokenize(e["phrase"], "ar")]
    expected = a.expected().tokens
    if not any(d for d in a.digits):  # ayah numbers are not in the expected words
        assert spoken == expected, a.text


class TestParts:
    def test_dictation_plan_on_the_fixtures(self, quran: Quran, analyses) -> None:
        for items in analyses.values():
            for a in items:
                if not a.is_quran:
                    check_plan(quran, a)

    def test_dictation_plan_on_random_mixes(self, quran: Quran, sentences) -> None:
        ordinary = sentences["ordinary"]
        for text in random_mixes(quran, ordinary, 150, seed=11):
            a = find_quran_parts(text, "ar", quran)
            assert a.voice_safe and not a.uthmani_outside, text
            check_plan(quran, a)

    def test_random_mixes_find_the_ayat(self, quran: Quran, sentences) -> None:
        # Every quoted stretch of five words or more, and every whole ayah of 3-4 words
        # (not an everyday one), lies inside a part.
        rng = random.Random(7)
        ordinary = sentences["ordinary"]
        everyday = {tuple(words(quran, s, a)) for s, a in EVERYDAY_AYAT}
        for _ in range(120):
            surah = rng.randint(1, 114)
            ayah = rng.randint(1, quran.ayah_count(surah))
            quote = words(quran, surah, ayah)
            if len(quote) < 3 or tuple(quote) in everyday:
                continue
            before, after = rng.choice(ordinary), rng.choice(ordinary)
            text = f"{before} {' '.join(quote)} {after}"
            a = find_quran_parts(text, "ar", quran)
            start = len(tokenize(before, "ar"))
            inside = [p for p in a.parts if p.start <= start and start + len(quote) <= p.end]
            assert inside, text

    def test_chunks_are_verbatim_and_short(self, quran: Quran) -> None:
        text = "قال المعلم: " + " ".join(words(quran, 2, 255)) + " وهذه آية الكرسي."
        a = find_quran_parts(text, "ar", quran)
        [part] = a.parts
        chunks = a.chunks(part)
        display = quran.ayat(2, 255, 255)[0].display
        assert all(u in display for u, _ in chunks)  # cut verbatim from the Uthmani line
        sizes = [len([w for w in u.split() if not is_pause_mark_token(w)]) for u, _ in chunks]
        assert max(sizes) <= CHUNK_MAX_WORDS and max(sizes) - min(sizes) <= 1
        assert " ".join(c for _, c in chunks) == " ".join(words(quran, 2, 255))
        # A chunk never crosses an ayah.
        surah = " ".join(words(quran, 112, 1, 4))
        b = find_quran_parts("نحفظ اليوم: " + surah, "ar", quran)
        assert [u for u, _ in b.chunks(b.parts[0])] == [x.display for x in quran.ayat(112, 1, 4)]

    def test_deterministic(self, quran: Quran, sentences) -> None:
        for text in random_mixes(quran, sentences["ordinary"], 20, seed=3):
            a, b = find_quran_parts(text, "ar", quran), find_quran_parts(text, "ar", quran)
            assert a.parts == b.parts and a.parts_json() == b.parts_json() and a.mushaf_text() == b.mushaf_text()

    def test_the_mushaf_text_has_no_differences(self, parts_texts, quran: Quran) -> None:
        for name in ("misquoted_q2", "misquoted_q1", "hard"):
            for text, _ in parts_texts[name]:
                a = find_quran_parts(text, "ar", quran)
                fixed = a.mushaf_text()
                b = find_quran_parts(fixed, "ar", quran)
                assert all(not p["differences"] for p in b.parts_json()), (text, fixed)
                assert [(p.g_lo, p.g_hi) for p in b.parts] == [(p.g_lo, p.g_hi) for p in a.parts]
                for part, pj in zip(a.parts, a.parts_json()):
                    c0, c1 = pj["chars"]
                    assert text[:c0] + pj["replacement"] + text[c1:] == _apply_one(a, part), text

    def test_the_script_of_the_replacement(self, quran: Quran) -> None:
        # Standard spelling stays standard; a quote in the Uthmani script gets Uthmani words.
        ayah = quran.ayat(112, 1, 1)[0]
        plain = "ذهبت سلمى " + " ".join(ayah.match_words[:3] + ["احد"])
        assert find_quran_parts(plain, "ar", quran).mushaf_text() == "ذهبت سلمى " + ayah.match
        uthmani = "ذهبت سلمى " + " ".join(ayah.display_words[:3] + ["احد"])
        assert find_quran_parts(uthmani, "ar", quran).mushaf_text() == "ذهبت سلمى " + ayah.display

    def test_ayah_numbers_belong_to_the_part(self, quran: Quran) -> None:
        numbered = " ".join(f"{' '.join(words(quran, 112, k))} ({k})" for k in range(1, 5))
        text = "حفظنا اليوم: " + numbered + " وهذه سورة الإخلاص."
        a = find_quran_parts(text, "ar", quran)
        [part] = a.parts_json()
        assert (part["ayah_from"], part["ayah_to"], part["whole"]) == (1, 4, True)
        plan = a.dictation_plan()
        assert [e["phrase"] for e in plan if e["reader"] == "voice"] == ["حفظنا اليوم:", "وهذه سورة الإخلاص."]
        assert find_quran_parts(numbered, "ar", quran).is_quran  # the numbers are labels

    def test_q1_labels_and_framing(self, quran: Quran) -> None:
        surah = " ".join(words(quran, 103, 1, 3))
        for text in (
            surah, "سورة العصر\n" + surah, "قال الله تعالى في سورة العصر: " + surah, surah + " صدق الله العظيم",
            "أعوذ بالله من الشيطان الرجيم " + quran.basmala_match + " " + surah, surah + " [العصر: 1-3]",
        ):
            a = find_quran_parts(text, "ar", quran)
            assert a.is_quran and a.quran_range() == {"surah": 103, "from": 1, "to": 3}, text
        # Out of mushaf order, or with a sentence of its own: not Q1.
        backwards = " ".join(words(quran, 114, 1, 6) + words(quran, 113, 1, 5))
        assert not find_quran_parts(backwards, "ar", quran).is_quran
        assert not find_quran_parts(surah + " ثم عدنا إلى البيت.", "ar", quran).is_quran
        # The basmala alone is an ayah (1:1); with a sentence after it, a Quran part.
        assert find_quran_parts(quran.basmala_match, "ar", quran).is_quran
        assert not find_quran_parts(quran.basmala_match + " نبدأ الدرس.", "ar", quran).is_quran

    def test_uthmani_script_outside_a_part(self, quran: Quran) -> None:
        # A word in the mushaf script that cannot be placed is refused, as before.
        word = quran.ayat(2, 255, 255)[0].display_words[5]
        a = find_quran_parts("ذهب الولد " + word + " إلى المدرسة", "ar", quran)
        assert a.uthmani_outside and a.refused
        assert not find_quran_parts("قرأنا " + quran.ayat(112, 1, 1)[0].display + " اليوم", "ar", quran).refused

    def test_offsets(self, quran: Quran) -> None:
        quote = " ".join(words(quran, 112, 1))
        text = "🙂 درسنا: " + quote + " اليوم"
        a = find_quran_parts(text, "ar", quran)
        [part] = a.parts_json(text)
        c0, c1 = part["chars"]
        assert text[c0:c1] == quote
        u0, u1 = part["utf16"]
        assert (u0, u1) == (c0 + 1, c1 + 1)  # the emoji is two UTF-16 code units

    def test_without_the_quran_text(self) -> None:
        a = find_quran_parts("ذهب الولد إلى المدرسة", "ar", None)
        assert a.parts == [] and not a.refused
        assert find_quran_parts("قُلْ هُوَ ٱللَّهُ أَحَدٌ", "ar", None).refused  # the script test


# ---------------------------------------------------------------------------
# The framed rule, restricted to the formula's neighbourhood (QS1)
# ---------------------------------------------------------------------------


class TestFramedNeighbourhood:
    def test_a_formula_elsewhere_no_longer_catches_everyday_runs(self, quran: Quran) -> None:
        # Regression (found by the previous build): a framing formula anywhere made the
        # framed 3-run rule catch إن شاء الله anywhere in the text.
        text = "أعوذ بالله من الشيطان الرجيم. ذهبنا إلى السوق إن شاء الله غدا."
        assert not looks_like_quran(text, quran)
        assert not find_quran_parts(text, "ar", quran).parts

    def test_the_neighbourhood(self, quran: Quran) -> None:
        three = " ".join(words(quran, 112, 4)[2:])  # the last three words of 112:4
        assert looks_like_quran("قال تعالى: " + three, quran)
        assert looks_like_quran(three + " صدق الله العظيم", quran)
        gap = " ".join(["في", "سورة", "الإخلاص", "الجميلة"][:QURAN_GUARD_FRAMED_GAP_WORDS])
        assert looks_like_quran(f"قال تعالى {gap} " + three, quran)
        far = "قال تعالى في سورة الإخلاص وهي سورة قصيرة نحفظها: " + three
        assert not looks_like_quran(far, quran)
        assert not looks_like_quran(three + " قال تعالى", quran)  # an opening formula looks forward

    def test_framed_runs_leave_out_everyday_formulas(self, quran: Quran) -> None:
        tokens = tokenize("إن شاء الله سنذهب", "ar")
        assert framed_runs(quran, tokens, [(0, False)]) == []
        assert quran.exact_matches(tokens, 3)  # the words are a Quran run


# ---------------------------------------------------------------------------
# Checks against the mushaf words (QS2)
# ---------------------------------------------------------------------------


class TestPartChecks:
    def test_recitation_compares_quran_words_strictly(self, quran: Quran) -> None:
        ayah = words(quran, 15, 44)  # holds the number word سبعة
        number = ayah.index("سبعة")
        text = "قرأنا اليوم: " + " ".join(ayah) + " وفي البيت سبعة أبواب."
        a = find_quran_parts(text, "ar", quran)
        assert len(a.parts) == 1
        heard_ayah = list(ayah)
        heard_ayah[number] = "سبع"  # another gender: a mistake in the ayah
        result, exp = a.check_recitation("قرأنا اليوم " + " ".join(heard_ayah) + " وفي البيت سبع أبواب")
        errors = [op for op in result.ops if op.kind != "match"]
        assert [(op.kind, op.expected) for op in errors] == [("sub", "سبعة")]
        assert errors[0].exp_index in exp.quran  # ... the ayah's, not the sentence's
        # Digits for the number: a mistake in the ayah, accepted in the sentence.
        heard_ayah[number] = "7"
        result, exp = a.check_recitation("قرأنا اليوم " + " ".join(heard_ayah) + " وفي البيت 7 أبواب")
        assert [(op.kind, op.exp_index in exp.quran) for op in result.ops if op.kind != "match"] == [("sub", True)]
        # The same sentence without the ayah keeps every tolerance.
        assert check_recitation("وفي البيت سبعة أبواب", "وفي البيت 7 أبواب", "ar").verdict == "correct"

    def test_recitation_joins_only_outside_the_part(self, quran: Quran) -> None:
        ayah = words(quran, 112, 1)
        text = "جاء عبد الله وقرأ " + " ".join(ayah)
        a = find_quran_parts(text, "ar", quran)
        joined = ayah[0] + ayah[1]  # two words of the ayah said as one
        result, _ = a.check_recitation("جاء عبدالله وقرأ " + " ".join([joined, *ayah[2:]]))
        assert [(op.kind, op.expected) for op in result.ops if op.kind != "match"][:1] in ([("sub", ayah[0])], [("del", ayah[0])])
        assert result.ops[1].kind == "match" and result.ops[1].heard == "عبدالله"

    def test_the_child_is_checked_against_the_mushaf(self, quran: Quran) -> None:
        ayah = words(quran, 2, 153)
        typed = list(ayah)
        typed[6] = qf._misread(typed[6])  # the parent's text has a misread word
        text = "الصبر مفتاح الفرج. قال تعالى: " + " ".join(typed)
        a = find_quran_parts(text, "ar", quran)
        result, _ = a.check_recitation("الصبر مفتاح الفرج قال تعالى " + " ".join(ayah))
        assert result.verdict == "correct"  # never corrected towards the misquote
        result, _ = a.check_recitation("الصبر مفتاح الفرج قال تعالى " + " ".join(typed))
        assert [(op.kind, op.expected, op.heard) for op in result.ops if op.kind != "match"] == [("sub", ayah[6], typed[6])]

    def test_disjoined_letters_by_name(self, quran: Quran) -> None:
        opening = words(quran, 2, 1, 2)
        a = find_quran_parts("قال المعلم: " + " ".join(opening) + " وهذه بداية سورة البقرة.", "ar", quran)
        heard = "قال المعلم ألف لام ميم " + " ".join(opening[1:]) + " وهذه بداية سورة البقرة"
        assert a.check_recitation(heard)[0].verdict == "correct"

    def test_dictation_accepts_the_two_mushaf_spellings_only(self, quran: Quran) -> None:
        ayah = quran.ayat(2, 153, 153)[0]
        text = "قال المعلم: " + ayah.match + " وكتبنا الآية."
        a = find_quran_parts(text, "ar", quran)
        assert a.check_writing(text)[0].verdict == "correct"  # the standard spelling
        uthmani = "قال المعلم " + " ".join(ayah.display_words) + " وكتبنا الآية"
        result, _ = a.check_writing(uthmani)
        assert result.verdict == "correct", [(op.kind, op.expected, op.heard) for op in result.ops if op.kind != "match"]
        # A spelling that is neither (no hamza) is a mistake, as everywhere in dictation.
        no_hamza = text.replace(ayah.match_words[1], ayah.match_words[1].replace("أ", "ا"))
        assert [(op.kind, op.expected) for op in a.check_writing(no_hamza)[0].ops if op.kind != "match"] == [
            ("sub", ayah.match_words[1])
        ]
        # Every other word is checked as strictly as before.
        assert a.check_writing(text.replace("وكتبنا", "وكتابنا"))[0].n_errors == 1
        plain = "قال المعلم: وكتبنا الآية."
        assert check_writing(plain, plain.replace("الآية", "الاية"), "ar").n_errors == 1

    def test_dictation_with_a_misquoted_text_expects_the_mushaf(self, quran: Quran) -> None:
        ayah = words(quran, 9, 119)
        typed = list(ayah)
        typed[4] = qf._misread(typed[4])
        text = "درسنا اليوم عن الصدق. قال الله تعالى: " + " ".join(typed)
        a = find_quran_parts(text, "ar", quran)
        written = "درسنا اليوم عن الصدق. قال الله تعالى: " + " ".join(ayah)
        assert a.check_writing(written)[0].verdict == "correct"
        assert a.check_writing(text)[0].n_errors == 1


# ---------------------------------------------------------------------------
# Timings (QS3), reported in docs/CONTRACT.md
# ---------------------------------------------------------------------------


def test_a_1000_word_text_is_analysed_quickly(quran: Quran, sentences, parts_texts) -> None:
    rng = random.Random(0)
    pools = {"ordinary": sentences["ordinary"], "lessons": [t for t, _ in parts_texts["lessons"]]}
    for name, pool in pools.items():
        lines, count = [], 0
        while count < 1000:
            lines.append(rng.choice(pool))
            count += len(lines[-1].split())
        text = "\n".join(lines)
        started = time.perf_counter()
        a = find_quran_parts(text, "ar", quran)
        a.parts_json()
        a.dictation_plan()
        assert time.perf_counter() - started < 2.0, name
        assert bool(a.parts) == (name == "lessons")


def test_one_analysis_tests_each_phrase_and_scope_once(quran: Quran, sentences, parts_texts, monkeypatch) -> None:
    # Final verification (P2): the search tested every voice phrase twice (while joining
    # the phrases, then in its voice round) and located some scopes twice; the answers
    # are now kept for the call, and the same (the memo is gone after the call).
    from mommy import guard

    rng = random.Random(1)
    pool = sentences["ordinary"] + [t for t, _ in parts_texts["lessons"]]
    text = " ".join(rng.choice(pool) for _ in range(40))
    expected = find_quran_parts(text, "ar", quran)
    phrases: list[str] = []
    located: list[tuple] = []  # the searches of Quran.locate made for the finder's scopes
    inside = []
    plain_phrase, plain_locate, finder_locate = guard._is_quran_phrase, Quran.locate, guard._Finder.locate

    def counted_phrase(t: str, q: Quran | None) -> bool:
        phrases.append(t)
        return plain_phrase(t, q)

    def counted_locate(self: Quran, joined: str, top_k: int = 5, within_surah: int | None = None, *, min_score=None):
        if inside:
            located.append((joined, top_k, within_surah, min_score))
        return plain_locate(self, joined, top_k, within_surah, min_score=min_score)

    def scope_locate(self, joined: str, top_k: int, min_score=None):
        inside.append(True)
        try:
            return finder_locate(self, joined, top_k, min_score)
        finally:
            inside.pop()

    monkeypatch.setattr(guard, "_is_quran_phrase", counted_phrase)
    monkeypatch.setattr(Quran, "locate", counted_locate)
    monkeypatch.setattr(guard._Finder, "locate", scope_locate)
    a = find_quran_parts(text, "ar", quran)
    assert phrases and len(phrases) == len(set(phrases))
    assert located and len(located) == len(set(located))
    assert a.parts == expected.parts and a.voice_safe == expected.voice_safe and a.is_quran == expected.is_quran
    assert guard._PHRASE_MEMO.get() is None
    n = len(phrases)
    guard.is_quran_phrase(phrases[0], quran)  # outside an analysis: tested again, not kept
    assert len(phrases) == n + 1


def _apply_one(a: QuranAnalysis, part) -> str:
    """The text with only this part replaced by its mushaf text."""
    from mommy.guard import _apply

    return _apply(a.text, a._edits(part))


def test_random_pairs_of_ordinary_sentences(quran: Quran, sentences) -> None:
    """Two ordinary sentences side by side gain a part only where the earlier guards
    already flagged the text: a run of 5 Quran words crosses the sentence end (the
    earlier word-by-word guard refused the whole text). The near-match rules add
    nothing, and a phrase cut that isolates an everyday ayah is joined back (RL-5; it
    gave 2 more texts with a part before)."""
    rng = random.Random(5)
    ordinary = sentences["ordinary"] + sentences["quranic"]
    with_parts = 0
    for _ in range(3000):
        text = rng.choice(ordinary) + " " + rng.choice(ordinary)
        a = find_quran_parts(text, "ar", quran)
        if a.parts:
            with_parts += 1
            assert dictation_speaks_quran(text, "ar", quran) or looks_like_quran(text, quran), text
            assert {p.rule for p in a.parts} <= {"ayah", "run"}, text
    assert with_parts == 1


# ---------------------------------------------------------------------------
# Short ayat with one OCR-like error (guard.near_short_ayat)
# ---------------------------------------------------------------------------


def _juz_amma_short(quran: Quran) -> list[tuple[int, int, list[str]]]:
    return [
        (s, a, list(quran.ayat(s, a, a)[0].match_words))
        for s in range(78, 115)
        for a in range(1, quran.ayah_count(s) + 1)
        if 3 <= len(quran.ayat(s, a, a)[0].match_words) <= 7 and (s, a) not in EVERYDAY_AYAT
    ]


def _found(quran: Quran, a: QuranAnalysis, ayah_words: list[str]) -> bool:
    """A part holds this ayah (an identical ayah elsewhere in the Quran counts)."""
    keys = [recitation_key(w, "ar") for w in ayah_words]
    return any(quran.keys_at(*quran.ayah_bounds(p.g_lo)) == keys for p in a.parts)


class TestShortAyatWithOneError:
    """The logic review's sweep (RL-1): every short ayah of Juz' Amma quoted in a lesson
    with one changed letter or one dropped inner word. Before the near match of short
    ayat, 57% were found framed (3-word ayat: 4 of 426), and the voice read the rest."""

    LESSON = "درسنا اليوم آية جديدة. {frame}{ayah} ثم شرحها المعلم."

    def sweep(self, quran: Quran, frame: str, edit: str, min_words: int = 3) -> tuple[int, int]:
        found = total = 0
        for s, a, w in _juz_amma_short(quran):
            if len(w) < min_words:
                continue
            k = (s + a) % len(w)  # one word position per ayah, spread over the positions
            e = list(w)
            if edit == "sub":
                k = next((i for i in [k, *range(len(w))] if any(c in qf.CONFUSED for c in w[i])), None)
                if k is None:
                    continue
                e[k] = qf._misread(e[k])
            else:
                if len(w) < 4:
                    continue
                k = 1 + k % (len(w) - 2)  # an inner word
                del e[k]
            text = self.LESSON.format(frame=frame, ayah=" ".join(e))
            analysis = find_quran_parts(text, "ar", quran)
            total += 1
            found += _found(quran, analysis, w)
        return found, total

    def test_framed_changed_letter(self, quran: Quran) -> None:
        found, total = self.sweep(quran, "قال تعالى: ", "sub")
        assert total > 400 and found / total >= 0.97, (found, total)

    def test_framed_dropped_word(self, quran: Quran) -> None:
        found, total = self.sweep(quran, "قال تعالى: ", "drop")
        assert total > 250 and found / total >= 0.97, (found, total)

    def test_unframed_changed_letter_from_four_words(self, quran: Quran) -> None:
        found, total = self.sweep(quran, "", "sub", min_words=4)
        assert total > 250 and found / total >= 0.97, (found, total)

    def test_the_difference_is_reported_and_fixed(self, quran: Quran) -> None:
        w = words(quran, 79, 35)
        e = list(w)
        e[2] = qf._misread(e[2])
        text = "درسنا اليوم عن يوم القيامة. قال تعالى: " + " ".join(e) + " ثم شرح المعلم الآية."
        a = find_quran_parts(text, "ar", quran)
        [part] = a.parts
        assert quran.location(part.g_lo)[:2] == (79, 35) and part.rule == "near"
        [diff] = a.parts_json()[0]["differences"]
        assert (diff["op"], diff["typed"], diff["mushaf_clean"]) == ("sub", e[2], w[2])
        assert " ".join(w) in a.mushaf_text()
        # The voice never reads it: neither the dictation plan nor the voice guard.
        plan = a.dictation_plan()
        assert [p["reader"] for p in plan] == ["voice", "voice", "grown_up", "voice"]
        assert is_quran_phrase(" ".join(e), quran)
        # The child is checked against the mushaf word, never the misquote.
        result, _ = a.check_recitation(text.replace(e[2], w[2]))
        assert result.n_errors == 0

    def test_a_misquoted_q1_text_stays_q1(self, quran: Quran) -> None:
        w = words(quran, 93, 7)
        k = next(i for i, x in enumerate(w) if any(c in qf.CONFUSED for c in x))
        e = list(w)
        e[k] = qf._misread(e[k])
        a = find_quran_parts("قال تعالى: " + " ".join(e), "ar", quran)
        assert a.is_quran and a.quran_range() == {"surah": 93, "from": 7, "to": 7}

    def test_no_hit_on_ordinary_text(self, quran: Quran, sentences) -> None:
        from mommy.guard import _key, near_short_ayat

        ordinary = [s for name in ("ordinary", "split", "quranic") for s in sentences[name]]
        assert len(ordinary) == 324
        for text in ordinary:
            assert near_short_ayat(quran, [_key(t) for t in tokenize(text, "ar")], lambda a, b: True) == [], text
        rng = random.Random(5)
        for _ in range(5000):
            text = " ".join(rng.sample(sentences["ordinary"], 2))
            assert near_short_ayat(quran, [_key(t) for t in tokenize(text, "ar")]) == [], text

    def test_two_errors_or_a_two_word_ayah_stay_ordinary(self, quran: Quran) -> None:
        # Measured limits: two words left of a three-word ayah, and a two-word ayah.
        w = words(quran, 112, 2)
        assert find_quran_parts("تعلمنا اليوم أن " + " ".join(w) + " وذهبنا إلى البيت.", "ar", quran).parts == []


# ---------------------------------------------------------------------------
# Words joined without a space (RL-2) and everyday formulas (RL-5)
# ---------------------------------------------------------------------------


class TestJoinedWords:
    """Quran words joined by a hyphen, an apostrophe, a minus sign, the Arabic letter
    mark, a tatweel or a zero-width character, or led by a conjunction: the voice refuses
    them, and the finder places them where it can."""

    JOINERS = ["-", "‐", "‑", "−", "؜", "'", "’", "ـ", "‌", "‍"]

    def test_the_voice_refuses_joined_ayat(self, quran: Quran) -> None:
        for joiner in self.JOINERS:
            for ref in [(112, 1), (1, 2), (114, 1)]:
                text = joiner.join(words(quran, *ref))
                assert is_quran_phrase(text, quran), (joiner, ref)
            long = joiner.join(words(quran, 2, 255)[:8])
            assert is_quran_phrase(long, quran), joiner
            assert is_quran_phrase("قال المعلم " + long, quran), joiner

    def test_arabic_words_are_split_at_a_hyphen_or_an_apostrophe(self, quran: Quran) -> None:
        for joiner in ["-", "‐", "‑", "−", "؜", "'", "’"]:
            text = joiner.join(words(quran, 112, 1))
            assert tokenize(text, "ar") == words(quran, 112, 1), joiner
            a = find_quran_parts("قال المعلم: " + text + " ثم سكت.", "ar", quran)
            assert [quran.location(p.g_lo)[:2] for p in a.parts] == [(112, 1)], joiner
        # Latin elisions and number ranges are unchanged.
        assert tokenize("l'école peut-être", "fr") == ["l'école", "peut-être"]
        assert tokenize("الآيات ١-٣", "ar") == ["الآيات", "١-٣"]

    def test_a_leading_conjunction(self, quran: Quran) -> None:
        ayah = " ".join(words(quran, 112, 1))
        for text in ["و" + ayah, "ف" + ayah, "قرأ الطالب و" + ayah + " بصوت جميل"]:
            assert is_quran_phrase(text, quran), text
            a = find_quran_parts(text, "ar", quran)
            [part] = a.parts
            # The part is the ayah's other words; the first stays with the sentence.
            assert part.rule == "contained" and quran.location(part.g_lo) == (112, 1, 1)
            assert not any(is_quran_phrase(p["phrase"], quran) for p in a.dictation_plan() if p["reader"] == "voice")
        assert not is_quran_phrase("وقال المعلم كلمة طيبة", quran)


class TestEverydayFormulas:
    """The everyday formulas stay ordinary words (2026-11-11, RL-5), whatever the commas:
    the dictation joins a formula the voice refuses on its own with a neighbouring phrase."""

    CONTEXTS = [
        "{f}.",
        "قال أبي: {f}، ثم خرجنا إلى المسجد.",
        "خرجنا إلى المسجد. {f}. ثم عدنا.",
        "سنذهب غدا {f} إلى البحر",
        "{f} على كل حال",
    ]

    def test_no_part_for_a_formula_in_a_text(self, quran: Quran) -> None:
        from mommy.quran import EVERYDAY_FORMULAS

        for f in EVERYDAY_FORMULAS:
            for ctx in self.CONTEXTS[1:]:
                text = ctx.format(f=f)
                a = find_quran_parts(text, "ar", quran)
                assert a.parts == [] and a.voice_safe, text
                plan = a.dictation_plan()
                assert {p["reader"] for p in plan} == {"voice"}, text
                assert not any(is_quran_phrase(p["phrase"], quran) for p in plan), text

    def test_a_text_that_is_only_a_formula(self, quran: Quran) -> None:
        # Nothing to join it with: the voice guard as built refuses it, so it is the one
        # case where a formula is read by a grown-up (never by the voice).
        a = find_quran_parts("لا إله إلا الله.", "ar", quran)
        assert [p["reader"] for p in a.dictation_plan()] == ["grown_up"]

    def test_everyday_phrases_cut_by_a_comma(self, quran: Quran) -> None:
        for text in [
            "قال التاجر: هذا من فضل ربي، ثم شكر الزبائن.",
            "كتب أبي على باب المحل هذا من فضل ربي.",
            "قالت أمي: سبحان الله وبحمده، ثم نامت.",
        ]:
            a = find_quran_parts(text, "ar", quran)
            assert a.parts == [], text
            assert not any(is_quran_phrase(p["phrase"], quran) for p in a.dictation_plan()), text

    def test_a_quotation_is_still_a_part(self, quran: Quran) -> None:
        text = "قال تعالى: " + " ".join(words(quran, 94, 6)) + "، فلا تيأسوا."
        assert [quran.location(p.g_lo)[:2] for p in find_quran_parts(text, "ar", quran).parts] == [(94, 6)]
