"""Tests for mommy.feedback (offline templates) and mommy.config (settings).

config has no test file of its own in this part of the work, so its tests live at the
end of this file.
"""

from __future__ import annotations

import re
from dataclasses import asdict
from pathlib import Path

import pytest

from mommy import feedback
from mommy.align import check_recitation, result_summary
from mommy.config import Settings, load_settings
from mommy.feedback import AGE_BANDS, for_result, point_out, praise, quran_feedback, say_again
from mommy.llm import VERDICTS, meaning_feedback
from mommy.textnorm import has_arabic, strip_tashkeel

LANGS = ("ar", "en", "fr")
KINDS = ("sub", "del", "ins")
WORDS = {"ar": "المدرسة", "en": "garden", "fr": "école"}

# Phrases that would suggest a person (or a parent) is speaking.
FIRST_PERSON = {
    "en": re.compile(r"\b(i|i'm|i've|me|my|mine|we|us|our|let's|mom|mommy|mum|mother|dad)\b", re.I),
    "fr": re.compile(r"\b(je|j'|moi|mon|ma|mes|nous|notre|on|maman|mère|papa)\b", re.I),
    "ar": re.compile(r"(أنا|إني|إنني|نحن|ماما|أمك|أمي|والدتك|بابا)"),
}


def all_messages() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for lang in LANGS:
        for age in AGE_BANDS:
            for seed in range(5):
                out.append((lang, praise(lang, age, seed)))
            for reason in (None, "empty", "error_rate", "nothing_written"):
                out.append((lang, say_again(lang, age, reason)))
            for kind in KINDS:
                for n_errors in (1, 3):
                    out.append((lang, point_out(lang, age, WORDS[lang], kind, n_errors)))
                    out.append((lang, point_out(lang, age, "", kind, n_errors)))
            out.append((lang, feedback.stopped(lang, age, WORDS[lang])))
            out.append((lang, feedback.unreadable(lang, age)))
    return out


# ---------------------------------------------------------------------------
# Children's templates
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("age", AGE_BANDS)
def test_every_template_exists_and_is_short(lang: str, age: str) -> None:
    messages = (
        [praise(lang, age), feedback.stopped(lang, age, WORDS[lang]), feedback.unreadable(lang, age)]
        + [say_again(lang, age, r) for r in (None, "error_rate", "nothing_written")]
        + [point_out(lang, age, WORDS[lang], k, n) for k in KINDS for n in (1, 2)]
    )
    for m in messages:
        assert m.strip() == m and m
        # Arabic vowel marks are not extra text to read; the raw text stays far below the
        # 400 characters that /api/tts accepts.
        assert len(strip_tashkeel(m)) <= 125 and len(m) <= 200
        assert m.count(".") + m.count("!") + m.count("?") + m.count("؟") <= 4


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("age", AGE_BANDS)
@pytest.mark.parametrize("kind", ["sub", "del"])
def test_point_out_quotes_the_expected_word(lang: str, age: str, kind: str) -> None:
    msg = point_out(lang, age, WORDS[lang], kind)
    assert WORDS[lang] in msg
    assert "{" not in msg


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("age", AGE_BANDS)
def test_point_out_insertion_does_not_name_a_word(lang: str, age: str) -> None:
    msg = point_out(lang, age, WORDS[lang], "ins")
    assert WORDS[lang] not in msg


def test_point_out_cleans_the_word_and_handles_empty() -> None:
    assert '"jardin"' not in point_out("en", "10-13", "  garden  ", "sub")
    assert '"garden"' in point_out("en", "10-13", "  garden  ", "sub")
    for lang in LANGS:
        msg = point_out(lang, "6-9", "   ", "del")
        assert msg and "«»" not in msg and '""' not in msg


def test_contract_example_wording() -> None:
    assert point_out("en", "6-9", "cat", "sub").startswith('Almost! Listen again: "cat"')


def test_language_of_messages() -> None:
    for lang, msg in all_messages():
        if lang == "ar":
            assert has_arabic(msg) and not re.search(r"[A-Za-z]", msg), msg
        else:
            assert not has_arabic(msg), msg


def test_messages_never_suggest_a_person_is_speaking() -> None:
    for lang, msg in all_messages():
        assert not FIRST_PERSON[lang].search(strip_tashkeel(msg)), msg


def test_tone_differs_by_age() -> None:
    for lang in LANGS:
        young = point_out(lang, "6-9", WORDS[lang], "del")
        teen = point_out(lang, "14-18", WORDS[lang], "del")
        assert young != teen
        assert young.count("!") >= teen.count("!")
        assert len(set(say_again(lang, a) for a in AGE_BANDS)) == 3


def test_praise_seed_is_deterministic_and_varies() -> None:
    for lang in LANGS:
        for age in AGE_BANDS:
            options = {praise(lang, age, s) for s in range(10)}
            assert len(options) >= 2
            assert praise(lang, age, 3) == praise(lang, age, 3)
            assert praise(lang, age, -1) in options


def test_invalid_arguments() -> None:
    with pytest.raises(ValueError):
        praise("de", "6-9")  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        say_again("en", "5-6")  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        point_out("en", "6-9", "cat", "match")


# Imperatives addressed to one child are gendered (أعد/أعيدي, حاول/حاولي, ...). Checked on
# the text without vowel marks, so a vocalised form cannot slip through.
GENDERED_IMPERATIVES = re.compile(
    r"(^|\s)(أعد|أعيدي|حاول|حاولي|اسمع|اسمعي|استمع|استمعي|انتبه|انتبهي|اقرأ|اقرئي|اقرا|"
    r"أكمل|أكملي|اكمل|اكملي|تابع|تابعي|ابدأ|ابدئي|قل|قولي|تذكر|تذكري|اكتب|اكتبي|كرر|كرري|"
    r"ركز|ركزي|جرب|جربي)(\s|[،.!؟:]|$)"
)


def arabic_spoken_messages() -> list[str]:
    """Every Arabic message that the app may read aloud (Quran feedback is never spoken)."""
    out = [msg for lang, msg in all_messages() if lang == "ar"]
    for age in AGE_BANDS:
        for verdict in VERDICTS:
            for ideas in ([], [WORDS["ar"]]):
                out.append(meaning_feedback(verdict, ideas, "ar", age))
    return out


def test_arabic_avoids_gendered_imperatives_in_children_templates() -> None:
    for msg in arabic_spoken_messages():
        assert not GENDERED_IMPERATIVES.search(strip_tashkeel(msg)), msg


def test_arabic_encouragement_is_inclusive_first_person_plural() -> None:
    # "هيا" is always followed by a "we" verb (هيا نُحاوِل، هيا نُعِيد), and the elliptical
    # "مرة أخرى من فضلك" is gone.
    seen = 0
    for msg in arabic_spoken_messages():
        bare = strip_tashkeel(msg)
        for following in re.findall(r"هيا\s+(\S+)", bare):
            assert following.startswith("ن"), msg
            seen += 1
        assert "من فضلك" not in bare, msg
    assert seen > 20


def test_arabic_spoken_messages_show_no_gender_to_the_voice() -> None:
    # The synthetic voice reads a bare final ك as the masculine "-ka", and a vowel on a
    # last ت or ك would fix the gender in writing. The only words ending in ك are
    # demonstratives.
    gender_vowel = re.compile("[\u062a\u0643][\u064e\u064f\u0650](?=[\\s،.!؟:»]|$)")
    for msg in arabic_spoken_messages():
        assert not gender_vowel.search(msg), msg
        for word in re.findall(r"[\u0621-\u064a]+", strip_tashkeel(msg)):
            if word.endswith("ك"):
                assert word in ("هناك", "هنالك", "ذلك", "تلك", "كذلك"), msg


def test_arabic_spoken_messages_have_vowels_for_the_synthetic_voice(mommy_root: Path) -> None:
    # espeak-ng, which phonemizes for the Arabic voice, gives a word without vowel marks
    # no vowels unless it knows the word (أحسنت -> ʔħsnt): the templates mark the vowels
    # it needs. Measured with the voice and the recogniser: 0.64 of the words came back
    # right with the unvocalised wording, 0.92 with this one.
    from mommy.tts import find_phonemizer

    phonemizer = find_phonemizer()
    data = mommy_root / "models" / "vits-piper-ar_JO-kareem-medium" / "espeak-ng-data"
    if phonemizer is None or not data.is_dir():
        pytest.skip("no espeak-ng phonemizer or Arabic voice data")
    vowel = re.compile("[aiueoæɑɐəɛɔ]")
    for msg in arabic_spoken_messages():
        for clause in phonemizer.phonemize(msg, "ar", data):
            for word in clause.split():
                assert vowel.search(word), (msg, clause)


# ---------------------------------------------------------------------------
# Quran
# ---------------------------------------------------------------------------


def test_quran_contract_examples() -> None:
    assert quran_feedback("correct", None).startswith("أحسنت")
    assert quran_feedback("sub", "كلمة") == "تنبيه: «كلمة»"
    assert quran_feedback("mistakes", "كلمة") == "تنبيه: «كلمة»"
    # Unclear says that the recitation did not come through, not that it was wrong.
    assert quran_feedback("unclear", None) == "لم تتّضح التلاوة جيدًا. هيا نعيدها مرة أخرى."
    assert quran_feedback("del", "كلمة") == "تنبيه: سقطت من التلاوة كلمة «كلمة»."
    assert quran_feedback("ins", "كلمة") == "تنبيه: في التلاوة كلمة زائدة عند «كلمة»."
    assert quran_feedback("sub", None) == "تنبيه: في التلاوة خطأ. هيا نعيدها مرة أخرى."
    assert quran_feedback("stopped", "كلمة") == "أحسنت فيما تلوت، وتوقفت التلاوة قبل «كلمة»."


def test_quran_feedback_has_no_gendered_imperatives() -> None:
    # Regression: انتبه and أعد التلاوة address a boy only; the child profile has no gender.
    gendered = re.compile(r"(^|\s)(أعد|أعيدي|انتبه|انتبهي|اقرأ|اقرئي|اتل|اتلي)(\s|[،.!؟:]|$)")
    for kind in ("correct", "mistakes", "sub", "del", "ins", "stopped", "unclear"):
        for word in ("كلمة", None):
            assert not gendered.search(quran_feedback(kind, word)), (kind, word)


@pytest.mark.parametrize("kind", ["correct", "mistakes", "mistake", "sub", "del", "ins", "stopped", "unclear"])
def test_quran_feedback_is_arabic_only(kind: str) -> None:
    msg = quran_feedback(kind, "كلمة")
    assert has_arabic(msg) and not re.search(r"[A-Za-z]", msg)
    assert not FIRST_PERSON["ar"].search(msg)


def test_quran_feedback_quotes_only_the_given_word_verbatim(quran_dir: Path) -> None:
    # A real Uthmani word with all its marks, read from the Tanzil file.
    line = next(
        l for l in (quran_dir / "quran-uthmani.txt").read_text(encoding="utf-8").splitlines()
        if l.startswith("112|1|")
    )
    w = line.split("|")[2].split()[-1]
    for kind in ("sub", "del", "ins", "mistakes", "stopped"):
        msg = quran_feedback(kind, w)
        assert f"«{w}»" in msg
        quoted = re.findall(r"«([^»]*)»", msg)
        assert quoted == [w]
    assert w not in quran_feedback("correct", w)
    assert w not in quran_feedback("unclear", w)


def test_quran_feedback_without_word_and_unknown_kind() -> None:
    msg = quran_feedback("sub", None)
    assert "«" not in msg and has_arabic(msg)
    assert quran_feedback("del", "  ") == msg
    with pytest.raises(ValueError):
        quran_feedback("great", "x")


def test_quran_messages_are_fixed() -> None:
    assert quran_feedback("correct", None) == feedback.QURAN_CORRECT
    assert quran_feedback("unclear", "x") == feedback.QURAN_UNCLEAR
    assert feedback.QURAN_CORRECT == "أحسنت، بارك الله في هذه التلاوة."


def test_quran_messages_have_no_addressed_suffix() -> None:
    # Regression (final verification, P4): the Quran section said "تنبيه: فاتتك كلمة …"
    # and "أحسنت، بارك الله فيك." to the child. Shown, not spoken, they still follow the
    # wording rule of every message: no ـك ending outside demonstratives (and the verb
    # بارك, whose ك is a root letter). The quoted mushaf word is left out (it is the Quran
    # text itself).
    messages = [quran_feedback(kind, "كلمة") for kind in ("correct", "mistakes", "sub", "del", "ins", "stopped", "unclear")]
    messages.append(quran_feedback("sub", None))
    for activity in ("recitation", "dictation"):
        for kind in ("sub", "del", "ins", "stopped"):
            messages.append(feedback.quran_part_feedback(kind, "كلمة", "ar", activity))
        messages.append(feedback.quran_part_feedback("sub", None, "ar", activity))
    for msg in messages:
        bare = strip_tashkeel(re.sub(r"«[^»]*»", "", msg))
        for word in re.findall(r"[\u0621-\u064a]+", bare):
            if word.endswith("ك"):
                assert word in ("هناك", "هنالك", "ذلك", "تلك", "كذلك", "بارك"), msg
        assert "فيك" not in bare.split() and "فاتتك" not in bare, msg


# ---------------------------------------------------------------------------
# for_result
# ---------------------------------------------------------------------------


def test_for_result_follows_the_verdict() -> None:
    correct = check_recitation("the cat sat", "the cat sat", "en")
    mistakes = check_recitation("the cat sat on the mat", "the dog sat on the mat", "en")
    unclear = check_recitation("the cat sat", "", "en")
    for form in (lambda r: r, asdict, result_summary):
        assert for_result(form(correct), "en", "10-13") == praise("en", "10-13")
        assert for_result(form(mistakes), "en", "10-13") == point_out("en", "10-13", "cat", "sub")
        assert for_result(form(unclear), "en", "10-13") == say_again("en", "10-13")


def test_for_result_insertion_first() -> None:
    r = check_recitation("the cat sat on the mat", "well the cat sat on the mat", "en")
    assert for_result(r, "fr", "6-9") == point_out("fr", "6-9", "", "ins")


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

_ENV_VARS = (
    "MOMMY_ASR_MODEL",
    "MOMMY_ASR_THREADS",
    "ANTHROPIC_API_KEY",
    "MOMMY_VISION_MODEL",
    "MOMMY_TEXT_MODEL",
    "MOMMY_EFFORT",
    "MOMMY_ALLOWED_HOSTS",
    "MOMMY_LIVE_RECITE",
    "MOMMY_LIVE_ASR_MODEL",
)


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for name in _ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_settings_defaults(clean_env: pytest.MonkeyPatch, mommy_root: Path) -> None:
    s = load_settings()
    assert s.root == mommy_root
    assert s.models_dir == mommy_root / "models"
    assert s.quran_dir == mommy_root / "data" / "quran"
    assert s.web_dir == mommy_root / "web"
    assert (s.asr_model, s.asr_threads, s.effort) == ("turbo", 4, "low")
    assert s.allowed_hosts == ("127.0.0.1", "localhost", "::1")
    assert s.anthropic_api_key_set is False
    assert s.vision_model is None and s.text_model is None
    assert s.claude_configured is False
    assert s.live_recite is True
    assert s.live_asr_model == "auto"
    assert (s.quran_dir / "quran-uthmani.txt").is_file()


def test_settings_from_environment(clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    clean_env.setenv("MOMMY_ASR_MODEL", "Small")
    clean_env.setenv("MOMMY_ALLOWED_HOSTS", " Tutor.Local , [::1],, tutor.local")
    clean_env.setenv("MOMMY_ASR_THREADS", "2")
    clean_env.setenv("ANTHROPIC_API_KEY", "not-a-real-key")
    clean_env.setenv("MOMMY_VISION_MODEL", "test-vision-model")
    clean_env.setenv("MOMMY_TEXT_MODEL", "test-text-model")
    clean_env.setenv("MOMMY_EFFORT", "medium")
    s = load_settings(tmp_path)
    assert s.root == tmp_path.resolve()
    assert s.models_dir == tmp_path.resolve() / "models"
    assert (s.asr_model, s.asr_threads, s.effort) == ("small", 2, "medium")
    assert s.allowed_hosts == ("tutor.local", "::1")
    assert s.anthropic_api_key_set is True
    assert (s.vision_model, s.text_model) == ("test-vision-model", "test-text-model")
    assert s.claude_configured is True
    # The key itself is never stored.
    assert "not-a-real-key" not in repr(s)


def test_settings_blank_values_count_as_unset(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("ANTHROPIC_API_KEY", "   ")
    clean_env.setenv("MOMMY_VISION_MODEL", "")
    clean_env.setenv("MOMMY_TEXT_MODEL", "test-text-model")
    clean_env.setenv("MOMMY_EFFORT", " ")
    s = load_settings()
    assert s.anthropic_api_key_set is False and s.vision_model is None
    assert s.effort == "low"
    assert s.claude_configured is False


def test_settings_partially_configured_claude_is_offline(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("ANTHROPIC_API_KEY", "not-a-real-key")
    clean_env.setenv("MOMMY_VISION_MODEL", "test-vision-model")
    assert load_settings().claude_configured is False


@pytest.mark.parametrize(
    "name,value",
    [
        ("MOMMY_ASR_MODEL", "large"),
        ("MOMMY_ASR_THREADS", "four"),
        ("MOMMY_ASR_THREADS", "0"),
        ("MOMMY_EFFORT", "extreme"),
        ("MOMMY_ALLOWED_HOSTS", " , ,"),
        ("MOMMY_LIVE_RECITE", "maybe"),
        ("MOMMY_LIVE_ASR_MODEL", "turbo"),
        ("MOMMY_LIVE_ASR_MODEL", "parakeet"),
    ],
)
def test_settings_invalid_values(clean_env: pytest.MonkeyPatch, name: str, value: str) -> None:
    clean_env.setenv(name, value)
    with pytest.raises(ValueError):
        load_settings()


@pytest.mark.parametrize(
    ("value", "on"),
    [("off", False), ("OFF", False), ("0", False), ("false", False), ("no", False),
     ("on", True), ("1", True), ("True", True), ("yes", True), ("  ", True), ("", True)],
)
def test_settings_live_recite_switch(clean_env: pytest.MonkeyPatch, value: str, on: bool) -> None:
    clean_env.setenv("MOMMY_LIVE_RECITE", value)
    assert load_settings().live_recite is on


@pytest.mark.parametrize(("value", "model"), [("whisper", "whisper"), (" Whisper ", "whisper"), ("AUTO", "auto"), ("", "auto")])
def test_settings_live_asr_model(clean_env: pytest.MonkeyPatch, value: str, model: str) -> None:
    clean_env.setenv("MOMMY_LIVE_ASR_MODEL", value)
    assert load_settings().live_asr_model == model


def test_settings_is_frozen(clean_env: pytest.MonkeyPatch) -> None:
    s = load_settings()
    assert isinstance(s, Settings)
    with pytest.raises(Exception):
        s.effort = "high"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Feedback that matches the result (several mistakes, stopping early, unclear input)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("age", AGE_BANDS)
@pytest.mark.parametrize("kind", KINDS)
def test_several_mistakes_are_not_worded_as_one(lang: str, age: str, kind: str) -> None:
    one = point_out(lang, age, WORDS[lang], kind)
    several = point_out(lang, age, WORDS[lang], kind, n_errors=3)
    assert one != several
    if kind != "ins":
        assert WORDS[lang] in several
    assert point_out(lang, age, "", kind, n_errors=2) != point_out(lang, age, "", kind)
    singular = {
        "en": r"\b(one word|a word was|you skipped a word)\b",
        "fr": r"\bun mot (était|n'était)|il manquait un mot|tu as sauté un mot",
        "ar": "كلمة واحدة|هناك كلمة مختلفة|سقطت كلمة|نقصت كلمة|هربت كلمة",
    }[lang]
    assert not re.search(singular, strip_tashkeel(several), re.I), several


@pytest.mark.parametrize(
    ("lang", "expected", "heard", "first"),
    [
        ("en", "The little cat sat on the warm mat near the door.", "The little dog sat on the mat near the door.", "cat"),
        ("fr", "Le petit chat dort sur le tapis rouge.", "Le petit chien dort sur le tapis.", "chat"),
        ("ar", "ذهب الولد الصغير إلى المدرسة في الصباح الباكر", "ذهب البنت الصغير إلى المدرسة في الصباح", "الولد"),
    ],
)
@pytest.mark.parametrize("age", AGE_BANDS)
def test_for_result_with_two_mistakes_uses_the_plural(lang: str, expected: str, heard: str, first: str, age: str) -> None:
    # Regression: "One word was different" was shown with a score of 9 of 11.
    r = check_recitation(expected, heard, lang)
    assert r.n_errors == 2 and r.verdict == "mistakes"
    for form in (lambda x: x, asdict, result_summary):
        text = for_result(form(r), lang, age)
        assert text == point_out(lang, age, first, "sub", n_errors=2)


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("age", AGE_BANDS)
def test_partial_reading_is_told_where_it_stopped_not_to_speak_louder(lang: str, age: str) -> None:
    # Regression: a clear but partial reading got "that was hard to hear, say it louder".
    expected = {
        "en": "The little cat sat on the warm mat near the door.",
        "fr": "Le petit chat dort sur le tapis près de la porte.",
        "ar": "جلس القط الصغير على البساط الدافئ قرب الباب",
    }[lang]
    heard = " ".join(expected.split()[:3])
    r = check_recitation(expected, heard, lang)
    nxt = expected.split()[3]
    for form in (lambda x: x, asdict, result_summary):
        text = for_result(form(r), lang, age)
        assert text == feedback.stopped(lang, age, nxt)
        assert text != say_again(lang, age)


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("age", AGE_BANDS)
def test_unreliable_but_audible_speech_is_not_told_to_speak_louder(lang: str, age: str) -> None:
    r = check_recitation("one two three four five", "alpha beta gamma delta epsilon", "en")
    assert r.say_again_reason == "error_rate"
    text = for_result(r, lang, age)
    assert text == say_again(lang, age, "error_rate") != say_again(lang, age)
    assert for_result(check_recitation("one two", "", "en"), lang, age) == say_again(lang, age)


@pytest.mark.parametrize("lang", LANGS)
def test_dictation_feedback(lang: str) -> None:
    from mommy.align import check_writing

    nothing = check_writing("le chat dort", "  ", "fr")
    assert for_result(nothing, lang, "6-9", activity="dictation") == say_again(lang, "6-9", "nothing_written")
    only_unreadable = check_writing("le chat dort", "le [?] dort", "fr")
    assert for_result(only_unreadable, lang, "6-9") == feedback.unreadable(lang, "6-9")
    assert for_result(result_summary(only_unreadable), lang, "6-9") == feedback.unreadable(lang, "6-9")
    # An unreadable word is never pointed out; the real mistake after it is.
    mixed = check_writing("le chat dort sur le tapis", "le [?] dor sur le tapis", "fr")
    assert for_result(mixed, lang, "6-9") == point_out(lang, "6-9", "dort", "sub")


# ---------------------------------------------------------------------------
# A mistake in a Quran part of a school text
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("lang", ["ar", "en", "fr"])
@pytest.mark.parametrize("activity", ["recitation", "dictation"])
def test_quran_part_feedback_quotes_only_the_mushaf_word(quran_dir: Path, lang: str, activity: str) -> None:
    from mommy.feedback import quran_part_feedback

    line = next(
        l for l in (quran_dir / "quran-uthmani.txt").read_text(encoding="utf-8").splitlines() if l.startswith("2|255|")
    )
    word = line.split("|")[2].split()[6]
    for kind in ("sub", "del", "ins", "stopped", "mistakes"):
        msg = quran_part_feedback(kind, word, lang, activity)
        assert msg.count(word) == 1, (kind, msg)
        rest = msg.replace(word, "")
        assert not any(w in rest for w in line.split("|")[2].split() if len(strip_tashkeel(w)) > 2), msg
    assert word not in quran_part_feedback("sub", None, lang, activity)
    with pytest.raises(ValueError):
        quran_part_feedback("correct", word, lang, activity)
    with pytest.raises(ValueError):
        quran_part_feedback("sub", word, lang, "reading")
    with pytest.raises(ValueError):
        quran_part_feedback("sub", word, "de", activity)  # type: ignore[arg-type]


def test_quran_part_feedback_is_respectful_and_neutral() -> None:
    from mommy.feedback import _QURAN_PART

    gendered = re.compile(r"(^|\s)(أعد|أعيدي|انتبه|انتبهي|اقرأ|اقرئي|اتل|اتلي|اكتب|اكتبي)(\s|[،.!؟:]|$)")
    for activity, templates in _QURAN_PART["ar"].items():
        for kind, template in templates.items():
            text = strip_tashkeel(template.replace("{word}", "كلمة"))
            assert not gendered.search(text), (activity, kind)
            assert not re.search(r"\w(ك|كِ|كَ)(\s|[،.!؟:»]|$)", template.replace("{word}", "")), (activity, kind)
            assert "الآية الكريمة" in text or kind == "stopped", (activity, kind)
    for lang in ("en", "fr"):
        for templates in _QURAN_PART[lang].values():
            for kind, template in templates.items():
                assert "noble" in template or kind == "stopped", (lang, kind)
    # French addressed to the child stays gender-neutral (no "tu es prêt(e)", "content(e)").
    for template in (t for v in _QURAN_PART["fr"].values() for t in v.values()):
        assert "tu " not in template.lower() and "(e)" not in template
