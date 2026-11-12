"""Readers for the Quran fixtures of the guard and parts tests.

``tests/arabic_school_sentences.txt`` and ``tests/quran_parts_texts.txt`` hold no Quran
word: their placeholders are filled here from the verbatim Tanzil files (see the header
of each file for the syntax). Misquotes (one letter changed, a word dropped, a hamza
left out) are made by code from the Tanzil words, so the fixture says only which word.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from mommy.quran import Quran

HERE = Path(__file__).resolve().parent
SENTENCES = HERE / "arabic_school_sentences.txt"
PARTS_TEXTS = HERE / "quran_parts_texts.txt"

PLACEHOLDER = re.compile(
    r"\{(?:(?P<form>[unN]):)?(?P<s>\d+):(?P<a>\d+)(?:-(?P<b>\d+))?(?::(?P<w>\d+)-(?P<v>\d+))?"
    r"(?:!(?P<edit>sub|drop|hamza):(?P<k>\d+))?\}"
)

#: Letters an OCR (or a hurried typist) confuses: dots above or below, one tooth more.
CONFUSED = {
    "ب": "ت", "ت": "ث", "ث": "ت", "ن": "ت", "ج": "ح", "ح": "خ", "خ": "ح", "د": "ذ", "ذ": "د",
    "ر": "ز", "ز": "ر", "س": "ش", "ش": "س", "ص": "ض", "ض": "ص", "ط": "ظ", "ظ": "ط", "ع": "غ",
    "غ": "ع", "ف": "ق", "ق": "ف",
}
HAMZA = {"أ": "ا", "إ": "ا", "آ": "ا", "ؤ": "و", "ئ": "ي"}
_INDIC = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")


@dataclass(frozen=True)
class Quote:
    """One placeholder: the ayat it quotes (words ``w..v`` of one ayah when given), and
    its edit: ``(kind, mushaf word, typed word)`` with kind ``sub`` (a changed letter or
    a missing hamza: the typed word differs) or ``del`` (the word was left out)."""

    surah: int
    first: int
    last: int
    words: tuple[int, int] | None
    edit: tuple[str, str, str | None] | None


def read_sections(path: Path) -> dict[str, list[str]]:
    """The sections of a fixture file, placeholders not yet filled (``\\n`` unescaped)."""
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        header = re.fullmatch(r"\[(\w+)\]", line)
        if header:
            current = header[1]
            sections[current] = []
            continue
        assert current is not None, line
        sections[current].append(line.replace("\\n", "\n"))
    return sections


def _misread(word: str) -> str:
    """The word with one letter changed (the first confusable letter after the first)."""
    for i in [*range(1, len(word)), 0]:
        if word[i] in CONFUSED:
            return word[:i] + CONFUSED[word[i]] + word[i + 1 :]
    raise ValueError(f"no letter to change in word {word!r}")


def _without_hamza(word: str) -> str:
    for i, c in enumerate(word):
        if c in HAMZA:
            return word[:i] + HAMZA[c] + word[i + 1 :]
    raise ValueError(f"no hamza in word {word!r}")


def fill(quran: Quran, text: str) -> tuple[str, list[Quote]]:
    """The text with its placeholders filled from Tanzil, and what each one quotes."""
    quotes: list[Quote] = []

    def repl(m: re.Match[str]) -> str:
        surah, first = int(m["s"]), int(m["a"])
        last = int(m["b"]) if m["b"] else first
        ayat = quran.ayat(surah, first, last)
        form = m["form"]
        if form == "u":
            assert not m["edit"] and not m["w"]
            quotes.append(Quote(surah, first, last, None, None))
            return " ".join(a.display for a in ayat)
        if form in ("n", "N"):
            assert not m["edit"] and not m["w"]
            quotes.append(Quote(surah, first, last, None, None))
            if form == "n":
                return " ".join(f"{a.match} ({a.ayah})" for a in ayat)
            return " ".join(f"{a.match} ﴿{str(a.ayah).translate(_INDIC)}﴾" for a in ayat)
        words = [w for a in ayat for w in a.match_words]
        span = None
        if m["w"]:
            assert first == last
            span = (int(m["w"]), int(m["v"]))
            words = words[span[0] - 1 : span[1]]
        edit = None
        if m["edit"]:
            k = int(m["k"]) - 1
            original = words[k]
            if m["edit"] == "drop":
                edit = ("del", original, None)
                words = words[:k] + words[k + 1 :]
            else:
                typed = _misread(original) if m["edit"] == "sub" else _without_hamza(original)
                edit = ("sub", original, typed)
                words = words[:k] + [typed] + words[k + 1 :]
        quotes.append(Quote(surah, first, last, span, edit))
        return " ".join(words)

    return PLACEHOLDER.sub(repl, text), quotes


def filled_sections(quran: Quran, path: Path) -> dict[str, list[tuple[str, list[Quote]]]]:
    return {name: [fill(quran, line) for line in lines] for name, lines in read_sections(path).items()}
