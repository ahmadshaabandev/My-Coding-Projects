"""The Quran module: verbatim Tanzil text, strict recitation checks and hifz search.

Hard rule 4 of the contract applies to everything here:

* the text comes only from the verbatim Tanzil files in ``data/quran/``
  (``quran-uthmani.txt`` for display, ``quran-simple-clean.txt`` for matching, and the
  Tanzil metadata ``quran-data.js`` for the Arabic surah names and ayah counts). Nothing is
  generated, completed or "fixed"; the files are only read;
* checking is strict, word by word, and decided by deterministic code
  (:func:`mommy.align.align`). No LLM and no speech synthesis is involved.

Two scripts of one line
-----------------------
Every ayah has two verbatim lines: the Uthmani line, which is shown to the child, and the
Simple-Clean line (standard spelling, no marks), which is compared with what the speech
recogniser heard. :class:`Ayah` keeps both, split into words, plus ``word_map``, which
gives for each match (Simple-Clean) word the display (Uthmani) word it belongs to.

The two scripts do not always have the same number of words. Uthmani writes the vocative
and a few assimilated forms as one word where standard spelling has two or three (the
vocative particle and its noun in 2:21 and many other ayat; three words in 20:94). Of
the 6236 ayat, **363** have a different word count in the two files (359 differ by one
word, 4 by two; in every one of them Simple-Clean has more words). ``word_map`` is built
by a monotonic alignment over the two word sequences (:func:`build_word_map`): one-to-one
steps and 2/3-to-one and one-to-2/3 merges, scored on the speech keys of
:func:`mommy.align.recitation_key`. Every map is monotonic, in range and covers every
display word.

Standalone Quranic pause marks (tokens made only of U+06D6-U+06ED: the small high
pause signs, the rub el hizb U+06DE and the sajdah sign U+06E9) are not words: they are
left out of ``display_words`` but kept in ``display``, which is always the verbatim line.

The basmala
-----------
The Tanzil txt files prefix ayah 1 of every surah except 1 and 9 with the basmala. It is
detected from the files themselves: the Simple-Clean basmala is the 4 words of 1:1, and
the number of leading Uthmani words that correspond to it is found by comparing their
speech keys with those of 1:1 in Uthmani (it is 4 in all 112 surahs; two of them, 95 and
97, spell the first word with an extra shadda, so the comparison is on keys, not bytes).
That prefix is removed from ``display``, ``match`` and both word lists. Surah 1 keeps it
(the basmala is ayah 1) and surah 9 has none. The full raw lines stay available through
:meth:`Quran.raw_lines`.

Checking
--------
:meth:`Quran.check` aligns the heard words with the match words of an ayah range and maps
every op back to ``(surah, ayah, display word)``. A leading isti'adha and a leading
basmala in the heard text are ignored: exactly, or with a small ASR tolerance (one wrong
word in the basmala, two in the isti'adha) when ignoring them strictly lowers the number
of errors. The basmala is not ignored when the range itself begins with it (1:1).

Hifz search
-----------
:meth:`Quran.locate` answers "where am I?" from a few recited words, with an inverted
index of the 3- to 7-word n-grams of the normalised match words of the whole Quran (one
sorted array of 64-bit n-gram hashes per n, hits verified word by word). Hits are grouped
by alignment diagonal (allowing a shift of two words for an inserted or dropped word) and
every group is scored by the share of heard words found in order at that place (a banded
longest common subsequence), then by the longest exact run and the number of matched
n-grams.

Measured on this machine (4 CPUs, no GPU) with ``tests/test_quran.py``:

* 7-word windows of normalised match words (inside one surah) that occur only once in
  the Quran: 96.48% of 77,116 (96.51% if windows may cross surah boundaries);
* 200 random 7-word windows in surahs 78-114 (fixed seed): top-1 correct 100%; with one
  word substituted 99.5%; with one word dropped 99.5%; with one word added inside the
  window 100%. A word added before the first one cannot be told apart from a wrong
  first word, and is then located one word early;
* ``Quran()`` construction in a fresh process: about 0.9 s; ``locate``: about 1-2 ms
  for 7 words, about 20 ms at worst (a single very frequent word).
"""

from __future__ import annotations

import difflib
import functools
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np

from .align import Op, align, align_with_joins, build_result, recitation_key
from .textnorm import tokenize

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

UTHMANI_FILE = "quran-uthmani.txt"
SIMPLE_CLEAN_FILE = "quran-simple-clean.txt"
METADATA_FILE = "quran-data.js"

N_SURAHS = 114
N_AYAT = 6236

ATTRIBUTION = "Quran text: Tanzil Project (tanzil.net), Hafs, Uthmani v1.1, CC BY 3.0, verbatim"
SOURCE_URL = "https://tanzil.net"
RIWAYA = "hafs"

#: Surahs whose first ayah carries no basmala prefix in the Tanzil files: in surah 1 the
#: basmala is ayah 1 itself, and surah 9 has none.
NO_BASMALA_PREFIX: tuple[int, ...] = (1, 9)

#: The isti'adha, as given in the contract (it is not Quran text, so it is not read from
#: the Tanzil files). Only its speech key is used.
ISTIADHA = "اعوذ بالله من الشيطان الرجيم"

#: Wrong, missing or extra heard words tolerated inside a leading isti'adha / basmala.
ISTIADHA_MAX_ERRORS = 2
BASMALA_MAX_ERRORS = 1
#: Words of the short forms said instead of the formulas (``أعوذ بالله``, ``بسم الله``):
#: removed only when heard exactly and when that lowers the errors.
SHORT_FORMULA_WORDS = 2
#: Expected words compared when choosing how many leading heard words are a formula.
FORMULA_WINDOW = 12

#: The disjoined letters (muqatta'at) that open 29 surahs, as (surah, ayah) of the ayah
#: whose first word they are. The words themselves are read from the Tanzil text; a
#: reciter says the letters by name (``الم`` is recited ``ألف لام ميم``).
MUQATTAAT_AYAT: tuple[tuple[int, int], ...] = tuple(
    (s, 1) for s in (2, 3, 7, 10, 11, 12, 13, 14, 15, 19, 20, 26, 27, 28, 29, 30, 31, 32, 36,
                     38, 40, 41, 42, 43, 44, 45, 46, 50, 68)
) + ((42, 2),)
#: The spoken name of each letter that occurs in the muqatta'at, as the recogniser writes
#: it (a final hamza, as in راء, is dropped by the speech key).
LETTER_NAMES: dict[str, str] = {
    "\u0627": "ألف", "\u0644": "لام", "\u0645": "ميم", "\u0635": "صاد", "\u0631": "راء",
    "\u0643": "كاف", "\u0647": "هاء", "\u064a": "ياء", "\u0639": "عين", "\u0637": "طاء",
    "\u0633": "سين", "\u062d": "حاء", "\u0642": "قاف", "\u0646": "نون",
}

#: Framing formulas around a quoted ayah ("the Exalted said: ...", "God the Almighty has
#: spoken the truth"), left out before :meth:`Quran.quran_runs` and the guard score.
FRAMING_FORMULAS: tuple[str, ...] = (
    "صدق الله العظيم",
    "قال الله تعالى",
    "قال الله عز وجل",
    "يقول الله تعالى",
    "قال تعالى",
    "قوله تعالى",
    ISTIADHA,
)

#: Everyday formulas whose words are also a few consecutive words of the Quran (said
#: before a meal, on good news, as a promise). The contextual-mode run rule
#: (:meth:`Quran.quran_runs` with ``exclude_formulas``) does not let a run pass through
#: them, so "إن شاء الله سنذهب غدا" or a sentence with the shahada is not refused for its
#: formula. The other rules still see these words. Measured on
#: ``tests/arabic_school_sentences.txt`` (see ``docs/CONTRACT.md``).
EVERYDAY_FORMULAS: tuple[str, ...] = (
    "بسم الله",
    "الحمد لله",
    "سبحان الله",
    "إن شاء الله",
    "ما شاء الله",
    "لا إله إلا الله",
    "لا حول ولا قوة إلا بالله",
    "لا قوة إلا بالله",
    "حسبنا الله ونعم الوكيل",
    "توكلت على الله",
    "الله أكبر",
    "أستغفر الله",
)

#: Whole ayat of three words that are also everyday Arabic phrases, as ثم نظر is for two
#: words ("in it are valuable books", "about what they were doing", "nor a close
#: friend", ...). :meth:`Quran.contained_ayat` does not count them inside a longer
#: phrase; a phrase that is exactly one of them is still a whole ayah
#: (:meth:`Quran.whole_ayah`). Given by number, so no Quran word is typed here; each one
#: must be a whole ayah of three words (checked when the text is loaded). Measured on
#: ``tests/arabic_school_sentences.txt`` (see ``docs/CONTRACT.md``).
EVERYDAY_AYAT: tuple[tuple[int, int], ...] = (
    (15, 93),   # about what they were doing
    (26, 101),  # nor a close friend
    (74, 18),   # he thought and weighed it up
    (74, 30),   # over it are nineteen
    (82, 12),   # they know what you do
    (86, 14),   # and it is not a jest
    (88, 12),   # in it is a flowing spring
    (98, 3),    # in it are valuable books
)

#: Longest ayah, in words, that :meth:`Quran.contained_ayat` looks for. A longer ayah
#: is a run of five Quran words, which the general guard already refuses.
SHORT_AYAH_MAX_WORDS = 4

#: Penalty per extra word of a merged step in :func:`build_word_map`.
MERGE_PENALTY = 0.25
#: Largest number of words merged into one in :func:`build_word_map`.
MAX_MERGE = 3

#: n-gram sizes of the hifz index.
NGRAM_MIN = 3
NGRAM_MAX = 7
#: Diagonal shift (inserted or dropped words) tolerated inside one locate candidate.
LOCATE_BAND = 2
#: Only the first words of a long recitation are used to locate it.
LOCATE_MAX_WORDS = 40
#: Candidate groups that are scored in detail, per heard variant.
LOCATE_MAX_GROUPS = 64
#: Display words in a locate preview.
PREVIEW_WORDS = 8

_SEPARATOR = -1  # word id between surahs: never matches
_UNKNOWN = -2  # heard word id for a word that does not occur in the Quran
_HASH_BASE = np.uint64(0x9E3779B97F4A7C15)


def _speech_key(token: str) -> str:
    """The comparison key of an Arabic token for speech (see ``align.recitation_key``)."""
    return recitation_key(token, "ar")


def _identity(token: str) -> str:
    return token


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Ayah:
    """One ayah, with its display (Uthmani) and match (Simple-Clean) forms.

    The lists are shared with the :class:`Quran` that built the ayah: treat them as
    read-only.
    """

    surah: int
    ayah: int
    display: str  # verbatim Uthmani line (with the basmala prefix removed for ayah 1, except surah 1)
    match: str  # verbatim Simple-Clean line (with the same basmala handling)
    display_words: list[str]
    match_words: list[str]
    word_map: list[int]  # for each match word index, the display word index (handles يا أيها vs يَـٰٓأَيُّهَا)


@dataclass(frozen=True)
class SurahInfo:
    """One row of the Tanzil surah metadata (``QuranData.Sura`` in ``quran-data.js``)."""

    number: int
    start: int  # index of the surah's first ayah in the whole Quran (0-based)
    ayah_count: int
    order: int  # revelation order
    rukus: int
    name_ar: str
    name_translit: str
    name_en: str
    revelation: str  # "Meccan" or "Medinan"


# ---------------------------------------------------------------------------
# Readers
# ---------------------------------------------------------------------------


def read_tanzil_text(path: Path) -> tuple[dict[tuple[int, int], str], list[str]]:
    """Read a Tanzil txt-2 file (``sura|aya|text`` lines).

    Returns ``({(surah, ayah): text}, licence_lines)`` with the ayat in file order and
    the ``#`` lines (the licence block) as they are. Blank lines are skipped. Raises
    ValueError on a malformed line or a repeated ``(surah, ayah)``.
    """
    verses: dict[tuple[int, int], str] = {}
    licence: list[str] = []
    with open(path, encoding="utf-8", newline="") as f:
        content = f.read()
    for lineno, raw in enumerate(content.split("\n"), start=1):
        line = raw.rstrip("\r")
        if not line.strip():
            continue
        if line.startswith("#"):
            licence.append(line)
            continue
        parts = line.split("|", 2)
        if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit() or not parts[2].strip():
            raise ValueError(f"{path.name}:{lineno}: not a 'sura|aya|text' line")
        key = (int(parts[0]), int(parts[1]))
        if key in verses:
            raise ValueError(f"{path.name}:{lineno}: ayah {key[0]}:{key[1]} appears twice")
        verses[key] = parts[2]
    return verses, licence


_JS_TOKEN_RE = re.compile(r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"|(-?\d+)")
_JS_ESCAPE_RE = re.compile(r"\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)", re.DOTALL)
_JS_SIMPLE_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}


def _js_unescape(s: str) -> str:
    def repl(m: re.Match[str]) -> str:
        e = m.group(1)
        if e[0] in "ux" and len(e) > 1:
            return chr(int(e[1:], 16))
        return _JS_SIMPLE_ESCAPES.get(e, e)

    return _JS_ESCAPE_RE.sub(repl, s)


def read_surah_metadata(path: Path) -> list[SurahInfo]:
    """Parse the surah table of the Tanzil metadata file ``quran-data.js``.

    The file is a JavaScript source; only the ``QuranData.Sura = [...]`` array is read,
    with its rows ``[start, ayas, order, rukus, name, tname, ename, type]``, a leading
    empty row and a trailing ``[6236, 1]`` sentinel. Raises ValueError unless there are
    114 rows whose start offsets add up and whose ayah counts total 6236.
    """
    text = Path(path).read_text(encoding="utf-8")
    m = re.search(r"QuranData\.Sura\s*=\s*\[(.*?)\n\s*\];", text, re.DOTALL)
    if m is None:
        raise ValueError(f"{Path(path).name}: no QuranData.Sura table")
    # Drop comment lines (the column legend is itself written as a bracketed list).
    body = "\n".join(line for line in m.group(1).split("\n") if not line.strip().startswith("//"))
    rows: list[list[int | str]] = []
    for row in re.findall(r"\[([^\[\]]*)\]", body):
        fields: list[int | str] = []
        for single, double, number in _JS_TOKEN_RE.findall(row):
            if number:
                fields.append(int(number))
            else:
                fields.append(_js_unescape(single or double))
        rows.append(fields)

    if len(rows) != N_SURAHS + 2 or rows[0] != [] or rows[-1] != [N_AYAT, 1]:
        raise ValueError(f"{Path(path).name}: expected an empty row, {N_SURAHS} surahs and a sentinel")
    surahs: list[SurahInfo] = []
    expected_start = 0
    for number, row in enumerate(rows[1:-1], start=1):
        if len(row) != 8 or not all(isinstance(v, int) for v in row[:4]) or not all(
            isinstance(v, str) and v for v in row[4:]
        ):
            raise ValueError(f"{Path(path).name}: malformed row for surah {number}")
        start, ayas, order, rukus = (int(v) for v in row[:4])
        if start != expected_start or ayas < 1:
            raise ValueError(f"{Path(path).name}: surah {number} starts at {start}, expected {expected_start}")
        expected_start += ayas
        surahs.append(
            SurahInfo(
                number=number,
                start=start,
                ayah_count=ayas,
                order=order,
                rukus=rukus,
                name_ar=str(row[4]),
                name_translit=str(row[5]),
                name_en=str(row[6]),
                revelation=str(row[7]),
            )
        )
    if expected_start != N_AYAT:
        raise ValueError(f"{Path(path).name}: ayah counts total {expected_start}, expected {N_AYAT}")
    return surahs


# ---------------------------------------------------------------------------
# Words
# ---------------------------------------------------------------------------


def is_pause_mark_token(token: str) -> bool:
    """True for a token made only of Quranic annotation marks (U+06D6-U+06ED).

    In the Uthmani text such tokens stand between words (pause marks, the rub el hizb,
    the sajdah sign). They are not words.
    """
    return bool(token) and all("\u06d6" <= c <= "\u06ed" for c in token)


def display_tokens(line: str) -> list[str]:
    """The display words of an Uthmani line: whitespace-separated, pause marks left out."""
    return [t for t in line.split() if not is_pause_mark_token(t)]


def _drop_leading_words(line: str, count: int, *, skip: Callable[[str], bool] | None = None) -> str:
    """``line`` without its first ``count`` whitespace-separated words.

    Tokens for which ``skip`` returns True are passed over without being counted. The
    rest of the line is returned exactly as it is (after the whitespace that follows the
    last dropped word).
    """
    pos = 0
    dropped = 0
    for m in re.finditer(r"\S+", line):
        if skip is not None and skip(m.group()):
            continue
        dropped += 1
        if dropped == count:
            pos = m.end()
            break
    else:
        raise ValueError("the line has fewer words than the prefix")
    return line[pos:].lstrip()


@functools.lru_cache(maxsize=1 << 16)
def _char_distance(a: str, b: str) -> float:
    """Character Levenshtein distance between two keys, divided by the longer length."""
    if a == b:
        return 0.0
    if not a or not b:
        return 1.0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i]
        for j, cb in enumerate(b, start=1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1] / len(a)


def _mappable(n: int, m: int) -> bool:
    """True when n match words can be aligned onto m display words with the steps of
    :func:`build_word_map`."""
    return (n == m == 0) or (n > 0 and m > 0 and n <= MAX_MERGE * m and m <= MAX_MERGE * n)


def build_word_map(match_keys: Sequence[str], display_keys: Sequence[str]) -> list[int]:
    """Map each match word to a display word by a monotonic alignment.

    ``match_keys`` and ``display_keys`` are the speech keys of the Simple-Clean and the
    Uthmani words of one ayah. The alignment uses the steps one-to-one, k-to-one and
    one-to-k (k = 2 or 3, at most :data:`MAX_MERGE`): a step costs the normalised
    character edit distance between the joined keys on both sides, plus
    :data:`MERGE_PENALTY` per extra word. The cheapest alignment that uses every word of
    both sides is taken; ties prefer one-to-one, then merges of match words.

    For speed, runs of identical keys (found with :class:`difflib.SequenceMatcher`) are
    taken as one-to-one anchors and the search runs only on the gaps between them; when
    a gap cannot be aligned on its own (one side empty), the whole ayah is searched.
    ``tests/test_quran.py`` checks that this gives the same maps as the full search on
    every ayah of the Quran.

    Returns, for each match word, the index of its display word. The result is
    non-decreasing, starts at 0, ends at ``len(display_keys) - 1`` and steps by at most
    :data:`MAX_MERGE`. With a one-to-k step the match word maps to the first of the k
    display words. Raises ValueError when no such alignment exists (one side more than
    three times longer than the other, or one side empty but not the other).
    """
    n, m = len(match_keys), len(display_keys)
    if not _mappable(n, m):
        raise ValueError(f"cannot map {n} match words onto {m} display words")
    if n == m and all(a == b for a, b in zip(match_keys, display_keys)):
        return list(range(n))  # cost 0, and every merge costs more

    word_map: list[int] = []
    i = j = 0
    blocks = difflib.SequenceMatcher(None, match_keys, display_keys, autojunk=False).get_matching_blocks()
    for block in blocks:  # the last block is the sentinel (n, m, 0)
        gap_n, gap_m = block.a - i, block.b - j
        if gap_n or gap_m:
            if not _mappable(gap_n, gap_m):
                return search_word_map(match_keys, display_keys)
            word_map.extend(j + d for d in search_word_map(match_keys[i : block.a], display_keys[j : block.b]))
        word_map.extend(range(block.b, block.b + block.size))
        i, j = block.a + block.size, block.b + block.size
    return word_map


def search_word_map(match_keys: Sequence[str], display_keys: Sequence[str]) -> list[int]:
    """The full alignment search of :func:`build_word_map`, without anchors."""
    n, m = len(match_keys), len(display_keys)
    if not _mappable(n, m):
        raise ValueError(f"cannot map {n} match words onto {m} display words")
    if n == 0:
        return []

    moves = [(1, 1)] + [(k, 1) for k in range(2, MAX_MERGE + 1)] + [(1, k) for k in range(2, MAX_MERGE + 1)]
    # Search a band around the straight path: i - j stays within the overall difference
    # plus one local merge each way.
    slack = MAX_MERGE - 1
    lo_diff, hi_diff = min(0, n - m) - slack, max(0, n - m) + slack

    inf = math.inf
    cost: dict[tuple[int, int], float] = {(n, m): 0.0}
    step: dict[tuple[int, int], tuple[int, int]] = {}
    for i in range(n, -1, -1):
        for j in range(min(m, i - lo_diff), max(0, i - hi_diff) - 1, -1):
            if (i, j) == (n, m):
                continue
            best, best_move = inf, None
            for di, dj in moves:
                rest = cost.get((i + di, j + dj), inf)
                if rest == inf:
                    continue
                left = "".join(match_keys[i : i + di])
                right = "".join(display_keys[j : j + dj])
                c = _char_distance(left, right) + MERGE_PENALTY * (di + dj - 2) + rest
                if c < best:
                    best, best_move = c, (di, dj)
            if best_move is not None:
                cost[(i, j)] = best
                step[(i, j)] = best_move
    if (0, 0) not in step:
        raise ValueError(f"cannot map {n} match words onto {m} display words")

    word_map: list[int] = []
    i = j = 0
    while i < n:
        di, dj = step[(i, j)]
        word_map.extend([j] * di)
        i, j = i + di, j + dj
    return word_map


def _count_errors(expected: Sequence[str], heard: Sequence[str]) -> int:
    """Word edit distance between two key sequences (via :func:`mommy.align.align`)."""
    return _count_errors_cached(tuple(expected), tuple(heard))


@functools.lru_cache(maxsize=1 << 14)
def _count_errors_cached(expected: tuple[str, ...], heard: tuple[str, ...]) -> int:
    # The formula checks compare the same short sequences again and again.
    return sum(op.kind != "match" for op in align(list(expected), list(heard), _identity))


def _leading_formula(formula: Sequence[str], heard: Sequence[str], max_errors: int) -> tuple[int, int] | None:
    """Find a formula (isti'adha, basmala) at the start of the heard keys.

    Tries every prefix length within ``max_errors`` of the formula's length and returns
    ``(prefix_length, errors)`` for the closest one (fewest word errors, then the length
    nearest the formula's, then the shorter), or None when it needs more than
    ``max_errors`` errors.
    """
    f = len(formula)
    # Fast exit (exact): within max_errors, at least f - max_errors formula words must be
    # matched, and only words of the formula found in the longest prefix tried can match.
    words = set(formula)
    if sum(1 for key in heard[: f + max_errors] if key in words) < f - max_errors:
        return None
    best: tuple[int, int, int] | None = None
    for k in range(max(1, f - max_errors), min(len(heard), f + max_errors) + 1):
        errors = _count_errors(formula, heard[:k])
        cand = (errors, abs(k - f), k)
        if best is None or cand < best:
            best = cand
    if best is None or best[0] > max_errors:
        return None
    return best[2], best[0]


def _indel_errors(expected: Sequence[str], heard: Sequence[str]) -> int:
    """Missing plus extra words between two key sequences.

    The insert/delete distance (``len(expected) + len(heard) - 2 * LCS``): a wrong word
    counts as one missing and one extra word. Used to choose how many leading heard
    words a formula takes: with substitutions at cost 1, a stray match between leftover
    formula words and expected words that were never recited could look like progress.
    """
    if not expected or not heard:
        return len(expected) + len(heard)
    vocab: dict[str, int] = {}
    exp_ids = [vocab.setdefault(k, len(vocab)) for k in expected]
    heard_ids = np.array([vocab.setdefault(k, len(vocab)) for k in heard], dtype=np.int64)
    m = len(heard_ids)
    row = np.zeros(m + 1, dtype=np.int64)  # LCS(expected[i:], heard[j:])
    for e in reversed(exp_ids):
        best = row.copy()
        np.maximum(best[:m], row[1:] + (heard_ids == e), out=best[:m])
        row = np.maximum.accumulate(best[::-1])[::-1]
    return len(expected) + m - 2 * int(row[0])


def _formula_prefixes(
    formula: Sequence[str], heard: Sequence[str], max_errors: int, short: int
) -> list[tuple[int, int]]:
    """Candidate formula lengths at the start of ``heard``: ``(prefix length, errors)``.

    Every length within ``max_errors`` of the formula's whose word errors are at most
    ``max_errors``, plus the first ``short`` words of the formula heard exactly. A prefix
    longer than the formula (extra words inside it, as in the long isti'adha) must end
    with the formula's last word: otherwise the "extra word" is the ayah's first word,
    said wrong, and it is left to the check.
    """
    f = len(formula)
    out = []
    for k in range(max(1, f - max_errors), min(len(heard), f + max_errors) + 1):
        if k > f and heard[k - 1] != formula[-1]:
            continue
        errors = _count_errors(formula, heard[:k])
        if errors <= max_errors:
            out.append((k, errors))
    if short and len(heard) >= short and list(heard[:short]) == list(formula[:short]):
        if all(k != short for k, _ in out):
            out.append((short, 0))
    return out


def _longest_true_run(flags: np.ndarray) -> int:
    """Length of the longest run of True values in a boolean array."""
    if not flags.any():
        return 0
    padded = np.concatenate(([0], flags.astype(np.int8), [0]))
    edges = np.flatnonzero(np.diff(padded))
    return int((edges[1::2] - edges[::2]).max())


def _lcs_path(a: np.ndarray, b: np.ndarray, prefer_offset: int) -> list[tuple[int, int]]:
    """One longest common subsequence of two id arrays, as ``(index in a, index in b)``.

    The path starts with the earliest element of ``a`` that can begin a longest common
    subsequence; among its possible partners in ``b`` the one whose offset ``j - i`` is
    closest to ``prefer_offset`` (then the earliest) is taken. Each following pair is
    the earliest that keeps the subsequence longest. Row-wise numpy DP over the suffix
    table ``S[i, j] = LCS(a[i:], b[j:])``.
    """
    n, m = len(a), len(b)
    if n == 0 or m == 0:
        return []
    table = np.zeros((n + 1, m + 1), dtype=np.int32)
    for i in range(n - 1, -1, -1):
        best = np.maximum(table[i + 1, :m], table[i + 1, 1:] + (b == a[i]))
        table[i, :m] = np.maximum.accumulate(best[::-1])[::-1]
    remaining = int(table[0, 0])
    path: list[tuple[int, int]] = []
    i = j = 0
    while remaining:
        for ii in range(i, n):
            js = np.flatnonzero((b[j:] == a[ii]) & (table[ii + 1, j + 1 :] == remaining - 1))
            if len(js):
                if not path:
                    offsets = js + j - ii
                    jj = j + int(js[np.lexsort((js, np.abs(offsets - prefer_offset)))[0]])
                else:
                    jj = j + int(js[0])
                path.append((ii, jj))
                i, j, remaining = ii + 1, jj + 1, remaining - 1
                break
        else:  # pragma: no cover - the table guarantees a continuation
            break
    return path


def _window_hashes(ids: np.ndarray, n: int) -> np.ndarray:
    """64-bit polynomial hashes of every window of ``n`` ids (wrapping arithmetic)."""
    count = len(ids) - n + 1
    if count <= 0:
        return np.zeros(0, dtype=np.uint64)
    shifted = (ids.astype(np.int64) + 3).astype(np.uint64)  # all ids are >= -2
    h = np.zeros(count, dtype=np.uint64)
    for t in range(n):
        h = h * _HASH_BASE + shifted[t : t + count]
    return h


def _clean_windows(ids: np.ndarray, n: int) -> np.ndarray:
    """Mask of the windows of ``n`` ids that contain no separator or unknown id."""
    count = len(ids) - n + 1
    if count <= 0:
        return np.zeros(0, dtype=bool)
    bad = np.concatenate(([0], np.cumsum(ids < 0)))
    return (bad[n:] - bad[:-n]) == 0


# ---------------------------------------------------------------------------
# The Quran
# ---------------------------------------------------------------------------


@dataclass
class _Hits:
    """n-gram hits of heard words: Quran position, heard position and n-gram size."""

    pos: np.ndarray
    heard: np.ndarray
    size: np.ndarray

    def __len__(self) -> int:
        return len(self.pos)


@dataclass(frozen=True)
class _Candidate:
    """One scored place for a heard word sequence (positions are global word indexes)."""

    score: float  # matched / number of heard words
    matched: int  # heard words found in order (longest common subsequence)
    skipped: int  # Quran words inside the matched stretch that were not heard
    run: int  # longest run of consecutive heard words matched exactly
    hits: int  # matched n-grams
    start: int  # position of the first heard word (extrapolated from the first match)
    end: int  # position of the last matched word

    def sort_key(self) -> tuple[float, int, int, int, int, int]:
        return (-self.score, -self.matched, self.skipped, -self.run, -self.hits, self.start)


class Quran:
    """The verbatim Tanzil Quran (Hafs), with strict checking and hifz search.

    Construction reads ``quran-uthmani.txt``, ``quran-simple-clean.txt`` and
    ``quran-data.js`` from ``quran_dir`` and validates them: 6236 ayat in each text
    file, the same ``(surah, ayah)`` keys in the same order, ayat numbered 1..n in
    surahs 1..114, and ayah counts that agree with the metadata for all 114 surahs.
    ValueError (or FileNotFoundError) is raised otherwise. The object is read-only
    afterwards and safe to share between threads.
    """

    attribution: str = ATTRIBUTION

    def __init__(self, quran_dir: Path) -> None:
        quran_dir = Path(quran_dir)
        uthmani, uthmani_licence = read_tanzil_text(quran_dir / UTHMANI_FILE)
        clean, clean_licence = read_tanzil_text(quran_dir / SIMPLE_CLEAN_FILE)
        self._surah_info = read_surah_metadata(quran_dir / METADATA_FILE)
        self.licence: str = "\n".join(uthmani_licence)
        self._validate(uthmani, clean, uthmani_licence, clean_licence)
        self._raw: dict[tuple[int, int], tuple[str, str]] = {k: (uthmani[k], clean[k]) for k in uthmani}

        self.basmala_match: str = clean[(1, 1)]
        self.basmala_display: str = uthmani[(1, 1)]
        self._basmala_keys: list[str] = [_speech_key(w) for w in clean[(1, 1)].split()]
        self._istiadha_keys: list[str] = [_speech_key(w) for w in tokenize(ISTIADHA, "ar")]

        self._ayat: dict[tuple[int, int], Ayah] = {}
        for key in uthmani:
            display, match = self._strip_basmala(key, uthmani[key], clean[key])
            display_words = display_tokens(display)
            match_words = match.split()
            if not display_words or not match_words:
                raise ValueError(f"ayah {key[0]}:{key[1]} has no words")
            word_map = build_word_map(
                [_speech_key(w) for w in match_words], [_speech_key(w) for w in display_words]
            )
            self._ayat[key] = Ayah(key[0], key[1], display, match, display_words, match_words, word_map)
        self._build_index()
        self._framing_keys = [[_speech_key(w) for w in f.split()] for f in FRAMING_FORMULAS]
        self._formula_keys = [[_speech_key(w) for w in tokenize(f, "ar")] for f in EVERYDAY_FORMULAS]
        # Whole ayat of two words or more, by their speech keys (see whole_ayah).
        self._ayah_by_keys: dict[tuple[str, ...], tuple[int, int]] = {}
        for key, a in self._ayat.items():
            if len(a.match_words) >= 2:
                self._ayah_by_keys.setdefault(tuple(_speech_key(w) for w in a.match_words), key)
        # Whole ayat of 2..SHORT_AYAH_MAX_WORDS words looked for inside a phrase (see
        # contained_ayat), without the everyday ones.
        everyday: set[tuple[str, ...]] = set()
        for surah, ayah in EVERYDAY_AYAT:
            listed = self._ayat.get((surah, ayah))
            words = listed.match_words if listed is not None else []
            if len(words) != 3:
                raise ValueError(f"EVERYDAY_AYAT: {surah}:{ayah} is not an ayah of three words")
            everyday.add(tuple(_speech_key(w) for w in words))
        self._short_ayat: dict[tuple[str, ...], tuple[int, int]] = {
            keys: where
            for keys, where in self._ayah_by_keys.items()
            if len(keys) <= SHORT_AYAH_MAX_WORDS and keys not in everyday
        }
        # Muqatta'at: global word position -> the letter names joined (speech key).
        self._muqattaat: dict[int, str] = {}
        for surah, ayah in MUQATTAAT_AYAT:
            word = self._ayat[(surah, ayah)].match_words[0]
            if not word or any(c not in LETTER_NAMES for c in word):
                raise ValueError(f"ayah {surah}:{ayah} does not start with disjoined letters")
            self._muqattaat[self._ayah_start[(surah, ayah)]] = "".join(
                _speech_key(LETTER_NAMES[c]) for c in word
            )

    # -- loading -------------------------------------------------------------

    def _validate(
        self,
        uthmani: dict[tuple[int, int], str],
        clean: dict[tuple[int, int], str],
        uthmani_licence: list[str],
        clean_licence: list[str],
    ) -> None:
        for name, verses, licence in (
            (UTHMANI_FILE, uthmani, uthmani_licence),
            (SIMPLE_CLEAN_FILE, clean, clean_licence),
        ):
            if len(verses) != N_AYAT:
                raise ValueError(f"{name}: {len(verses)} ayat, expected {N_AYAT}")
            if not any("Tanzil" in line for line in licence):
                raise ValueError(f"{name}: the Tanzil licence block is missing")
        if list(uthmani) != list(clean):
            raise ValueError("the Uthmani and Simple-Clean files do not list the same ayat in the same order")
        counts: dict[int, int] = {}
        for surah, _ in uthmani:
            counts[surah] = counts.get(surah, 0) + 1
        for info in self._surah_info:
            if counts.get(info.number) != info.ayah_count:
                raise ValueError(
                    f"surah {info.number}: {counts.get(info.number, 0)} ayat in the text, "
                    f"{info.ayah_count} in {METADATA_FILE}"
                )
        expected = [(info.number, a) for info in self._surah_info for a in range(1, info.ayah_count + 1)]
        for got, want in zip(uthmani, expected):
            if got != want:
                raise ValueError(f"ayah {got[0]}:{got[1]} found where {want[0]}:{want[1]} was expected")

    def _strip_basmala(self, key: tuple[int, int], uthmani: str, clean: str) -> tuple[str, str]:
        """Remove the basmala prefix that Tanzil puts on ayah 1 (not of surahs 1 and 9)."""
        surah, ayah = key
        if ayah != 1 or surah == 1:
            return uthmani, clean
        basmala_words = self._raw[(1, 1)][1].split()
        starts_with_basmala = clean.split()[: len(basmala_words)] == basmala_words
        if surah in NO_BASMALA_PREFIX:
            if starts_with_basmala:
                raise ValueError(f"surah {surah} unexpectedly starts with the basmala")
            return uthmani, clean
        if not starts_with_basmala:
            raise ValueError(f"surah {surah}: ayah 1 does not start with the basmala")
        match = _drop_leading_words(clean, len(basmala_words))

        # How many Uthmani words spell the basmala here: compare their keys with 1:1.
        target = "".join(_speech_key(w) for w in display_tokens(self._raw[(1, 1)][0]))
        words = display_tokens(uthmani)
        joined, count = "", 0
        while count < len(words) and len(joined) < len(target):
            joined += _speech_key(words[count])
            count += 1
        if joined != target:
            raise ValueError(f"surah {surah}: the Uthmani basmala does not match 1:1")
        return _drop_leading_words(uthmani, count, skip=is_pause_mark_token), match

    def _build_index(self) -> None:
        """Lay out every match word in one array (a separator after each surah) and
        build the n-gram hash index over their speech keys."""
        vocab: dict[str, int] = {}
        ids: list[int] = []
        words: list[str] = []
        loc_surah: list[int] = []
        loc_ayah: list[int] = []
        loc_word: list[int] = []
        self._surah_range: dict[int, tuple[int, int]] = {}
        self._ayah_start: dict[tuple[int, int], int] = {}
        for info in self._surah_info:
            lo = len(ids)
            for ayah_no in range(1, info.ayah_count + 1):
                a = self._ayat[(info.number, ayah_no)]
                self._ayah_start[(info.number, ayah_no)] = len(ids)
                for idx, w in enumerate(a.match_words):
                    ids.append(vocab.setdefault(_speech_key(w), len(vocab)))
                    words.append(w)
                    loc_surah.append(info.number)
                    loc_ayah.append(ayah_no)
                    loc_word.append(idx)
            self._surah_range[info.number] = (lo, len(ids))
            ids.append(_SEPARATOR)
            words.append("")
            loc_surah.append(0)
            loc_ayah.append(0)
            loc_word.append(-1)
        self._vocab = vocab
        self._ids = np.array(ids, dtype=np.int64)
        self._words = words
        self._loc_surah = np.array(loc_surah, dtype=np.int32)
        self._loc_ayah = np.array(loc_ayah, dtype=np.int32)
        self._loc_word = np.array(loc_word, dtype=np.int32)

        self._ngrams: dict[int, tuple[np.ndarray, np.ndarray]] = {}
        for n in range(NGRAM_MIN, NGRAM_MAX + 1):
            hashes = _window_hashes(self._ids, n)
            positions = np.flatnonzero(_clean_windows(self._ids, n))
            hashes = hashes[positions]
            order = np.argsort(hashes, kind="stable")
            self._ngrams[n] = (hashes[order], positions[order])

    # -- text access ---------------------------------------------------------

    def surahs(self) -> list[dict]:
        """The 114 surahs: ``[{number, name_ar, ayah_count, name_translit, name_en}]``.

        Names and counts come verbatim from the Tanzil metadata file (``name_ar`` is the
        Arabic name; ``name_translit`` and ``name_en`` are Tanzil's transliteration and
        English name, for the en/fr interface). The counts are checked against the text.
        """
        return [
            {
                "number": s.number,
                "name_ar": s.name_ar,
                "ayah_count": s.ayah_count,
                "name_translit": s.name_translit,
                "name_en": s.name_en,
            }
            for s in self._surah_info
        ]

    def ayah_count(self, surah: int) -> int:
        """Number of ayat in ``surah`` (1..114); ValueError for another number."""
        self._check_surah(surah)
        return self._surah_info[surah - 1].ayah_count

    def ayat(self, surah: int, start: int, end: int) -> list[Ayah]:
        """The ayat ``start..end`` (inclusive) of ``surah``.

        Raises ValueError unless ``1 <= start <= end <= ayah_count(surah)``.
        """
        self._check_range(surah, start, end)
        return [self._ayat[(surah, a)] for a in range(start, end + 1)]

    def raw_lines(self, surah: int, ayah: int) -> tuple[str, str]:
        """The full verbatim ``(Uthmani, Simple-Clean)`` lines of one ayah, basmala
        prefix included."""
        self._check_range(surah, ayah, ayah)
        return self._raw[(surah, ayah)]

    def _check_surah(self, surah: int) -> None:
        if isinstance(surah, bool) or not isinstance(surah, int) or not 1 <= surah <= N_SURAHS:
            raise ValueError(f"surah must be an integer from 1 to {N_SURAHS}, got {surah!r}")

    def _check_range(self, surah: int, start: int, end: int) -> None:
        self._check_surah(surah)
        count = self._surah_info[surah - 1].ayah_count
        for value in (start, end):
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"ayah numbers must be integers, got {value!r}")
        if not 1 <= start <= end <= count:
            raise ValueError(f"ayah range {start}-{end} is not within 1-{count} of surah {surah}")

    # -- checking ------------------------------------------------------------

    def check(self, surah: int, start: int, end: int, heard_text: str) -> dict:
        """Strictly check a recitation of ayat ``start..end`` of ``surah``.

        ``heard_text`` is the unprompted transcript. It is tokenised with
        :func:`mommy.textnorm.tokenize` and aligned word by word with the match words of
        the range (:func:`mommy.align.align`, speech keys). A leading isti'adha and/or
        basmala in the heard text is ignored (see the module docstring), except a
        basmala that the range itself starts with (1:1).

        Returns a JSON-ready dict::

            {"ops": [op, ...], "verdict": "correct" | "mistakes" | "unclear",
             "say_again": bool,
             "first_error": {"surah", "ayah", "word_index_display",
                             "expected_display_word", "kind"} | None,
             "n_expected": int, "n_errors": int, "word_accuracy": float,
             "tolerated": ["istiadha", "basmala"],   # what was ignored, in order
             "words": [entry, ...]}

        Each op has the :class:`mommy.align.Op` fields (``exp_index`` indexes the match
        words of the whole range, ``heard_index`` the tokens of ``heard_text``,
        ``expected`` is the Simple-Clean word) plus ``surah``, ``ayah``, ``word_index``
        (match word in the ayah), ``word_index_display`` and ``expected_display`` (the
        Uthmani word); these are None for an insertion. ``first_error`` locates the
        first error (for an insertion, the expected word that follows it, or the last
        word of the range). ``words`` lists every display word of the range in reading
        order as ``{"surah", "ayah", "word_index_display", "display", "status",
        "heard"}`` with ``status`` "match", "sub" (wrong, or only partly said) or "del",
        and an extra ``{"status": "ins", "heard": ..., other fields None}`` entry where
        a word was added.
        """
        self._check_range(surah, start, end)
        g_lo = self._ayah_start[(surah, start)]
        g_hi = self._ayah_start[(surah, end)] + len(self._ayat[(surah, end)].match_words)
        expected = self._words[g_lo:g_hi]
        expected_keys = [_speech_key(w) for w in expected]

        heard_tokens = tokenize(heard_text or "", "ar")
        heard_keys = [_speech_key(t) for t in heard_tokens]
        offset, tolerated = self._strip_formulas(heard_keys, expected_keys)

        rest_keys = heard_keys[offset:]
        ops = align_with_joins(
            expected, heard_tokens[offset:], _speech_key, max_pieces=1,
            extra_joins=(self._muqattaat_joins(g_lo, len(expected), rest_keys), {}),
        )
        if offset:
            for op in ops:
                if op.heard_index is not None:
                    op.heard_index += offset
        result = build_result(ops, len(expected), len(heard_tokens) - offset)

        op_dicts = [self._op_dict(op, g_lo) for op in ops]
        first_error = None
        if result.first_error_exp_index is not None:
            kind = next(op.kind for op in ops if op.kind != "match")
            first_error = {**self._display_location(g_lo + result.first_error_exp_index), "kind": kind}
        stopped_at = None
        if result.stopped_at_exp_index is not None:
            stopped_at = self._display_location(g_lo + result.stopped_at_exp_index)
        return {
            "ops": op_dicts,
            "verdict": result.verdict,
            "say_again": result.say_again,
            "first_error": first_error,
            "n_expected": result.n_expected,
            "n_errors": result.n_errors,
            "word_accuracy": result.word_accuracy,
            "tolerated": tolerated,
            "stopped_at": stopped_at,
            "words": self._display_view(op_dicts, surah, start, end),
        }

    def _display_location(self, g: int) -> dict[str, Any]:
        """``{surah, ayah, word_index_display, expected_display_word}`` of a word position."""
        s, a, mi = self._location(g)
        ayah = self._ayat[(s, a)]
        dj = ayah.word_map[mi]
        return {"surah": s, "ayah": a, "word_index_display": dj, "expected_display_word": ayah.display_words[dj]}

    def _muqattaat_joins(self, g_lo: int, n: int, heard_keys: Sequence[str]) -> dict[tuple[int, int], list[int]]:
        """Joined matches for disjoined letters recited by name in the range ``[g_lo,
        g_lo + n)``: expected word ``i`` matches heard words ``j..j+k`` whose keys
        joined are the letter names joined (``الم`` / ``ألف لام ميم``, ``يس`` /
        ``ياسين``)."""
        joins: dict[tuple[int, int], list[int]] = {}
        for g, names in self._muqattaat.items():
            if not g_lo <= g < g_lo + n:
                continue
            for j in range(len(heard_keys)):
                joined = ""
                for k in range(1, len(names) + 1):
                    if j + k > len(heard_keys):
                        break
                    joined += heard_keys[j + k - 1]
                    if joined == names:
                        joins.setdefault((g - g_lo, j), []).append(k)
                    if not names.startswith(joined):
                        break
        return joins

    def _strip_formulas(self, heard_keys: list[str], expected_keys: list[str] | None) -> tuple[int, list[str]]:
        """Count the leading heard tokens that are an isti'adha and/or a basmala.

        Each formula is removed at most once, in either order. The basmala is kept when
        ``expected_keys`` itself starts with it.

        With ``expected_keys`` (checking), the number of words a formula takes is chosen
        by the result: every candidate length (within the formula's error tolerance, and
        the short forms ``أعوذ بالله`` / ``بسم الله`` heard exactly) is scored by the
        missing and extra words of the rest against the start of the expected words,
        then by the formula's own errors, then the shorter length wins, over every order
        and combination of the two formulas. A formula heard exactly is always removed;
        any other plan is used only when it strictly lowers the errors. So ``بسم الله
        الرحمن`` (last word missing) before an ayah takes three words, not the ayah's
        first word.

        Without ``expected_keys`` (hifz search), a formula heard exactly, or with at most
        its tolerance of errors, is removed (the caller tries both variants).
        """
        formulas = [("istiadha", self._istiadha_keys, ISTIADHA_MAX_ERRORS)]
        if expected_keys is None or expected_keys[: len(self._basmala_keys)] != self._basmala_keys:
            formulas.append(("basmala", self._basmala_keys, BASMALA_MAX_ERRORS))
        if expected_keys is None:
            return self._strip_formulas_loosely(heard_keys, formulas)

        # A formula heard exactly is always removed, as before.
        exact_offset, exact_names = self._strip_formulas_loosely(heard_keys, formulas, max_errors=0)

        # Score every other plan (which formulas, in which order, how many words each)
        # by the missing and extra words of the rest against the start of the expected
        # words: the first FORMULA_WINDOW expected words against as many heard words, or,
        # when the window holds the whole range, against every remaining heard word.
        window = expected_keys[:FORMULA_WINDOW]
        whole = len(expected_keys) <= FORMULA_WINDOW

        @functools.lru_cache(maxsize=None)
        def rest_errors(start: int) -> int:
            rest = heard_keys[start:] if whole else heard_keys[start : start + len(window)]
            return _indel_errors(window, rest)

        best: tuple[int, int, int, list[str]] | None = None

        def explore(start: int, formula_errors: int, names: list[str]) -> None:
            nonlocal best
            for name, keys, max_errors in formulas:
                if name in names:
                    continue
                for k, errors in _formula_prefixes(keys, heard_keys[start:], max_errors, SHORT_FORMULA_WORDS):
                    plan = (rest_errors(start + k), formula_errors + errors, start + k, [*names, name])
                    if best is None or plan[:3] < best[:3]:
                        best = plan
                    explore(start + k, formula_errors + errors, [*names, name])

        explore(0, 0, [])
        if best is not None and best[0] < rest_errors(exact_offset):
            return best[2], best[3]
        return exact_offset, exact_names

    def _strip_formulas_loosely(
        self, heard_keys: list[str], formulas: list[tuple[str, list[str], int]], max_errors: int | None = None
    ) -> tuple[int, list[str]]:
        """Remove leading formulas greedily, each heard with at most its tolerance of
        errors (or ``max_errors``), in either order."""
        offset = 0
        tolerated: list[str] = []
        while len(tolerated) < len(formulas):
            for name, keys, tolerance in formulas:
                if name in tolerated:
                    continue
                found = _leading_formula(keys, heard_keys[offset:], tolerance if max_errors is None else max_errors)
                if found is None:
                    continue
                offset += found[0]
                tolerated.append(name)
                break
            else:
                break
        return offset, tolerated

    def _location(self, g: int) -> tuple[int, int, int]:
        """``(surah, ayah, match word index)`` of a global word position."""
        return int(self._loc_surah[g]), int(self._loc_ayah[g]), int(self._loc_word[g])

    def _op_dict(self, op: Op, g_lo: int) -> dict[str, Any]:
        d: dict[str, Any] = {
            "kind": op.kind,
            "exp_index": op.exp_index,
            "heard_index": op.heard_index,
            "expected": op.expected,
            "heard": op.heard,
            "surah": None,
            "ayah": None,
            "word_index": None,
            "word_index_display": None,
            "expected_display": None,
        }
        if op.exp_index is not None:
            s, a, mi = self._location(g_lo + op.exp_index)
            ayah = self._ayat[(s, a)]
            dj = ayah.word_map[mi]
            d.update(surah=s, ayah=a, word_index=mi, word_index_display=dj, expected_display=ayah.display_words[dj])
        return d

    def _display_view(self, op_dicts: list[dict[str, Any]], surah: int, start: int, end: int) -> list[dict[str, Any]]:
        """Fold match-word ops into one entry per display word (see :meth:`check`)."""
        by_word: dict[tuple[int, int], list[dict[str, Any]]] = {}
        inserted_before: dict[tuple[int, int] | None, list[str]] = {}
        pending: list[str] = []
        for d in op_dicts:
            if d["kind"] == "ins":
                pending.append(d["heard"])
                continue
            where = (d["ayah"], d["word_index_display"])
            if pending:
                inserted_before.setdefault(where, []).extend(pending)
                pending = []
            by_word.setdefault(where, []).append(d)
        if pending:
            inserted_before.setdefault(None, []).extend(pending)

        def ins_entry(heard: str) -> dict[str, Any]:
            return {"surah": None, "ayah": None, "word_index_display": None, "display": None,
                    "status": "ins", "heard": heard}

        entries: list[dict[str, Any]] = []
        last_status = "match"
        for a in range(start, end + 1):
            ayah = self._ayat[(surah, a)]
            for dj, word in enumerate(ayah.display_words):
                for heard in inserted_before.get((a, dj), ()):
                    entries.append(ins_entry(heard))
                ops = by_word.get((a, dj))
                if ops is None:
                    # A display word with no match word of its own (the second word of a
                    # one-to-two step) shares the status of the word before it.
                    status, heard_text = last_status, None
                else:
                    kinds = {d["kind"] for d in ops}
                    status = "match" if kinds == {"match"} else "del" if kinds == {"del"} else "sub"
                    heard_words = [d["heard"] for d in ops if d["heard"]]
                    heard_text = " ".join(heard_words) if heard_words else None
                last_status = status
                entries.append({"surah": surah, "ayah": a, "word_index_display": dj, "display": word,
                                "status": status, "heard": heard_text})
        for heard in inserted_before.get(None, ()):
            entries.append(ins_entry(heard))
        return entries

    # -- hifz search ---------------------------------------------------------

    def locate(
        self, heard_text: str, top_k: int = 5, within_surah: int | None = None, *, min_score: float | None = None
    ) -> list[dict]:
        """Find where in the Quran the heard words are ("where am I?").

        Returns up to ``top_k`` candidates, best first::

            [{"surah", "ayah", "word_index", "match_word_index", "score",
              "display_preview"}, ...]

        ``word_index`` is the index of the first located word in the ayah's
        ``display_words`` (``match_word_index`` the same in ``match_words``).
        ``score`` (0..1) is the share of the heard words found in order at that place.
        ``display_preview`` is up to 8 display words from that word on (continuing into
        the next ayat of the surah). Candidates do not overlap; equally good places
        (repeated passages) are listed in Quran order. With ``within_surah`` only that
        surah is searched. A leading isti'adha or basmala is tried both with and without
        the words. Only the first :data:`LOCATE_MAX_WORDS` words are used. An empty
        list means nothing was found.

        With ``min_score`` (the Quran guard), a word sequence whose share of words that
        occur in the Quran at all is below ``min_score`` is not searched: none of its
        candidates could reach that score, so the candidates that do are the same.
        """
        if isinstance(top_k, bool) or not isinstance(top_k, int) or top_k < 1:
            raise ValueError(f"top_k must be a positive integer, got {top_k!r}")
        if within_surah is not None:
            self._check_surah(within_surah)
            lo, hi = self._surah_range[within_surah]
        else:
            lo, hi = 0, len(self._ids)

        keys = [_speech_key(t) for t in tokenize(heard_text or "", "ar")]
        variants = [keys[:LOCATE_MAX_WORDS]]
        offset, _ = self._strip_formulas(keys, None)
        if 0 < offset < len(keys):
            variants.append(keys[offset : offset + LOCATE_MAX_WORDS])

        candidates: list[_Candidate] = []
        for variant in variants:
            if min_score is not None and variant:
                known = sum(1 for k in variant if k in self._vocab)
                if known < min_score * len(variant):
                    continue  # matched <= known words, so every score would be below min_score
            candidates.extend(self._candidates(variant, lo, hi))
        candidates.sort(key=_Candidate.sort_key)

        chosen: list[_Candidate] = []
        for cand in candidates:
            if any(cand.start <= c.end and c.start <= cand.end for c in chosen):
                continue
            chosen.append(cand)
            if len(chosen) == top_k:
                break
        return [self._candidate_dict(c) for c in chosen]

    def _candidates(self, keys: list[str], lo: int, hi: int) -> list[_Candidate]:
        """Scored candidate places for one heard key sequence, within ``[lo, hi)``."""
        if not keys:
            return []
        heard = np.array([self._vocab.get(k, _UNKNOWN) for k in keys], dtype=np.int64)
        hits = self._ngram_hits(heard, lo, hi)
        if not len(hits):
            hits = self._scan_hits(heard, lo, hi, min(2, len(heard)))
        if not len(hits):
            return []

        diag = hits.pos - hits.heard
        out: list[_Candidate] = []
        length = len(heard)
        for seed, members in self._group_diagonals(diag):
            mask = np.isin(diag, members)
            pos, size = hits.pos[mask], hits.size[mask]
            # The group's surah is that of its seed diagonal's first hit.
            p_seed = int(pos[np.flatnonzero(diag[mask] == seed)[0]])
            s_lo, s_hi = self._surah_range[int(self._loc_surah[p_seed])]
            w_lo = max(s_lo, members[0] - LOCATE_BAND)
            w_hi = min(s_hi, members[-1] + length + LOCATE_BAND)
            path = _lcs_path(heard, self._ids[w_lo:w_hi], seed - w_lo)
            if not path:
                continue
            (h_first, q_first), (_, q_last) = path[0], path[-1]
            q_first, q_last = q_first + w_lo, q_last + w_lo
            matched = len(path)
            run = 0
            for d in members:
                idx = d + np.arange(length)
                inside = (idx >= s_lo) & (idx < s_hi)
                flags = inside & (self._ids[np.clip(idx, 0, len(self._ids) - 1)] == heard)
                run = max(run, _longest_true_run(flags))
            start = max(q_first - h_first, s_lo)  # a wrong first word still starts here
            end = max(q_last, int((pos + size - 1).max()))
            out.append(
                _Candidate(
                    score=round(matched / length, 4),
                    matched=matched,
                    skipped=(q_last - q_first + 1) - matched,
                    run=run,
                    hits=int(mask.sum()),
                    start=start,
                    end=end,
                )
            )
        return out

    def _ngram_hits(self, heard: np.ndarray, lo: int, hi: int) -> _Hits:
        """Exact n-gram hits (n = 3..7) of the heard ids at Quran positions in ``[lo, hi)``."""
        pos_parts: list[np.ndarray] = []
        heard_parts: list[np.ndarray] = []
        size_parts: list[np.ndarray] = []
        for n in range(NGRAM_MIN, min(NGRAM_MAX, len(heard)) + 1):
            starts = np.flatnonzero(_clean_windows(heard, n))
            if not len(starts):
                continue
            query = _window_hashes(heard, n)[starts]
            sorted_hashes, positions = self._ngrams[n]
            left = np.searchsorted(sorted_hashes, query, side="left")
            right = np.searchsorted(sorted_hashes, query, side="right")
            counts = right - left
            total = int(counts.sum())
            if not total:
                continue
            first = np.repeat(left, counts)
            within = np.arange(total) - np.repeat(np.cumsum(counts) - counts, counts)
            pos = positions[first + within]
            hpos = np.repeat(starts, counts)
            # Verify word by word (rules out hash collisions) and keep the search range.
            span = np.arange(n)
            exact = np.all(self._ids[pos[:, None] + span] == heard[hpos[:, None] + span], axis=1)
            keep = exact & (pos >= lo) & (pos + n <= hi)
            pos_parts.append(pos[keep])
            heard_parts.append(hpos[keep])
            size_parts.append(np.full(int(keep.sum()), n, dtype=np.int64))
        if not pos_parts:
            empty = np.zeros(0, dtype=np.int64)
            return _Hits(empty, empty, empty)
        return _Hits(np.concatenate(pos_parts), np.concatenate(heard_parts), np.concatenate(size_parts))

    def _scan_hits(self, heard: np.ndarray, lo: int, hi: int, n: int) -> _Hits:
        """Exact hits of every heard n-gram (n = 1 or 2) by scanning ``[lo, hi)``.

        Used for very short or very garbled input, where no 3-gram is intact.
        """
        pos_parts: list[np.ndarray] = []
        heard_parts: list[np.ndarray] = []
        segment = self._ids[lo:hi]
        for h in np.flatnonzero(_clean_windows(heard, n)):
            mask = segment[: len(segment) - n + 1] == heard[h]
            for t in range(1, n):
                mask &= segment[t : len(segment) - n + 1 + t] == heard[h + t]
            found = np.flatnonzero(mask) + lo
            pos_parts.append(found)
            heard_parts.append(np.full(len(found), h, dtype=np.int64))
        if not pos_parts:
            empty = np.zeros(0, dtype=np.int64)
            return _Hits(empty, empty, empty)
        pos = np.concatenate(pos_parts)
        return _Hits(pos, np.concatenate(heard_parts), np.full(len(pos), n, dtype=np.int64))

    def _group_diagonals(self, diag: np.ndarray) -> list[tuple[int, list[int]]]:
        """Group hit diagonals (Quran position minus heard position) around seeds.

        Seeds are taken greedily by hit count (then position) and take every free
        diagonal within :data:`LOCATE_BAND` of them, so one group tolerates an inserted
        or dropped word. Returns ``(seed, sorted member diagonals)`` for the
        :data:`LOCATE_MAX_GROUPS` groups with the most hits.
        """
        uniq, counts = np.unique(diag, return_counts=True)
        order = sorted(range(len(uniq)), key=lambda t: (-int(counts[t]), int(uniq[t])))
        taken = np.zeros(len(uniq), dtype=bool)
        groups: list[tuple[int, int, list[int]]] = []
        for t in order:
            if taken[t]:
                continue
            a = int(np.searchsorted(uniq, uniq[t] - LOCATE_BAND, side="left"))
            b = int(np.searchsorted(uniq, uniq[t] + LOCATE_BAND, side="right"))
            members = [u for u in range(a, b) if not taken[u]]
            taken[members] = True
            groups.append((-int(counts[members].sum()), int(uniq[t]), [int(uniq[u]) for u in members]))
        groups.sort(key=lambda g: (g[0], g[1]))
        return [(seed, members) for _, seed, members in groups[:LOCATE_MAX_GROUPS]]

    def _candidate_dict(self, cand: _Candidate) -> dict[str, Any]:
        s, a, mi = self._location(cand.start)
        ayah = self._ayat[(s, a)]
        dj = ayah.word_map[mi]
        return {
            "surah": s,
            "ayah": a,
            "word_index": dj,
            "match_word_index": mi,
            "score": cand.score,
            "display_preview": self._preview(s, a, dj),
        }

    def _preview(self, surah: int, ayah: int, word: int) -> str:
        """Up to :data:`PREVIEW_WORDS` display words from a position, within the ayah.

        The preview is cut from the verbatim Uthmani line at word boundaries, so the
        pause marks between the words it keeps stay where they are. It ends with the
        ayah: words of the next ayah are never run into it.
        """
        display = self._ayat[(surah, ayah)].display
        spans = [m.span() for m in re.finditer(r"\S+", display) if not is_pause_mark_token(m.group())]
        if not 0 <= word < len(spans):
            return ""
        last = min(word + PREVIEW_WORDS, len(spans)) - 1
        return display[spans[word][0] : spans[last][1]]

    # -- Quran text in other texts (the general endpoints' guard) ---------------

    def strip_framing(self, text: str) -> tuple[list[str], bool]:
        """The tokens of ``text`` without framing formulas (:data:`FRAMING_FORMULAS`,
        such as ``قال تعالى`` or ``صدق الله العظيم``), and whether one was found."""
        tokens = tokenize(text or "", "ar")
        keys = [_speech_key(t) for t in tokens]
        drop = [False] * len(tokens)
        for formula in self._framing_keys:
            f = len(formula)
            for i in range(len(keys) - f + 1):
                if keys[i : i + f] == formula and not any(drop[i : i + f]):
                    drop[i : i + f] = [True] * f
        return [t for t, d in zip(tokens, drop) if not d], any(drop)

    def _formula_mask(self, keys: Sequence[str]) -> list[bool]:
        """For each key, whether it belongs to an everyday formula (:data:`EVERYDAY_FORMULAS`)."""
        mask = [False] * len(keys)
        for formula in self._formula_keys:
            f = len(formula)
            for i in range(len(keys) - f + 1):
                if list(keys[i : i + f]) == formula:
                    mask[i : i + f] = [True] * f
        return mask

    def quran_runs(
        self, tokens: Sequence[str], min_words: int, *, exclude_formulas: bool = False
    ) -> list[tuple[int, int]]:
        """Stretches of ``tokens`` that are Quran text: ``[(start, end)]`` token spans
        covered by runs of at least ``min_words`` (3..7) consecutive words found, in
        order and consecutively, somewhere in the Quran (speech keys, Simple-Clean
        text). Overlapping runs are merged. With ``exclude_formulas``, the words of an
        everyday formula (:data:`EVERYDAY_FORMULAS`) count as words that are not in the
        Quran, so no run passes through a formula."""
        if not NGRAM_MIN <= min_words <= NGRAM_MAX:
            raise ValueError(f"min_words must be from {NGRAM_MIN} to {NGRAM_MAX}")
        keys = [_speech_key(t) for t in tokens]
        ids = np.array([self._vocab.get(k, _UNKNOWN) for k in keys], dtype=np.int64)
        if exclude_formulas and len(ids):
            ids[np.array(self._formula_mask(keys), dtype=bool)] = _UNKNOWN
        if len(ids) < min_words:
            return []
        starts = np.flatnonzero(_clean_windows(ids, min_words))
        if not len(starts):
            return []
        query = _window_hashes(ids, min_words)[starts]
        sorted_hashes, positions = self._ngrams[min_words]
        left = np.searchsorted(sorted_hashes, query, side="left")
        right = np.searchsorted(sorted_hashes, query, side="right")
        span = np.arange(min_words)
        spans: list[tuple[int, int]] = []
        for h, lo, hi in zip(starts, left, right):
            pos = positions[lo:hi]
            if len(pos) and np.any(np.all(self._ids[pos[:, None] + span] == ids[h + span], axis=1)):
                a, b = int(h), int(h) + min_words
                if spans and a <= spans[-1][1]:
                    spans[-1] = (spans[-1][0], b)
                else:
                    spans.append((a, b))
        return spans

    def whole_ayah(self, tokens: Sequence[str]) -> tuple[int, int] | None:
        """``(surah, ayah)`` when ``tokens`` are exactly the words of one ayah of at least
        two words (speech keys), else None."""
        if len(tokens) < 2:
            return None
        return self._ayah_by_keys.get(tuple(_speech_key(t) for t in tokens))

    def contained_ayat(self, tokens: Sequence[str], min_words: int) -> list[tuple[int, int, int, int]]:
        """Whole ayat of ``min_words`` (at least 2) to :data:`SHORT_AYAH_MAX_WORDS` words
        found as consecutive ``tokens`` (speech keys): ``[(start, end, surah, ayah)]``,
        in token order. The everyday ayat of :data:`EVERYDAY_AYAT` are not counted.
        Longer ayat are runs of five Quran words or more (:meth:`quran_runs`)."""
        if min_words < 2:
            raise ValueError("min_words must be at least 2")
        keys = [_speech_key(t) for t in tokens]
        found: list[tuple[int, int, int, int]] = []
        for start in range(len(keys)):
            for n in range(min_words, min(SHORT_AYAH_MAX_WORDS, len(keys) - start) + 1):
                where = self._short_ayat.get(tuple(keys[start : start + n]))
                if where is not None:
                    found.append((start, start + n, where[0], where[1]))
        return found

    # -- statistics ----------------------------------------------------------

    def ngram_uniqueness(self, n: int = 7) -> float:
        """Share of the n-word windows of match words (inside one surah) whose
        normalised words occur at no other place in the Quran."""
        if n < 1:
            raise ValueError("n must be at least 1")
        positions = np.flatnonzero(_clean_windows(self._ids, n))
        if not len(positions):
            return 0.0
        hashes = _window_hashes(self._ids, n)[positions]
        _, inverse, counts = np.unique(hashes, return_inverse=True, return_counts=True)
        return float((counts[inverse] == 1).mean())


__all__ = [
    "ATTRIBUTION",
    "Ayah",
    "EVERYDAY_AYAT",
    "EVERYDAY_FORMULAS",
    "FRAMING_FORMULAS",
    "ISTIADHA",
    "LETTER_NAMES",
    "MUQATTAAT_AYAT",
    "N_AYAT",
    "N_SURAHS",
    "Quran",
    "RIWAYA",
    "SHORT_AYAH_MAX_WORDS",
    "SOURCE_URL",
    "SurahInfo",
    "build_word_map",
    "display_tokens",
    "is_pause_mark_token",
    "read_surah_metadata",
    "read_tanzil_text",
    "search_word_map",
]
