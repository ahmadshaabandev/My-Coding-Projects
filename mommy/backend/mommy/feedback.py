"""Fixed feedback messages: the offline wording, and the fallback when Claude fails.

Tone: warm and encouraging, in short sentences, adapted to the age band (playful for
6-9, plain for 14-18). Messages speak to the child in the second person and never in
the first person, so nothing suggests that a person (let alone a parent) is speaking.

Arabic messages are Modern Standard Arabic that a young child understands. They avoid
gendered imperatives where a neutral form is natural (``مرة أخرى من فضلك`` rather than
``أعِد``/``أعيدي``); unvocalised past-tense forms such as ``أحسنت`` and ``نسيت`` read for
a boy or a girl alike.

The Quran feedback (:func:`quran_feedback`) is a separate, fixed and respectful set of
Arabic messages that quotes at most the single word it is given. It follows the same
neutrality rule (``تنبيه``, ``التلاوة مرة أخرى من فضلك`` rather than ``انتبه``/``أعد``).

The messages match the result: one mistake is "one word", several are "a few words,
the first one is ..."; a child who stopped early is told where; a clear recording far
from the text is not told to speak louder; a word a reader could not read (``[?]``) is
never pointed out as the child's mistake.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping

from .align import UNREADABLE as UNREADABLE_MARK  # the mark of a word a reader could not read
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

# The same, when there is more than one mistake: the first one is named, and the message
# does not pretend it was the only one.
_POINT_OUT_SEVERAL: dict[str, dict[str, dict[str, str]]] = {
    "en": {
        "sub": {
            "6-9": 'Almost! A few words were not quite right. The first one is "{word}". Try once more!',
            "10-13": 'Nearly there. A few words were not right. The first one is "{word}". Give it another try.',
            "14-18": 'Some words were not right. The first one: the text says "{word}".',
        },
        "del": {
            "6-9": 'Oops, some words ran away! The first one you skipped is "{word}". Try again!',
            "10-13": 'A few words were not right. First, you skipped "{word}". Try once more.',
            "14-18": 'Some words were not right. The first missing word is "{word}".',
        },
        "ins": {
            "6-9": "Oops, a few words were not quite right, and an extra word sneaked in! Try again!",
            "10-13": "A few words were not right. First, you added a word that is not in the text. Try once more.",
            "14-18": "Some words were not right, starting with an extra word that is not in the text.",
        },
    },
    "fr": {
        "sub": {
            "6-9": "Presque ! Quelques mots n'étaient pas tout à fait justes. Le premier est « {word} ». Essaie encore !",
            "10-13": "Presque ! Quelques mots n'étaient pas justes. Le premier est « {word} ». Essaie encore une fois.",
            "14-18": "Plusieurs mots n'étaient pas justes. Le premier : le texte dit « {word} ».",
        },
        "del": {
            "6-9": "Oups, des mots se sont envolés ! Le premier oublié est « {word} ». Essaie encore !",
            "10-13": "Quelques mots n'étaient pas justes. D'abord, tu as sauté « {word} ». Essaie encore une fois.",
            "14-18": "Plusieurs mots n'étaient pas justes. Le premier mot manquant : « {word} ».",
        },
        "ins": {
            "6-9": "Oups, quelques mots n'étaient pas tout à fait justes, et un mot en plus s'est glissé ! Essaie encore !",
            "10-13": "Quelques mots n'étaient pas justes. D'abord, tu as ajouté un mot qui n'est pas dans le texte. Essaie encore une fois.",
            "14-18": "Plusieurs mots n'étaient pas justes, à commencer par un mot en trop, absent du texte.",
        },
    },
    "ar": {
        "sub": {
            "6-9": "اقتربت كثيرًا! بعض الكلمات لم تكن صحيحة، وأولها «{word}». هيا مرة أخرى!",
            "10-13": "اقتربت! بعض الكلمات لم تكن صحيحة، وأولها «{word}». مرة أخرى من فضلك.",
            "14-18": "هناك عدة كلمات غير صحيحة، أولها: «{word}».",
        },
        "del": {
            "6-9": "أوه، هربت بعض الكلمات! أول كلمة فاتتك: «{word}». هيا مرة أخرى!",
            "10-13": "بعض الكلمات لم تكن صحيحة. أول كلمة فاتتك: «{word}». مرة أخرى من فضلك.",
            "14-18": "هناك عدة أخطاء، أولها كلمة ساقطة: «{word}».",
        },
        "ins": {
            "6-9": "أوه، بعض الكلمات لم تكن صحيحة، ودخلت كلمة زائدة! هيا مرة أخرى!",
            "10-13": "بعض الكلمات لم تكن صحيحة، أولها كلمة زائدة ليست في النص. مرة أخرى من فضلك.",
            "14-18": "هناك عدة أخطاء، أولها كلمة زائدة ليست في النص.",
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

_POINT_OUT_SEVERAL_NO_WORD: dict[str, dict[str, str]] = {
    "en": {
        "6-9": "Almost! A few words were not quite right. Try again!",
        "10-13": "Nearly there. A few words were not right. Give it another try.",
        "14-18": "Some words were not right.",
    },
    "fr": {
        "6-9": "Presque ! Quelques mots n'étaient pas tout à fait justes. Essaie encore !",
        "10-13": "Presque ! Quelques mots n'étaient pas justes. Essaie encore une fois.",
        "14-18": "Plusieurs mots n'étaient pas justes.",
    },
    "ar": {
        "6-9": "اقتربت كثيرًا! بعض الكلمات لم تكن صحيحة. هيا مرة أخرى!",
        "10-13": "اقتربت! بعض الكلمات لم تكن صحيحة. مرة أخرى من فضلك.",
        "14-18": "هناك عدة كلمات غير صحيحة.",
    },
}

# The child stopped before the end; {word} is the first word not said or written.
_STOPPED: dict[str, dict[str, str]] = {
    "en": {
        "6-9": 'Good start! You stopped at "{word}". Next time, keep going to the end!',
        "10-13": 'Good start. You stopped at "{word}". Try to go on to the end.',
        "14-18": 'You stopped at "{word}". Continue to the end next time.',
    },
    "fr": {
        "6-9": "Bon début ! La suite commence à « {word} ». La prochaine fois, va jusqu'au bout !",
        "10-13": "Bon début. La suite commence à « {word} ». Essaie d'aller jusqu'au bout.",
        "14-18": "Il manque la fin, à partir de « {word} ». Va jusqu'au bout la prochaine fois.",
    },
    "ar": {
        "6-9": "بداية جميلة! توقفت قبل «{word}». هيا حتى النهاية في المرة القادمة!",
        "10-13": "بداية جيدة. توقفت قبل «{word}». مرة أخرى حتى النهاية من فضلك.",
        "14-18": "توقفت قبل «{word}». يرجى الإكمال حتى النهاية.",
    },
}

# Words a reader could not read in a photo of the child's writing ([?]).
_UNREADABLE: dict[str, dict[str, str]] = {
    "en": {
        "6-9": "Some words were hard to read. They will be checked together!",
        "10-13": "Some words could not be read. They need to be checked.",
        "14-18": "Some words could not be read and need checking.",
    },
    "fr": {
        "6-9": "Certains mots étaient difficiles à lire. Ils seront vérifiés !",
        "10-13": "Certains mots n'ont pas pu être lus. Il faut les vérifier.",
        "14-18": "Certains mots n'ont pas pu être lus et doivent être vérifiés.",
    },
    "ar": {
        "6-9": "بعض الكلمات صعبة القراءة، وستتم مراجعتها!",
        "10-13": "تعذرت قراءة بعض الكلمات، ويلزم التحقق منها.",
        "14-18": "تعذرت قراءة بعض الكلمات وتحتاج إلى مراجعة.",
    },
}

# The recording was fine, but what was heard is far from the text (wrong page, another
# paragraph, or a weak recognition): not a reason to speak louder.
_SAY_AGAIN_DIFFERENT: dict[str, dict[str, str]] = {
    "en": {
        "6-9": "Hmm, that sounded quite different from the text. Try reading it again, from the start to the end!",
        "10-13": "That was quite different from the text. Try again from the beginning.",
        "14-18": "The recording did not match the text well. Read it again from the beginning.",
    },
    "fr": {
        "6-9": "Hum, c'était assez différent du texte. Essaie de le relire, du début à la fin !",
        "10-13": "C'était assez différent du texte. Recommence depuis le début.",
        "14-18": "L'enregistrement ne correspond pas bien au texte. Relis-le depuis le début.",
    },
    "ar": {
        "6-9": "كان ما سُمع مختلفًا كثيرًا عن النص. هيا مرة أخرى من البداية إلى النهاية!",
        "10-13": "كان ما سُمع مختلفًا كثيرًا عن النص. مرة أخرى من البداية من فضلك.",
        "14-18": "التسجيل لا يطابق النص جيدًا. يرجى القراءة من البداية.",
    },
}

# A dictation with nothing written on it (or typed).
_NOTHING_WRITTEN: dict[str, dict[str, str]] = {
    "en": {
        "6-9": "No words were found in the writing. Try the dictation again!",
        "10-13": "No words were found in the writing. Try the dictation again.",
        "14-18": "No written words were found. Try the dictation again.",
    },
    "fr": {
        "6-9": "Aucun mot n'a été trouvé dans l'écriture. Essaie encore la dictée !",
        "10-13": "Aucun mot n'a été trouvé dans l'écriture. Recommence la dictée.",
        "14-18": "Aucun mot écrit n'a été trouvé. Recommence la dictée.",
    },
    "ar": {
        "6-9": "لم توجد كلمات مكتوبة. هيا، الإملاء مرة أخرى!",
        "10-13": "لم توجد كلمات مكتوبة. الإملاء مرة أخرى من فضلك.",
        "14-18": "لم توجد كلمات مكتوبة. يرجى إعادة الإملاء.",
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

# Quran: fixed, respectful, Arabic only, and neutral for a boy or a girl (no imperative:
# a noun or an unvocalised past-tense form instead of انتبه / أعد).
QURAN_CORRECT = "أحسنت، بارك الله فيك."
QURAN_UNCLEAR = "التلاوة مرة أخرى من فضلك."
_QURAN_MISTAKE = {
    "sub": "تنبيه: «{word}»",
    "del": "تنبيه، فاتتك كلمة: «{word}»",
    "ins": "تنبيه، في التلاوة كلمة زائدة عند «{word}»",
    "stopped": "أحسنت فيما تلوت، وتوقفت التلاوة قبل «{word}».",
}
_QURAN_MISTAKE_NO_WORD = "تنبيه، في التلاوة خطأ. التلاوة مرة أخرى من فضلك."
_QURAN_KINDS = ("correct", "mistakes", "mistake", "sub", "del", "ins", "stopped", "unclear")


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


def point_out(lang: Lang, age: AgeBand, expected_word: str, kind: str, n_errors: int = 1) -> str:
    """Point out the first mistake gently, for example ``Almost! Listen again: "cat".``

    ``kind`` is ``"sub"`` (a word was said differently), ``"del"`` (a word was skipped)
    or ``"ins"`` (an extra word was added). For sub and del the expected word is quoted;
    an insertion has no expected word, so its message does not quote any word (the
    argument is accepted and ignored). With an empty word, a message without a quote
    is used. ``n_errors`` is the number of mistakes: with more than one, the message
    says there were several and names the first ("A few words were not right. The
    first one is ...").

    Raises ValueError for an unknown language, age band or kind.
    """
    _check(lang, age)
    if kind not in ERROR_KINDS:
        raise ValueError(f"unknown mistake kind: {kind!r} (expected sub, del or ins)")
    word = _clean_word(expected_word)
    several = n_errors > 1
    if kind != "ins" and not word:
        return (_POINT_OUT_SEVERAL_NO_WORD if several else _POINT_OUT_NO_WORD)[lang][age]
    return (_POINT_OUT_SEVERAL if several else _POINT_OUT)[lang][kind][age].format(word=word)


def stopped(lang: Lang, age: AgeBand, next_word: str) -> str:
    """Tell the child where they stopped: ``next_word`` is the first word not said or
    written (``Good start! You stopped at "sat". ...``)."""
    _check(lang, age)
    word = _clean_word(next_word)
    if not word:
        return _POINT_OUT_SEVERAL_NO_WORD[lang][age]
    return _STOPPED[lang][age].format(word=word)


def unreadable(lang: Lang, age: AgeBand) -> str:
    """Some written words could not be read from the photo, and nothing else was wrong."""
    _check(lang, age)
    return _UNREADABLE[lang][age]


def say_again(lang: Lang, age: AgeBand, reason: str | None = None) -> str:
    """Ask the child to try again because the input was not usable.

    ``reason`` is the result's ``say_again_reason``: ``"empty"`` or None (nothing was
    heard: "that was hard to hear, a little louder"), ``"error_rate"`` (the recording
    was clear but very different from the text: "read it again from the start", never
    "louder"), or ``"nothing_written"`` (a dictation with no words written).
    """
    _check(lang, age)
    if reason == "error_rate":
        return _SAY_AGAIN_DIFFERENT[lang][age]
    if reason == "nothing_written":
        return _NOTHING_WRITTEN[lang][age]
    return _SAY_AGAIN[lang][age]


def quran_feedback(kind: str, expected_word: str | None) -> str:
    """Fixed, respectful Arabic feedback for a Quran recitation.

    ``kind`` is a verdict (``"correct"``, ``"mistakes"``, ``"unclear"``) or a mistake
    kind (``"sub"``, ``"del"``, ``"ins"``; ``"mistakes"`` reads like ``"sub"``), or
    ``"stopped"`` when everything recited was right but the child stopped before the end
    of the range. ``expected_word`` is the verbatim display word at the first mistake
    (for ``"stopped"``, the first word not recited), and is the only Quran text ever
    quoted; it is quoted exactly as given (only surrounding whitespace is removed). It is
    ignored for ``"correct"`` and ``"unclear"``. The wording addresses a boy or a girl
    alike (no imperative).

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


def for_result(
    result: Any, lang: Lang, age: AgeBand, seed: int = 0, *, activity: str | None = None
) -> str:
    """Template feedback for a whole check result (offline wording).

    ``result`` is a :class:`mommy.align.CheckResult`, its ``dataclasses.asdict`` form, or
    the dict of :func:`mommy.align.result_summary`. ``activity`` is ``"recitation"`` or
    ``"dictation"`` (optional; else the ``"activity"`` key of a summary). Returns, in
    this order:

    * :func:`say_again` when the result says so, worded for its ``say_again_reason``
      (an empty dictation says that nothing was written);
    * :func:`praise` when it is correct;
    * :func:`stopped` when the first mistake is where the child stopped early;
    * :func:`point_out` for the first mistake, in the plural when there are several;
    * :func:`unreadable` when the only "mistakes" are words a reader marked ``[?]``.

    Words marked unreadable are never pointed out. The verdict is never changed. Praise
    is for strict (word-by-word) results only; contextual mode has its own wording
    (:func:`mommy.llm.meaning_feedback`).
    """
    data: Mapping[str, Any] = result if isinstance(result, Mapping) else vars(result)
    activity = activity or data.get("activity")
    if data.get("say_again") or data.get("verdict") == "unclear":
        reason = data.get("say_again_reason")
        if activity == "dictation" and reason in (None, "empty"):
            reason = "nothing_written"
        return say_again(lang, age, reason)
    errors = data.get("errors")
    if errors is None:
        errors = [
            op if isinstance(op, Mapping) else vars(op)
            for op in data.get("ops", [])
            if (op.get("kind") if isinstance(op, Mapping) else op.kind) != "match"
        ]
    errors = [e for e in errors if e.get("heard") != UNREADABLE_MARK]
    n_unreadable = int(data.get("n_unreadable") or 0)
    if data.get("verdict") == "correct" or (not errors and not n_unreadable):
        return praise(lang, age, seed)
    if not errors:
        return unreadable(lang, age)
    first = errors[0]
    stop = data.get("stopped_at_exp_index")
    if stop is not None and first["kind"] == "del" and first.get("exp_index") == stop:
        return stopped(lang, age, first.get("expected") or "")
    n_errors = int(data.get("n_errors") or len(errors)) - n_unreadable
    return point_out(lang, age, first.get("expected") or "", first["kind"], n_errors=max(n_errors, len(errors)))


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
    "stopped",
    "unreadable",
]
