"""Quran text inside the texts of the general endpoints: the guards and the Quran parts.

The general endpoints (recite, dictation, text check, page reader, voice) take school
texts. The product owner's decisions on Quran in those texts (``docs/CONTRACT.md``, hard
rule 4):

* **Q1, a text that is Quran.** Leave out the framing formulas (``قال تعالى``, the
  isti'adha, a basmala at the start, ``صدق الله العظيم``) and the surah and ayah labels
  (``سورة الإخلاص``, ``(1)``, ``[البقرة: 255]``). If what remains is one or more whole
  ayat in mushaf order, the text is Quran: it belongs to the Quran section (recitation
  only, word by word against the Tanzil text) and the general endpoints refuse it with
  ``422 quran_text``.
* **Q2, a school text that includes Quran.** Its **Quran parts** (a quoted ayah or part
  of one, a basmala at the start, a short ayah inside a sentence, a partial ayah on its
  own) are found by the server (:func:`find_quran_parts`), never taken from a client. A
  Quran part is recited and written against the mushaf words only (never the typed
  ones), is never read by the synthetic voice (a grown-up reads it in a dictation), is
  never judged by meaning, and its feedback comes from fixed templates only.

The guards
----------
Each use of a text keeps its guard (all leave the framing formulas out first):

* :func:`looks_like_quran`: the text is in the Uthmani script, holds a run of
  :data:`QURAN_GUARD_RUN_WORDS` (5) consecutive Quran words, a run of
  :data:`QURAN_GUARD_FRAMED_RUN_WORDS` (3) in a framing formula's neighbourhood (it
  starts at most :data:`QURAN_GUARD_FRAMED_GAP_WORDS` words after an opening formula or
  ends at most that many before ``صدق الله العظيم``, and does not pass through an
  everyday formula of :data:`mommy.quran.EVERYDAY_FORMULAS`), or at least 90% of its 4 or
  more words are found in order at one place. The building block of the next two.
* :func:`is_quran_phrase` (the voice, ``/api/tts``): :func:`looks_like_quran`, a phrase
  that is exactly a whole ayah of two words or more, or one that holds a whole ayah of
  3 or 4 words (:data:`QURAN_GUARD_CONTAINED_AYAH_WORDS`, without
  :data:`mommy.quran.EVERYDAY_AYAT`).
* :func:`looks_like_quran_for_meaning` (contextual mode): :func:`looks_like_quran`, a
  run of 4 that does not pass through an everyday formula, or a contained short ayah.

The Quran parts
---------------
:func:`find_quran_parts` applies the same rules to place the Quran text of a text: the
runs of 5 and the framed runs of 3 (with their place in the Quran, :meth:`mommy.quran.Quran.exact_matches`),
the contained short ayat, a text or line that is exactly a whole ayah, the 90% rule of
:meth:`mommy.quran.Quran.locate` on the text, its lines and its sentences, and a near
match for an ayah with a changed, dropped or misread word (a part completed to the end
of its ayah, two parts joined across one or two words, or a whole ayah located in a
sentence with one misread word). Then every dictation phrase that the voice would refuse
(:func:`is_quran_phrase`) is searched with the same rules until none is left, so the
voice never meets a Quran phrase. Ayah numbers between the words (``(1)``) do not break a
part. The analysis (:class:`QuranAnalysis`) also says whether the text is Q1, and gives
the mushaf words of every part, their differences from the typed words, the grown-up's
reading chunks, the dictation plan and the expected words of a check.
"""

from __future__ import annotations

import bisect
import contextvars
import functools
import math
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Sequence

from .align import (
    CheckResult,
    Op,
    align_with_joins,
    build_result,
    check_recitation,
    check_writing,
    recitation_key,
    speech_joins,
    tokenize_written,
    without_rigid,
    writing_key,
)
from .phrases import SENTENCE_PUNCTUATION, split_phrase_spans, split_phrases
from .quran import EVERYDAY_AYAT, SHORT_AYAH_MAX_WORDS, Quran
from .textnorm import TATWEEL, Lang, has_arabic, token_spans, tokenize
from .tts import is_quranic_script

# ---------------------------------------------------------------------------
# Thresholds (measured on tests/arabic_school_sentences.txt, see docs/CONTRACT.md)
# ---------------------------------------------------------------------------

#: :func:`looks_like_quran`: a text of at least this many words...
QURAN_GUARD_MIN_WORDS = 4
#: ...whose words are found, in order, at one place of the Quran at least this share;
QURAN_GUARD_MIN_SCORE = 0.9
#: or that holds this many consecutive words found consecutively in the Quran;
QURAN_GUARD_RUN_WORDS = 5
#: or, in a framing formula's neighbourhood (قال تعالى, صدق الله العظيم), this many,
QURAN_GUARD_FRAMED_RUN_WORDS = 3
#: starting at most this many words after an opening formula (قال الله تعالى في سورة
#: البقرة: ...) or ending at most this many before a closing one.
QURAN_GUARD_FRAMED_GAP_WORDS = 4
#: Contextual mode (the meaning is judged by the brain): also a run of this many
#: consecutive Quran words, everyday formulas left out (:data:`mommy.quran.EVERYDAY_FORMULAS`).
QURAN_GUARD_CONTEXTUAL_RUN_WORDS = 4
#: A phrase the voice would speak, and a text judged by meaning, may not contain a whole
#: ayah of this many words or more (up to :data:`mommy.quran.SHORT_AYAH_MAX_WORDS`;
#: longer ayat are runs of QURAN_GUARD_RUN_WORDS). Two-word ayat such as ثم نظر are
#: ordinary Arabic and are refused only as a phrase of their own.
QURAN_GUARD_CONTAINED_AYAH_WORDS = 3

#: Near match: a part is completed to the end (or start) of its ayah when at most this
#: many ayah words are missing from it...
NEAR_EXTEND_MAX_WORDS = 8
#: ...and the typed words there differ from them by one edit (two from 6 words on); two
#: parts are joined across at most this many words on each side.
NEAR_GAP_WORDS = 3
#: A whole ayah located in a sentence with a misread word needs this many words found,
NEAR_MIN_MATCHED = 4
#: in a sentence or line of at most this many words.
NEAR_MAX_SCOPE_WORDS = 60
#: A short ayah of this many words is also found with three of them in a row and the
#: fourth misread (:meth:`_Finder.short_misreads`; measured: no false positive).
SHORT_MISREAD_WORDS = 4
#: Words a located stretch may drift from its diagonal (dropped or added words).
FIT_BAND = 6

#: Words in one reading chunk of a Quran part (the cap of a dictation phrase).
CHUNK_MAX_WORDS = 6

#: The Quran guard of a text check: word-by-word recitation (and the dictation check),
#: recitation judged by meaning, or dictation (the voice reads the text out).
GuardMode = Literal["strict", "contextual", "dictation"]

QURAN_TEXT_MESSAGE = (
    "This text is from the Quran. Please use the Quran section: it checks recitation "
    "against the verbatim Tanzil text, without AI and without a synthetic voice."
)
#: Contextual mode, for a school text with Quran parts (Q2) or Quran words in a row.
QURAN_MEANING_MESSAGE = (
    "This text includes words of the Quran, whose meaning is never judged by AI. It can be "
    "recited word by word."
)

Reader = Literal["voice", "grown_up"]

# ---------------------------------------------------------------------------
# The guards
# ---------------------------------------------------------------------------

Anchors = list[tuple[int, bool]]  # (position in the tokens without framing, closing formula)


def _without_framing(quran: Quran, tokens: Sequence[str]) -> tuple[list[int], Anchors]:
    """The indices of ``tokens`` that are not part of a framing formula, and where each
    formula stood among them: an opening formula at the first kept token after it, a
    closing one at the first kept token after the words it closes."""
    framing = quran.framing_spans(tokens)
    drop = {i for start, end, _ in framing for i in range(start, end)}
    kept = [i for i in range(len(tokens)) if i not in drop]
    anchors = [(bisect.bisect_left(kept, start if closing else end), closing) for start, end, closing in framing]
    return kept, anchors


def _guard_tokens(text: str, quran: Quran | None) -> tuple[Quran, list[str], Anchors] | None:
    """``(quran, tokens, anchors)`` for the data-based Quran tests: the words of ``text``
    without framing formulas, and where the formulas were; None when there is nothing to
    test (no Tanzil text, or no Arabic letter)."""
    if quran is None or not has_arabic(text):
        return None
    tokens = tokenize(text or "", "ar")
    kept, anchors = _without_framing(quran, tokens)
    return quran, [tokens[i] for i in kept], anchors


def framed_runs(quran: Quran, tokens: Sequence[str], anchors: Anchors) -> list[tuple[int, int, int]]:
    """Runs of :data:`QURAN_GUARD_FRAMED_RUN_WORDS` (3) or more consecutive Quran words in
    a framing formula's neighbourhood: ``[(start, end, g)]`` (see
    :meth:`mommy.quran.Quran.exact_matches`). A run counts when it starts at most
    :data:`QURAN_GUARD_FRAMED_GAP_WORDS` words after an opening formula (``قال تعالى``,
    the isti'adha) or ends at most that many before a closing one (``صدق الله العظيم``),
    and the words of an everyday formula (``إن شاء الله``) are not Quran words here.
    ``tokens`` are the words without the formulas and ``anchors`` where the formulas
    stood (:func:`_guard_tokens`)."""
    if not anchors:
        return []
    out = []
    for a, b, g in quran.exact_matches(tokens, QURAN_GUARD_FRAMED_RUN_WORDS, exclude_formulas=True):
        for pos, closing in anchors:
            if (0 <= pos - b <= QURAN_GUARD_FRAMED_GAP_WORDS) if closing else (0 <= a - pos <= QURAN_GUARD_FRAMED_GAP_WORDS):
                out.append((a, b, g))
                break
    return out


def _framed(anchors: Anchors, a: int, b: int) -> bool:
    """Tokens ``a..b - 1`` (without the formulas) start at most
    :data:`QURAN_GUARD_FRAMED_GAP_WORDS` words after an opening formula or end at most
    that many before a closing one."""
    return any(
        (0 <= pos - b <= QURAN_GUARD_FRAMED_GAP_WORDS) if closing else (0 <= a - pos <= QURAN_GUARD_FRAMED_GAP_WORDS)
        for pos, closing in anchors
    )


def _quran_passage(quran: Quran, tokens: list[str], anchors: Anchors, *, locate: bool = True) -> bool:
    """The data-based part of :func:`looks_like_quran`, on the words without framing
    (without ``locate``, the 90% rule is left out)."""
    if quran.quran_runs(tokens, QURAN_GUARD_RUN_WORDS):
        return True
    if framed_runs(quran, tokens, anchors):
        return True
    if not locate or len(tokens) < QURAN_GUARD_MIN_WORDS:
        return False
    best = quran.locate(" ".join(tokens), top_k=1, min_score=QURAN_GUARD_MIN_SCORE)
    return bool(best) and best[0]["score"] >= QURAN_GUARD_MIN_SCORE


def looks_like_quran(text: str, quran: Quran | None) -> bool:
    """True when ``text`` is, or holds, a passage of the Quran (the voice's and the
    meaning guard's building block; see the module docstring).

    Framing formulas (``قال تعالى``, ``صدق الله العظيم``, the isti'adha, ...; see
    :data:`mommy.quran.FRAMING_FORMULAS`) are left out first. Then the text is Quran when
    it is written in the Uthmani Quranic script (:func:`mommy.tts.is_quranic_script`),
    holds a run of :data:`QURAN_GUARD_RUN_WORDS` (5) consecutive words found
    consecutively in the Quran, a framed run (:func:`framed_runs`), or has at least
    :data:`QURAN_GUARD_MIN_WORDS` words of which :data:`QURAN_GUARD_MIN_SCORE` are found
    in order at one place (:meth:`mommy.quran.Quran.locate`). Without the Quran data only
    the script test is possible.
    """
    if is_quranic_script(text):
        return True
    found = _guard_tokens(text, quran)
    return found is not None and _quran_passage(*found)


def is_whole_ayah(text: str, quran: Quran | None) -> bool:
    """True when ``text`` (framing formulas left out) is exactly one ayah of two words or
    more (``الله الصمد``)."""
    found = _guard_tokens(text, quran)
    return found is not None and found[0].whole_ayah(found[1]) is not None


def contains_short_ayah(text: str, quran: Quran | None) -> bool:
    """True when the words of ``text`` (framing formulas left out) hold, one after the
    other, a whole ayah of :data:`QURAN_GUARD_CONTAINED_AYAH_WORDS` (3) or 4 words
    (:meth:`mommy.quran.Quran.contained_ayat`). The everyday ayat of
    :data:`mommy.quran.EVERYDAY_AYAT` do not count, and nor do two-word ayat (ثم نظر)."""
    found = _guard_tokens(text, quran)
    return found is not None and bool(found[0].contained_ayat(found[1], QURAN_GUARD_CONTAINED_AYAH_WORDS))


def is_quran_phrase(text: str, quran: Quran | None) -> bool:
    """True when the voice may not speak ``text`` (``/api/tts``, a dictation phrase):
    :func:`looks_like_quran`, a phrase that is exactly a whole ayah of two words or more
    (:func:`is_whole_ayah`), a phrase that contains a whole short ayah
    (:func:`contains_short_ayah`), a short ayah with one misread or dropped word
    (:func:`near_short_ayat`), or a short ayah whose first word carries a conjunction
    (``و``/``ف``, :func:`clitic_ayat`). The phrase is also tested with the characters
    that can join two words without a space (a tatweel, a zero-width joiner, a slash
    inside a word, ...) turned into spaces (:func:`_joined_variants`)."""
    memo = _PHRASE_MEMO.get()
    if memo is None or memo[0] is not quran:
        return _is_quran_phrase(text, quran)
    answer = memo[1].get(text)
    if answer is None:
        answer = memo[1][text] = _is_quran_phrase(text, quran)
    return answer


#: The answers of :func:`is_quran_phrase` during one :func:`find_quran_parts` call, as
#: ``(quran, {phrase: answer})``. The search tests the voice phrases while it joins them
#: and again after each round, with the same Quran data, so about half the tests were
#: repeats (measured on 1000 ordinary words: 518 tests of 244 phrases). The function is
#: pure, so the answers are the same; the memo lives only for that call (and its thread).
_PHRASE_MEMO: contextvars.ContextVar[tuple[Any, dict[str, bool]] | None] = contextvars.ContextVar(
    "mommy_guard_phrase_memo", default=None
)


def _is_quran_phrase(text: str, quran: Quran | None) -> bool:
    if is_quranic_script(text):
        return True
    return any(_voice_refuses(v, quran) for v in [text, *_joined_variants(text)])


def _voice_refuses(text: str, quran: Quran | None, *, soft: bool = True) -> bool:
    """:func:`is_quran_phrase` on one form of the text; without ``soft``, the rules that
    only fire because of where a phrase was cut are left out (:func:`_soft_refusal`): the
    90% rule of :meth:`mommy.quran.Quran.locate`, and a phrase that is exactly an
    everyday ayah (:data:`mommy.quran.EVERYDAY_AYAT`) or an ayah of two words."""
    found = _guard_tokens(text, quran)
    if found is None:
        return False
    q, tokens, anchors = found
    whole = q.whole_ayah(tokens)
    if whole is not None and (soft or not (len(tokens) == 2 or whole in _EVERYDAY_AYAT)):
        return True
    return (
        bool(q.contained_ayat(tokens, QURAN_GUARD_CONTAINED_AYAH_WORDS))
        or bool(near_short_ayat(q, [_key(t) for t in tokens], lambda a, b: _framed(anchors, a, b)))
        or bool(clitic_ayat(q, tokens))
        or _quran_passage(*found, locate=soft)
    )


def is_everyday_formula(text: str, quran: Quran | None) -> bool:
    """True when the words of ``text`` (framing formulas left out) are exactly one of the
    everyday formulas of :data:`mommy.quran.EVERYDAY_FORMULAS` (``لا إله إلا الله``)."""
    found = _guard_tokens(text, quran)
    return found is not None and found[0].is_everyday_formula(found[1])


def _soft_refusal(phrase: str, sentence: str, quran: Quran | None) -> bool:
    """The voice refuses ``phrase`` only because it is an everyday formula
    (:func:`is_everyday_formula`), or only by a rule that fires because of where the
    phrase was cut (the 90% rule, or the phrase is exactly an everyday ayah or an ayah of
    two words: ``هذا من فضل ربي،``, ``فيها كتب قيمة``, ``ونراه قريبا``) while its
    ``sentence`` as a whole is not refused. Such a phrase is joined with a neighbouring
    phrase rather than made a Quran part (:func:`_join_soft_phrases`): the decision of
    2026-11-11 keeps the everyday formulas and these phrases ordinary words."""
    if is_quranic_script(phrase) or any(_voice_refuses(v, quran) for v in _joined_variants(phrase)):
        return False
    if is_everyday_formula(phrase, quran):
        return True
    return not _voice_refuses(phrase, quran, soft=False) and not is_quran_phrase(sentence, quran)


def _joined_variants(text: str) -> list[str]:
    """``text`` with every character that is not a letter, a mark or a digit, and every
    tatweel, turned into a space, when that splits words that were joined (``قلـهو``,
    a zero-width joiner between two words); else nothing."""
    spaced = "".join(c if unicodedata.category(c)[0] in "LMN" and c != TATWEEL else " " for c in text)
    return [spaced] if tokenize(spaced, "ar") != tokenize(text, "ar") else []


def clitic_ayat(quran: Quran, tokens: Sequence[str]) -> list[tuple[int, int, int, int]]:
    """Whole short ayat (:data:`QURAN_GUARD_CONTAINED_AYAH_WORDS` to
    :data:`mommy.quran.SHORT_AYAH_MAX_WORDS` words, or ``tokens`` exactly an ayah) whose
    first word carries a leading ``و`` or ``ف`` (``وقل هو الله أحد``): ``[(start, end,
    g_lo, g_hi)]`` with the global positions of the whole ayah. Measured: no hit on the
    ordinary sentences, 5000 random pairs of them or the app's Arabic strings."""
    out = []
    for i, t in enumerate(tokens):
        if len(t) < 3 or t[0] not in "وف":
            continue
        rest = [t[1:], *tokens[i + 1 : i + SHORT_AYAH_MAX_WORDS]]
        hits = [(a, b, surah, ayah) for a, b, surah, ayah in quran.contained_ayat(rest, QURAN_GUARD_CONTAINED_AYAH_WORDS) if a == 0]
        if i == 0 and (whole := quran.whole_ayah([t[1:], *tokens[1:]])) is not None:
            hits.append((0, len(tokens), *whole))
        for a, b, surah, ayah in hits:
            g = quran.global_position(surah, ayah)
            out.append((i, i + b, g, quran.ayah_bounds(g)[1]))
    return out


def looks_like_quran_for_meaning(text: str, quran: Quran | None) -> bool:
    """The Quran guard of contextual mode, where the brain judges the meaning of the text:
    :func:`looks_like_quran`, or a run of :data:`QURAN_GUARD_CONTEXTUAL_RUN_WORDS` (4)
    consecutive Quran words that does not pass through an everyday formula
    (:data:`mommy.quran.EVERYDAY_FORMULAS`), a whole short ayah inside the text
    (:func:`contains_short_ayah`), or what the voice refuses inside a text
    (:func:`near_short_ayat`, :func:`clitic_ayat`, and the words a separator joined). The
    endpoints also refuse by meaning every text with a Quran part (:func:`find_quran_parts`)."""
    if is_quranic_script(text):
        return True
    for v in [text, *_joined_variants(text)]:
        found = _guard_tokens(v, quran)
        if found is None:
            return False
        q, tokens, anchors = found
        if (
            q.quran_runs(tokens, QURAN_GUARD_CONTEXTUAL_RUN_WORDS, exclude_formulas=True)
            or q.contained_ayat(tokens, QURAN_GUARD_CONTAINED_AYAH_WORDS)
            or near_short_ayat(q, [_key(t) for t in tokens], lambda a, b: _framed(anchors, a, b))
            or clitic_ayat(q, tokens)
            or _quran_passage(*found)
        ):
            return True
    return False


def dictation_speaks_quran(text: str, lang: Lang, quran: Quran | None) -> bool:
    """True when reading the plain :func:`mommy.phrases.split_phrases` phrases of ``text``
    aloud would make the voice speak Quran text: a phrase or non-empty line that
    :func:`is_quran_phrase` refuses, the whole text being a whole ayah, or a whole short
    ayah among the text's words (which the six-word cap may cut between two phrases).

    This was the dictation guard before Quran parts (the ``scope: "phrase"`` refusal).
    The endpoints now dictate such a text with a grown-up reading its Quran parts
    (:meth:`QuranAnalysis.dictation_plan`); the rule is kept because the measured tables
    of ``docs/CONTRACT.md`` are stated with it.
    """
    if contains_short_ayah(text, quran):
        return True
    whole = text.strip()
    if is_whole_ayah(whole, quran):
        return True
    seen = {whole}
    for part in [*split_phrases(text, lang), *(line.strip() for line in text.splitlines())]:
        if part and part not in seen:
            seen.add(part)
            if is_quran_phrase(part, quran):
                return True
    return False


# ---------------------------------------------------------------------------
# Quran parts
# ---------------------------------------------------------------------------

#: An ayah number or range (``5``, ``١٢``, ``1-3``): a label, not a word.
_DIGITS_RE = re.compile("^[0-9\u0660-\u0669\u06f0-\u06f9]+(?:[-\u2010\u2011\u2212][0-9\u0660-\u0669\u06f0-\u06f9]+)?$")
#: The mark a page reader writes for a word it could not read (see :data:`mommy.align.UNREADABLE`).
_UNREADABLE_RE = re.compile(r"\[\s*[?\u061f]\s*\]")
#: Quranic-only characters outside words (pause marks, the end-of-ayah and rub el hizb
#: signs), removed from the phrases the voice reads.
_QURANIC_MARKS_RE = re.compile("[ۖ-ۭ]")
#: Brackets around an ayah number (both ornate parentheses can open or close it).
_OPENING_BRACKETS = "([{\ufd3e\ufd3f"
_CLOSING_BRACKETS = ")]}\ufd3e\ufd3f"
#: Quotation marks and brackets around a quoted ayah (:meth:`_Finder.in_context`).
_OPENING_QUOTES = "«\"\u201c\u201e(\ufd3e\ufd3f["
_CLOSING_QUOTES = "»\"\u201d)\ufd3e\ufd3f]"
#: Punctuation that closes what came before it: never the start of a voice phrase.
_LEADING_CLOSERS = ")]}\ufd3e\ufd3f\u00bb\u201d\u2019\u203a\"'" + SENTENCE_PUNCTUATION
_EVERYDAY_AYAT = frozenset(EVERYDAY_AYAT)
#: Characters that end a sentence (the near-match and locate scopes).
_SENTENCE_ENDS = ".!?؟۔…\n"

#: Speech keys of the label words around a quotation (left out when deciding Q1).
_SURAH_WORDS = frozenset({"سوره"})
_AYAH_WORDS = frozenset({"ايه", "الايه", "ايات", "الايات", "ايتان", "الايتان", "الايتين", "رقم"})
_LABEL_PREPOSITIONS = frozenset({"في", "من"})
#: Leading conjunctions and prepositions: adding or dropping one is a different word, not
#: a misread one.
_CLITICS = "وفبلك"

#: Which candidate wins when two overlap and have the same length.
_RULE_RANK = {"ayah": 0, "run": 1, "contained": 2, "framed": 3, "located": 4, "near": 5}


def _key(token: str) -> str:
    return recitation_key(token, "ar")


@functools.lru_cache(maxsize=1 << 15)
def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i]
        for j, cb in enumerate(b, start=1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def is_misread(typed: str, mushaf: str) -> bool:
    """True when the speech key ``typed`` can be a misread or mistyped ``mushaf`` word:
    one letter changed, dropped or added (two from six letters on), but not a leading
    conjunction or preposition (و ف ب ل ك) added or dropped, which makes another word. A
    missing hamza or a vowel mark is not even a difference here: the speech keys are equal."""
    if typed == mushaf:
        return True
    if min(len(typed), len(mushaf)) < 2:
        return False
    d = _levenshtein(typed, mushaf)
    if d == 1 and len(typed) != len(mushaf):
        longer, shorter = (typed, mushaf) if len(typed) > len(mushaf) else (mushaf, typed)
        if longer[1:] == shorter and longer[0] in _CLITICS:
            return False
    return d == 1 or (d == 2 and min(len(typed), len(mushaf)) >= 6)


def near_short_ayat(
    quran: Quran, keys: Sequence[str], context: Callable[[int, int], bool] | None = None
) -> list[tuple[int, int, int, int]]:
    """Whole short ayat (3 to :data:`mommy.quran.NEAR_AYAH_MAX_WORDS` words) in the speech
    keys ``keys`` with one OCR-like error: one word misread (:func:`is_misread`; for an
    ayah of three words, a mushaf word of three letters or more, unless ``context(start,
    end)`` says the words stand next to a framing formula or inside quotation marks) or
    one inner word dropped (ayat of four words or more), every other word as in the mushaf:
    ``[(start, end, g_lo, g_hi)]`` with the global positions of the whole ayah. The
    everyday ayat (:data:`mommy.quran.EVERYDAY_AYAT`) are left out. Measured: no hit on
    the ordinary sentences of ``tests/arabic_school_sentences.txt``, on 5000 random pairs
    of them, or on the Arabic strings of the app and its tests (``docs/CONTRACT.md``)."""
    out = []
    for a, b, surah, ayah, kind, i in quran.near_ayat(keys):
        g_lo = quran.global_position(surah, ayah)
        g_hi = quran.ayah_bounds(g_lo)[1]
        if kind == "sub":
            mushaf = quran.keys_at(g_lo + i, g_lo + i + 1)[0]
            if not is_misread(keys[a + i], mushaf):
                continue
            if g_hi - g_lo == 3 and len(mushaf) < 3 and not (context is not None and context(a, b)):
                continue
        out.append((a, b, g_lo, g_hi))
    return out


@dataclass(frozen=True)
class QuranPart:
    """One Quran part of a text: tokens ``start..end - 1`` (``textnorm.tokenize``) stand
    for the Quran words at global positions ``g_lo..g_hi - 1`` (one surah; see
    :meth:`mommy.quran.Quran.location`). ``rule`` says what found it: ``ayah`` (a text,
    line or phrase that is a whole ayah), ``run`` (5 Quran words in a row), ``framed`` (3
    next to a framing formula), ``contained`` (a whole short ayah inside), ``located``
    (90% of a text, line, sentence or phrase found in order) or ``near`` (an ayah with a
    changed, dropped or misread word)."""

    start: int
    end: int
    g_lo: int
    g_hi: int
    rule: str


@dataclass(frozen=True)
class _Cand:
    """A candidate part while searching, in the index space of the matching tokens."""

    a: int
    b: int
    g_lo: int
    g_hi: int
    rule: str
    exact: bool  # the tokens are the Quran words one for one (same keys)

    @property
    def diagonal(self) -> int:
        return self.g_lo - self.a


@dataclass
class _Fit:
    a: int
    b: int
    g_lo: int
    g_hi: int
    matched: int
    edits: int
    misreads_only: bool
    whole: bool


def _semi_global(
    typed: Sequence[str], quran_keys: Sequence[str], offset: int, band: int
) -> list[tuple[str, int | None, int | None]]:
    """Align every typed key with a stretch of ``quran_keys`` (Quran words before and
    after the stretch are free): ``[(kind, typed index, quran index)]``, kind match,
    sub, ins (a typed word) or del (a Quran word). Fewest edits, then most matches. The
    search stays within ``band`` words of the diagonal where typed word ``i`` faces Quran
    word ``i + offset``."""
    t, q = len(typed), len(quran_keys)
    big = t + q + 1

    def cols(i: int) -> range:
        return range(max(0, i + offset - band), min(q, i + offset + band) + 1)

    cost: list[dict[int, int]] = [{j: 0 for j in cols(0)}]
    for i in range(1, t + 1):
        up, row = cost[i - 1], {}
        for j in cols(i):
            options = []
            if j - 1 in up:
                options.append(up[j - 1] + (-1 if typed[i - 1] == quran_keys[j - 1] else big))
            if j in up:
                options.append(up[j] + big)
            if j - 1 in row:
                options.append(row[j - 1] + big)
            if options:
                row[j] = min(options)
        cost.append(row)
    if not cost[t]:
        return []
    j = min(cost[t], key=lambda col: (cost[t][col], col))
    ops: list[tuple[str, int | None, int | None]] = []
    i = t
    while i > 0:
        here = cost[i][j]
        up = cost[i - 1]
        same = j > 0 and typed[i - 1] == quran_keys[j - 1]
        if j - 1 in up and here == up[j - 1] + (-1 if same else big):
            ops.append(("match" if same else "sub", i - 1, j - 1))
            i, j = i - 1, j - 1
        elif j in up and here == up[j] + big:
            ops.append(("ins", i - 1, None))
            i -= 1
        else:
            ops.append(("del", None, j - 1))
            j -= 1
    ops.reverse()
    return ops


def _complete(remaining: Sequence[str], typed: Sequence[str]) -> tuple[int, int] | None:
    """How many of the ``typed`` keys complete the ``remaining`` Quran keys (in order),
    with misread substitutions, dropped and extra words: ``(typed words taken, edits)``,
    or None. The last Quran word must be matched or misread by the last word taken
    (there is typed evidence at the far end), and the edits are at most 1 (2 from six
    remaining words on)."""
    r, t = len(remaining), len(typed)
    if not r:
        return None
    limit = 1 if r < 6 else 2
    inf = math.inf
    cost = [[inf] * (t + 1) for _ in range(r + 1)]
    cost[0] = list(range(t + 1))
    for i in range(1, r + 1):
        cost[i][0] = i
        for j in range(1, t + 1):
            sub = 0 if remaining[i - 1] == typed[j - 1] else (1 if is_misread(typed[j - 1], remaining[i - 1]) else inf)
            cost[i][j] = min(cost[i - 1][j - 1] + sub, cost[i - 1][j] + 1, cost[i][j - 1] + 1)
    best: tuple[int, int, int] | None = None
    for m in range(1, t + 1):
        sub = 0 if remaining[-1] == typed[m - 1] else (1 if is_misread(typed[m - 1], remaining[-1]) else inf)
        c = cost[r - 1][m - 1] + sub
        if c <= limit and (best is None or (c, abs(m - r)) < (best[0], best[1])):
            best = (int(c), abs(m - r), m)
    return None if best is None else (best[2], best[0])


def _gap_cost(quran_keys: Sequence[str], typed: Sequence[str]) -> float:
    """Edit distance between two short key lists, substitutions allowed only for misreads."""
    q, t = len(quran_keys), len(typed)
    inf = math.inf
    cost = [[float(i + j) if i == 0 or j == 0 else inf for j in range(t + 1)] for i in range(q + 1)]
    for i in range(1, q + 1):
        for j in range(1, t + 1):
            sub = 0 if quran_keys[i - 1] == typed[j - 1] else (1 if is_misread(typed[j - 1], quran_keys[i - 1]) else inf)
            cost[i][j] = min(cost[i - 1][j - 1] + sub, cost[i - 1][j] + 1, cost[i][j - 1] + 1)
    return cost[q][t]


class _Finder:
    """The search of :func:`find_quran_parts` for one text.

    Matching runs on the tokens without the framing formulas and the ayah-number labels
    (digits): ``self.m`` maps that sequence back to the text's tokens, as
    :meth:`mommy.quran.Quran.strip_framing` does for the guards."""

    def __init__(self, quran: Quran, text: str, lang: Lang) -> None:
        self.q = quran
        self.text = text
        self.lang = lang
        self.spans = token_spans(text, lang)
        self.tokens = [text[a:b] for a, b in self.spans]
        n = len(self.tokens)
        self.framing = quran.framing_spans(self.tokens)
        self.is_framing = [False] * n
        for start, end, _ in self.framing:
            for i in range(start, end):
                self.is_framing[i] = True
        self.is_digit = [bool(_DIGITS_RE.match(t)) for t in self.tokens]
        self.m = [i for i in range(n) if not self.is_framing[i] and not self.is_digit[i]]
        self.mtokens = [self.tokens[i] for i in self.m]
        self.mkeys = [_key(t) for t in self.mtokens]
        self.anchors = [
            (bisect.bisect_left(self.m, start if closing else end), closing) for start, end, closing in self.framing
        ]
        self._located: dict[tuple[str, int, float | None], list[dict[str, Any]]] = {}

    def locate(self, joined: str, top_k: int, min_score: float | None = None) -> list[dict[str, Any]]:
        """:meth:`mommy.quran.Quran.locate` of a scope's words, once per scope and query: the
        search places every scope by the 90% rule, then again in its near-match pass and
        its voice rounds (measured on 1000 words with 21 quoted ayat: 162 calls, 124 of them
        different, a third of their time). The answers are only read."""
        key = (joined, top_k, min_score)
        found = self._located.get(key)
        if found is None:
            found = self._located[key] = self.q.locate(joined, top_k=top_k, min_score=min_score)
        return found

    # -- scopes ------------------------------------------------------------------

    def m_range(self, lo: int, hi: int) -> tuple[int, int]:
        """The matching-token range of the text's tokens ``lo..hi - 1``."""
        return bisect.bisect_left(self.m, lo), bisect.bisect_left(self.m, hi)

    def token_range(self, c0: int, c1: int) -> tuple[int, int]:
        """The tokens inside the characters ``c0..c1 - 1``."""
        starts = [a for a, _ in self.spans]
        lo = bisect.bisect_left(starts, c0)
        hi = lo
        while hi < len(self.spans) and self.spans[hi][1] <= c1:
            hi += 1
        return lo, hi

    def segments(self) -> list[tuple[int, int]]:
        """The lines and the sentences of the text, as matching-token ranges."""
        out: set[tuple[int, int]] = set()
        offset = 0
        for line in self.text.split("\n"):
            out.add(self.m_range(*self.token_range(offset, offset + len(line))))
            offset += len(line) + 1
        start = 0
        for i in range(1, len(self.spans) + 1):
            if i == len(self.spans) or any(c in _SENTENCE_ENDS for c in self.text[self.spans[i - 1][1] : self.spans[i][0]]):
                out.add(self.m_range(start, i))
                start = i
        return sorted(r for r in out if r[1] > r[0])

    # -- the rules ---------------------------------------------------------------

    def scope_cands(self, lo: int, hi: int, *, runs: bool = True, formulas: bool = True) -> list[_Cand]:
        """The candidates of the matching tokens ``lo..hi - 1``: with ``runs``, the runs of
        5, the framed runs, the contained short ayat; always, the scope as a whole ayah
        and the 90% rule. With ``formulas``, words that are exactly an everyday formula
        (:data:`mommy.quran.EVERYDAY_FORMULAS`) stay ordinary words under the 90% rule
        (the decision of 2026-11-11); the voice-phrase search turns that off for a
        formula the voice still refuses after :func:`_join_soft_phrases`."""
        q, toks = self.q, self.mtokens[lo:hi]
        out: list[_Cand] = []
        if runs:
            for a, b, g in q.exact_matches(toks, QURAN_GUARD_RUN_WORDS):
                out.append(_Cand(lo + a, lo + b, g, g + b - a, "run", True))
            anchors = [(pos - lo, closing) for pos, closing in self.anchors if lo <= pos <= hi]
            for a, b, g in framed_runs(q, toks, anchors):
                out.append(_Cand(lo + a, lo + b, g, g + b - a, "framed", True))
            for a, b, surah, ayah in q.contained_ayat(toks, QURAN_GUARD_CONTAINED_AYAH_WORDS):
                g = q.global_position(surah, ayah)
                out.append(_Cand(lo + a, lo + b, g, g + b - a, "contained", True))
        whole = q.whole_ayah(toks)
        if whole is not None:
            g = q.global_position(*whole)
            out.append(_Cand(lo, hi, g, g + hi - lo, "ayah", True))
        out.extend(self.located(lo, hi, formulas=formulas))
        return out

    def near_short(self, lo: int = 0, hi: int | None = None) -> list[_Cand]:
        """Whole short ayat with one misread or dropped word among the matching tokens
        ``lo..hi - 1`` (:func:`near_short_ayat`)."""
        hi = len(self.mkeys) if hi is None else hi
        return [
            _Cand(lo + a, lo + b, g_lo, g_hi, "near", False)
            for a, b, g_lo, g_hi in near_short_ayat(
                self.q, self.mkeys[lo:hi], lambda a, b: self.in_context(lo + a, lo + b)
            )
        ]

    def in_context(self, a: int, b: int) -> bool:
        """The matching tokens ``a..b - 1`` stand next to a framing formula
        (:func:`_framed`) or inside quotation marks or brackets (``«…»``, ``﴿…﴾``)."""
        if _framed(self.anchors, a, b):
            return True
        i0, i1 = self.m[a], self.m[b - 1]
        before = self.text[self.spans[i0 - 1][1] if i0 else 0 : self.spans[i0][0]]
        after = self.text[self.spans[i1][1] : self.spans[i1 + 1][0] if i1 + 1 < len(self.spans) else len(self.text)]
        return any(c in _OPENING_QUOTES for c in before) and any(c in _CLOSING_QUOTES for c in after)

    def clitics(self, lo: int = 0, hi: int | None = None) -> list[_Cand]:
        """A short ayah whose first word carries a leading conjunction (:func:`clitic_ayat`):
        the part is the ayah's other words (the first word stays with the sentence, whose
        conjunction it carries), so the voice never reads the ayah."""
        hi = len(self.mkeys) if hi is None else hi
        return [
            _Cand(lo + a + 1, lo + b, g_lo + 1, g_hi, "contained", True)
            for a, b, g_lo, g_hi in clitic_ayat(self.q, self.mtokens[lo:hi])
            if b - a >= 2
        ]

    def short_misreads(self) -> list[_Cand]:
        """A whole ayah of four words, three of them found in a row and the first or the
        last one misread (one letter): ``قل هو الله`` and a misread ``أحد``. The words of
        an everyday formula do not count as the three."""
        q, keys, out = self.q, self.mkeys, []
        for a, b, g in q.exact_matches(self.mtokens, 3, exclude_formulas=True):
            first, end = q.ayah_bounds(g)
            if end - first != SHORT_MISREAD_WORDS or b - a != SHORT_MISREAD_WORDS - 1:
                continue
            ayah = q.keys_at(first, end)
            if g == first and b < len(keys) and keys[b] != ayah[-1] and is_misread(keys[b], ayah[-1]):
                out.append(_Cand(a, b + 1, first, end, "near", False))
            elif g == first + 1 and a > 0 and keys[a - 1] != ayah[0] and is_misread(keys[a - 1], ayah[0]):
                out.append(_Cand(a - 1, b, first, end, "near", False))
        return out

    def whole(self, c: _Cand) -> bool:
        """The candidate's Quran words are whole ayat."""
        return self.q.ayah_bounds(c.g_lo)[0] == c.g_lo and self.q.ayah_bounds(c.g_hi - 1)[1] == c.g_hi

    def located(self, lo: int, hi: int, *, near: bool = False, formulas: bool = True) -> list[_Cand]:
        """The 90% rule of :func:`looks_like_quran` on a scope, placed by a fit; and, with
        ``near`` and a run of 3 Quran words in the scope, a whole ayah located there with
        at most one changed, dropped or misread word (two from ten words on). With
        ``formulas``, words that are exactly an everyday formula are not placed."""
        toks = self.mtokens[lo:hi]
        if len(toks) < QURAN_GUARD_MIN_WORDS:
            return []
        joined = " ".join(toks)
        best = self.locate(joined, top_k=1, min_score=QURAN_GUARD_MIN_SCORE)
        if best and best[0]["score"] >= QURAN_GUARD_MIN_SCORE:
            fit = self.fit(lo, hi, best[0])
            if fit is not None and not (formulas and self.q.is_everyday_formula(self.mtokens[fit.a : fit.b])):
                exact = fit.edits == 0 and fit.b - fit.a == fit.g_hi - fit.g_lo
                return [_Cand(fit.a, fit.b, fit.g_lo, fit.g_hi, "located", exact)]
        if near and len(toks) <= NEAR_MAX_SCOPE_WORDS and self.q.quran_runs(toks, 3):
            for cand in self.locate(joined, top_k=3):
                fit = self.fit(lo, hi, cand)
                if fit is None or not fit.whole or not fit.misreads_only or fit.matched < NEAR_MIN_MATCHED:
                    continue
                if fit.edits <= (1 if fit.g_hi - fit.g_lo < 10 else 2):
                    return [_Cand(fit.a, fit.b, fit.g_lo, fit.g_hi, "near", fit.edits == 0)]
        return []

    def fit(self, lo: int, hi: int, cand: dict[str, Any]) -> _Fit | None:
        """Align the scope's words with the Quran around a :meth:`mommy.quran.Quran.locate`
        candidate, and keep the stretch between the first and the last matched word."""
        q = self.q
        typed = self.mkeys[lo:hi]
        g0 = q.global_position(cand["surah"], cand["ayah"], cand["match_word_index"])
        s_lo, s_hi = q.surah_bounds(g0)
        # Where the scope's first word stands in the Quran: from the longest run of 3
        # exact words near the candidate (locate's start is clamped at a surah's start).
        start = g0
        runs = [
            (b - a, g - a) for a, b, g in q.exact_matches(self.mtokens[lo:hi], 3)
            if s_lo <= g < s_hi and g0 - len(typed) - 10 <= g <= g0 + len(typed) + 10
        ]
        if runs:
            start = max(runs)[1]
        w_lo, w_hi = max(s_lo, start - FIT_BAND), min(s_hi, start + len(typed) + FIT_BAND)
        if w_lo >= w_hi:
            return None
        first = q.ayah_bounds(w_lo)[0]
        if w_lo - first <= 10:
            w_lo = first
        last = q.ayah_bounds(w_hi - 1)[1]
        if last - w_hi <= 10:
            w_hi = last
        quran_keys = q.keys_at(w_lo, w_hi)
        ops = _semi_global(typed, quran_keys, start - w_lo, FIT_BAND)
        matched = [k for k, op in enumerate(ops) if op[0] == "match"]
        if not matched:
            return None
        inner = ops[matched[0] : matched[-1] + 1]
        t0, j0 = ops[matched[0]][1], ops[matched[0]][2]
        t1, j1 = ops[matched[-1]][1], ops[matched[-1]][2]
        assert t0 is not None and j0 is not None and t1 is not None and j1 is not None
        g_lo, g_hi = w_lo + j0, w_lo + j1 + 1
        subs = [(typed[ti], quran_keys[qj]) for kind, ti, qj in inner if kind == "sub" and ti is not None and qj is not None]
        return _Fit(
            a=lo + t0, b=lo + t1 + 1, g_lo=g_lo, g_hi=g_hi,
            matched=len(matched), edits=sum(1 for op in inner if op[0] != "match"),
            misreads_only=all(is_misread(x, y) for x, y in subs),
            whole=q.ayah_bounds(g_lo)[0] == g_lo and q.ayah_bounds(g_hi - 1)[1] == g_hi,
        )

    # -- choosing, completing and joining ------------------------------------------

    @staticmethod
    def resolve(cands: Sequence[_Cand]) -> list[_Cand]:
        """Non-overlapping parts from the candidates: the longest first; an overlapping
        candidate on the same diagonal (the same Quran words) is merged in, any other is
        dropped."""
        chosen: list[_Cand] = []
        for c in sorted(cands, key=lambda c: (-(c.b - c.a), _RULE_RANK[c.rule], c.a, c.g_lo)):
            clash = [p for p in chosen if c.a < p.b and p.a < c.b]
            if not clash:
                chosen.append(c)
            elif c.exact and all(p.exact and p.diagonal == c.diagonal for p in clash):
                a, b = min(c.a, *(p.a for p in clash)), max(c.b, *(p.b for p in clash))
                rule = min([c, *clash], key=lambda p: _RULE_RANK[p.rule]).rule
                chosen = [p for p in chosen if p not in clash]
                chosen.append(_Cand(a, b, a + c.diagonal, b + c.diagonal, rule, True))
        return sorted(chosen, key=lambda c: c.a)

    def complete_and_join(self, parts: list[_Cand]) -> list[_Cand]:
        """Complete each part to the start and the end of the ayat it covers in part
        (:func:`_complete`), then join neighbours in one surah across a short gap
        (a changed, dropped or extra word between two stretches of one quotation)."""
        q = self.q
        done: list[_Cand] = []
        for idx, p in enumerate(parts):
            right_limit = parts[idx + 1].a if idx + 1 < len(parts) else len(self.mkeys)
            left_limit = done[-1].b if done else 0
            end = q.ayah_bounds(p.g_hi - 1)[1]
            remaining = q.keys_at(p.g_hi, end) if end > p.g_hi else []
            if 0 < len(remaining) <= NEAR_EXTEND_MAX_WORDS:
                taken = _complete(remaining, self.mkeys[p.b : min(right_limit, p.b + len(remaining) + 1)])
                if taken is not None:
                    p = _Cand(p.a, p.b + taken[0], p.g_lo, end, "near", False)
            start = q.ayah_bounds(p.g_lo)[0]
            remaining = q.keys_at(start, p.g_lo) if start < p.g_lo else []
            if 0 < len(remaining) <= NEAR_EXTEND_MAX_WORDS:
                lo = max(left_limit, p.a - len(remaining) - 1)
                taken = _complete(remaining[::-1], self.mkeys[lo : p.a][::-1])
                if taken is not None:
                    p = _Cand(p.a - taken[0], p.b, start, p.g_hi, "near", False)
            done.append(p)
        joined: list[_Cand] = []
        for p in done:
            if joined and self.joinable(joined[-1], p):
                prev = joined.pop()
                exact = prev.exact and p.exact and prev.diagonal == p.diagonal
                p = _Cand(prev.a, p.b, prev.g_lo, p.g_hi, prev.rule if exact else "near", exact)
            joined.append(p)
        return joined

    def joinable(self, p: _Cand, nxt: _Cand) -> bool:
        q = self.q
        gap_q, gap_t = nxt.g_lo - p.g_hi, nxt.a - p.b
        if not (0 <= gap_q <= NEAR_GAP_WORDS and 0 <= gap_t <= NEAR_GAP_WORDS):
            return False
        if q.location(p.g_hi - 1)[0] != q.location(nxt.g_lo)[0]:
            return False
        if gap_q == gap_t == 0:
            return True
        cost = _gap_cost(q.keys_at(p.g_hi, nxt.g_lo) if gap_q else [], self.mkeys[p.b : nxt.a])
        return cost <= max(1, min(gap_q, gap_t))

    # -- the search ----------------------------------------------------------------

    def find(self) -> list[_Cand]:
        n = len(self.mkeys)
        segments = [r for r in self.segments() if r != (0, n)]
        cands = self.scope_cands(0, n)
        for lo, hi in segments:
            cands += self.scope_cands(lo, hi, runs=False)
        parts = self.resolve(cands)
        # The near match of a whole ayah, where a run of 3 Quran words is not yet inside
        # a part of whole ayat (an ayah with a misread word has such runs around it).
        loose = [
            (a, b) for a, b, _ in self.q.exact_matches(self.mtokens, 3)
            if not any(p.a <= a and b <= p.b and self.whole(p) for p in parts)
        ]
        near = [
            c for lo, hi in [(0, n), *segments]
            if any(lo < b and a < hi for a, b in loose)
            for c in self.located(lo, hi, near=True)
        ]
        parts = self.complete_and_join(
            self.resolve([*parts, *near, *self.short_misreads(), *self.near_short(), *self.clitics()])
        )
        # Every phrase the voice would refuse is searched with the same rules, until the
        # voice is left with no Quran phrase (each round adds a part, or stops).
        self.voice_safe = True
        for _ in range(len(self.mkeys) + 1):
            flagged = [
                self.m_range(*self.token_range(c0, c1))
                for phrase, (c0, c1) in self.voice_phrases(parts)
                if is_quran_phrase(phrase, self.q)
            ]
            if not flagged:
                break
            extra = [
                c
                for lo, hi in flagged
                for c in [*self.scope_cands(lo, hi, formulas=False), *self.near_short(lo, hi), *self.clitics(lo, hi)]
            ]
            new = self.complete_and_join(self.resolve([*parts, *extra]))
            if new == parts:  # a refused phrase with no part found in it: never seen
                self.voice_safe = False
                break
            parts = new
        return parts

    def to_parts(self, cands: Sequence[_Cand]) -> list[QuranPart]:
        """The candidates as parts of the text's tokens. An ayah number in brackets right
        after a part (``... أحد (1)``) belongs to it: the voice does not read it out."""
        out = []
        for c in cands:
            end = self.m[c.b - 1] + 1
            while end < len(self.tokens) and self.is_digit[end] and self.bracketed(end):
                end += 1
            out.append(QuranPart(self.m[c.a], end, c.g_lo, c.g_hi, c.rule))
        return out

    def bracketed(self, i: int) -> bool:
        """True when token ``i`` stands in brackets with nothing else between it and the
        token before (``(1)``, ``[٢]``, ``﴿٣﴾``)."""
        before = self.text[self.spans[i - 1][1] : self.spans[i][0]] if i else ""
        after_end = self.spans[i + 1][0] if i + 1 < len(self.spans) else len(self.text)
        after = self.text[self.spans[i][1] : after_end]
        return (
            any(c in _OPENING_BRACKETS for c in before)
            and any(c in _CLOSING_BRACKETS for c in after)
            and all(not c.isalnum() for c in before)
        )

    def voice_phrases(self, cands: Sequence[_Cand]) -> list[tuple[str, tuple[int, int]]]:
        """The phrases the voice would read around the parts ``cands`` (see
        :func:`_voice_phrases`)."""
        return _voice_phrases(self.text, self.lang, self.spans, self.to_parts(cands), self.q)


#: A phrase joined with its neighbour by :func:`_join_soft_phrases` has at most this many
#: words (the usual cap is 6).
SOFT_JOIN_MAX_WORDS = 8


def _voice_phrases(
    text: str,
    lang: Lang,
    spans: Sequence[tuple[int, int]],
    parts: Sequence[QuranPart],
    quran: Quran | None = None,
) -> list[tuple[str, tuple[int, int]]]:
    """The dictation phrases of the text between the parts: :func:`mommy.phrases.split_phrase_spans`
    of each stretch, with Quranic marks outside words removed; ``[(phrase, (start, end))]``.
    With the Quran text, a phrase the voice refuses only softly (an everyday formula, or
    an everyday phrase the cut isolated) is joined with a neighbour (:func:`_join_soft_phrases`)."""
    out: list[tuple[str, tuple[int, int]]] = []
    pos = 0
    for c0, c1 in [*((spans[p.start][0], spans[p.end - 1][1]) for p in parts), (len(text), len(text))]:
        stretch = [(pos + a, pos + b) for _, (a, b) in split_phrase_spans(text[pos:c0], lang)]
        if quran is not None and len(stretch) > 1:
            stretch = _join_soft_phrases(text, stretch, quran, after_part=bool(pos))
        for k, (a, b) in enumerate(stretch):
            phrase = _voice_text(text[a:b], first_after_part=k == 0 and bool(pos))
            if phrase:
                out.append((phrase, (a, b)))
        pos = c1
    return out


def _voice_text(raw: str, *, first_after_part: bool) -> str:
    phrase = " ".join(_QURANIC_MARKS_RE.sub("", raw).split())  # marks outside words
    if first_after_part:
        phrase = phrase.lstrip(_LEADING_CLOSERS + " ")  # what closes the part before: ``(1)``, ``»``
    return phrase


def _sentence_around(text: str, a: int, b: int) -> str:
    """The sentence of ``text`` that holds the characters ``a..b - 1``."""
    lo = a
    while lo > 0 and text[lo - 1] not in _SENTENCE_ENDS:
        lo -= 1
    core_end = b
    while core_end > a and not text[core_end - 1].isalnum():
        core_end -= 1
    hi = core_end
    while hi < len(text) and text[hi] not in _SENTENCE_ENDS:
        hi += 1
    return text[lo : min(len(text), hi + 1)]


def _join_soft_phrases(
    text: str, stretch: list[tuple[int, int]], quran: Quran, *, after_part: bool
) -> list[tuple[int, int]]:
    """Join each phrase the voice refuses only softly (:func:`_soft_refusal`) with the
    phrase before it, else the one after it, when the joined phrase has at most
    :data:`SOFT_JOIN_MAX_WORDS` words and the voice guard (as built) accepts it. An
    everyday phrase isolated by the cut stays within its sentence; an everyday formula
    may join the next or the previous sentence. A phrase that cannot be joined is left
    as it is (the search then makes it a Quran part)."""
    out = list(stretch)
    i = 0
    while i < len(out):
        a, b = out[i]
        phrase = _voice_text(text[a:b], first_after_part=i == 0 and after_part)
        if not phrase or not is_quran_phrase(phrase, quran) or not _soft_refusal(phrase, _sentence_around(text, a, b), quran):
            i += 1
            continue
        formula = is_everyday_formula(phrase, quran)
        joined = None
        for j in (i - 1, i + 1):
            if not 0 <= j < len(out):
                continue
            lo, hi = min(i, j), max(i, j)
            between = text[out[lo][0] : out[hi][0]]
            core = between.rstrip(" \t\n" + SENTENCE_PUNCTUATION + "»\"\u201d)")
            if not formula and any(c in _SENTENCE_ENDS for c in between[len(core):]):
                continue  # another sentence: only a formula joins it
            joined = _rejoin(text, out, lo, hi, j, quran, after_part)
            if joined is not None:
                out[lo : hi + 1] = joined
                i = lo + len(joined) - 1 if len(joined) > 1 and j == i + 1 else lo
                break
        if joined is None:
            i += 1
    return out


def _rejoin(
    text: str, out: list[tuple[int, int]], lo: int, hi: int, j: int, quran: Quran, after_part: bool
) -> list[tuple[int, int]] | None:
    """Phrases ``lo`` and ``hi`` (neighbours, ``j`` the one that gives words) joined into
    one phrase of at most :data:`SOFT_JOIN_MAX_WORDS` words, or, failing that, with one
    to three words of ``j`` moved over to the other; None when the voice guard refuses
    every form."""

    def ok(spans: list[tuple[int, int]]) -> bool:
        for k, (a, b) in enumerate(spans):
            phrase = _voice_text(text[a:b], first_after_part=lo + k == 0 and after_part)
            if not phrase or len(tokenize(phrase, "ar")) > SOFT_JOIN_MAX_WORDS or is_quran_phrase(phrase, quran):
                return False
        return True

    whole = [(out[lo][0], out[hi][1])]
    if ok(whole):
        return whole
    a_j, b_j = out[j]
    words = [(a_j + a, a_j + b) for a, b in token_spans(text[a_j:b_j], "ar")]
    for k in range(1, min(3, len(words) - 1) + 1):
        if j == lo:  # the last k words of the phrase before go to the next one
            cut = words[len(words) - k][0]
            spans = [(out[lo][0], cut), (cut, out[hi][1])]
        else:  # the first k words of the phrase after go to the one before
            cut = words[k][0]
            spans = [(out[lo][0], cut), (cut, out[hi][1])]
        if ok(spans):
            return spans
    return None


@dataclass
class ExpectedWords:
    """The expected words of a recitation or dictation check of a text with Quran parts:
    the typed words outside the parts, and the mushaf (Simple-Clean) words of each part
    in its place (``textnorm.tokenize`` order).

    ``quran`` maps the index of every Quran word to ``(part index, global position)``;
    ``display`` gives its word as it is in the mushaf (the Uthmani display word, or
    words); ``ranges`` the expected-index range of each part; ``alternatives`` the
    Uthmani spelling of each complete display group, ``(first, end, display words)``."""

    tokens: list[str]
    quran: dict[int, tuple[int, int]] = field(default_factory=dict)
    display: dict[int, str] = field(default_factory=dict)
    ranges: list[tuple[int, int]] = field(default_factory=list)
    alternatives: list[tuple[int, int, list[str]]] = field(default_factory=list)

    @property
    def rigid(self) -> set[int]:
        return set(self.quran)


@dataclass
class QuranAnalysis:
    """What :func:`find_quran_parts` found in one text.

    ``text`` is the text analysed (the cleaned text of an endpoint), ``spans`` its token
    spans (``textnorm.token_spans``), ``parts`` the Quran parts in text order,
    ``is_quran`` whether the text is Quran (Q1), and ``uthmani_outside`` whether a word in
    the Uthmani script lies outside every part (it cannot be placed in the mushaf: the
    endpoints refuse such a text as Quran text, as before)."""

    text: str
    lang: Lang
    spans: list[tuple[int, int]]
    parts: list[QuranPart]
    is_quran: bool
    uthmani_outside: bool
    quran: Quran | None
    framing: frozenset[int] = frozenset()
    digits: frozenset[int] = frozenset()
    #: The voice is left with no phrase that :func:`is_quran_phrase` refuses (a safety
    #: net: the search makes every such phrase a part; False has never been seen).
    voice_safe: bool = True
    _cache: dict[str, dict[Any, Any]] = field(default_factory=dict, repr=False, compare=False)

    # -- refusals ------------------------------------------------------------------

    @property
    def refused(self) -> bool:
        """The general endpoints refuse the text (``422 quran_text``): it is Quran (Q1), or
        it has Uthmani script outside the parts."""
        return self.is_quran or self.uthmani_outside

    def quran_range(self) -> dict[str, int] | None:
        """``{"surah", "from", "to"}`` when the text is Quran (Q1) and its ayat are one
        range of one surah (what the Quran section opens with), else None."""
        if not self.is_quran or self.quran is None:
            return None
        q = self.quran
        basmala = q.global_position(1, 1)
        refs = [p for p in self.parts if (p.g_lo, p.g_hi) != (basmala, basmala + 4)] or list(self.parts)
        if not refs:
            return None
        first, last = q.location(refs[0].g_lo), q.location(refs[-1].g_hi - 1)
        if first[0] != last[0]:
            return None
        ayat = [a for p in refs for a in range(q.location(p.g_lo)[1], q.location(p.g_hi - 1)[1] + 1)]
        if ayat != list(range(first[1], last[1] + 1)):
            return None
        return {"surah": first[0], "from": first[1], "to": last[1]}

    # -- tokens --------------------------------------------------------------------

    @property
    def tokens(self) -> list[str]:
        return [self.text[a:b] for a, b in self.spans]

    def _typed(self, part: QuranPart) -> list[int]:
        """The typed words of a part (its tokens without labels and framing formulas)."""
        return [i for i in range(part.start, part.end) if i not in self.digits and i not in self.framing]

    def _require_quran(self) -> Quran:
        assert self.quran is not None, "an analysis with parts has the Quran text"
        return self.quran

    # -- the mushaf words of a part ------------------------------------------------------

    def _groups(self, part: QuranPart) -> list[dict[str, Any]]:
        cache = self._cache.setdefault("groups", {})
        if part not in cache:
            cache[part] = self._require_quran().word_groups(part.g_lo, part.g_hi)
        return cache[part]

    def _group_display(self, group: dict[str, Any]) -> str:
        q = self._require_quran()
        words = q.ayat(group["surah"], group["ayah"], group["ayah"])[0].display_words
        d0, d1 = group["display"]
        return " ".join(words[d0 : d1 + 1])

    def mushaf_words(self, part: QuranPart) -> tuple[list[str], list[str], list[str]]:
        """``(uthmani, clean, clean_display)``: the part's display words, its Simple-Clean
        words, and for each Simple-Clean word the display word(s) that spell it."""
        q = self._require_quran()
        uthmani: list[str] = []
        clean_display: list[str] = []
        last: tuple[int, int, int] | None = None
        for group in self._groups(part):
            words = q.ayat(group["surah"], group["ayah"], group["ayah"])[0].display_words
            d0, d1 = group["display"]
            for d in range(d0, d1 + 1):
                if (group["surah"], group["ayah"], d) != last:
                    uthmani.append(words[d])
                    last = (group["surah"], group["ayah"], d)
            clean_display.extend([" ".join(words[d0 : d1 + 1])] * (group["g"][1] - group["g"][0]))
        return uthmani, q.words_at(part.g_lo, part.g_hi), clean_display

    def chunks(self, part: QuranPart) -> list[tuple[str, str]]:
        """The grown-up's reading chunks of a part: ``[(vowelled Uthmani text, the same in
        Simple-Clean words)]``. A chunk never crosses an ayah and has at most
        :data:`CHUNK_MAX_WORDS` display words (the cap of a dictation phrase); a longer
        stretch of an ayah is cut into near-equal chunks. The Uthmani text is cut
        verbatim from the Tanzil line (pause marks between its words kept)."""
        q = self._require_quran()
        by_ayah: list[list[dict[str, Any]]] = []
        for group in self._groups(part):
            if by_ayah and (by_ayah[-1][0]["surah"], by_ayah[-1][0]["ayah"]) == (group["surah"], group["ayah"]):
                by_ayah[-1].append(group)
            else:
                by_ayah.append([group])
        out: list[tuple[str, str]] = []
        for groups in by_ayah:
            sizes = [g["display"][1] - g["display"][0] + 1 for g in groups]
            pieces = max(1, -(-sum(sizes) // CHUNK_MAX_WORDS))
            while True:
                base, extra = divmod(len(groups), pieces)
                cuts = [base + 1 if k < extra else base for k in range(pieces)]
                bounds, pos = [], 0
                for size in cuts:
                    bounds.append((pos, pos + size))
                    pos += size
                if all(sum(sizes[a:b]) <= CHUNK_MAX_WORDS for a, b in bounds) or pieces >= len(groups):
                    break
                pieces += 1
            for a, b in bounds:
                if a == b:
                    continue
                first, last = groups[a], groups[b - 1]
                uthmani = q.display_slice(first["surah"], first["ayah"], first["display"][0], last["display"][1])
                clean = " ".join(q.words_at(first["g"][0], last["g"][1]))
                out.append((uthmani, clean))
        return out

    # -- differences from the mushaf --------------------------------------------------

    def _ops(self, part: QuranPart) -> list[Op]:
        """The typed words of a part aligned with its mushaf words (every op, matches
        included); see :meth:`differences`."""
        cache = self._cache.setdefault("ops", {})
        if part not in cache:
            _, clean, _ = self.mushaf_words(part)
            typed = [self.text[self.spans[i][0] : self.spans[i][1]] for i in self._typed(part)]
            cache[part] = quran_writing_ops(clean, self._alternatives(part, 0), typed, self.lang)
        return cache[part]

    def differences(self, part: QuranPart) -> list[Op]:
        """The typed words of a part against its mushaf words, compared as the dictation
        compares a Quran word (:func:`quran_writing_ops`): diacritics are ignored and the
        Uthmani or the standard spelling is accepted; a changed letter, a missing hamza
        and a missing or extra word are differences. ``exp_index`` indexes the part's
        Simple-Clean words and ``heard_index`` its typed words (:meth:`_typed`)."""
        return [op for op in self._ops(part) if op.kind != "match"]

    def _alternatives(self, part: QuranPart, offset: int) -> list[tuple[int, int, list[str]]]:
        out = []
        for group in self._groups(part):
            if group["complete"]:
                g0, g1 = group["g"]
                out.append((offset + g0 - part.g_lo, offset + g1 - part.g_lo, self._group_display(group).split()))
        return out

    def _script_is_uthmani(self, part: QuranPart) -> bool:
        return any(is_quranic_script(self.text[self.spans[i][0] : self.spans[i][1]]) for i in self._typed(part))

    def _edits(self, part: QuranPart) -> list[tuple[int, int, str]]:
        """Character edits ``(start, end, new text)`` that turn the part's typed words into
        the mushaf words, in the script closest to what was typed (Uthmani when the typed
        words use the Uthmani script, else the standard Simple-Clean spelling); labels,
        punctuation and words that already agree are kept as typed."""
        uthmani = self._script_is_uthmani(part)
        _, clean, clean_display = self.mushaf_words(part)
        typed = self._typed(part)

        def word(m: int) -> str:
            if not uthmani:
                return clean[m]
            # One display word can spell two Simple-Clean words: write it once.
            return "" if m > 0 and clean_display[m] == clean_display[m - 1] else clean_display[m]

        ops = self._ops(part)
        edits: list[tuple[int, int, str]] = []
        for k, op in enumerate(ops):
            if op.kind == "sub" and op.heard_index is not None and op.exp_index is not None:
                a, b = self.spans[typed[op.heard_index]]
                edits.append((a, b, word(op.exp_index)))
            elif op.kind == "ins" and op.heard_index is not None:
                a, b = self.spans[typed[op.heard_index]]
                while b < len(self.text) and self.text[b] in " \t":
                    b += 1
                edits.append((a, b, ""))
            elif op.kind == "del" and op.exp_index is not None and (w := word(op.exp_index)):
                after = next((o.heard_index for o in ops[k + 1 :] if o.heard_index is not None), None)
                before = next((o.heard_index for o in reversed(ops[:k]) if o.heard_index is not None), None)
                gap_lo = self.spans[typed[before]][1] if before is not None else self.spans[part.start][0]
                gap_hi = self.spans[typed[after]][0] if after is not None else self.spans[part.end - 1][1]
                mark = _UNREADABLE_RE.search(self.text, gap_lo, max(gap_lo, gap_hi))
                if mark and not any(e[0] == mark.start() for e in edits):
                    edits.append((mark.start(), mark.end(), w))  # the word a page reader could not read
                elif after is not None:
                    pos = self.spans[typed[after]][0]
                    edits.append((pos, pos, w + " "))
                else:
                    pos = self.spans[typed[-1]][1] if typed else self.spans[part.start][0]
                    edits.append((pos, pos, " " + w))
        return edits

    def replacement(self, part: QuranPart) -> str:
        """The part's characters with its differences replaced by the mushaf words (equal
        to the typed characters when nothing differs)."""
        a, b = self.spans[part.start][0], self.spans[part.end - 1][1]
        return _apply(self.text[a:b], [(s - a, e - a, w) for s, e, w in self._edits(part)])

    def mushaf_text(self) -> str:
        """The text with every differing Quran part replaced by the mushaf words
        (:meth:`replacement`); equal to the text when nothing differs."""
        return _apply(self.text, [e for part in self.parts for e in self._edits(part)])

    # -- the dictation ---------------------------------------------------------------------

    def dictation_plan(self) -> list[dict[str, Any]]:
        """The phrases of a dictation of the text, in order: ``[{"phrase", "reader",
        "read_text", "part"}]``. The voice reads the phrases of the text between the parts
        (:func:`mommy.phrases.split_phrase_spans` of each stretch); every Quran part is
        read by a grown-up, chunk by chunk (:meth:`chunks`): ``phrase`` is the chunk in
        Simple-Clean words (what the child writes) and ``read_text`` the vowelled
        Uthmani text shown to the grown-up. ``part`` is the index of the part."""
        out: list[dict[str, Any]] = []
        voice = _voice_phrases(self.text, self.lang, self.spans, self.parts, self.quran)
        k = 0
        for index, part in enumerate([*self.parts, None]):
            limit = self.spans[part.start][0] if part is not None else len(self.text) + 1
            while k < len(voice) and voice[k][1][0] < limit:
                out.append({"phrase": voice[k][0], "reader": "voice", "read_text": None, "part": None})
                k += 1
            if part is not None:
                for uthmani, clean in self.chunks(part):
                    out.append({"phrase": clean, "reader": "grown_up", "read_text": uthmani, "part": index})
        return out

    # -- checks ----------------------------------------------------------------------

    def expected(self) -> ExpectedWords:
        """The expected words of a check (:class:`ExpectedWords`)."""
        tokens = self.tokens
        out = ExpectedWords(tokens=[])
        starts = {p.start: (index, p) for index, p in enumerate(self.parts)}
        i = 0
        while i < len(tokens):
            if i not in starts:
                out.tokens.append(tokens[i])
                i += 1
                continue
            index, part = starts[i]
            x = len(out.tokens)
            _, clean, clean_display = self.mushaf_words(part)
            for m, (w, d) in enumerate(zip(clean, clean_display)):
                out.quran[x + m] = (index, part.g_lo + m)
                out.display[x + m] = d
            out.tokens.extend(clean)
            out.ranges.append((x, x + len(clean)))
            out.alternatives.extend(self._alternatives(part, x))
            i = part.end
        return out

    def check_recitation(self, heard_text: str) -> tuple[CheckResult, ExpectedWords]:
        """A word-by-word recitation check (``/api/recite/check`` strict). The typed words
        outside the parts keep every speech tolerance of :func:`mommy.align.check_recitation`;
        a Quran part's mushaf words are compared as :meth:`mommy.quran.Quran.check`
        compares them: speech keys, no joined or split words, no numbers by value, the
        disjoined letters said by name."""
        exp = self.expected()
        if not self.parts:
            return check_recitation(self.text, heard_text, self.lang), exp
        q = self._require_quran()
        heard = tokenize(heard_text, self.lang)
        joins = without_rigid(speech_joins(exp.tokens, heard, self.lang), exp.rigid)
        heard_keys = [_key(t) for t in heard]
        for (x, y), part in zip(exp.ranges, self.parts):
            for (i, j), ks in q.muqattaat_joins(part.g_lo, y - x, heard_keys).items():
                joins[0].setdefault((x + i, j), []).extend(ks)
        ops = align_with_joins(
            exp.tokens, heard, lambda t: recitation_key(t, self.lang), extra_joins=joins, rigid=exp.rigid
        )
        return build_result(ops, len(exp.tokens), len(heard)), exp

    def check_writing(self, written_text: str, *, strict_tashkeel: bool = False) -> tuple[CheckResult, ExpectedWords]:
        """A dictation check (``/api/dictation/check``): the words outside the parts as
        strictly as :func:`mommy.align.check_writing`; a Quran word is accepted in its
        Simple-Clean spelling or in its Uthmani spelling (both through the dictation
        key), and in nothing else."""
        exp = self.expected()
        if not self.parts:
            return check_writing(self.text, written_text, self.lang, strict_tashkeel=strict_tashkeel), exp
        written = tokenize_written(written_text, self.lang)
        ops = quran_writing_ops(exp.tokens, exp.alternatives, written, self.lang, strict_tashkeel=strict_tashkeel)
        return build_result(ops, len(exp.tokens), len(written), unreliable_error_rate=None), exp

    # -- JSON ------------------------------------------------------------------------

    def parts_json(self, submitted: str | None = None, *, lead: int = 0) -> list[dict[str, Any]]:
        """The parts as the API returns them (``docs/CONTRACT.md``). ``submitted`` is the
        text as the client sent it and ``lead`` the characters stripped from its start, so
        the offsets point into what the client holds."""
        submitted = self.text if submitted is None else submitted
        q = self.quran
        out: list[dict[str, Any]] = []
        exp_ranges = self.expected().ranges if self.parts else []
        for index, part in enumerate(self.parts):
            assert q is not None
            uthmani, clean, clean_display = self.mushaf_words(part)
            typed = self._typed(part)
            c0, c1 = lead + self.spans[part.start][0], lead + self.spans[part.end - 1][1]
            first, last = q.location(part.g_lo), q.location(part.g_hi - 1)
            diffs = []
            ops = self._ops(part)
            for k, op in enumerate(ops):
                if op.kind == "match":
                    continue
                exp = op.exp_index
                if exp is None:  # an extra typed word: placed before the next mushaf word
                    exp_word, exp_display = None, None
                    index_ = next((o.exp_index for o in ops[k + 1 :] if o.exp_index is not None), len(clean))
                else:
                    exp_word, exp_display, index_ = clean[exp], clean_display[exp], exp
                diffs.append({
                    "op": op.kind,
                    "typed": op.heard,
                    "mushaf": exp_display,
                    "mushaf_clean": exp_word,
                    "index": index_,
                    "token": typed[op.heard_index] if op.heard_index is not None else None,
                })
            out.append({
                "start": part.start,
                "end": part.end,
                "chars": [c0, c1],
                "utf16": [_utf16(submitted, c0), _utf16(submitted, c1)],
                "surah": first[0],
                "ayah_from": first[1],
                "ayah_to": last[1],
                "word_from": first[2],
                "word_to": last[2] + 1,
                "whole": q.ayah_bounds(part.g_lo)[0] == part.g_lo and q.ayah_bounds(part.g_hi - 1)[1] == part.g_hi,
                "rule": part.rule,
                "uthmani": uthmani,
                "clean": clean,
                "clean_display": clean_display,
                "differences": diffs,
                "replacement": self.replacement(part),
                "chunks": [u for u, _ in self.chunks(part)],
                "exp_start": exp_ranges[index][0],
                "exp_end": exp_ranges[index][1],
            })
        return out


def _utf16(text: str, index: int) -> int:
    """A code-point offset as a UTF-16 code-unit offset (what JavaScript counts)."""
    return index + sum(1 for c in text[:index] if ord(c) > 0xFFFF)


def _apply(text: str, edits: Sequence[tuple[int, int, str]]) -> str:
    for start, end, new in sorted(edits, key=lambda e: (e[0], e[1]), reverse=True):
        text = text[:start] + new + text[end:]
    return text


def quran_writing_ops(
    expected: Sequence[str],
    alternatives: Sequence[tuple[int, int, Sequence[str]]],
    written: Sequence[str],
    lang: Lang,
    *,
    strict_tashkeel: bool = False,
) -> list[Op]:
    """Align written words with expected words as a dictation does
    (:func:`mommy.align.writing_key`, no joined or split words), where the expected words
    ``first..end - 1`` of each alternative may also be written as its display words (the
    Uthmani spelling of Quran words). Every other word compares as in
    :func:`mommy.align.check_writing`."""

    def key(token: str) -> str:
        return writing_key(token, lang, strict_tashkeel=strict_tashkeel)

    written_keys = [key(w) for w in written]
    at: dict[str, list[int]] = {}
    for j, k in enumerate(written_keys):
        at.setdefault(k, []).append(j)
    join_heard: dict[tuple[int, int], list[int]] = {}
    join_exp: dict[tuple[int, int], list[int]] = {}
    blocks: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for first, end, display in alternatives:
        dkeys = [key(d) for d in display]
        if not dkeys or not all(dkeys):
            continue
        for j in at.get(dkeys[0], ()):
            if written_keys[j : j + len(dkeys)] != dkeys:
                continue
            n_exp, n_disp = end - first, len(dkeys)
            if n_exp == 1:
                join_heard.setdefault((first, j), []).append(n_disp)
            elif n_disp == 1:
                join_exp.setdefault((first, j), []).append(n_exp)
            else:
                blocks.setdefault((first, j), []).append((n_exp, n_disp))
    return align_with_joins(list(expected), list(written), key, max_pieces=1, extra_joins=(join_heard, join_exp, blocks))


def _labels(quran: Quran, tokens: Sequence[str], keys: Sequence[str], digits: set[int]) -> set[int]:
    """Surah and ayah labels (``سورة الإخلاص``, ``في سورة البقرة``, ``[البقرة: 255]``,
    ``الآية 5``): left out, with the ayah numbers, when deciding whether a text is Quran."""
    out: set[int] = set()
    n = len(tokens)
    for i in range(n):
        k = keys[i]
        if k in _SURAH_WORDS:
            size = quran.surah_name_at(tokens, i + 1)
            if size:
                out.update(range(i, i + 1 + size))
                if i > 0 and keys[i - 1] in _LABEL_PREPOSITIONS:
                    out.add(i - 1)
        elif k in _AYAH_WORDS and i + 1 < n and (i + 1) in digits:
            out.add(i)
            if i > 0 and keys[i - 1] in _LABEL_PREPOSITIONS:
                out.add(i - 1)
        else:
            size = quran.surah_name_at(tokens, i)
            if size and i + size in digits:
                out.update(range(i, i + size))
    return out


def find_quran_parts(text: str, lang: Lang, quran: Quran | None) -> QuranAnalysis:
    """The Quran parts of a (cleaned) text, and whether the text is Quran (Q1).

    Deterministic: the same text and language always give the same parts, so every
    endpoint recomputes them from the text itself (a client's list is never used). See
    the module docstring for the rules; without the Tanzil text or without an Arabic
    letter there are no parts, and a text in the Uthmani script is refused then (the
    script test of the guards)."""
    spans = token_spans(text, lang)
    if quran is None or not has_arabic(text):
        return QuranAnalysis(text, lang, spans, [], False, is_quranic_script(text), quran)
    memo = _PHRASE_MEMO.set((quran, {}))
    try:
        finder = _Finder(quran, text, lang)
        parts = finder.to_parts(finder.find())
    finally:
        _PHRASE_MEMO.reset(memo)
    tokens = finder.tokens
    covered = [False] * len(tokens)
    for p in parts:
        for i in range(p.start, p.end):
            covered[i] = True
    digits = {i for i, d in enumerate(finder.is_digit) if d}
    framing = {i for i, f in enumerate(finder.is_framing) if f}
    uthmani_outside = any(is_quranic_script(t) and not covered[i] for i, t in enumerate(tokens))
    analysis = QuranAnalysis(
        text, lang, spans, parts, False, uthmani_outside, quran, frozenset(framing), frozenset(digits),
        voice_safe=finder.voice_safe,
    )
    analysis.is_quran = _is_quran(analysis, finder, digits, framing)
    return analysis


def _is_quran(analysis: QuranAnalysis, finder: _Finder, digits: set[int], framing: set[int]) -> bool:
    """Q1: without framing formulas and labels, the text is whole ayat in mushaf order (a
    basmala before them, or between two surahs, is a framing formula here)."""
    q = analysis.quran
    if q is None or not analysis.parts:
        return False
    keys = [_key(t) for t in finder.tokens]
    left_out = framing | digits | _labels(q, finder.tokens, keys, digits)
    rest = [i for i in range(len(finder.tokens)) if i not in left_out]
    if not rest:
        return False
    holding: list[QuranPart] = []
    for i in rest:
        part = next((p for p in analysis.parts if p.start <= i < p.end), None)
        if part is None:
            return False
        if not holding or holding[-1] is not part:
            holding.append(part)
    for p in holding:
        if not (q.ayah_bounds(p.g_lo)[0] == p.g_lo and q.ayah_bounds(p.g_hi - 1)[1] == p.g_hi):
            return False
    basmala = q.global_position(1, 1)
    ordered = [p for p in holding if (p.g_lo, p.g_hi) != (basmala, basmala + 4)]
    return all(b.g_lo >= a.g_hi for a, b in zip(ordered, ordered[1:]))


__all__ = [
    "CHUNK_MAX_WORDS",
    "QURAN_GUARD_CONTAINED_AYAH_WORDS",
    "QURAN_GUARD_CONTEXTUAL_RUN_WORDS",
    "QURAN_GUARD_FRAMED_GAP_WORDS",
    "QURAN_GUARD_FRAMED_RUN_WORDS",
    "QURAN_GUARD_MIN_SCORE",
    "QURAN_GUARD_MIN_WORDS",
    "QURAN_GUARD_RUN_WORDS",
    "QURAN_MEANING_MESSAGE",
    "QURAN_TEXT_MESSAGE",
    "ExpectedWords",
    "GuardMode",
    "QuranAnalysis",
    "QuranPart",
    "clitic_ayat",
    "contains_short_ayah",
    "dictation_speaks_quran",
    "find_quran_parts",
    "framed_runs",
    "is_misread",
    "is_quran_phrase",
    "is_whole_ayah",
    "looks_like_quran",
    "near_short_ayat",
    "looks_like_quran_for_meaning",
    "quran_writing_ops",
]
