"""Text normalisation and tokenisation for Arabic, English and French.

Everything that decides whether two words are "the same" goes through this module, so
the rules here are deliberately explicit, deterministic and documented.

Three entry points matter:

* :func:`tokenize` splits text into words while keeping the original surface forms
  (for display), so a French elision such as ``l'école`` stays one token.
* :func:`normalize_word` builds a comparison key for **speech** (recitation and the
  Quran): Arabic letter variants that a speech recogniser spells inconsistently are
  unified, and tashkeel is removed.
* :func:`normalize_dictation_word` builds a comparison key for **dictation**
  (spelling): hamza seats, ta marbuta and alef maksura stay significant in Arabic, and
  French accents stay significant.

Arabic Unicode ranges handled here (see :func:`strip_tashkeel`):

* U+0610-U+061A honorific signs and small vowels written above or below letters;
* U+064B-U+065F harakat, tanwin, shadda, sukun, combining maddah and hamza, and the
  other combining Arabic marks of the basic block;
* U+0670 superscript ("dagger") alef;
* U+0640 tatweel (kashida), which is only a stretching stroke;
* U+06D6-U+06ED Quranic annotation marks: pause marks, small high letters, the small
  waw and yeh of the Uthmani script, the end-of-ayah sign, the rub el hizb and the
  sajdah sign.

Uthmani spelling
----------------
The Tanzil Uthmani text uses spellings that differ from the standard ("simple")
spelling a speech recogniser produces.  :func:`normalize_word` maps the regular ones,
measured on the verbatim Tanzil files (see ``tests/test_textnorm.py``):

* the superscript alef stands for a written alef in most words (``ٱلْعَـٰلَمِينَ`` is
  ``العالمين``), but not in a short list of words that standard spelling writes without
  it (``ٱلرَّحْمَـٰنِ`` is ``الرحمن``, also هذا، ذلك، لكن، إله، أولئك، هؤلاء، الله); after a
  waw it replaces the waw (``ٱلصَّلَوٰةَ`` is ``الصلاة``); on a final alef maksura it adds
  nothing (``عَلَىٰ`` is ``على``), and on a medial one it is a plain alef
  (``أَدْرَىٰكَ`` is ``أدراك``);
* the small waw and small yeh after a final pronoun ``ه`` are vowel extensions and are
  dropped (``بِهِۦ`` is ``به``); elsewhere they stand for a written letter
  (``دَاوُۥدَ`` is ``داوود``), as do the small high yeh and the small high noon;
* a hamza written on a tatweel is given the seat that standard spelling uses
  (``تَسْـَٔلُونَ`` is ``تسألون``, ``شَيْـًٔا`` is ``شيئا``, ``ٱلْـَٔاخِرَةِ`` is
  ``الآخرة``);
* the article written with one doubled lam (``ٱلَّيْلِ``) is ``الليل``, as are
  ``اللاتي`` and ``اللائي``.

These rules only fire on characters that modern typed Arabic does not use (or, for the
superscript alef, uses in exactly the exception words), so they do not change the
normalisation of ordinary text.

Measured on ayat whose Uthmani and Simple-Clean token counts match, the share of word
pairs that normalise to the same key is 99.5% for Juz' Amma (surahs 78-114, 2402 of
2413 pairs) and 99.5% for the whole Quran (70,455 of 70,798).  The contract rules alone
give 92.2% and 91.5%.  What remains is mostly a bare hamza on the line where standard
spelling gives it a seat (``أَرَءَيْتَ`` / ``أرأيت``) and a silent alef after a final waw
that standard spelling omits (``يَتْلُوا۟`` / ``يتلو``); neither can be decided from the
word alone without hurting ordinary text, so they are left as they are.
"""

from __future__ import annotations

import functools
import re
import unicodedata
from typing import Literal, Sequence

Lang = Literal["ar", "en", "fr"]

LANGUAGES: tuple[Lang, ...] = ("ar", "en", "fr")

# ---------------------------------------------------------------------------
# Character classes
# ---------------------------------------------------------------------------

TATWEEL = "\u0640"
SUPERSCRIPT_ALEF = "\u0670"
ALEF_WASLA = "\u0671"
HAMZA = "\u0621"
HAMZA_ABOVE = "\u0654"
SMALL_WAW = "\u06e5"
SMALL_YEH = "\u06e6"
SMALL_HIGH_YEH = "\u06e7"
SMALL_HIGH_NOON = "\u06e8"
END_OF_AYAH = "\u06dd"

ALEF = "\u0627"
ALEF_HAMZA = "\u0623"
WAW_HAMZA = "\u0624"
YEH_HAMZA = "\u0626"
WAW = "\u0648"
YEH = "\u064a"
ALEF_MAKSURA = "\u0649"
HEH = "\u0647"
NOON = "\u0646"

FATHA, DAMMA, KASRA = "\u064e", "\u064f", "\u0650"
FATHATAN, DAMMATAN, KASRATAN = "\u064b", "\u064c", "\u064d"
SUKUN = "\u0652"

# Removed by strip_tashkeel.  Kept as one character class so that the ranges stated in
# the contract are visible in one place.
_TASHKEEL_CLASS = (
    "\u0610-\u061a"  # honorific signs, small fatha/damma/kasra
    "\u064b-\u065f"  # harakat, tanwin, shadda, sukun, combining maddah/hamza, ...
    "\u0670"  # superscript alef
    "\u0640"  # tatweel
    "\u06d6-\u06ed"  # Quranic annotation marks
)
_TASHKEEL_RE = re.compile(f"[{_TASHKEEL_CLASS}]")

# When tashkeel is kept (strict dictation) the vowel marks stay, but the stretching
# stroke and the Quranic annotation marks still go: a child never writes them.
_NON_VOWEL_MARKS_RE = re.compile("[\u0610-\u0617\u0640\u06d6-\u06ed]")

# Marks that sit on a letter: a letter's marks are the run of these characters after it
# (after NFC the vowel comes before the hamza: ``ـَٔ`` is tatweel, fatha, hamza above).
# The small waw and yeh (letters in Uthmani spelling), the end-of-ayah sign, the
# rub el hizb and the sajdah sign are not marks of a letter.
_MARK_RE = re.compile("[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed]")

_ARABIC_INDIC_DIGITS = "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669"
_PERSIAN_DIGITS = "\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9"
_DIGIT_TABLE = str.maketrans(
    _ARABIC_INDIC_DIGITS + _PERSIAN_DIGITS, "0123456789" * 2
)

# Apostrophe look-alikes that keyboards, OCR and word processors produce.
APOSTROPHES = "'\u2019\u2018\u02bc\u2032\u00b4`\uff07"
# Hyphen look-alikes that join the parts of one word.  Dashes (en/em) separate words.
HYPHENS = "-\u2010\u2011\u2212"
_JOINER_TABLE = str.maketrans(
    {**{c: "'" for c in APOSTROPHES}, **{c: "-" for c in HYPHENS}}
)
# Separators that are kept inside a number token ("3,5", "1.000", "12:30", "٣٫٥").
_NUMBER_SEPARATORS = ".,:\u066b\u066c"

# Letters of Persian/Urdu keyboards that look the same as Arabic letters.
_KEYBOARD_VARIANTS = str.maketrans({"\u06cc": "\u064a", "\u06a9": "\u0643", "\u06c1": "\u0647"})

# Speech normaliser: unify the letters a recogniser spells inconsistently.
_SPEECH_LETTERS = str.maketrans(
    {
        "\u0623": "\u0627",  # أ
        "\u0625": "\u0627",  # إ
        "\u0622": "\u0627",  # آ
        "\u0671": "\u0627",  # ٱ wasla
        "\u0672": "\u0627",  # alef with wavy hamza above
        "\u0673": "\u0627",  # alef with wavy hamza below
        "\u0675": "\u0627",  # high hamza alef
        "\u0649": "\u064a",  # ى -> ي
        "\u0629": "\u0647",  # ة -> ه
        "\u0624": "\u0648",  # ؤ -> و
        "\u0626": "\u064a",  # ئ -> ي
    }
)

# Latin ligatures folded in every mode: a parent typing on a keyboard, or a child
# writing joined letters, should not be marked wrong for "coeur" against "cœur".
_LIGATURES = {"\u0153": "oe", "\u00e6": "ae"}


def is_arabic_char(c: str) -> bool:
    """Return True for a character of the Arabic blocks (letters, marks, digits)."""
    o = ord(c)
    return (
        0x0600 <= o <= 0x06FF
        or 0x0750 <= o <= 0x077F
        or 0x08A0 <= o <= 0x08FF
        or 0xFB50 <= o <= 0xFDFF
        or 0xFE70 <= o <= 0xFEFF
    )


def has_arabic(text: str) -> bool:
    """Return True when ``text`` contains at least one Arabic letter."""
    return any(is_arabic_char(c) and unicodedata.category(c).startswith("L") for c in text)


def _is_word_char(c: str) -> bool:
    """Letters, combining marks and digits make up words."""
    return unicodedata.category(c)[0] in "LMN"


# ---------------------------------------------------------------------------
# Tashkeel
# ---------------------------------------------------------------------------


def strip_tashkeel(s: str) -> str:
    """Remove Arabic diacritics and annotation marks from ``s``.

    Removes harakat, tanwin, shadda, sukun and the other combining marks U+064B-U+065F,
    the small vowels and honorific signs U+0610-U+061A, the superscript alef U+0670,
    tatweel U+0640 and the Quranic annotation marks U+06D6-U+06ED.

    The text is first put in Unicode NFC form, so a hamza or maddah typed as a separate
    combining mark on its seat (``ا`` + U+0654) becomes the letter it is canonically
    equal to (``أ``) and is kept.  Letters, spaces and punctuation are otherwise left as
    they are.
    """
    return _TASHKEEL_RE.sub("", unicodedata.normalize("NFC", s))


# ---------------------------------------------------------------------------
# Shared preparation
# ---------------------------------------------------------------------------


def _prepare(w: str) -> str:
    """Compatibility-normalise, unify joiners and digits, and drop invisible characters.

    NFKC turns Arabic presentation forms (copied from PDFs) and full-width characters
    into ordinary letters; it is otherwise neutral for the three languages.
    """
    # Joiners first: NFKC would turn the acute accent used as an apostrophe into a
    # space and a combining accent.
    s = unicodedata.normalize("NFKC", w.translate(_JOINER_TABLE))
    s = s.translate(_DIGIT_TABLE).translate(_KEYBOARD_VARIANTS)
    # Format characters (zero-width joiners, bidi marks, soft hyphen) and any whitespace
    # left by NFKC carry no letters.
    return "".join(
        c for c in s if unicodedata.category(c) != "Cf" and not c.isspace()
    )


def _clean_punctuation(s: str) -> str:
    """Keep letters, marks and digits; keep ``'`` and ``-`` only between them."""
    kept = [c for c in s if _is_word_char(c) or c in "'-"]
    out: list[str] = []
    for i, c in enumerate(kept):
        if c in "'-":
            between_letters = (
                bool(out)
                and _is_word_char(out[-1])
                and i + 1 < len(kept)
                and _is_word_char(kept[i + 1])
            )
            if between_letters:
                out.append(c)
        else:
            out.append(c)
    return "".join(out)


def _fold_latin(s: str, *, keep_accents: bool) -> str:
    """Casefold, fold ligatures and optionally remove diacritics from non-Arabic letters."""
    s = s.casefold()
    for lig, rep in _LIGATURES.items():
        s = s.replace(lig, rep)
    if keep_accents:
        return unicodedata.normalize("NFC", s)
    out: list[str] = []
    for c in s:
        if is_arabic_char(c):
            out.append(c)
        else:
            out.extend(
                d for d in unicodedata.normalize("NFD", c) if unicodedata.category(d) != "Mn"
            )
    return unicodedata.normalize("NFC", "".join(out))


# ---------------------------------------------------------------------------
# Uthmani orthography (speech normaliser only)
# ---------------------------------------------------------------------------

# Words that standard spelling writes WITHOUT the alef that a superscript alef marks.
# They are matched on the bare skeleton of the word (superscript alef removed, letters
# unified as in the speech normaliser) with optional clitics.
_PRE = r"(?:ا)?(?:[وف])?(?:[بلك])?"  # interrogative a-, wa/fa, bi/li/ka
_DAGGER_EXCEPTIONS = re.compile(
    "^(?:"
    + _PRE
    + r"(?:ذلك(?:م|ما|ن)?|كذلك|هذا|هذه|هذان|هذين|هكذا|هولا|اوليك(?:م)?|"
    r"لكن(?:ا|ه|ها|هم|ي|كم)?)"
    + "|"
    + _PRE
    + r"(?:ال)?(?:ل)?رحمن"
    + "|"
    + _PRE
    + r"(?:ال)?اله(?:ا|ين|كم|هم|نا|ي|ك|ه|هما|كما)?"
    + "|"
    + r"(?:ا)?(?:[وفت])?(?:[بلك])?(?:ا)?لله(?:م)?"
    + ")$"
)


def _marks_after(s: str, i: int) -> int:
    """Index of the first character after the run of marks that starts at ``i``."""
    while i < len(s) and _MARK_RE.match(s[i]):
        i += 1
    return i


def _prev_base(s: str, i: int) -> int:
    """Index of the base letter that the mark at ``i`` belongs to (or -1)."""
    j = i - 1
    while j >= 0 and _MARK_RE.match(s[j]):
        j -= 1
    return j


def _hamza_on_tatweel(s: str, i: int) -> str:
    """Return the seat letter for a hamza above that sits on the tatweel at ``s[i]``.

    ``s[i]`` is a tatweel whose marks include U+0654.  The seat follows the standard
    spelling rules that the Tanzil Simple text uses: a kasra on the hamza, a kasra
    before it, or a preceding ya give ``ئ``; a damma gives ``ؤ`` (but ``ئ`` before a
    waw); a sukun takes its seat from the vowel before it; a fatha gives ``أ``, except
    before an alef, where the two make ``آ``.  The seat is returned as the hamza letter
    (``ئ``, ``ؤ`` or ``أ``), so that the rest of the speech normaliser treats it exactly
    like the same letter typed in standard spelling; an empty string means "no extra
    letter".
    """
    end = _marks_after(s, i + 1)
    marks = s[i + 1 : end]
    nxt = s[end] if end < len(s) else ""
    j = _prev_base(s, i)
    prev = s[j] if j >= 0 else ""
    prev_marks = s[j + 1 : i] if j >= 0 else ""
    alef_follows = (
        nxt == ALEF
        or SUPERSCRIPT_ALEF in marks
        or (nxt == TATWEEL and SUPERSCRIPT_ALEF in s[end + 1 : _marks_after(s, end + 1)])
    )
    if KASRA in marks or KASRATAN in marks or prev in (YEH, ALEF_MAKSURA):
        return YEH_HAMZA  # مُتَّكِـِٔينَ -> متكئين, شَيْـًٔا -> شيئا, خَطِيٓـَٔـٰتِكُمْ -> خطيئاتكم
    if FATHA in marks and alef_follows:
        return ""  # ٱلْـَٔاخِرَةِ -> الآخرة, بِـَٔايَـٰتِنَا -> بآياتنا
    if KASRA in prev_marks:
        return YEH_HAMZA  # فِـَٔةٍ -> فئة, أَنۢبِـُٔونِى -> أنبئوني
    if DAMMA in marks or DAMMATAN in marks:
        return YEH_HAMZA if nxt == WAW else WAW_HAMZA
    if SUKUN in marks:
        return WAW_HAMZA if DAMMA in prev_marks else ALEF_HAMZA  # تُـْٔوِيهِ, يَسْتَـْٔذِنُكَ
    if FATHA in marks or FATHATAN in marks:
        return "" if alef_follows else ALEF_HAMZA  # تَسْـَٔلُونَ -> تسألون
    return ""


def _replace_last(out: list[str], old: str, new: str) -> None:
    """Replace the last occurrence of ``old`` in ``out`` (in place)."""
    for k in range(len(out) - 1, -1, -1):
        if out[k] == old:
            out[k] = new
            return


def _uthmani_to_standard(s: str, *, letters_only: bool = False) -> str:
    """Rewrite the regular Uthmani spellings of ``s`` (one NFC word) in standard letters.

    Only Uthmani-specific characters are touched: the small waw, yeh, high yeh and high
    noon, a hamza above sitting on a tatweel, and the superscript alef.  The result still
    holds the other marks; the caller strips them.  With ``letters_only`` (used when
    tashkeel is kept) only the small letters are rewritten.
    """
    specials = (SMALL_WAW, SMALL_YEH, SMALL_HIGH_YEH, SMALL_HIGH_NOON, HAMZA_ABOVE, SUPERSCRIPT_ALEF)
    if not any(c in s for c in specials):
        return s

    dagger_is_silent = False
    if not letters_only and SUPERSCRIPT_ALEF in s:
        # Decide the exception words on the bare skeleton of the whole word.
        skeleton = _TASHKEEL_RE.sub("", s).translate(_SPEECH_LETTERS)
        if len(skeleton) > 1:
            skeleton = skeleton.replace(HAMZA, "")
        dagger_is_silent = bool(_DAGGER_EXCEPTIONS.match(skeleton))

    out: list[str] = []
    n = len(s)
    for i, c in enumerate(s):
        if c in (SMALL_WAW, SMALL_YEH):
            base = _prev_base(s, i)
            if base >= 0 and s[base] == HEH and _marks_after(s, i + 1) >= n:
                continue  # vowel extension of a final pronoun ه: not written
            out.append(WAW if c == SMALL_WAW else YEH)
        elif c == SMALL_HIGH_YEH:
            out.append(YEH)
        elif c == SMALL_HIGH_NOON:
            out.append(NOON)
        elif letters_only:
            out.append(c)
        elif c == TATWEEL and HAMZA_ABOVE in s[i + 1 : _marks_after(s, i + 1)]:
            out.append(_hamza_on_tatweel(s, i))
        elif c == HAMZA_ABOVE and _prev_base(s, i) >= 0 and s[_prev_base(s, i)] == TATWEEL:
            continue  # given its seat with the tatweel
        elif c == SUPERSCRIPT_ALEF:
            base = _prev_base(s, i)
            base_char = s[base] if base >= 0 else ""
            if base_char == WAW and base == i - 1:
                _replace_last(out, WAW, ALEF)  # صلوٰة -> صلاة
            elif base_char == ALEF_MAKSURA:
                if _marks_after(s, i + 1) < n:
                    _replace_last(out, ALEF_MAKSURA, ALEF)  # أدرىٰك -> أدراك
                # a final ىٰ is just ى
            elif not dagger_is_silent:
                out.append(ALEF)
        else:
            out.append(c)
    return "".join(out)


# ---------------------------------------------------------------------------
# Public normalisers
# ---------------------------------------------------------------------------


def normalize_word(
    w: str, lang: Lang, *, keep_tashkeel: bool = False, keep_accents: bool = True
) -> str:
    """Return the comparison key of one word for speech matching.

    Arabic (any Arabic letters in the word, whatever ``lang`` is):

    * the regular Uthmani spellings are rewritten in standard spelling (module
      docstring);
    * tashkeel is stripped (see :func:`strip_tashkeel`) unless ``keep_tashkeel``; the
      tatweel and Quranic annotation marks are always dropped;
    * alef forms ``أ إ آ ٱ`` become ``ا``; ``ى`` becomes ``ي``; ``ة`` becomes ``ه``;
      ``ؤ`` becomes ``و``; ``ئ`` becomes ``ي``; ``ء`` is dropped when the word has
      other letters;
    * same-sound spellings are unified: a hamza (``ء ؤ ئ``) before a waw is dropped
      (``رءوف`` / ``رؤوف``, ``مسئول`` / ``مسؤول``), ``مائة`` / ``مائتين`` become
      ``مئة`` / ``مئتين`` and ``داوود`` becomes ``داود``.

    English and French: casefold; the ligatures ``œ`` and ``æ`` become ``oe``/``ae``;
    with ``keep_accents=False`` diacritics are removed (``é`` -> ``e``).  Use
    ``keep_accents=False`` for speech, where a recogniser's accents are unreliable.

    All languages: Arabic-Indic and Persian digits become ASCII digits; typographic
    apostrophes become ``'``; punctuation (including ``، ؛ ؟``) and symbols are
    removed, except an apostrophe or hyphen between two letters (``l'école``,
    ``don't``, ``peut-être``).  The result may be empty.
    """
    return _normalize_word_cached(w, keep_tashkeel, keep_accents)


@functools.lru_cache(maxsize=1 << 17)
def _normalize_word_cached(w: str, keep_tashkeel: bool, keep_accents: bool) -> str:
    # The rules do not depend on ``lang`` (Arabic rules apply to Arabic letters, Latin
    # rules to Latin letters), so it is not part of the cache key.
    s = _prepare(w)
    if any(is_arabic_char(c) for c in s):
        s = _normalize_arabic_speech(s, keep_tashkeel=keep_tashkeel)
    s = _fold_latin(s, keep_accents=keep_accents)
    return _clean_punctuation(s)


# Uthmani writes the article and a following lam as one doubled lam in a few words
# (ٱلَّيْلِ for الليل, ٱلَّـٰتِى for اللاتي, ٱلَّـٰٓـِٔى for اللائي).  Standard spelling
# keeps both lams.  (الذي، التي، الذين have one lam in both spellings.)
_WASLA_DOUBLED_LAM_RE = re.compile("\u0671\u0644[\u064b-\u065f]*\u0651")
_SINGLE_LAM_WORDS_RE = re.compile("^([\u0648\u0641\u0628\u0643]?)\u0627\u0644(?=\u064a\u0644|\u0627\u062a\u064a|\u0627\u064a\u064a)")


# Same-sound spellings that differ between older (Tanzil Simple-Clean, some textbooks) and
# modern typed Arabic, which the speech recogniser writes. Speech normaliser only: in a
# dictation the spelling is what is checked.
#
# * A hamza before a waw is written on the line, on a ya seat or on a waw seat (رءوف /
#   رؤوف, مسئول / مسؤول, جاءوا / جاؤوا, يستهزئون / يستهزؤون): the hamza and its seat
#   are dropped, leaving one waw.
# * مائة / مائتين are also written مئة / مئتين (not مائدة: only before ة or ت).
# * داوود is also written داود.
#
# Measured on the Simple-Clean text (rewriting ءو/ئو as ؤو, مائة as مئة and داوود as
# داود): without these rules 147 tokens (66 distinct words, in 140 ayat) had a key
# different from that of their modern spelling; with them, none (tests/test_textnorm.py).
_HAMZA_BEFORE_WAW_RE = re.compile("[\u0621\u0624\u0626](?=\u0648)")
_MIAH_RE = re.compile("\u0645\u0627(?=\u0626[\u0629\u062a])")
_DAWUD_RE = re.compile("\u062f\u0627\u0648\u0648\u062f")


def _normalize_arabic_speech(s: str, *, keep_tashkeel: bool) -> str:
    """Speech-normalise the Arabic letters of one prepared word (see normalize_word)."""
    s = unicodedata.normalize("NFC", s)
    doubled_lam = bool(_WASLA_DOUBLED_LAM_RE.search(s))
    if not keep_tashkeel:
        s = _uthmani_to_standard(s)
        s = _TASHKEEL_RE.sub("", s)
    else:
        s = _uthmani_to_standard(s, letters_only=True)
        s = _NON_VOWEL_MARKS_RE.sub("", s)
    s = _HAMZA_BEFORE_WAW_RE.sub("", s)
    s = _MIAH_RE.sub("\u0645", s)
    s = _DAWUD_RE.sub("\u062f\u0627\u0648\u062f", s)
    s = s.translate(_SPEECH_LETTERS)
    letters = [c for c in s if unicodedata.category(c).startswith("L")]
    if any(c != HAMZA for c in letters):
        s = s.replace(HAMZA, "")
    if doubled_lam and not keep_tashkeel:
        s = _SINGLE_LAM_WORDS_RE.sub("\\1\u0627\u0644\u0644", s)
    return s


def normalize_dictation_word(w: str, lang: Lang, *, keep_tashkeel: bool = False) -> str:
    """Return the comparison key of one word for dictation (spelling) checks.

    Lighter than :func:`normalize_word`, because in dictation the spelling itself is
    what is checked:

    * Arabic: ``أ إ آ ء ؤ ئ ة ى`` stay distinct (``مدرسه`` is not ``مدرسة``); only the
      wasla ``ٱ`` becomes ``ا`` (no one writes it by hand), Persian keyboard letters
      become Arabic, and the tatweel and Quranic annotation marks are dropped.  Tashkeel
      is stripped unless ``keep_tashkeel``; with it, marks are compared in canonical
      (NFC) order, so the order in which shadda and fatha were typed does not matter.
    * English and French: casefold, accents kept (``é`` is not ``e``); the ligatures
      ``œ``/``æ`` are folded to ``oe``/``ae``.
    * All languages: digits become ASCII, typographic apostrophes become ``'``, and
      punctuation is removed except an apostrophe or hyphen inside a word.
    """
    return _normalize_dictation_cached(w, keep_tashkeel)


@functools.lru_cache(maxsize=1 << 15)
def _normalize_dictation_cached(w: str, keep_tashkeel: bool) -> str:
    s = _prepare(w)
    if any(is_arabic_char(c) for c in s):
        s = unicodedata.normalize("NFC", s).replace(ALEF_WASLA, ALEF)
        if keep_tashkeel:
            s = _NON_VOWEL_MARKS_RE.sub("", s)
        else:
            s = _TASHKEEL_RE.sub("", s)
        s = unicodedata.normalize("NFC", s)
    s = _fold_latin(s, keep_accents=True)
    return _clean_punctuation(s)


# ---------------------------------------------------------------------------
# Tokenisation
# ---------------------------------------------------------------------------


def _token_spans(text: str) -> list[tuple[int, int]]:
    """Return ``(start, end)`` spans of candidate word tokens in ``text``.

    A token is a run of letters, combining marks and digits.  An apostrophe or hyphen
    stays inside a token when it has a word character on both sides (``l'école``,
    ``aujourd'hui``, ``don't``, ``peut-être``).  ``. , :`` and the Arabic decimal and
    thousands separators stay inside a number when they have a digit on both sides
    (``3,5``, ``12:30``).  Invisible format characters inside a word are kept with it.
    Everything else separates tokens.
    """
    spans: list[tuple[int, int]] = []
    n = len(text)
    start: int | None = None
    for i, c in enumerate(text):
        if _is_word_char(c):
            inside = True
        elif start is not None and 0 < i < n - 1:
            before, after = text[i - 1], text[i + 1]
            if c in APOSTROPHES or c in HYPHENS:
                inside = _is_word_char(before) and _is_word_char(after)
            elif c in _NUMBER_SEPARATORS:
                inside = before.isdigit() and after.isdigit()
            elif unicodedata.category(c) == "Cf" and c != END_OF_AYAH:
                inside = _is_word_char(before) and _is_word_char(after)
            else:
                inside = False
        else:
            inside = False
        if inside:
            if start is None:
                start = i
        elif start is not None:
            spans.append((start, i))
            start = None
    if start is not None:
        spans.append((start, n))
    return spans


def token_spans(text: str, lang: Lang) -> list[tuple[int, int]]:
    """Return the ``(start, end)`` character spans of the tokens :func:`tokenize` returns.

    ``text[start:end]`` is each token's surface form.  Useful to cut text at word
    boundaries without losing its punctuation (see :mod:`mommy.phrases`).
    """
    return [(a, b) for a, b in _token_spans(text) if normalize_word(text[a:b], lang)]


def tokenize(text: str, lang: Lang) -> list[str]:
    """Split ``text`` into word tokens, keeping their original surface forms.

    Splits on whitespace, punctuation and symbols (including ``، ؛ ؟`` and
    guillemets).  Apostrophes and hyphens inside a word do not split it, so French
    elisions (``l'école``, ``qu'il``, ``aujourd'hui``) and English contractions
    (``don't``) are single tokens, with either ``'`` or ``’``.  Tokens that normalise to
    nothing (a lone tatweel, or a standalone Quranic pause mark such as ``ۚ``) are
    dropped.  The surface form is returned unchanged, so it can be shown to the user;
    compare tokens through :func:`normalize_word` or :func:`normalize_dictation_word`.
    """
    return [text[a:b] for a, b in token_spans(text, lang)]


# ---------------------------------------------------------------------------
# Speech only: numbers, English spelling variants and contractions
# ---------------------------------------------------------------------------
#
# A speech recogniser writes "12" where the page prints "twelve" (and the reverse),
# "color" for "colour" and "they're" for "they are". The child said the text right, so
# speech matching (mommy.align.check_recitation) treats these as the same words.
# Dictation never uses these rules: writing "3" for "three" is a difference there.

#: Numbers whose words are known, in each language: 0..NUMBER_WORDS_MAX.
NUMBER_WORDS_MAX = 100

_EN_UNITS = ("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine")
_EN_TEENS = (
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
    "eighteen", "nineteen",
)
_EN_TENS = {20: "twenty", 30: "thirty", 40: "forty", 50: "fifty", 60: "sixty", 70: "seventy",
            80: "eighty", 90: "ninety"}
_EN_ORDINAL_WORDS = {"one": "first", "two": "second", "three": "third", "five": "fifth",
                     "eight": "eighth", "nine": "ninth", "twelve": "twelfth"}

_FR_UNITS = ("zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf")
_FR_TEENS = ("dix", "onze", "douze", "treize", "quatorze", "quinze", "seize",
             "dix-sept", "dix-huit", "dix-neuf")
# Tens that combine regularly ("vingt et un", "vingt-deux"); septante, huitante,
# octante and nonante are the Belgian and Swiss forms.
_FR_REGULAR_TENS = {20: ("vingt",), 30: ("trente",), 40: ("quarante",), 50: ("cinquante",),
                    60: ("soixante",), 70: ("septante",), 80: ("huitante", "octante"),
                    90: ("nonante",)}

# Arabic: masculine and feminine forms, nominative and accusative/genitive.
_AR_UNITS: dict[int, tuple[str, ...]] = {
    1: ("واحد", "واحدة"),
    2: ("اثنان", "اثنين", "اثنتان", "اثنتين", "ثنتان", "ثنتين"),
    3: ("ثلاثة", "ثلاث"),
    4: ("أربعة", "أربع"),
    5: ("خمسة", "خمس"),
    6: ("ستة", "ست"),
    7: ("سبعة", "سبع"),
    8: ("ثمانية", "ثماني", "ثمان", "ثمانى"),
    9: ("تسعة", "تسع"),
}
_AR_TEEN_ONE = ("أحد", "إحدى")
_AR_TEEN_TWO = ("اثنا", "اثني", "اثنتا", "اثنتي", "اثنى")
_AR_TEN = ("عشر", "عشرة")
_AR_TENS = {20: ("عشرون", "عشرين"), 30: ("ثلاثون", "ثلاثين"), 40: ("أربعون", "أربعين"),
            50: ("خمسون", "خمسين"), 60: ("ستون", "ستين"), 70: ("سبعون", "سبعين"),
            80: ("ثمانون", "ثمانين"), 90: ("تسعون", "تسعين")}
_AR_HUNDRED = ("مائة", "مئة", "مية")
_AR_AND = "و"


def _words(spelling: str) -> tuple[str, ...]:
    """A spelling such as ``"dix-sept"`` or ``"vingt et un"`` as its words."""
    return tuple(w for w in re.split("[ -]", spelling) if w)


def _en_number_forms() -> dict[int, list[tuple[str, ...]]]:
    forms: dict[int, list[tuple[str, ...]]] = {}
    for n, w in enumerate(_EN_UNITS):
        forms[n] = [(w,)]
    for n, w in enumerate(_EN_TEENS, start=10):
        forms[n] = [(w,)]
    for tens, w in _EN_TENS.items():
        forms[tens] = [(w,)]
        for unit in range(1, 10):
            forms[tens + unit] = [(w, _EN_UNITS[unit])]
    forms[100] = [("hundred",), ("one", "hundred"), ("a", "hundred")]
    return forms


def _en_ordinal(word: str) -> str:
    if word in _EN_ORDINAL_WORDS:
        return _EN_ORDINAL_WORDS[word]
    if word.endswith("y"):
        return word[:-1] + "ieth"  # twenty -> twentieth
    return word + "th"


def _fr_number_forms() -> dict[int, list[tuple[str, ...]]]:
    forms: dict[int, list[tuple[str, ...]]] = {}
    for n, w in enumerate(_FR_UNITS):
        forms[n] = [_words(w)]
    forms[1].append(("une",))
    for n, w in enumerate(_FR_TEENS, start=10):
        forms[n] = [_words(w)]

    def add(n: int, *spellings: tuple[str, ...]) -> None:
        forms.setdefault(n, []).extend(spellings)

    for tens, names in _FR_REGULAR_TENS.items():
        for w in names:
            add(tens, (w,))
            add(tens + 1, (w, "et", "un"), (w, "et", "une"), (w, "un"))
            for unit in range(2, 10):
                add(tens + unit, (w, _FR_UNITS[unit]))
    # 70-79: soixante-dix, soixante et onze, soixante-douze ... soixante-dix-neuf.
    add(70, ("soixante", "dix"))
    add(71, ("soixante", "et", "onze"), ("soixante", "onze"))
    for n in range(72, 80):
        add(n, ("soixante", *_words(_FR_TEENS[n - 70])))
    # 80-99: quatre-vingts, quatre-vingt-un ... quatre-vingt-dix-neuf.
    add(80, ("quatre", "vingts"), ("quatre", "vingt"))
    for n in range(81, 100):
        rest = _FR_UNITS[n - 80] if n < 90 else _FR_TEENS[n - 90]
        add(n, ("quatre", "vingt", *_words(rest)))
    add(81, ("quatre", "vingt", "une"))
    add(100, ("cent",))
    return forms


def _fr_ordinal_forms(n: int, spelling: tuple[str, ...]) -> list[tuple[str, ...]]:
    """The ordinal forms of one French cardinal spelling (accents already removed)."""
    if n == 1 and len(spelling) == 1:
        return [("premier",), ("premiere",)]
    *head, last = spelling
    if last in ("un", "une"):
        tail = "unieme"
    elif last == "cinq":
        tail = "cinquieme"
    elif last == "neuf":
        tail = "neuvieme"
    elif last == "vingts":
        tail = "vingtieme"
    elif last.endswith("e"):
        tail = last[:-1] + "ieme"
    else:
        tail = last + "ieme"
    out = [(*head, tail)]
    if n == 2 and len(spelling) == 1:
        out += [("second",), ("seconde",)]
    return out


def _ar_number_forms() -> dict[int, list[tuple[str, ...]]]:
    forms: dict[int, list[tuple[str, ...]]] = {0: [("صفر",)]}
    for n, ws in _AR_UNITS.items():
        forms[n] = [(w,) for w in ws]
    forms[10] = [(w,) for w in _AR_TEN]
    forms[11] = [(a, b) for a in _AR_TEEN_ONE for b in _AR_TEN]
    forms[12] = [(a, b) for a in _AR_TEEN_TWO for b in _AR_TEN]
    for n in range(13, 20):
        forms[n] = [(a, b) for a in _AR_UNITS[n - 10] for b in _AR_TEN]
    for tens, ws in _AR_TENS.items():
        forms[tens] = [(w,) for w in ws]
        for unit in range(1, 10):
            forms[tens + unit] = [(u, _AR_AND, w) for u in _AR_UNITS[unit] for w in ws]
    forms[100] = [(w,) for w in _AR_HUNDRED]
    return forms


def _number_key(word: str, lang: Lang) -> str:
    """The speech key of one number word, keeping nothing but letters."""
    return _normalize_word_cached(word, False, False).replace("'", "")


@functools.lru_cache(maxsize=None)
def _number_table(lang: Lang) -> dict[tuple[str, ...], str]:
    """Spelled numbers of ``lang`` (as tuples of word keys) -> value (``"c21"``, ``"o21"``)."""
    table: dict[tuple[str, ...], str] = {}

    def put(spelling: tuple[str, ...], value: str) -> None:
        table.setdefault(tuple(_number_key(w, lang) for w in spelling), value)

    if lang == "en":
        for n, spellings in _en_number_forms().items():
            for sp in spellings:
                put(sp, f"c{n}")
                put((*sp[:-1], _en_ordinal(sp[-1])), f"o{n}")
    elif lang == "fr":
        for n, spellings in _fr_number_forms().items():
            for sp in spellings:
                put(sp, f"c{n}")
                keyed = tuple(_number_key(w, lang) for w in sp)
                for ordinal in _fr_ordinal_forms(n, keyed):
                    put(ordinal, f"o{n}")
    else:
        for n, spellings in _ar_number_forms().items():
            for sp in spellings:
                put(sp, f"c{n}")
    return table


@functools.lru_cache(maxsize=None)
def _number_vocabulary(lang: Lang) -> frozenset[str]:
    return frozenset(w for spelling in _number_table(lang) for w in spelling)


_DIGIT_ORDINAL_RE: dict[str, re.Pattern[str]] = {
    "en": re.compile(r"(\d+)(?:st|nd|rd|th)"),
    "fr": re.compile(r"(\d+)(?:er|re|ere|e|eme|ieme|nd|nde)"),
}


def digit_number(token: str, lang: Lang) -> str | None:
    """The value of a number written in digits, for speech matching.

    ``"12"``, ``"٢١"`` -> ``"c12"``, ``"c21"`` (Arabic-Indic and Western digits are the
    same); an ordinal ``"21st"`` (English) or ``"1er"``, ``"2e"``, ``"3ème"`` (French)
    -> ``"o21"``, ``"o1"``, ``"o2"``, ``"o3"``. None for anything else (``"3,5"``,
    ``"12:30"``, words).
    """
    raw = _prepare(token)
    if not raw or not raw.isalnum() or not raw[0].isdigit():
        return None  # words, and numbers with separators ("3,5", "12:30")
    if raw.isascii() and raw.isdigit():
        return f"c{int(raw)}"
    key = _normalize_word_cached(token, False, False)
    pattern = _DIGIT_ORDINAL_RE.get(lang)
    if pattern is not None and key.isascii() and (m := pattern.fullmatch(key)):
        return f"o{int(m.group(1))}"
    return None


def spoken_number(tokens: Sequence[str], lang: Lang) -> str | None:
    """The value of a number written in words (0 to :data:`NUMBER_WORDS_MAX`), or None.

    ``tokens`` are consecutive tokens that together spell exactly one number:
    ``["twelve"]``, ``["twenty", "five"]``, ``["twenty-five"]``, ``["vingt", "et",
    "un"]``, ``["quatre-vingt-dix"]``, ``["واحد", "وعشرون"]``; values as in
    :func:`digit_number`. English and French ordinals (``"twenty-first"``,
    ``"deuxième"``, ``"premier"``) give ``"o<n>"``. Arabic forms of both genders and
    cases are accepted (``ثلاثة``/``ثلاث``, ``عشرون``/``عشرين``, ``اثنا عشر``/``اثنتي
    عشرة``), with the ``و`` of a compound number written on its own or joined.
    """
    table = _number_table(lang)
    vocabulary = _number_vocabulary(lang)
    words: list[str] = []
    for token in tokens:
        for part in _normalize_word_cached(token, False, False).replace("'", "").split("-"):
            if not part:
                continue
            if part in vocabulary:
                words.append(part)
            elif lang == "ar" and part.startswith(_AR_AND) and part[1:] in vocabulary:
                words.extend((_AR_AND, part[1:]))  # وعشرون -> و عشرون
            else:
                return None
    return table.get(tuple(words)) if words else None


def is_number_word(token: str, lang: Lang) -> bool:
    """True when ``token`` can start a number written in words (see :func:`spoken_number`)."""
    key = _normalize_word_cached(token, False, False).replace("'", "")
    first = key.split("-", 1)[0]
    vocabulary = _number_vocabulary(lang)
    return first in vocabulary or (lang == "ar" and first.startswith(_AR_AND) and first[1:] in vocabulary)


# British and American spellings of the same English words (speech only). Applied to a
# speech key (lower case, no accents, no hyphens or apostrophes) on both sides, so a word
# folded by mistake (detour -> detor) still equals itself.
_EN_SPELLING_WORDS = {
    "grey": "gray", "greys": "grays", "defence": "defense", "offence": "offense",
    "licence": "license", "pretence": "pretense", "programme": "program",
    "programmes": "programs", "tyre": "tire", "tyres": "tires", "aeroplane": "airplane",
    "aeroplanes": "airplanes", "plough": "plow", "mould": "mold", "cheque": "check",
    "jewellery": "jewelry", "pyjamas": "pajamas", "judgement": "judgment", "ageing": "aging",
    "practise": "practice", "practised": "practiced", "practising": "practicing",
    "enrol": "enroll", "fulfil": "fulfill", "skilful": "skillful", "wilful": "willful",
    "instalment": "installment", "storey": "story", "storeys": "stories", "mum": "mom",
    "mummy": "mommy", "maths": "math", "doughnut": "donut", "moustache": "mustache",
}
_EN_SPELLING_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?<=[a-z]{3})our"), "or"),  # colour, favourite, neighbourhood
    (re.compile(r"(?<=[a-z])([tb])re(s?)$"), r"\1er\2"),  # centre, theatres, fibre
    (re.compile(r"(?<=[a-z]{3})is(e|es|ed|ing|ation|ations|er|ers)$"), r"iz\1"),  # realise
    (re.compile(r"(?<=[a-z]{2})ys(e|es|ed|ing)$"), r"yz\1"),  # analyse
    (re.compile(r"ogue(s?)$"), r"og\1"),  # catalogue, dialogues
    (re.compile(r"(?<=[a-z]{2}[ae])ll(ed|ing|er|ers)$"), r"l\1"),  # travelled, cancelling
)


def fold_english_spelling(key: str) -> str:
    """Fold the British spelling of an English speech key onto the American one.

    ``colour`` -> ``color``, ``favourite`` -> ``favorite``, ``centre`` -> ``center``,
    ``realise`` -> ``realize``, ``analyse`` -> ``analyze``, ``catalogue`` ->
    ``catalog``, ``travelled`` -> ``traveled``, plus a short table (``grey``,
    ``defence``, ``programme``, ``maths``, ...). For speech matching only, where the
    recogniser writes American spelling for a British text.
    """
    if key in _EN_SPELLING_WORDS:
        return _EN_SPELLING_WORDS[key]
    for pattern, replacement in _EN_SPELLING_RULES:
        key = pattern.sub(replacement, key)
    return key


_EN_PRONOUN_IS = ("he", "she", "it", "that", "there", "what", "who", "where", "here", "how")
_EN_SUBJECTS = ("i", "you", "he", "she", "it", "we", "they", "that", "there", "who", "what")
_EN_CONTRACTION_TABLE: dict[str, tuple[tuple[str, ...], ...]] = {
    "i'm": (("i", "am"),),
    "let's": (("let", "us"),),
    "can't": (("cannot",), ("can", "not")),
    "won't": (("will", "not"),),
    "shan't": (("shall", "not"),),
    **{f"{p}'re": ((p, "are"),) for p in ("you", "we", "they", "who", "what")},
    **{f"{p}'s": ((p, "is"), (p, "has")) for p in _EN_PRONOUN_IS},
    **{f"{p}'ve": ((p, "have"),) for p in (*_EN_SUBJECTS, "could", "should", "would", "might", "must")},
    **{f"{p}'ll": ((p, "will"),) for p in _EN_SUBJECTS},
    **{f"{p}'d": ((p, "would"), (p, "had")) for p in _EN_SUBJECTS},
}


def english_expansions(token: str) -> tuple[tuple[str, ...], ...]:
    """The full forms of an English contraction, for speech matching.

    ``"they're"`` -> ``(("they", "are"),)``; ``"she's"`` -> ``(("she", "is"), ("she",
    "has"))``; ``"don't"`` -> ``(("do", "not"),)``; ``"can't"`` -> ``(("cannot",), ("can",
    "not"))``. Only written contractions count (with an apostrophe, straight or
    typographic): ``were`` is not ``we're``. A possessive (``Sam's``) is not expanded.
    Returns an empty tuple for any other token.
    """
    key = _normalize_word_cached(token, False, False)
    if "'" not in key:
        return ()
    if key in _EN_CONTRACTION_TABLE:
        return _EN_CONTRACTION_TABLE[key]
    if key.endswith("n't") and len(key) > 3:
        return ((key[:-3], "not"),)  # isn't, doesn't, couldn't, ...
    return ()


__all__ = [
    "Lang",
    "LANGUAGES",
    "APOSTROPHES",
    "HYPHENS",
    "NUMBER_WORDS_MAX",
    "digit_number",
    "english_expansions",
    "fold_english_spelling",
    "has_arabic",
    "is_arabic_char",
    "is_number_word",
    "spoken_number",
    "normalize_dictation_word",
    "normalize_word",
    "strip_tashkeel",
    "token_spans",
    "tokenize",
]
