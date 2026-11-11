"""Tests for mommy.llm: ClaudeBrain (with a fake client), OfflineBrain and make_brain.

No test talks to the network: ClaudeBrain always gets a fake client, and an autouse
fixture makes any socket connection fail. Model names are obviously fake.
"""

from __future__ import annotations

import base64
import inspect
import json
import logging
import re
import socket
from dataclasses import asdict, replace
from pathlib import Path
from typing import Any

import anthropic
import httpx2
import pytest
from anthropic.types import Message

from mommy import feedback, llm
from mommy.align import check_recitation, check_writing, result_summary
from mommy.config import Settings, load_settings
from mommy.feedback import AGE_BANDS
from mommy.llm import (
    FEEDBACK_SCHEMA,
    HANDWRITING_SCHEMA,
    MAX_FEEDBACK_CHARS,
    MAX_TOKENS_TEXT,
    MAX_TOKENS_VISION,
    MEANING_SCHEMA,
    PAGE_SCHEMA,
    Brain,
    ClaudeBrain,
    OfflineBrain,
    compact_summary,
    make_brain,
    meaning_feedback,
    meaning_overlap,
)
from mommy.llm import _MEANING_TEMPLATES
from mommy.textnorm import has_arabic

LANGS = ("ar", "en", "fr")
VISION_MODEL = "test-vision-model"
TEXT_MODEL = "test-text-model"
REQUEST_ID = "req_test_0001"

# A JPEG-looking payload with a marker, to prove image bytes never reach the logs.
JPEG = b"\xff\xd8\xff\xe0" + b"SECRET-IMAGE-BYTES" * 8
JPEG_B64 = base64.standard_b64encode(JPEG).decode("ascii")
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16

# Only these request parameters may be sent (docs/CONTRACT.md, hard rule 7).
ALLOWED_REQUEST_KEYS = {"model", "max_tokens", "system", "messages", "output_config"}
FORBIDDEN_KEYS = {"temperature", "top_p", "top_k", "thinking", "budget_tokens"}
UNSUPPORTED_SCHEMA_KEYS = {"minLength", "maxLength", "minimum", "maximum", "multipleOf", "pattern"}

FIRST_PERSON = {
    "en": re.compile(r"\b(i|i'm|i've|me|my|mine|we|us|our|let's|mom|mommy|mum|mother|dad)\b", re.I),
    "fr": re.compile(r"\b(je|j'|moi|mon|ma|mes|nous|notre|on|maman|mère|papa)\b", re.I),
    "ar": re.compile(r"(أنا|إني|إنني|نحن|ماما|أمك|أمي|والدتك|بابا)"),
}


# ---------------------------------------------------------------------------
# Fakes and fixtures
# ---------------------------------------------------------------------------


class FakeMessages:
    """Records every ``create`` call and returns (or raises) the queued replies in order."""

    def __init__(self, replies: list[Any]) -> None:
        self.replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if not self.replies:
            raise AssertionError("unexpected API call")
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return reply


class FakeClient:
    def __init__(self, *replies: Any) -> None:
        self.messages = FakeMessages(list(replies))

    @property
    def calls(self) -> list[dict[str, Any]]:
        return self.messages.calls


def reply(
    payload: Any,
    *,
    stop_reason: str = "end_turn",
    thinking: bool = True,
    request_id: str = REQUEST_ID,
    model: str = TEXT_MODEL,
    extra_text: str | None = None,
) -> Message:
    """A real SDK Message: an (empty) thinking block, then the text block with the JSON."""
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    content: list[dict[str, Any]] = []
    if thinking:
        content.append({"type": "thinking", "thinking": "", "signature": "sig"})
    content.append({"type": "text", "text": text})
    if extra_text is not None:
        content.append({"type": "text", "text": extra_text})
    message = Message(
        id="msg_test",
        type="message",
        role="assistant",
        model=model,
        content=content,
        stop_reason=stop_reason,
        stop_details={"type": "refusal", "category": None, "explanation": None} if stop_reason == "refusal" else None,
        usage={"input_tokens": 123, "output_tokens": 45},
    )
    message._request_id = request_id
    return message


def thinking_only() -> Message:
    message = reply("{}")
    message.content = [message.content[0]]
    return message


REQ = httpx2.Request("POST", "https://api.example.invalid/v1/messages")


def status_error(cls: type[anthropic.APIStatusError], status: int) -> anthropic.APIStatusError:
    response = httpx2.Response(status, request=REQ, headers={"request-id": "req_err_1"})
    body = {"type": "error", "error": {"type": "api_error", "message": "SECRET-ERROR-DETAIL"}}
    return cls("SECRET-ERROR-DETAIL", response=response, body=body)


def api_errors() -> list[BaseException]:
    return [
        status_error(anthropic.BadRequestError, 400),
        status_error(anthropic.AuthenticationError, 401),
        status_error(anthropic.PermissionDeniedError, 403),
        status_error(anthropic.NotFoundError, 404),
        status_error(anthropic.RateLimitError, 429),
        status_error(anthropic.InternalServerError, 500),
        status_error(anthropic.OverloadedError, 529),
        anthropic.APIConnectionError(request=REQ),
        anthropic.APITimeoutError(request=REQ),
        anthropic.APIResponseValidationError(httpx2.Response(200, request=REQ), body=None),
        anthropic.CredentialsError("SECRET-ERROR-DETAIL"),
    ]


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("tests must not open network connections")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


@pytest.fixture(autouse=True)
def restore_sdk_log_levels():
    """ClaudeBrain caps the SDK loggers; put them back after each test."""
    names = ("anthropic", "httpx2", "httpcore2")
    saved = {name: logging.getLogger(name).level for name in names}
    yield
    for name, level in saved.items():
        logging.getLogger(name).setLevel(level)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        root=tmp_path,
        models_dir=tmp_path / "models",
        quran_dir=tmp_path / "data" / "quran",
        web_dir=tmp_path / "web",
        asr_model="small",
        asr_threads=1,
        anthropic_api_key_set=True,
        vision_model=VISION_MODEL,
        text_model=TEXT_MODEL,
        effort="low",
    )


def brain_with(settings: Settings, *replies: Any) -> tuple[ClaudeBrain, FakeClient]:
    client = FakeClient(*replies)
    return ClaudeBrain(settings, client=client), client


PAGE_REPLY = {"lang": "ar", "text": "ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ.", "notes": "", "contains_quran": False}
HANDWRITING_REPLY = {"text": "the kat sat on the mat", "uncertain_words": ["kat"], "legible": True}
MEANING_REPLY = {
    "missing_ideas": ["the cat was in the garden"],
    "wrong_ideas": [],
    "verdict": "partly",
    "feedback": "Good try! Remember where the cat was playing.",
}


def mistakes_summary(lang: str = "en") -> dict:
    expected = {"en": "the cat sat on the mat", "fr": "le chat est sur le tapis", "ar": "ذهب الولد إلى المدرسة"}[lang]
    heard = {"en": "the dog sat on the mat", "fr": "le chien est sur le tapis", "ar": "ذهب البنت إلى المدرسة"}[lang]
    return result_summary(check_recitation(expected, heard, lang))


# ---------------------------------------------------------------------------
# Request shape
# ---------------------------------------------------------------------------


def walk_keys(value: Any):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from walk_keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_keys(item)


def check_schema(schema: dict) -> None:
    """Every object is closed and requires all its properties; no unsupported keywords."""
    assert not UNSUPPORTED_SCHEMA_KEYS & set(walk_keys(schema))
    stack = [schema]
    while stack:
        node = stack.pop()
        if node.get("type") == "object":
            assert node["additionalProperties"] is False
            assert set(node["required"]) == set(node["properties"])
            stack.extend(node["properties"].values())
        elif node.get("type") == "array":
            stack.append(node["items"])


def assert_clean_request(kwargs: dict, *, model: str, max_tokens: int, schema: dict, effort: str = "low") -> None:
    assert set(kwargs) == ALLOWED_REQUEST_KEYS
    assert not FORBIDDEN_KEYS & set(walk_keys(kwargs))
    assert kwargs["model"] == model
    assert kwargs["max_tokens"] == max_tokens
    assert kwargs["output_config"] == {"effort": effort, "format": {"type": "json_schema", "schema": schema}}
    check_schema(kwargs["output_config"]["format"]["schema"])
    system = kwargs["system"]
    assert "children aged 6 to 18" in system
    assert "AI tutor" in system and "Never claim" in system and "mother" in system
    assert len(kwargs["messages"]) == 1 and kwargs["messages"][0]["role"] == "user"


@pytest.mark.parametrize("schema", [PAGE_SCHEMA, HANDWRITING_SCHEMA, MEANING_SCHEMA, FEEDBACK_SCHEMA])
def test_schemas_are_closed_and_supported(schema: dict) -> None:
    check_schema(schema)


def test_read_page_request(settings: Settings) -> None:
    brain, client = brain_with(settings, reply(PAGE_REPLY, model=VISION_MODEL))
    brain.read_page(JPEG, "ar")
    (kwargs,) = client.calls
    assert_clean_request(kwargs, model=VISION_MODEL, max_tokens=MAX_TOKENS_VISION, schema=PAGE_SCHEMA)
    assert MAX_TOKENS_VISION == 16000
    image, text = kwargs["messages"][0]["content"]
    assert image == {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": JPEG_B64}}
    assert text["type"] == "text" and "Arabic (ar)" in text["text"]
    system = kwargs["system"].lower()
    for phrase in ("exactly as printed", "tashkeel", "do not correct", "[?]", "page numbers", "notes"):
        assert phrase in system


def test_read_page_request_without_hint(settings: Settings) -> None:
    brain, client = brain_with(settings, reply(PAGE_REPLY))
    brain.read_page(JPEG, None)
    assert "No language hint" in client.calls[0]["messages"][0]["content"][1]["text"]


def test_effort_comes_from_settings(settings: Settings) -> None:
    brain, client = brain_with(replace(settings, effort="medium"), reply(MEANING_REPLY))
    brain.judge_meaning("The cat played in the garden.", "The cat played.", "en", "6-9")
    assert client.calls[0]["output_config"]["effort"] == "medium"


@pytest.mark.parametrize(
    ("data", "media_type"),
    [(PNG, "image/png"), (b"GIF89a" + b"\x00" * 8, "image/gif"), (b"RIFF\x00\x00\x00\x00WEBPVP8 ", "image/webp")],
)
def test_image_media_type_is_sniffed(settings: Settings, data: bytes, media_type: str) -> None:
    brain, client = brain_with(settings, reply(PAGE_REPLY))
    brain.read_page(data, None)
    assert client.calls[0]["messages"][0]["content"][0]["source"]["media_type"] == media_type


def test_read_handwriting_request_is_blind(settings: Settings) -> None:
    brain, client = brain_with(settings, reply(MEANING_REPLY), reply(HANDWRITING_REPLY, model=VISION_MODEL))
    # An earlier call carries an expected text; it must not leak into the handwriting call.
    brain.judge_meaning("SECRET-EXPECTED a rabbit ran home", "a rabbit ran home", "en", "10-13")
    brain.read_handwriting(JPEG, "en")
    kwargs = client.calls[1]
    assert_clean_request(kwargs, model=VISION_MODEL, max_tokens=MAX_TOKENS_VISION, schema=HANDWRITING_SCHEMA)
    dumped = json.dumps(kwargs, ensure_ascii=False)
    assert "SECRET-EXPECTED" not in dumped and "rabbit" not in dumped
    image, text = kwargs["messages"][0]["content"]
    assert image["type"] == "image" and image["source"]["data"] == JPEG_B64
    assert text == {
        "type": "text",
        "text": "The child wrote this dictation in English (en). "
        "Transcribe the handwriting exactly as written, keeping every mistake.",
    }
    system = kwargs["system"]
    assert "Do NOT correct spelling" in system
    assert "deliberately not told what the child was supposed to write" in system
    for phrase in ("misspellings", "hamza", "missing or extra dots", "reversed", "[?]", "uncertain_words", "legible"):
        assert phrase in system


@pytest.mark.parametrize("cls", [Brain, ClaudeBrain, OfflineBrain])
def test_read_handwriting_takes_no_expected_text(cls: type) -> None:
    params = list(inspect.signature(cls.read_handwriting).parameters)
    assert params == ["self", "image_jpeg", "lang"]


def test_judge_meaning_request(settings: Settings) -> None:
    brain, client = brain_with(settings, reply(MEANING_REPLY))
    brain.judge_meaning("Le chat joue dans le jardin.", "Le chat joue.", "fr", "10-13")
    (kwargs,) = client.calls
    assert_clean_request(kwargs, model=TEXT_MODEL, max_tokens=MAX_TOKENS_TEXT, schema=MEANING_SCHEMA)
    assert MAX_TOKENS_TEXT == 4000
    (block,) = kwargs["messages"][0]["content"]
    assert block["type"] == "text"
    assert "French (fr)" in block["text"] and "Age band: 10-13" in block["text"]
    assert "<expected_text>\nLe chat joue dans le jardin.\n</expected_text>" in block["text"]
    assert "<heard_text>\nLe chat joue.\n</heard_text>" in block["text"]
    system = kwargs["system"]
    for phrase in ("lenient about wording", "strict about meaning", "missing_ideas", "wrong_ideas", '"6-9"', '"14-18"'):
        assert phrase in system


def test_word_feedback_request(settings: Settings) -> None:
    summary = {**mistakes_summary("en"), "activity": "recitation"}
    brain, client = brain_with(settings, reply({"feedback": 'So close! The word is "cat".'}))
    brain.word_feedback(summary, "en", "6-9")
    (kwargs,) = client.calls
    assert_clean_request(kwargs, model=TEXT_MODEL, max_tokens=MAX_TOKENS_TEXT, schema=FEEDBACK_SCHEMA)
    text = kwargs["messages"][0]["content"][0]["text"]
    sent = json.loads(text.split("<result_summary>\n")[1].split("\n</result_summary>")[0])
    assert sent == compact_summary(summary)
    assert sent["verdict"] == "mistakes" and sent["activity"] == "recitation"
    assert sent["errors"][0] == {"kind": "sub", "expected": "cat", "heard": "dog"}
    assert "Never contradict or change the verdict" in kwargs["system"]


# ---------------------------------------------------------------------------
# Parsing successful replies
# ---------------------------------------------------------------------------


def test_read_page_keeps_text_exactly(settings: Settings) -> None:
    printed = "ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ، وَقَرَأَ الدَّرْسَ.\n\nثُمَّ عَادَ إِلَى البَيْتِ؟"
    data = {"lang": "ar", "text": "  " + printed + "\n", "notes": "Page number left out.", "contains_quran": False}
    brain, _ = brain_with(settings, reply(data))
    assert brain.read_page(JPEG, None) == {
        "text": printed,
        "lang": "ar",
        "notes": "Page number left out.",
        "contains_quran": False,
        "needs_manual": False,
    }


def test_read_page_empty_text_needs_manual(settings: Settings) -> None:
    brain, _ = brain_with(settings, reply({**PAGE_REPLY, "text": "", "notes": "No text visible."}))
    result = brain.read_page(JPEG, "en")
    assert result["needs_manual"] is True and "error" not in result


def test_read_page_flags_quran(settings: Settings) -> None:
    brain, _ = brain_with(settings, reply({**PAGE_REPLY, "contains_quran": True}))
    assert brain.read_page(JPEG, "ar")["contains_quran"] is True


def test_read_handwriting_keeps_mistakes(settings: Settings) -> None:
    data = {"text": "l'ecole est fermé\nil fé beau", "uncertain_words": [" fé ", "fé", "", "fermé"], "legible": True}
    brain, _ = brain_with(settings, reply(data))
    assert brain.read_handwriting(JPEG, "fr") == {
        "text": "l'ecole est fermé\nil fé beau",
        "uncertain_words": ["fé", "fermé"],
        "legible": True,
        "needs_manual": False,
    }


def test_read_handwriting_illegible(settings: Settings) -> None:
    brain, _ = brain_with(settings, reply({"text": "", "uncertain_words": [], "legible": False}))
    result = brain.read_handwriting(JPEG, "ar")
    assert result["legible"] is False and result["needs_manual"] is True and "error" not in result


def test_judge_meaning_result(settings: Settings) -> None:
    brain, _ = brain_with(settings, reply(MEANING_REPLY))
    result = brain.judge_meaning("The cat played in the garden.", "The cat played.", "en", "6-9")
    assert result == {
        "verdict": "partly",
        "missing_ideas": ["the cat was in the garden"],
        "wrong_ideas": [],
        "feedback": "Good try! Remember where the cat was playing.",
    }


def test_judge_meaning_long_feedback_uses_template(settings: Settings) -> None:
    long = "Good. " * (MAX_FEEDBACK_CHARS // 5)
    brain, _ = brain_with(settings, reply({**MEANING_REPLY, "feedback": long}))
    result = brain.judge_meaning("The cat played in the garden.", "The cat played.", "en", "6-9")
    assert result["verdict"] == "partly"
    assert result["feedback"] == meaning_feedback("partly", ["the cat was in the garden"], "en", "6-9")


def test_judge_meaning_empty_heard_skips_the_api(settings: Settings) -> None:
    brain, client = brain_with(settings)
    result = brain.judge_meaning("The cat played in the garden.", "  ", "en", "6-9")
    assert client.calls == []
    assert result["verdict"] == "different" and result["approximate"] is True
    assert result["feedback"] == feedback.say_again("en", "6-9")
    assert "error" not in result


def test_word_feedback_returns_model_text(settings: Settings) -> None:
    brain, _ = brain_with(settings, reply({"feedback": "  So close!  The word is «cat».  "}))
    assert brain.word_feedback(mistakes_summary("en"), "en", "6-9") == "So close! The word is «cat»."


def test_word_feedback_correct_verdict(settings: Settings) -> None:
    summary = result_summary(check_recitation("le chat dort", "le chat dort", "fr"))
    brain, _ = brain_with(settings, reply({"feedback": "Bravo, tout est juste !"}))
    assert brain.word_feedback(summary, "fr", "10-13") == "Bravo, tout est juste !"


def test_word_feedback_arabic_word_with_tashkeel(settings: Settings) -> None:
    summary = result_summary(check_writing("ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ", "ذهب الولد إلى المدرسه", "ar"))
    brain, _ = brain_with(settings, reply({"feedback": "اقتربت! انتبه لكلمة «المدرسة»."}))
    assert brain.word_feedback(summary, "ar", "10-13") == "اقتربت! انتبه لكلمة «المدرسة»."


def test_word_feedback_must_quote_first_error(settings: Settings) -> None:
    summary = mistakes_summary("en")
    brain, _ = brain_with(settings, reply({"feedback": "Everything was right, well done!"}))
    assert brain.word_feedback(summary, "en", "6-9") == feedback.for_result(summary, "en", "6-9")


def test_word_feedback_too_long_uses_template(settings: Settings) -> None:
    summary = mistakes_summary("en")
    brain, _ = brain_with(settings, reply({"feedback": "cat " * 100}))
    assert brain.word_feedback(summary, "en", "6-9") == feedback.for_result(summary, "en", "6-9")


@pytest.mark.parametrize("change", [{"verdict": "unclear"}, {"say_again": True}])
def test_word_feedback_unclear_skips_the_api(settings: Settings, change: dict) -> None:
    summary = {**mistakes_summary("en"), **change}
    brain, client = brain_with(settings)
    assert brain.word_feedback(summary, "en", "14-18") == feedback.say_again("en", "14-18")
    assert client.calls == []


def test_word_feedback_accepts_asdict_result(settings: Settings) -> None:
    result = asdict(check_recitation("the cat sat", "the dog sat", "en"))
    brain, client = brain_with(settings, reply({"feedback": 'Almost! The word is "cat".'}))
    assert brain.word_feedback(result, "en", "6-9") == 'Almost! The word is "cat".'
    text = client.calls[0]["messages"][0]["content"][0]["text"]
    assert '"ops"' not in text and '"expected": "cat"' in text


def test_compact_summary_drops_unknown_keys() -> None:
    summary = {**mistakes_summary("en"), "secret": "x", "activity": "painting"}
    compact = compact_summary(summary)
    assert set(compact) == {"verdict", "n_expected", "n_errors", "word_accuracy", "errors"}


def test_first_text_block_is_parsed(settings: Settings) -> None:
    message = reply(PAGE_REPLY, extra_text="not json")
    brain, _ = brain_with(settings, message)
    assert brain.read_page(JPEG, "ar")["text"] == PAGE_REPLY["text"]


# ---------------------------------------------------------------------------
# Failures fall back to the offline behaviour
# ---------------------------------------------------------------------------


def run_all(brain: ClaudeBrain) -> dict[str, Any]:
    return {
        "read_page": brain.read_page(JPEG, "fr"),
        "read_handwriting": brain.read_handwriting(JPEG, "fr"),
        "judge_meaning": brain.judge_meaning("Le chat joue dans le jardin.", "Le chat joue.", "fr", "6-9"),
        "word_feedback": brain.word_feedback(mistakes_summary("fr"), "fr", "6-9"),
    }


def assert_fallbacks(results: dict[str, Any], code: str) -> None:
    offline = OfflineBrain()
    assert results["read_page"] == {**offline.read_page(JPEG, "fr"), "error": code}
    assert results["read_page"]["needs_manual"] is True and results["read_page"]["text"] == ""
    assert results["read_handwriting"] == {**offline.read_handwriting(JPEG, "fr"), "error": code}
    expected_meaning = offline.judge_meaning("Le chat joue dans le jardin.", "Le chat joue.", "fr", "6-9")
    assert results["judge_meaning"] == {**expected_meaning, "error": code}
    assert results["judge_meaning"]["approximate"] is True
    assert results["word_feedback"] == feedback.for_result(mistakes_summary("fr"), "fr", "6-9")


@pytest.mark.parametrize("error", api_errors(), ids=lambda e: type(e).__name__)
def test_api_errors_fall_back(settings: Settings, error: BaseException) -> None:
    brain, client = brain_with(settings, error, error, error, error)
    results = run_all(brain)
    assert len(client.calls) == 4
    assert_fallbacks(results, type(error).__name__)


@pytest.mark.parametrize(
    ("make_reply", "code"),
    [
        (lambda: reply("{}", stop_reason="refusal"), "refusal"),
        (lambda: reply('{"text": "trunc', stop_reason="max_tokens"), "max_tokens"),
        (lambda: reply("this is not JSON {"), "JSONDecodeError"),
        (lambda: reply("[1, 2]"), "invalid_output"),
        (lambda: reply({"unexpected": True}), "invalid_output"),
        (thinking_only, "invalid_output"),
    ],
    ids=["refusal", "max_tokens", "bad_json", "json_list", "wrong_keys", "no_text_block"],
)
def test_unusable_replies_fall_back(settings: Settings, make_reply, code: str) -> None:
    brain, _ = brain_with(settings, *(make_reply() for _ in range(4)))
    assert_fallbacks(run_all(brain), code)


@pytest.mark.parametrize(
    ("method", "args", "bad"),
    [
        ("read_page", (JPEG, None), {**PAGE_REPLY, "lang": "de"}),
        ("read_page", (JPEG, None), {**PAGE_REPLY, "contains_quran": "no"}),
        ("read_handwriting", (JPEG, "en"), {**HANDWRITING_REPLY, "legible": "yes"}),
        ("read_handwriting", (JPEG, "en"), {**HANDWRITING_REPLY, "uncertain_words": "kat"}),
        ("judge_meaning", ("a b c", "a b", "en", "6-9"), {**MEANING_REPLY, "verdict": "great"}),
        ("judge_meaning", ("a b c", "a b", "en", "6-9"), {**MEANING_REPLY, "missing_ideas": [1, 2]}),
    ],
)
def test_wrong_types_fall_back(settings: Settings, method: str, args: tuple, bad: dict) -> None:
    brain, _ = brain_with(settings, reply(bad))
    assert getattr(brain, method)(*args)["error"] == "invalid_output"


# ---------------------------------------------------------------------------
# Logging: metadata only, never content
# ---------------------------------------------------------------------------

SECRETS = ("SECRET-IMAGE-BYTES", JPEG_B64[:24], "SECRET-EXPECTED", "SECRET-HEARD", "SECRET-OUTPUT", "SECRET-ERROR-DETAIL")


def assert_no_secrets(caplog: pytest.LogCaptureFixture) -> None:
    for record in caplog.records:
        rendered = record.getMessage() + repr(record.args) + str(record.exc_info)
        for secret in SECRETS:
            assert secret not in rendered, (secret, rendered)


def test_logs_metadata_not_content(settings: Settings, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    summary = result_summary(check_recitation("SECRET-EXPECTED cat", "SECRET-HEARD cat", "en"))
    brain, _ = brain_with(
        settings,
        reply({**PAGE_REPLY, "text": "SECRET-OUTPUT", "notes": "SECRET-OUTPUT"}),
        reply({"text": "SECRET-OUTPUT", "uncertain_words": ["SECRET-OUTPUT"], "legible": True}),
        reply({**MEANING_REPLY, "feedback": "SECRET-OUTPUT " * 80}),  # also triggers a warning
        reply({"feedback": "SECRET-OUTPUT"}),
    )
    brain.read_page(JPEG, "en")
    brain.read_handwriting(JPEG, "en")
    brain.judge_meaning("SECRET-EXPECTED a rabbit", "SECRET-HEARD a rabbit", "en", "6-9")
    brain.word_feedback(summary, "en", "6-9")
    assert_no_secrets(caplog)
    text = caplog.text
    assert text.count(REQUEST_ID) == 4
    assert "input_tokens=123" in text and "output_tokens=45" in text and "latency_ms=" in text
    assert f"image_bytes={len(JPEG)}" in text


def test_error_logs_have_no_content(settings: Settings, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    error = status_error(anthropic.RateLimitError, 429)
    brain, _ = brain_with(settings, error, reply("SECRET-OUTPUT not json"), reply("{}", stop_reason="refusal"))
    brain.read_page(JPEG, "en")
    brain.judge_meaning("SECRET-EXPECTED a rabbit", "SECRET-HEARD a rabbit", "en", "6-9")
    brain.read_handwriting(JPEG, "en")
    assert_no_secrets(caplog)
    assert "RateLimitError" in caplog.text and "req_err_1" in caplog.text and "status=429" in caplog.text
    assert "JSONDecodeError" in caplog.text and "refused" in caplog.text


@pytest.mark.parametrize("anthropic_level", [logging.DEBUG, logging.NOTSET])
def test_sdk_debug_logging_is_capped(settings: Settings, caplog: pytest.LogCaptureFixture, anthropic_level: int) -> None:
    caplog.set_level(logging.DEBUG)  # root at DEBUG: a NOTSET logger would inherit it
    logging.getLogger("anthropic").setLevel(anthropic_level)
    ClaudeBrain(settings, client=FakeClient())
    for name in ("anthropic", "anthropic._base_client", "httpx2"):
        assert not logging.getLogger(name).isEnabledFor(logging.DEBUG)


# ---------------------------------------------------------------------------
# Validation and construction
# ---------------------------------------------------------------------------


def test_brains_follow_the_protocol(settings: Settings) -> None:
    claude = ClaudeBrain(settings, client=FakeClient())
    offline = OfflineBrain()
    assert isinstance(claude, Brain) and claude.name == "claude"
    assert isinstance(offline, Brain) and offline.name == "offline"


@pytest.mark.parametrize("missing", ["vision_model", "text_model"])
def test_claude_brain_needs_both_models(settings: Settings, missing: str) -> None:
    with pytest.raises(ValueError):
        ClaudeBrain(replace(settings, **{missing: None}), client=FakeClient())


@pytest.mark.parametrize("use_claude", [True, False])
def test_invalid_arguments_raise(settings: Settings, use_claude: bool) -> None:
    brain = ClaudeBrain(settings, client=FakeClient()) if use_claude else OfflineBrain()
    with pytest.raises(ValueError):
        brain.read_page(JPEG, "de")
    with pytest.raises(ValueError):
        brain.read_handwriting(JPEG, "es")
    with pytest.raises(ValueError):
        brain.judge_meaning("a b", "a b", "xx", "6-9")
    with pytest.raises(ValueError):
        brain.judge_meaning("a b", "a b", "en", "5-7")
    with pytest.raises(ValueError):
        brain.word_feedback(mistakes_summary(), "en", "adult")


def test_empty_image_raises(settings: Settings) -> None:
    brain, client = brain_with(settings)
    with pytest.raises(ValueError):
        brain.read_page(b"", "en")
    with pytest.raises(ValueError):
        brain.read_handwriting(b"", "en")
    assert client.calls == []


def test_make_brain_claude(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    brain = make_brain(settings)
    assert isinstance(brain, ClaudeBrain) and brain.name == "claude"


@pytest.mark.parametrize(
    "change",
    [{"anthropic_api_key_set": False}, {"vision_model": None}, {"text_model": None}, {"vision_model": ""}],
)
def test_make_brain_offline(settings: Settings, change: dict) -> None:
    brain = make_brain(replace(settings, **change))
    assert isinstance(brain, OfflineBrain) and brain.name == "offline"


def test_make_brain_from_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    monkeypatch.setenv("MOMMY_VISION_MODEL", VISION_MODEL)
    monkeypatch.setenv("MOMMY_TEXT_MODEL", TEXT_MODEL)
    assert make_brain(load_settings(tmp_path)).name == "claude"
    monkeypatch.delenv("MOMMY_TEXT_MODEL")
    assert make_brain(load_settings(tmp_path)).name == "offline"


# ---------------------------------------------------------------------------
# OfflineBrain
# ---------------------------------------------------------------------------


def test_offline_read_page() -> None:
    brain = OfflineBrain()
    assert brain.read_page(JPEG, "fr") == {
        "text": "",
        "lang": "fr",
        "notes": "",
        "contains_quran": False,
        "needs_manual": True,
    }
    assert brain.read_page(JPEG, None)["lang"] is None


def test_offline_read_handwriting() -> None:
    assert OfflineBrain().read_handwriting(JPEG, "ar") == {
        "text": "",
        "uncertain_words": [],
        "legible": False,
        "needs_manual": True,
    }


MEANING_CASES = [
    # (lang, expected text, heard text, verdict)
    ("en", "The little cat played in the garden with a red ball.",
     "A little cat was playing with the red ball in the garden.", "same_meaning"),
    ("en", "The little cat played in the garden with a red ball.", "The cat played with a ball.", "partly"),
    ("en", "The little cat played in the garden with a red ball.", "My dad drives a big truck to work.", "different"),
    ("en", "The boy is happy today.", "The boy is not happy today.", "partly"),
    ("en", "Tom's dogs liked the stories.", "Tom's dog likes stories.", "same_meaning"),
    ("fr", "Le petit chat joue dans le jardin avec une balle rouge.",
     "Un petit chat jouait avec la balle rouge dans le jardin.", "same_meaning"),
    ("fr", "L'élève est allé à l'école ce matin.", "l eleve est alle a l ecole le matin", "same_meaning"),
    ("fr", "Le petit chat joue dans le jardin avec une balle rouge.", "le chat joue", "partly"),
    ("fr", "Le petit chat joue dans le jardin avec une balle rouge.", "Mon frère mange une pomme.", "different"),
    ("fr", "Il aime les pommes vertes.", "Il n'aime pas les pommes vertes.", "partly"),
    ("ar", "ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ فِي الصَّبَاحِ البَاكِرِ.",
     "الولد ذهب للمدرسة في الصباح الباكر", "same_meaning"),
    ("ar", "ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ، وَقَرَأَ الدَّرْسَ.", "ذهب الولد وقرأ الدرس في المدرسة", "same_meaning"),
    ("ar", "ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ فِي الصَّبَاحِ البَاكِرِ وَقَرَأَ الدَّرْسَ.",
     "ذهب الولد إلى المدرسة", "partly"),
    ("ar", "ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ.", "أكلت القطة السمكة", "different"),
    ("ar", "كَانَ الطَّقْسُ جَمِيلًا اليَوْمَ.", "الطقس جميل اليوم", "same_meaning"),
    ("ar", "الطَّقْسُ جَمِيلٌ اليَوْمَ.", "الطقس ليس جميلا اليوم", "partly"),
]


@pytest.mark.parametrize(("lang", "expected", "heard", "verdict"), MEANING_CASES)
def test_offline_judge_meaning(lang: str, expected: str, heard: str, verdict: str) -> None:
    result = OfflineBrain().judge_meaning(expected, heard, lang, "10-13")
    assert result["verdict"] == verdict, result
    assert result["approximate"] is True
    assert result["wrong_ideas"] == []
    assert set(result) == {"verdict", "missing_ideas", "wrong_ideas", "feedback", "approximate", "coverage"}
    assert has_arabic(result["feedback"]) == (lang == "ar")
    assert not FIRST_PERSON[lang].search(result["feedback"])


def test_offline_missing_ideas_are_surface_forms_in_order() -> None:
    result = OfflineBrain().judge_meaning(
        "ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ فِي الصَّبَاحِ البَاكِرِ وَقَرَأَ الدَّرْسَ.", "ذهب الولد إلى المدرسة", "ar", "6-9"
    )
    assert result["missing_ideas"] == ["الصَّبَاحِ", "البَاكِرِ", "وَقَرَأَ", "الدَّرْسَ"]
    assert "«الصَّبَاحِ»" in result["feedback"]


def test_offline_partly_feedback_quotes_first_missing_word() -> None:
    result = OfflineBrain().judge_meaning("The little cat played in the garden.", "The cat played.", "en", "6-9")
    assert result["verdict"] == "partly"
    assert result["missing_ideas"] == ["little", "garden"]
    assert '"little"' in result["feedback"]


@pytest.mark.parametrize("lang", LANGS)
def test_offline_empty_heard_asks_again(lang: str) -> None:
    result = OfflineBrain().judge_meaning("ذهب الولد" if lang == "ar" else "the cat sat", "", lang, "6-9")
    assert result["verdict"] == "different"
    assert result["feedback"] == feedback.say_again(lang, "6-9")


def test_offline_coverage_thresholds() -> None:
    words = "apple banana cherry dragon eagle falcon guitar hammer island jungle".split()
    expected = " ".join(words)

    def verdict(n: int) -> str:
        return meaning_overlap(expected, " ".join(words[:n]), "en")["verdict"]

    assert llm.SAME_MEANING_MIN_COVERAGE == 0.7 and llm.PARTLY_MIN_COVERAGE == 0.3
    assert [verdict(n) for n in (10, 7, 6, 3, 2, 0)] == [
        "same_meaning", "same_meaning", "partly", "partly", "different", "different",
    ]


def test_offline_function_words_only_text() -> None:
    assert OfflineBrain().judge_meaning("It is what it is.", "it is what it is", "en", "14-18")["verdict"] == "same_meaning"


@pytest.mark.parametrize("lang", LANGS)
def test_offline_word_feedback_uses_templates(lang: str) -> None:
    brain = OfflineBrain()
    for age in AGE_BANDS:
        summary = mistakes_summary(lang)
        assert brain.word_feedback(summary, lang, age) == feedback.for_result(summary, lang, age)


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("age", AGE_BANDS)
def test_meaning_templates(lang: str, age: str) -> None:
    for verdict in ("same_meaning", "partly", "different"):
        for missing in ([], ["  jardin  "]):
            text = meaning_feedback(verdict, missing, lang, age)
            assert text and "{" not in text
            assert has_arabic(text) == (lang == "ar")
            assert not FIRST_PERSON[lang].search(text)
    assert "jardin" in meaning_feedback("partly", ["jardin"], lang, age)
    with pytest.raises(ValueError):
        meaning_feedback("great", [], lang, age)


_MEANING_SAME = {lang: _MEANING_TEMPLATES[lang]["same_meaning"] for lang in LANGS}
FULL_PRAISE = {
    lang: {age: {_MEANING_SAME[lang][age]} | {feedback.praise(lang, age, k) for k in range(3)} for age in AGE_BANDS}
    for lang in LANGS
}


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("age", AGE_BANDS)
def test_same_meaning_with_missing_ideas_is_not_full_praise(lang: str, age: str) -> None:
    # Regression: "Super job! You told it just right!" was shown next to "Ideas to add".
    text = meaning_feedback("same_meaning", ["  soleil  "], lang, age)
    assert "soleil" in text and text not in FULL_PRAISE[lang][age]
    assert not FIRST_PERSON[lang].search(text)
    assert meaning_feedback("same_meaning", [], lang, age) == _MEANING_SAME[lang][age]


@pytest.mark.parametrize(
    ("lang", "expected", "heard", "missing"),
    [
        ("en", "Plants need sunlight to grow. The sun gives us light and heat.",
         "The sun gives light and warmth, and plants need it to grow.", "sunlight"),
        ("fr", "Les plantes ont besoin de lumière pour grandir. Le soleil donne de la lumière et de la chaleur.",
         "Le soleil donne de la lumière et de la chaleur, les plantes en ont besoin pour pousser.", "grandir"),
        ("ar", "تحتاج النباتات إلى الضوء لكي تنمو. الشمس تعطينا الضوء والحرارة.",
         "تحتاج النباتات إلى الضوء لكي تكبر. الشمس تعطينا الضوء والحرارة.", "تنمو"),
    ],
)
@pytest.mark.parametrize("age", AGE_BANDS)
def test_offline_same_meaning_with_missing_ideas_says_nearly_all_there(
    lang: str, expected: str, heard: str, missing: str, age: str
) -> None:
    result = OfflineBrain().judge_meaning(expected, heard, lang, age)
    assert result["verdict"] == "same_meaning" and result["missing_ideas"]
    assert result["missing_ideas"][0] == missing
    assert missing in result["feedback"]
    assert result["feedback"] not in FULL_PRAISE[lang][age]


def test_token_ceilings_leave_room_for_thinking() -> None:
    # Thinking tokens count toward max_tokens on current models; the ceilings stay below
    # the size at which the SDK refuses a non-streaming request (about 21,000).
    assert MAX_TOKENS_VISION == 16000 and MAX_TOKENS_TEXT == 4000
    assert max(MAX_TOKENS_VISION, MAX_TOKENS_TEXT) < 21000


def test_word_feedback_with_only_unreadable_words_skips_the_api(settings: Settings) -> None:
    summary = result_summary(check_writing("Le chat dort.", "Le chat [?].", "fr"))
    brain, client = brain_with(settings)
    assert brain.word_feedback(summary, "fr", "10-13") == feedback.unreadable("fr", "10-13")
    assert client.calls == []


def test_word_feedback_tells_the_model_where_the_child_stopped(settings: Settings) -> None:
    summary = result_summary(check_recitation("the cat sat on the mat", "the cat", "en"))
    assert compact_summary(summary)["stopped_at"] == "sat"
    brain, client = brain_with(settings, reply({"feedback": 'Good start! You stopped at "sat".'}))
    assert brain.word_feedback(summary, "en", "6-9") == 'Good start! You stopped at "sat".'
    assert '"stopped_at": "sat"' in client.calls[0]["messages"][0]["content"][0]["text"]
    assert "stopped_at" in client.calls[0]["system"]


# ---------------------------------------------------------------------------
# Hard rule 6: no Claude model identifiers in these files
# ---------------------------------------------------------------------------

# The family names are spelled backwards so that this file does not contain them either.
_FAMILIES = [name[::-1] for name in ("supo", "tennos", "ukiah", "elbaf", "sohtym")]


@pytest.mark.parametrize("path", [Path(llm.__file__), Path(__file__)], ids=["llm.py", "test_llm.py"])
def test_no_model_identifiers(path: Path) -> None:
    text = path.read_text(encoding="utf-8").lower()
    assert not re.search(r"claude[\s_-]*\d", text)
    assert not re.search(r"claude-[a-z]", text)
    for family in _FAMILIES:
        assert family not in text
