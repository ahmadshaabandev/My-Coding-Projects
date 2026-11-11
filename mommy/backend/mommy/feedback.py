"""Fixed feedback messages: the offline wording, and the fallback when Claude fails.

Tone: warm and encouraging, in short sentences, adapted to the age band (playful for
6-9, plain for 14-18). Messages speak to the child in the second person and never in
the first person, so nothing suggests that a person (let alone a parent) is speaking.

Arabic messages are Modern Standard Arabic that a young child understands. They avoid
gendered imperatives where a neutral form is natural (``مرة أخرى من فضلك`` rather than
``أعِد``/``أعيدي``); unvocalised past-tense forms such as ``أحسنت`` and ``نسيت`` read for
a boy or a girl alike.

The Quran feedback (:func:`quran_feedback`) is a separate, fixed and respectful set of
Arabic messages that quotes at most the single word it is given.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping

from .textnorm import Lang

AgeBand = Literal["6-9", "10-13", "14-18"]

AGE_BANDS: tuple[AgeBand, ...] = ("6-9", "10-13", "14-18")
ERROR_KINDS: tuple[str, ...] = ("sub", "del", "ins")

# ---------------------------------------------------------------------------
# Templates. "{word}" is replaced by the expected word.
# ---------------------------------------------------------------------------

_PRAISE: dict[str, dict[str, tuple[str, ...]]] = {
    "en": {
        "6-9": (
            "Super job! Every word was right!",
            "Hooray! You got them all!",
            "Wow, amazing work! Give yourself a high five!",
        ),
        "10-13": (
            "Great job! Every word was correct.",
            "Excellent work, no mistakes at all!",
            "Well done! That was perfect.",
        ),
        "14-18": (
            "Correct. Well done.",
            "All words correct. Nice work.",
            "Perfect accuracy. Good job.",
        ),
    },
    "fr": {
        "6-9": (
            "Bravo ! Tous les mots sont justes !",
            "Super ! Tout est juste !",
            "Génial ! Quel beau travail !",
        ),
        "10-13": (
            "Très bien ! Tous les mots sont corrects.",
            "Excellent travail, aucune erreur !",
            "Bien joué ! C'était parfait.",
        ),
        "14-18": (
            "Correct. Bien joué.",
            "Tous les mots sont corrects. Beau travail.",
            "Sans faute. Très bien.",
        ),
    },
    "ar": {
        "6-9": (
            "أحسنت! كل الكلمات صحيحة!",
            "رائع! عمل جميل جدًّا!",
            "ممتاز! لا يوجد أي خطأ!",
        ),
        "10-13": (
            "أحسنت! كل الكلمات صحيحة.",
            "عمل ممتاز، دون أي خطأ!",
            "عمل متقن، أحسنت!",
        ),
        "14-18": (
            "صحيح. أحسنت.",
            "كل الكلمات صحيحة. عمل جيد.",
            "دقة تامة دون أخطاء.",
        ),
    },
}

_POINT_OUT: dict[str, dict[str, dict[str, str]]] = {
    "en": {
        "sub": {
            "6-9": 'Almost! Listen again: "{word}". Try once more!',
            "10-13": 'Nearly there. The word is "{word}". Give it another try.',
            "14-18": 'One word was different. The text says "{word}".',
        },
        "del": {
            "6-9": 'Oops, a word ran away! You skipped "{word}". Try again!',
            "10-13": 'You skipped a word: "{word}". Try once more.',
            "14-18": 'A word was missing: "{word}".',
        },
        "ins": {
            "6-9": "Oops, an extra word sneaked in! Try again!",
            "10-13": "You added a word that is not in the text. Try once more.",
            "14-18": "There was an extra word that is not in the text.",
        },
    },
    "fr": {
        "sub": {
            "6-9": "Presque ! Écoute bien : « {word} ». Essaie encore !",
            "10-13": "Presque ! Le mot est « {word} ». Essaie encore une fois.",
            "14-18": "Un mot était différent. Le texte dit « {word} ».",
        },
        "del": {
            "6-9": "Oups, un mot s'est envolé ! Tu as oublié « {word} ». Essaie encore !",
            "10-13": "Tu as sauté un mot : « {word} ». Essaie encore une fois.",
            "14-18": "Il manquait un mot : « {word} ».",
        },
        "ins": {
            "6-9": "Oups, un mot en plus s'est glissé ! Essaie encore !",
            "10-13": "Tu as ajouté un mot qui n'est pas dans le texte. Essaie encore une fois.",
            "14-18": "Il y avait un mot en trop, absent du texte.",
        },
    },
    "ar": {
        "sub": {
            "6-9": "اقتربت كثيرًا! الكلمة هي «{word}». هيا مرة أخرى!",
            "10-13": "اقتربت! الكلمة الصحيحة هي «{word}». مرة أخرى من فضلك.",
            "14-18": "هناك كلمة مختلفة، والصحيح: «{word}».",
        },
        "del": {
            "6-9": "أوه، هربت كلمة! نسيت كلمة «{word}». هيا مرة أخرى!",
            "10-13": "فاتتك كلمة: «{word}». مرة أخرى من فضلك.",
            "14-18": "سقطت كلمة: «{word}».",
        },
        "ins": {
            "6-9": "أوه، دخلت كلمة زائدة! هيا مرة أخرى!",
            "10-13": "أضفت كلمة ليست في النص. مرة أخرى من فضلك.",
            "14-18": "هناك كلمة زائدة ليست في النص.",
        },
    },
}

# Used for sub/del when no word is given.
_POINT_OUT_NO_WORD: dict[str, dict[str, str]] = {
    "en": {
        "6-9": "Almost! One word was not quite right. Try again!",
        "10-13": "Nearly there. One word was not right. Give it another try.",
        "14-18": "One word was not right.",
    },
    "fr": {
        "6-9": "Presque ! Un mot n'était pas tout à fait juste. Essaie encore !",
        "10-13": "Presque ! Un mot n'était pas juste. Essaie encore une fois.",
        "14-18": "Un mot n'était pas juste.",
    },
    "ar": {
        "6-9": "اقتربت كثيرًا! كلمة واحدة لم تكن صحيحة. هيا مرة أخرى!",
        "10-13": "اقتربت! كلمة واحدة لم تكن صحيحة. مرة أخرى من فضلك.",
        "14-18": "هناك كلمة غير صحيحة.",
    },
}

_SAY_AGAIN: dict[str, dict[str, str]] = {
    "en": {
        "6-9": "Hmm, that was hard to hear. Can you say it again, a little louder?",
        "10-13": "That was not clear enough. Please say it again.",
        "14-18": "The recording was unclear. Please try again.",
    },
    "fr": {
        "6-9": "Hum, c'était difficile à entendre. Tu peux le redire un peu plus fort ?",
        "10-13": "Ce n'était pas assez clair. Redis-le, s'il te plaît.",
        "14-18": "L'enregistrement n'était pas clair. Réessaie, s'il te plaît.",
    },
    "ar": {
        "6-9": "لم يكن الصوت واضحًا. مرة أخرى بصوت أعلى قليلًا، من فضلك!",
        "10-13": "لم يكن الصوت واضحًا بما يكفي. مرة أخرى من فضلك.",
        "14-18": "التسجيل غير واضح. يرجى الإعادة.",
    },
}

# Quran: fixed, respectful, Arabic only.
QURAN_CORRECT = "أحسنت، بارك الله فيك."
QURAN_UNCLEAR = "أعد التلاوة من فضلك."
_QURAN_MISTAKE = {
    "sub": "انتبه: «{word}»",
    "del": "انتبه، فاتتك كلمة: «{word}»",
    "ins": "انتبه، في التلاوة كلمة زائدة عند «{word}»",
}
_QURAN_MISTAKE_NO_WORD = "انتبه، في التلاوة خطأ. أعد التلاوة من فضلك."
_QURAN_KINDS = ("correct", "mistakes", "mistake", "sub", "del", "ins", "unclear")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _check(lang: str, age: str) -> None:
    if lang not in _PRAISE:
        raise ValueError(f"unsupported language: {lang!r}")
    if age not in AGE_BANDS:
        raise ValueError(f"unsupported age band: {age!r}")


def _clean_word(word: str | None) -> str:
    """The word to quote: surrounding whitespace removed, inner whitespace collapsed."""
    return " ".join((word or "").split())


def praise(lang: Lang, age: AgeBand, seed: int = 0) -> str:
    """Praise for a recitation or dictation without mistakes.

    ``seed`` picks one of several messages deterministically (any integer), so the app
    can vary the wording, for example with the attempt number.
    """
    _check(lang, age)
    options = _PRAISE[lang][age]
    return options[seed % len(options)]


def point_out(lang: Lang, age: AgeBand, expected_word: str, kind: str) -> str:
    """Point out one mistake gently, for example ``Almost! Listen again: "cat".``

    ``kind`` is ``"sub"`` (a word was said differently), ``"del"`` (a word was skipped)
    or ``"ins"`` (an extra word was added). For sub and del the expected word is quoted;
    an insertion has no expected word, so its message does not quote any word (the
    argument is accepted and ignored). With an empty word, a message without a quote
    is used.

    Raises ValueError for an unknown language, age band or kind.
    """
    _check(lang, age)
    if kind not in ERROR_KINDS:
        raise ValueError(f"unknown mistake kind: {kind!r} (expected sub, del or ins)")
    word = _clean_word(expected_word)
    if kind != "ins" and not word:
        return _POINT_OUT_NO_WORD[lang][age]
    return _POINT_OUT[lang][kind][age].format(word=word)


def say_again(lang: Lang, age: AgeBand) -> str:
    """Ask the child to say it again because the recording was not clear."""
    _check(lang, age)
    return _SAY_AGAIN[lang][age]


def quran_feedback(kind: str, expected_word: str | None) -> str:
    """Fixed, respectful Arabic feedback for a Quran recitation.

    ``kind`` is a verdict (``"correct"``, ``"mistakes"``, ``"unclear"``) or a mistake
    kind (``"sub"``, ``"del"``, ``"ins"``; ``"mistakes"`` reads like ``"sub"``).
    ``expected_word`` is the verbatim display word at the first mistake, and is the only
    Quran text ever quoted; it is quoted exactly as given (only surrounding whitespace is
    removed). It is ignored for ``"correct"`` and ``"unclear"``.

    Raises ValueError for an unknown kind.
    """
    if kind not in _QURAN_KINDS:
        raise ValueError(f"unknown Quran feedback kind: {kind!r}")
    if kind == "correct":
        return QURAN_CORRECT
    if kind == "unclear":
        return QURAN_UNCLEAR
    word = (expected_word or "").strip()
    if not word:
        return _QURAN_MISTAKE_NO_WORD
    template = _QURAN_MISTAKE["sub" if kind in ("mistakes", "mistake") else kind]
    return template.format(word=word)


def for_result(result: Any, lang: Lang, age: AgeBand, seed: int = 0) -> str:
    """Template feedback for a whole check result (offline wording).

    ``result`` is a :class:`mommy.align.CheckResult`, its ``dataclasses.asdict`` form, or
    the dict of :func:`mommy.align.result_summary`. Returns :func:`say_again` when the
    result says so, :func:`praise` when it is correct, and otherwise
    :func:`point_out` for the first mistake. The verdict is never changed.
    """
    data: Mapping[str, Any] = result if isinstance(result, Mapping) else vars(result)
    if data.get("say_again") or data.get("verdict") == "unclear":
        return say_again(lang, age)
    errors = data.get("errors")
    if errors is None:
        errors = [
            op if isinstance(op, Mapping) else vars(op)
            for op in data.get("ops", [])
            if (op.get("kind") if isinstance(op, Mapping) else op.kind) != "match"
        ]
    if data.get("verdict") == "correct" or not errors:
        return praise(lang, age, seed)
    first = errors[0]
    return point_out(lang, age, first.get("expected") or "", first["kind"])


__all__ = [
    "AGE_BANDS",
    "ERROR_KINDS",
    "QURAN_CORRECT",
    "QURAN_UNCLEAR",
    "AgeBand",
    "for_result",
    "point_out",
    "praise",
    "quran_feedback",
    "say_again",
]
