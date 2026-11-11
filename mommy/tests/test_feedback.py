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
from mommy.textnorm import has_arabic

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
            out.append((lang, say_again(lang, age)))
            for kind in KINDS:
                out.append((lang, point_out(lang, age, WORDS[lang], kind)))
                out.append((lang, point_out(lang, age, "", kind)))
    return out


# ---------------------------------------------------------------------------
# Children's templates
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("age", AGE_BANDS)
def test_every_template_exists_and_is_short(lang: str, age: str) -> None:
    messages = [praise(lang, age), say_again(lang, age)] + [
        point_out(lang, age, WORDS[lang], k) for k in KINDS
    ]
    for m in messages:
        assert m.strip() == m and m
        assert len(m) <= 120
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
        assert not FIRST_PERSON[lang].search(msg), msg


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


def test_arabic_avoids_gendered_imperatives_in_children_templates() -> None:
    # Imperatives such as أعد/أعيدي, حاول/حاولي, اسمع/اسمعي are gendered; the children's
    # templates use neutral forms.
    gendered = re.compile(r"(^|\s)(أعد|أعيدي|حاول|حاولي|اسمع|اسمعي|استمع|استمعي|انتبه|انتبهي)(\s|[،.!؟]|$)")
    for lang, msg in all_messages():
        if lang == "ar":
            assert not gendered.search(msg), msg


# ---------------------------------------------------------------------------
# Quran
# ---------------------------------------------------------------------------


def test_quran_contract_examples() -> None:
    assert quran_feedback("correct", None).startswith("أحسنت")
    assert quran_feedback("sub", "كلمة") == "انتبه: «كلمة»"
    assert quran_feedback("mistakes", "كلمة") == "انتبه: «كلمة»"
    assert quran_feedback("unclear", None).startswith("أعد التلاوة من فضلك")


@pytest.mark.parametrize("kind", ["correct", "mistakes", "mistake", "sub", "del", "ins", "unclear"])
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
    for kind in ("sub", "del", "ins", "mistakes"):
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
    assert (s.asr_model, s.asr_threads, s.effort) == ("small", 4, "low")
    assert s.anthropic_api_key_set is False
    assert s.vision_model is None and s.text_model is None
    assert s.claude_configured is False
    assert (s.quran_dir / "quran-uthmani.txt").is_file()


def test_settings_from_environment(clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    clean_env.setenv("MOMMY_ASR_MODEL", "Turbo")
    clean_env.setenv("MOMMY_ASR_THREADS", "2")
    clean_env.setenv("ANTHROPIC_API_KEY", "not-a-real-key")
    clean_env.setenv("MOMMY_VISION_MODEL", "test-vision-model")
    clean_env.setenv("MOMMY_TEXT_MODEL", "test-text-model")
    clean_env.setenv("MOMMY_EFFORT", "medium")
    s = load_settings(tmp_path)
    assert s.root == tmp_path.resolve()
    assert s.models_dir == tmp_path.resolve() / "models"
    assert (s.asr_model, s.asr_threads, s.effort) == ("turbo", 2, "medium")
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
    ],
)
def test_settings_invalid_values(clean_env: pytest.MonkeyPatch, name: str, value: str) -> None:
    clean_env.setenv(name, value)
    with pytest.raises(ValueError):
        load_settings()


def test_settings_is_frozen(clean_env: pytest.MonkeyPatch) -> None:
    s = load_settings()
    assert isinstance(s, Settings)
    with pytest.raises(Exception):
        s.effort = "high"  # type: ignore[misc]
