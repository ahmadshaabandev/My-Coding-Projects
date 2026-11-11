"""Tests for mommy.textnorm.

Quran words are never typed here: they are read from the verbatim Tanzil files and
picked by position or by a character pattern.
"""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from pathlib import Path

import pytest

from mommy.textnorm import (
    has_arabic,
    normalize_dictation_word,
    normalize_word,
    strip_tashkeel,
    token_spans,
    tokenize,
)

QURAN_DIR = Path(__file__).resolve().parent.parent / "data" / "quran"


# ---------------------------------------------------------------------------
# Tanzil helpers
# ---------------------------------------------------------------------------


@lru_cache(maxsize=None)
def _load(name: str) -> dict[tuple[int, int], str]:
    verses: dict[tuple[int, int], str] = {}
    for line in (QURAN_DIR / name).read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        surah, ayah, text = line.split("|", 2)
        verses[(int(surah), int(ayah))] = text
    return verses


def uthmani() -> dict[tuple[int, int], str]:
    return _load("quran-uthmani.txt")


def simple() -> dict[tuple[int, int], str]:
    return _load("quran-simple-clean.txt")


@lru_cache(maxsize=None)
def aligned_pairs(first: int, last: int) -> tuple[tuple[str, str], ...]:
    """(Uthmani word, Simple-Clean word) pairs of ayat whose word counts match."""
    pairs: list[tuple[str, str]] = []
    u, s = uthmani(), simple()
    for key in u:
        if not first <= key[0] <= last:
            continue
        uw, sw = tokenize(u[key], "ar"), tokenize(s[key], "ar")
        if len(uw) == len(sw):
            pairs.extend(zip(uw, sw))
    return tuple(pairs)


def agreement(pairs: tuple[tuple[str, str], ...]) -> float:
    same = sum(normalize_word(a, "ar") == normalize_word(b, "ar") for a, b in pairs)
    return same / len(pairs)


def word(source: dict[tuple[int, int], str], surah: int, ayah: int, index: int) -> str:
    return tokenize(source[(surah, ayah)], "ar")[index]


# ---------------------------------------------------------------------------
# The data files
# ---------------------------------------------------------------------------


def test_tanzil_files_are_complete() -> None:
    assert len(uthmani()) == 6236
    assert len(simple()) == 6236


# ---------------------------------------------------------------------------
# strip_tashkeel
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "first,last",
    [(0x0610, 0x061A), (0x064B, 0x065F), (0x0670, 0x0670), (0x0640, 0x0640), (0x06D6, 0x06ED)],
)
def test_strip_tashkeel_removes_every_mark_in_the_contract_ranges(first: int, last: int) -> None:
    for code in range(first, last + 1):
        mark = chr(code)
        text = "ك" + mark + "تب"  # ك<mark>تب
        assert strip_tashkeel(text) == "كتب", f"U+{code:04X}"


def test_strip_tashkeel_keeps_letters_spaces_and_punctuation() -> None:
    text = "قال، ثم مشى؟ نعم! 123"
    assert strip_tashkeel(text) == text
    assert strip_tashkeel("abc é") == "abc é"


def test_strip_tashkeel_keeps_neighbouring_letters_outside_the_ranges() -> None:
    # U+0621..U+064A letters and U+0671 wasla are not marks.
    letters = "".join(chr(c) for c in range(0x0621, 0x063B)) + "".join(chr(c) for c in range(0x0641, 0x064B)) + "ٱ"
    assert strip_tashkeel(letters) == letters


def test_strip_tashkeel_keeps_a_decomposed_hamza_as_a_letter() -> None:
    # alef + combining hamza above is canonically the letter أ: it must survive.
    assert strip_tashkeel("أَكَلَ") == "أكل"
    assert strip_tashkeel("إ") == "إ"


def test_strip_tashkeel_on_real_uthmani_line() -> None:
    line = uthmani()[(1, 2)]
    stripped = strip_tashkeel(line)
    assert not any(
        "ً" <= c <= "ٟ" or c in "ٰـ" or "ۖ" <= c <= "ۭ" for c in stripped
    )
    assert len(stripped.split()) == len(line.split())


# ---------------------------------------------------------------------------
# normalize_word: Arabic
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("أحمد", "احمد"),
        ("إبراهيم", "ابراهيم"),
        ("آمن", "امن"),
        ("ٱلحمد", "الحمد"),
        ("على", "علي"),
        ("مدرسة", "مدرسه"),
        ("مؤمن", "مومن"),
        ("بئر", "بير"),
        ("سماء", "سما"),
        ("شيء", "شي"),
        ("ء", "ء"),  # a lone hamza is kept
        ("مَدْرَسَةٌ", "مدرسه"),
        ("كـتـاب", "كتاب"),  # tatweel
        ("مرحبا،", "مرحبا"),
        ("لماذا؟", "لماذا"),
        ("؛", ""),
        ("١٢٣", "123"),
        ("۴۵۶", "456"),
        ("ﻻ", "لا"),  # presentation form of lam-alef
        ("ی", "ي"),  # Persian yeh
    ],
)
def test_normalize_word_arabic(raw: str, expected: str) -> None:
    assert normalize_word(raw, "ar") == expected


def test_normalize_word_arabic_spelling_variants_are_equal() -> None:
    # The variants a speech recogniser produces for the same word.
    for a, b in [("إلى", "الى"), ("مدرسة", "مدرسه"), ("أسئلة", "اسيله"), ("هذا", "هٰذا")]:
        assert normalize_word(a, "ar") == normalize_word(b, "ar")


def test_normalize_word_keep_tashkeel() -> None:
    w = "مَدْرَسَةٌ"
    kept = normalize_word(w, "ar", keep_tashkeel=True)
    assert "َ" in kept and "ْ" in kept and "ٌ" in kept
    assert strip_tashkeel(kept) == normalize_word(w, "ar")
    assert "ـ" not in normalize_word("كَـتَـب", "ar", keep_tashkeel=True)


@pytest.mark.parametrize(
    "vocalised,plain",
    [
        ("هٰذَا", "هذا"),
        ("ذٰلِكَ", "ذلك"),
        ("لٰكِنَّ", "لكن"),
        ("الرَّحْمٰنِ", "الرحمن"),
        ("اللّٰهُ", "الله"),
        ("إِلٰهٌ", "إله"),
        ("هٰؤُلَاءِ", "هؤلاء"),
        ("أُولٰئِكَ", "أولئك"),
        ("وَكَذٰلِكَ", "وكذلك"),
    ],
)
def test_superscript_alef_in_modern_text_matches_plain_spelling(vocalised: str, plain: str) -> None:
    # Modern vocalised text writes these words with a superscript alef that standard
    # spelling never writes as an alef.
    assert normalize_word(vocalised, "ar") == normalize_word(plain, "ar")


def test_normalize_word_is_idempotent_on_quran_words() -> None:
    for source in (uthmani(), simple()):
        for key in list(source)[:800]:
            for w in tokenize(source[key], "ar"):
                once = normalize_word(w, "ar")
                assert normalize_word(once, "ar") == once, w


# ---------------------------------------------------------------------------
# Uthmani vs Simple-Clean agreement (measured on the verbatim files)
# ---------------------------------------------------------------------------


def test_agreement_juz_amma_surahs_78_to_114() -> None:
    pairs = aligned_pairs(78, 114)
    assert len(pairs) > 2300
    rate = agreement(pairs)
    # Measured: 2402 / 2413 = 99.5%. Without the Uthmani rules it is 92.2%.
    assert rate >= 0.99, rate


def test_agreement_whole_quran() -> None:
    pairs = aligned_pairs(1, 114)
    rate = agreement(pairs)
    # Measured: 99.52% (70,455) of 70,798 aligned word pairs.
    assert rate >= 0.99, rate


def test_rahman_with_superscript_alef_matches_simple_spelling() -> None:
    # Ayah 1:3 starts with the word ar-Rahman in both files.
    u, s = word(uthmani(), 1, 3, 0), word(simple(), 1, 3, 0)
    assert "ٰ" in u and "ٱ" in u
    assert normalize_word(u, "ar") == normalize_word(s, "ar") == s


def test_wasla_matches_plain_alef() -> None:
    u, s = word(uthmani(), 1, 2, 0), word(simple(), 1, 2, 0)
    assert u.startswith("ٱ")
    assert normalize_word(u, "ar") == normalize_word(s, "ar")


def test_alamin_superscript_alef_is_a_written_alef() -> None:
    # 1:2 ends with al-'alamin: Uthmani writes the long a as a superscript alef,
    # Simple-Clean writes a full alef.
    u, s = word(uthmani(), 1, 2, -1), word(simple(), 1, 2, -1)
    assert "ٰ" in u and "ا" in s[2:]
    assert normalize_word(u, "ar") == normalize_word(s, "ar")


def _pairs_with(predicate) -> list[tuple[str, str]]:
    return [(a, b) for a, b in aligned_pairs(1, 114) if predicate(unicodedata.normalize("NFC", a))]


@pytest.mark.parametrize(
    "name,predicate,min_examples",
    [
        ("superscript alef after waw (salah)", lambda w: "وٰ" in w, 50),
        ("final alef maksura with superscript alef", lambda w: w.rstrip("ٓۡۚۖۗ").endswith("ىٰ"), 300),
        ("medial alef maksura with superscript alef", lambda w: "ىٰ" in w.rstrip("ٓ").rstrip("ٰ")[:-1], 50),
        ("small waw / yeh after a final pronoun heh", lambda w: w.endswith(("هُۥ", "هِۦ")), 500),
        ("small waw inside a word", lambda w: "ۥ" in w[:-1] and "ۥٓ" not in w, 10),
        ("small high yeh", lambda w: "ۧ" in w, 20),
        ("hamza above on tatweel", lambda w: "ـ" in w and "ٔ" in w, 500),
        ("superscript alef elsewhere", lambda w: "ٰ" in w and "وٰ" not in w and "ىٰ" not in w, 3000),
    ],
)
def test_uthmani_rules_agree_with_simple_spelling(name: str, predicate, min_examples: int) -> None:
    pairs = _pairs_with(predicate)
    assert len(pairs) >= min_examples, (name, len(pairs))
    rate = agreement(tuple(pairs))
    assert rate >= 0.95, (name, rate)


def test_standalone_pause_marks_are_not_tokens() -> None:
    for key in [(2, 2), (2, 5), (78, 37)]:
        line = uthmani()[key]
        letter_words = [w for w in line.split() if any(unicodedata.category(c) == "Lo" for c in w)]
        assert tokenize(line, "ar") == letter_words
        assert len(tokenize(line, "ar")) < len(line.split()) or key == (78, 37)


def test_uthmani_and_simple_token_counts_match_for_most_ayat() -> None:
    u, s = uthmani(), simple()
    same = sum(len(tokenize(u[k], "ar")) == len(tokenize(s[k], "ar")) for k in u)
    assert same / len(u) > 0.9


# ---------------------------------------------------------------------------
# normalize_word: English and French
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,lang,keep_accents,expected",
    [
        ("Hello,", "en", True, "hello"),
        ("DON'T", "en", True, "don't"),
        ("don’t", "en", True, "don't"),
        ("'quoted'", "en", True, "quoted"),
        ("students'", "en", True, "students"),
        ("well-known", "en", True, "well-known"),
        ("-dash-", "en", True, "dash"),
        ("L'École", "fr", True, "l'école"),
        ("l’école", "fr", True, "l'école"),
        ("l´école", "fr", True, "l'école"),
        ("L'École", "fr", False, "l'ecole"),
        ("aujourd’hui", "fr", True, "aujourd'hui"),
        ("Peut-être", "fr", False, "peut-etre"),
        ("«Bonjour»", "fr", True, "bonjour"),
        ("Cœur", "fr", True, "coeur"),
        ("ça", "fr", False, "ca"),
        ("Noël!", "fr", True, "noël"),
        ("50%", "en", True, "50"),
        ("…", "en", True, ""),
        ("été", "fr", True, "été"),  # decomposed accents
    ],
)
def test_normalize_word_latin(raw: str, lang: str, keep_accents: bool, expected: str) -> None:
    assert normalize_word(raw, lang, keep_accents=keep_accents) == expected


def test_normalize_word_accents_kept_by_default() -> None:
    assert normalize_word("été", "fr") == "été"
    assert normalize_word("été", "fr") != normalize_word("ete", "fr")
    assert normalize_word("été", "fr", keep_accents=False) == normalize_word("ete", "fr", keep_accents=False)


# ---------------------------------------------------------------------------
# normalize_dictation_word
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "a,b",
    [
        ("مدرسة", "مدرسه"),  # ta marbuta vs ha
        ("إلى", "الى"),  # hamza seat
        ("أكل", "اكل"),
        ("آمن", "امن"),
        ("على", "علي"),  # alef maksura vs ya
        ("مؤمن", "مومن"),
        ("سماء", "سما"),
        ("été", "ete"),
        ("où", "ou"),
    ],
)
def test_dictation_keeps_spelling_distinctions(a: str, b: str) -> None:
    lang = "ar" if has_arabic(a) else "fr"
    assert normalize_dictation_word(a, lang) != normalize_dictation_word(b, lang)


@pytest.mark.parametrize(
    "a,b",
    [
        ("مَدْرَسَةٌ", "مدرسة"),
        ("كـتـاب", "كتاب"),
        ("ٱلحمد", "الحمد"),
        ("مرحبا،", "مرحبا"),
        ("École", "école"),
        ("l’école", "l'école"),
        ("cœur", "coeur"),
        ("Bonjour!", "bonjour"),
    ],
)
def test_dictation_ignores_tashkeel_case_and_punctuation(a: str, b: str) -> None:
    lang = "ar" if has_arabic(a) else "fr"
    assert normalize_dictation_word(a, lang) == normalize_dictation_word(b, lang)


def test_dictation_strict_tashkeel() -> None:
    assert normalize_dictation_word("مَدْرَسَةٌ", "ar", keep_tashkeel=True) != normalize_dictation_word(
        "مدرسة", "ar", keep_tashkeel=True
    )
    # Mark order does not matter (NFC): shadda+fatha == fatha+shadda.
    assert normalize_dictation_word("شَّم", "ar", keep_tashkeel=True) == normalize_dictation_word(
        "شَّم", "ar", keep_tashkeel=True
    )
    assert "ـ" not in normalize_dictation_word("كَـتَـبَ", "ar", keep_tashkeel=True)


# ---------------------------------------------------------------------------
# tokenize
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text,lang,expected",
    [
        ("L'école est fermée aujourd'hui.", "fr", ["L'école", "est", "fermée", "aujourd'hui"]),
        ("Qu'il vienne, jusqu’à demain !", "fr", ["Qu'il", "vienne", "jusqu’à", "demain"]),
        ("« Bonjour », dit-il.", "fr", ["Bonjour", "dit-il"]),
        ("I don't know, she said.", "en", ["I", "don't", "know", "she", "said"]),
        ("Don’t stop—keep going!", "en", ["Don’t", "stop", "keep", "going"]),
        ("ذهب الولد، ثم عاد؛ هل فهمت؟", "ar", ["ذهب", "الولد", "ثم", "عاد", "هل", "فهمت"]),
        ("الكِتابُ مُفيدٌ.", "ar", ["الكِتابُ", "مُفيدٌ"]),
        ("Le prix est 3,5 euros à 12:30.", "fr", ["Le", "prix", "est", "3,5", "euros", "à", "12:30"]),
        ("عندي ٣٫٥ كتب", "ar", ["عندي", "٣٫٥", "كتب"]),
        ("  ", "en", []),
        ("", "fr", []),
        ("... !!! ،،", "ar", []),
        ("'hello' -world-", "en", ["hello", "world"]),
        ("rock'n'roll", "en", ["rock'n'roll"]),
        ("a , b", "en", ["a", "b"]),
    ],
)
def test_tokenize(text: str, lang: str, expected: list[str]) -> None:
    assert tokenize(text, lang) == expected


def test_tokenize_keeps_surface_forms() -> None:
    text = "L’ÉCOLE, c'est   génial"
    assert tokenize(text, "fr") == ["L’ÉCOLE", "c'est", "génial"]


def test_tokenize_drops_lone_tatweel_and_marks() -> None:
    assert tokenize("ـ ۚ ۖ كتاب", "ar") == ["كتاب"]


def test_token_spans_match_tokenize() -> None:
    for text, lang in [
        ("L'école est fermée aujourd'hui.", "fr"),
        (uthmani()[(2, 255)], "ar"),
        ("I don't know—maybe 3,5?", "en"),
    ]:
        spans = token_spans(text, lang)
        assert [text[a:b] for a, b in spans] == tokenize(text, lang)
        assert all(a < b for a, b in spans)
        assert all(spans[i][1] <= spans[i + 1][0] for i in range(len(spans) - 1))


def test_elision_and_contraction_normalise_with_either_apostrophe() -> None:
    for a, b, lang in [("l'école", "l’école", "fr"), ("don't", "don’t", "en"), ("qu'il", "qu’il", "fr")]:
        assert tokenize(a, lang) == [a] and tokenize(b, lang) == [b]
        assert normalize_word(a, lang) == normalize_word(b, lang)


# ---------------------------------------------------------------------------
# Same-sound hamza spellings (speech key only)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("older", "modern"),
    [
        ("رءوف", "رؤوف"),
        ("مسئول", "مسؤول"),
        ("مسئولا", "مسؤولا"),
        ("جاءوا", "جاؤوا"),
        ("يستهزئون", "يستهزؤون"),
        ("رءوسهم", "رؤوسهم"),
        ("شئون", "شؤون"),
        ("مائة", "مئة"),
        ("مائتين", "مئتين"),
        ("ثلاثمائة", "ثلاثمئة"),
        ("داوود", "داود"),
    ],
)
def test_same_sound_hamza_spellings_share_the_speech_key(older: str, modern: str) -> None:
    assert normalize_word(older, "ar") == normalize_word(modern, "ar")
    # Dictation: the spelling is what is checked, so they stay different.
    assert normalize_dictation_word(older, "ar") != normalize_dictation_word(modern, "ar")


def test_hamza_folding_leaves_other_words_alone() -> None:
    assert normalize_word("مائدة", "ar") != normalize_word("مئدة", "ar")
    assert normalize_word("سؤال", "ar") != normalize_word("سأل", "ar")
    assert normalize_word("مؤمن", "ar") == normalize_word("مومن", "ar")  # as before


def test_simple_clean_words_match_their_modern_spelling() -> None:
    # Regression: 147 Simple-Clean tokens (66 distinct words in 140 ayat) used to have a
    # speech key different from that of their modern spelling, which the recogniser
    # writes, so a correctly recited word was reported as a substitution.
    import re

    def modern(w: str) -> str:
        w = re.sub("[ءئ]و", "ؤو", w)
        w = re.sub("مائ(?=[ةت])", "مئ", w)
        return w.replace("داوود", "داود")

    changed = 0
    for text in simple().values():
        for w in tokenize(text, "ar"):
            m = modern(w)
            if m != w:
                changed += 1
                assert normalize_word(m, "ar") == normalize_word(w, "ar"), w
    assert changed == 147


def test_uthmani_hamza_on_tatweel_before_waw_matches_simple_clean() -> None:
    # Uthmani writes the hamza of these words on a tatweel; its seat must fold the same
    # way as the Simple-Clean spelling. Picked by pattern from the verbatim files.
    u, s = uthmani(), simple()
    checked = 0
    for key in u:
        uw, sw = tokenize(u[key], "ar"), tokenize(s[key], "ar")
        if len(uw) != len(sw):
            continue
        for a, b in zip(uw, sw):
            if re.search("[ءئ]و", b) and "ـ" in a:
                checked += 1
                assert normalize_word(a, "ar") == normalize_word(b, "ar"), (key, b)
    assert checked > 10
