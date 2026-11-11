"""Cut a text into short phrases for dictation.

The app reads a dictation out one phrase at a time. A phrase ends at sentence or clause
punctuation (``. ! ? ؟ ، ؛ , ; :``, the ellipsis and the Urdu-style full stop ``۔``) or
at a blank line, and is then capped at ``max_words`` words. A long clause is cut into
pieces of near-equal length, always between two words: 13 words with ``max_words=6``
give 5 + 4 + 4, never 6 + 6 + 1.

Phrases keep their punctuation, so the speech voice can use it for intonation and the
child can write it. Punctuation never starts a phrase on its own: a closing quote or
bracket right after the punctuation mark stays with the phrase it closes. Whitespace,
including line breaks inside a paragraph, is collapsed to single spaces.

Punctuation does not split:

* inside a number (``3,5``, ``12:30``, ``٣٫٥``), because tokens keep their number
  separators (see :func:`mommy.textnorm.token_spans`);
* after a common abbreviation (``Mr.``, ``Dr.``, ``Mme.``) or a single capital initial
  (``J. K. Rowling``, ``M. Dupont``).
"""

from __future__ import annotations

import re

from .textnorm import Lang, token_spans

#: Characters that end a dictation phrase.
SENTENCE_PUNCTUATION = ".!?\u061f\u060c\u061b,;:\u2026\u06d4"

# Closing quotes and brackets that belong to the phrase before them.
_CLOSERS = "\"'\u00bb\u201d\u2019\u203a)]}\ufd3e"
# Closers that never open a quotation, so they still close the phrase after a space
# (French typography writes "Bonjour. »").
_SPACED_CLOSERS = "\u00bb\u201d\u203a)]}\ufd3e"

_BLANK_LINE_RE = re.compile(r"\n[^\S\n]*\n")

# Abbreviations followed by a full stop that does not end a sentence (casefolded).
_ABBREVIATIONS: dict[str, frozenset[str]] = {
    "en": frozenset({"mr", "mrs", "ms", "dr", "st", "prof", "mt", "jr", "sr", "vs"}),
    "fr": frozenset({"mme", "mmes", "mlle", "mlles", "dr", "pr", "st", "ste", "cf"}),
    "ar": frozenset(),
}


def split_phrases(text: str, lang: Lang, max_words: int = 6) -> list[str]:
    """Split ``text`` into dictation phrases of at most ``max_words`` words.

    Splits on sentence punctuation (``. ! ? ؟ ، ؛ , ; :``) and blank lines, then caps
    each chunk at ``max_words`` words by cutting it into near-equal pieces at word
    boundaries. Never splits inside a word and drops chunks without words. Words are
    counted as :func:`mommy.textnorm.tokenize` counts them (``l'école`` is one word).

    Raises ValueError when ``max_words`` is smaller than 1.
    """
    if max_words < 1:
        raise ValueError("max_words must be at least 1")
    spans = token_spans(text, lang)
    phrases: list[str] = []
    for start, end in _chunks(text, lang, spans):
        chunk_spans = [(a, b) for a, b in spans if a >= start and b <= end]
        if not chunk_spans:
            continue
        for piece_start, piece_end in _cap(text, start, end, chunk_spans, max_words):
            phrase = " ".join(text[piece_start:piece_end].split())
            if phrase:
                phrases.append(phrase)
    return phrases


def _chunks(text: str, lang: Lang, spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Return ``(start, end)`` ranges of ``text`` cut after sentence punctuation."""
    inside_token = bytearray(len(text))
    token_ending_at: dict[int, tuple[int, int]] = {}
    for a, b in spans:
        inside_token[a:b] = b"\x01" * (b - a)
        token_ending_at[b] = (a, b)

    chunks: list[tuple[int, int]] = []
    start = 0
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c in SENTENCE_PUNCTUATION and not inside_token[i] and not _is_abbreviation(
            text, i, lang, token_ending_at
        ):
            j = _end_of_break(text, i + 1, inside_token)
            chunks.append((start, j))
            start = i = j
            continue
        if c == "\n":
            blank = _BLANK_LINE_RE.match(text, i)
            if blank:
                chunks.append((start, i))
                start = i = blank.end()
                continue
        i += 1
    chunks.append((start, n))
    return chunks


def _end_of_break(text: str, j: int, inside_token: bytearray) -> int:
    """Extend a break that starts before ``text[j]`` over the marks that belong to it.

    One break covers a run such as ``?!``, ``...`` or ``.»``, and also a closing quote
    or bracket after spaces (``Bonjour. »``).
    """
    n = len(text)
    while j < n and not inside_token[j]:
        if text[j] in SENTENCE_PUNCTUATION or text[j] in _CLOSERS:
            j += 1
            continue
        k = j
        while k < n and text[k].isspace():
            k += 1
        if k > j and k < n and text[k] in _SPACED_CLOSERS:
            j = k + 1
            continue
        break
    return j


def _is_abbreviation(
    text: str, i: int, lang: Lang, token_ending_at: dict[int, tuple[int, int]]
) -> bool:
    """True when the full stop at ``text[i]`` closes an abbreviation or an initial."""
    if text[i] != "." or i not in token_ending_at:
        return False
    a, b = token_ending_at[i]
    word = text[a:b]
    if len(word) == 1 and word.isalpha() and word.isupper() and word.isascii():
        return True
    return word.casefold() in _ABBREVIATIONS.get(lang, frozenset())


def _cap(
    text: str, start: int, end: int, spans: list[tuple[int, int]], max_words: int
) -> list[tuple[int, int]]:
    """Cut one chunk into near-equal pieces of at most ``max_words`` tokens.

    Each cut is made at the first whitespace after the last word of a piece, so
    punctuation stays with the word it follows and an opening quote with the word it
    precedes. Without whitespace between the two words (``mot—mot``), the cut is made
    just before the next word.
    """
    n = len(spans)
    if n <= max_words:
        return [(start, end)]
    groups = -(-n // max_words)  # ceil
    base, extra = divmod(n, groups)
    sizes = [base + 1 if g < extra else base for g in range(groups)]

    pieces: list[tuple[int, int]] = []
    piece_start = start
    first = 0
    for size in sizes[:-1]:
        last_end = spans[first + size - 1][1]
        next_start = spans[first + size][0]
        cut = next_start
        for pos in range(last_end, next_start):
            if text[pos].isspace():
                cut = pos
                break
        pieces.append((piece_start, cut))
        piece_start = cut
        first += size
    pieces.append((piece_start, end))
    return pieces


__all__ = ["SENTENCE_PUNCTUATION", "split_phrases"]
