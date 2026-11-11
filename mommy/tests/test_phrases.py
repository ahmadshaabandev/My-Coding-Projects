"""Tests for mommy.phrases.split_phrases."""

from __future__ import annotations

import random

import pytest

from mommy.phrases import split_phrases
from mommy.textnorm import tokenize


def words_of(phrases: list[str], lang: str) -> list[str]:
    return [t for p in phrases for t in tokenize(p, lang)]


def assert_invariants(text: str, lang: str, max_words: int) -> list[str]:
    phrases = split_phrases(text, lang, max_words)
    assert all(p and p == p.strip() for p in phrases), phrases
    assert all(1 <= len(tokenize(p, lang)) <= max_words for p in phrases), phrases
    # No word is lost, duplicated, cut or reordered.
    assert words_of(phrases, lang) == tokenize(text, lang)
    return phrases


# ---------------------------------------------------------------------------
# Arabic
# ---------------------------------------------------------------------------


def test_arabic_splits_on_arabic_comma_semicolon_and_question_mark() -> None:
    text = "ذهب الولد إلى المدرسة، وقرأ الدرس؛ ثم عاد إلى البيت. هل فهمت؟ نعم!"
    assert split_phrases(text, "ar") == [
        "ذهب الولد إلى المدرسة،",
        "وقرأ الدرس؛",
        "ثم عاد إلى البيت.",
        "هل فهمت؟",
        "نعم!",
    ]


def test_arabic_long_clause_is_capped_in_balanced_pieces() -> None:
    text = "ثم عاد الولد الصغير إلى البيت مع أصدقائه في الحافلة الكبيرة"  # 11 words
    phrases = assert_invariants(text, "ar", 6)
    assert [len(tokenize(p, "ar")) for p in phrases] == [6, 5]


def test_arabic_with_tashkeel_keeps_marks_on_their_words() -> None:
    text = "ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ، وَقَرَأَ الدَّرْسَ."
    assert split_phrases(text, "ar") == ["ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ،", "وَقَرَأَ الدَّرْسَ."]


# ---------------------------------------------------------------------------
# French
# ---------------------------------------------------------------------------


def test_french_sentence_and_clause_punctuation() -> None:
    text = "Le chat dort. Il fait beau aujourd'hui, et le soleil brille ; tout va bien !"
    assert split_phrases(text, "fr") == [
        "Le chat dort.",
        "Il fait beau aujourd'hui,",
        "et le soleil brille ;",
        "tout va bien !",
    ]


def test_french_quotes_stay_with_their_phrase() -> None:
    text = "Il dit : « Bonjour. » Puis il part..."
    assert split_phrases(text, "fr") == ["Il dit :", "« Bonjour. »", "Puis il part..."]


def test_french_elisions_count_as_one_word() -> None:
    text = "L'élève qu'il aime n'est pas là aujourd'hui"  # 7 words
    phrases = assert_invariants(text, "fr", 6)
    assert len(phrases) == 2
    assert phrases[0].startswith("L'élève qu'il")


def test_numbers_and_abbreviations_do_not_split() -> None:
    # 7 words: the number separators do not break the phrase (the cap is raised).
    assert split_phrases("Le prix est 3,5 euros à 12:30.", "fr", max_words=8) == [
        "Le prix est 3,5 euros à 12:30."
    ]
    assert split_phrases("Il a 3,5 ans.", "fr") == ["Il a 3,5 ans."]
    assert split_phrases("M. Dupont et Mme Durand arrivent.", "fr") == ["M. Dupont et Mme Durand arrivent."]


# ---------------------------------------------------------------------------
# English
# ---------------------------------------------------------------------------


def test_english_sentences() -> None:
    text = "The cat sat on the mat. Was it happy? Yes!"
    assert split_phrases(text, "en") == ["The cat sat on the mat.", "Was it happy?", "Yes!"]


def test_english_abbreviations_and_initials() -> None:
    text = "Mr. Smith met Dr. Jones. J. K. Rowling wrote books!"
    assert split_phrases(text, "en", max_words=8) == [
        "Mr. Smith met Dr. Jones.",
        "J. K. Rowling wrote books!",
    ]


def test_english_contractions_stay_whole() -> None:
    phrases = assert_invariants("I don't think we'll go out today because it's raining", "en", 4)
    assert any("don't" in p for p in phrases)
    assert all("'" not in p.split()[0][:1] for p in phrases)


def test_runs_of_punctuation_make_one_break() -> None:
    assert split_phrases("Really?! Yes... Fine.", "en") == ["Really?!", "Yes...", "Fine."]


def test_whitespace_and_blank_lines() -> None:
    text = "Line one\nline two\n\n  New paragraph   here  "
    assert split_phrases(text, "en") == ["Line one line two", "New paragraph here"]


# ---------------------------------------------------------------------------
# Caps, empties, invariants
# ---------------------------------------------------------------------------


def test_max_words_balanced_pieces() -> None:
    text = " ".join(f"w{i}" for i in range(13))
    phrases = split_phrases(text, "en", 6)
    assert [len(p.split()) for p in phrases] == [5, 4, 4]


def test_max_words_one() -> None:
    assert split_phrases("a b, c", "en", max_words=1) == ["a", "b,", "c"]


def test_invalid_max_words() -> None:
    with pytest.raises(ValueError):
        split_phrases("a b", "en", max_words=0)


@pytest.mark.parametrize("text", ["", "   ", "...", "!!! ,,, ؟؟ ،", "« »", "\n\n\n"])
def test_no_words_no_phrases(text: str) -> None:
    assert split_phrases(text, "en") == []
    assert split_phrases(text, "ar") == []


def test_words_joined_by_dashes_are_cut_between_words() -> None:
    text = "—".join(f"w{i}" for i in range(8))
    phrases = assert_invariants(text, "en", 4)
    assert len(phrases) == 2


@pytest.mark.parametrize("seed", range(30))
def test_random_texts_respect_max_words(seed: int) -> None:
    rng = random.Random(seed)
    lang = rng.choice(["ar", "en", "fr"])
    vocab = {
        "ar": ["كتاب", "الولد", "إلى", "مَدْرَسَةٌ", "قال", "٣"],
        "en": ["cat", "don't", "the", "well-known", "3,5", "Dr."],
        "fr": ["l'école", "été", "peut-être", "chat", "à", "12:30"],
    }[lang]
    seps = [" ", " ", " ", ", ", ". ", " ; ", "! ", "? ", "، ", "؟ ", " — ", "\n", "\n\n", " « ", " » "]
    parts: list[str] = []
    for _ in range(rng.randint(0, 60)):
        parts.append(rng.choice(vocab))
        parts.append(rng.choice(seps))
    text = "".join(parts)
    max_words = rng.randint(1, 8)
    assert_invariants(text, lang, max_words)
