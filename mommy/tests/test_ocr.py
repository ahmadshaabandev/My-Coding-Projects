"""The local page reader (mommy.ocr): reading order, text clean-up, limits, privacy, and
the real PP-OCR models on small generated pages (skipped when the models in
models/ppocr-onnx/ or onnxruntime/OpenCV are missing; about 1 s each)."""

from __future__ import annotations

import builtins
import io
import logging
import math
import threading
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont, features

from mommy import ocr
from mommy.config import load_settings
from mommy.ocr import (
    MODEL_DIR_NAME,
    MODEL_FILES,
    UNREADABLE,
    Line,
    OCRBusy,
    OCRUnavailable,
    PPOCRReader,
    TextBox,
    arabic_reading_order,
    arabic_share,
    decode_image,
    drop_page_numbers,
    guess_latin_lang,
    join_lines,
    mark_share,
    order_lines,
    reading_order,
    tidy,
)

ROOT = Path(__file__).resolve().parent.parent
FATHA, KASRA, SUKUN = "َ", "ِ", "ْ"
NASKH = Path("/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf")
DEJAVU = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")


# ---------------------------------------------------------------------------
# Reading order of an Arabic line
# ---------------------------------------------------------------------------


def test_an_arabic_line_is_put_in_reading_order() -> None:
    # The recogniser reads left to right: an Arabic line comes out reversed, numbers and
    # Latin words in their own order.
    assert arabic_reading_order("3 سردلا") == "الدرس 3"
    assert arabic_reading_order("12 ةحفص") == "صفحة 12"
    assert arabic_reading_order("٢١ ةحفص") == "صفحة ٢١"  # Arabic-Indic digits are written left to right too
    assert arabic_reading_order("3.5 ددعلا") == "العدد 3.5"
    assert arabic_reading_order("Paris ىلإ") == "إلى Paris"
    assert arabic_reading_order("؟كلاح فيك") == "كيف حالك؟"


def test_a_mark_follows_its_letter_and_a_stray_mark_is_dropped() -> None:
    logical = "بَتْ"  # ba fatha, ta sukun
    visual = logical[::-1]  # how the recogniser writes it: each mark before its letter
    assert arabic_reading_order(visual) == logical
    assert arabic_reading_order(visual + FATHA) == logical  # a mark with no letter before it after reversing
    assert arabic_reading_order(FATHA + " ب") == "ب "  # after reversing, the mark follows a space
    read = reading_order([("ت", 0.9), (SUKUN, 0.7), ("ب", 1.0)])
    assert read == [("ب", 1.0), (SUKUN, 0.7), ("ت", 0.9)]  # confidences travel with their characters


def test_tidy_drops_unsure_marks_and_hides_unsure_words() -> None:
    read = [("ب", 0.99), (FATHA, 0.95), ("ي", 0.98), (KASRA, 0.3), ("ت", 0.97), (" ", 0.9), (" ", 0.9),
            ("ق", 0.2), ("ل", 0.9), (" ", 0.9), ("ب", 0.9), (SUKUN, 0.1)]
    assert tidy(read, min_mark=0.6, unsure=0.35) == "بَيت " + UNREADABLE + " ب"
    assert tidy(read, min_mark=0.0, unsure=0.0) == "بَيِت قل بْ"
    assert tidy([(" ", 1.0), ("a", 1.0), (" ", 1.0)]) == "a"


def test_script_measures() -> None:
    assert arabic_share("ذهب Ali") == pytest.approx(3 / 6)
    assert arabic_share("123 ...") == 0.0
    assert mark_share("بَيْت") == pytest.approx(2 / 3)
    assert mark_share("abc") == 0.0
    assert guess_latin_lang("Le garçon et sa sœur sont à l'école.") == "fr"
    assert guess_latin_lang("The boy and his sister went to the park.") == "en"


# ---------------------------------------------------------------------------
# Lines and paragraphs
# ---------------------------------------------------------------------------


def box(x0: float, y0: float, x1: float, y1: float, text: str, angle_deg: float = 0.0) -> TextBox:
    """A box from an upright rectangle, turned by ``angle_deg`` about the page origin."""
    a = math.radians(angle_deg)
    rot = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]], dtype=np.float32)
    pts = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=np.float32) @ rot.T
    return TextBox(pts, text=text)


def test_boxes_of_a_line_run_right_to_left_in_arabic_and_left_to_right_otherwise() -> None:
    boxes = [box(100, 0, 300, 40, "الثاني"), box(320, 0, 600, 40, "الأول"), box(100, 60, 600, 100, "سطر جديد")]
    lines = order_lines(boxes)
    assert [line.text for line in lines] == ["الأول الثاني", "سطر جديد"] and lines[0].rtl
    lines = order_lines([box(320, 0, 600, 40, "second"), box(100, 0, 300, 40, "first")])
    assert [line.text for line in lines] == ["first second"] and not lines[0].rtl


@pytest.mark.parametrize("angle", [-6.0, -2.0, 0.0, 3.0, 7.0])
def test_a_tilted_photo_keeps_its_lines(angle: float) -> None:
    # Three lines of two segments each, the page turned: grouping follows the page's slope.
    boxes = []
    for k in range(3):
        y = 100 + 60 * k
        boxes += [box(500, y, 1100, y + 40, f"r{k}"), box(100, y, 480, y + 40, f"l{k}")]
    lines = order_lines(boxes[::-1])
    assert [line.text for line in lines] == ["l0 r0", "l1 r1", "l2 r2"]


def test_paragraphs_follow_gaps_and_short_lines() -> None:
    def line(y: float, x0: float, x1: float, text: str, rtl: bool = False) -> Line:
        return Line([TextBox(np.zeros((4, 2), np.float32), text=text, rtl=rtl)], y, x0, x1, 40.0, rtl)

    lines = [
        line(0, 300, 700, "Title"),  # a short line: a paragraph of its own
        line(100, 100, 900, "one two"),
        line(150, 100, 900, "three"),
        line(200, 100, 500, "four."),  # the last line of a paragraph ends early
        line(250, 100, 900, "five"),
        line(400, 100, 900, "six"),  # a wider space than between the other lines
    ]
    assert join_lines(lines) == "Title\none two three four.\nfive\nsix"
    rtl = [line(0, 100, 900, "أ", True), line(50, 600, 900, "ب", True), line(100, 100, 900, "ج", True)]
    assert join_lines(rtl) == "أ ب\nج"  # an Arabic line ends at its left edge


def test_a_page_number_is_left_out() -> None:
    def line(text: str) -> Line:
        return Line([TextBox(np.zeros((4, 2), np.float32), text=text)], 0, 0, 1, 1, False)

    texts = [ln.text for ln in drop_page_numbers([line("12"), line("Lesson"), line("Text 3"), line("- 13 -")])]
    assert texts == ["Lesson", "Text 3"]
    assert [ln.text for ln in drop_page_numbers([line("7")])] == ["7"]


# ---------------------------------------------------------------------------
# Images, limits and the reader's state
# ---------------------------------------------------------------------------


def encode(img: Image.Image, fmt: str = "JPEG") -> bytes:
    out = io.BytesIO()
    img.save(out, fmt)
    return out.getvalue()


def test_images_are_decoded_in_memory_within_limits() -> None:
    bgr = decode_image(encode(Image.new("RGB", (3000, 1500), (10, 20, 30))))
    assert bgr.shape == (1000, 2000, 3) and bgr.dtype == np.uint8
    assert tuple(bgr[0, 0]) == pytest.approx((30, 20, 10), abs=3)  # BGR
    assert decode_image(encode(Image.new("L", (64, 48)), "PNG")).shape == (48, 64, 3)
    with pytest.raises(ValueError, match="too many pixels"):
        decode_image(encode(Image.new("L", (5000, 4000)), "PNG"))
    with pytest.raises(ValueError, match="too small"):
        decode_image(encode(Image.new("RGB", (20, 400))))
    with pytest.raises(ValueError, match="could not be decoded"):
        decode_image(b"\xff\xd8\xff\xe0 not a jpeg")


def test_missing_models_make_the_reader_unavailable(tmp_path: Path) -> None:
    reader = PPOCRReader(tmp_path, num_threads=1)
    assert reader.available is False
    assert "missing" in (reader.unavailable_reason or "") and MODEL_DIR_NAME in (reader.unavailable_reason or "")
    with pytest.raises(OCRUnavailable):
        reader.read_page(encode(Image.new("RGB", (100, 100))), None)
    reader.preload()  # nothing to load, no error
    with pytest.raises(ValueError, match="unsupported language"):
        reader.read_page(b"", "de")  # type: ignore[arg-type]


def fake_models(tmp_path: Path) -> Path:
    (tmp_path / MODEL_DIR_NAME).mkdir()
    for name in MODEL_FILES.values():
        (tmp_path / MODEL_DIR_NAME / name).write_bytes(b"not a model")
    return tmp_path


def test_one_page_at_a_time_and_a_bounded_wait(tmp_path: Path) -> None:
    reader = PPOCRReader(fake_models(tmp_path), num_threads=1)
    assert reader.available
    image = encode(Image.new("RGB", (100, 100)))
    reader._lock.acquire()  # another page is being read
    try:
        with pytest.raises(OCRBusy):
            reader.read_page(image, "en", timeout=0.05)
    finally:
        reader._lock.release()


def test_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("MOMMY_OCR", "MOMMY_OCR_THREADS", "MOMMY_ASR_THREADS", "MOMMY_ACCESS_CODE", "MOMMY_ACCESS_CODE_FILE",
                 "MOMMY_REQUIRE_ACCESS_CODE"):
        monkeypatch.delenv(name, raising=False)
    settings = load_settings()
    assert settings.ocr is True and settings.ocr_threads == settings.asr_threads == 4
    monkeypatch.setenv("MOMMY_ASR_THREADS", "2")
    assert load_settings().ocr_threads == 2  # follows the recogniser's
    monkeypatch.setenv("MOMMY_OCR_THREADS", "3")
    assert load_settings().ocr_threads == 3
    for off in ("off", "0", "False", " no "):
        monkeypatch.setenv("MOMMY_OCR", off)
        assert load_settings().ocr is False
    monkeypatch.setenv("MOMMY_OCR", "on")
    assert load_settings().ocr is True
    for bad_name, bad in (("MOMMY_OCR", "maybe"), ("MOMMY_OCR_THREADS", "0"), ("MOMMY_OCR_THREADS", "two")):
        monkeypatch.setenv(bad_name, bad)
        with pytest.raises(ValueError, match=bad_name):
            load_settings()
        monkeypatch.delenv(bad_name)
    assert PPOCRReader.from_settings(load_settings()).num_threads == 2


# ---------------------------------------------------------------------------
# The real models (skipped without them)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def reader() -> PPOCRReader:
    reader = PPOCRReader(ROOT / "models", num_threads=2)
    if not reader.available:
        pytest.skip(f"local page reader unavailable: {reader.unavailable_reason}")
    reader.preload()
    return reader


def page(lines: list[str], *, font: Any = None, size: tuple[int, int] = (900, 300), rtl: bool = False,
         turn: float = 0.0) -> bytes:
    """A small generated page: dark text on off-white paper, optionally turned, as a JPEG."""
    img = Image.new("RGB", size, (250, 248, 240))
    draw = ImageDraw.Draw(img)
    font = font or ImageFont.load_default(size=40)
    for k, text in enumerate(lines):
        if rtl:
            draw.text((size[0] - 40, 30 + 80 * k), text, fill=(20, 20, 20), font=font, anchor="ra", direction="rtl")
        else:
            draw.text((40, 30 + 80 * k), text, fill=(20, 20, 20), font=font)
    if turn:
        img = img.rotate(turn, expand=True, fillcolor=(90, 70, 50))
    return encode(img)


def test_reads_an_english_page(reader: PPOCRReader) -> None:
    image = page(["The Lost Kite", "", "Sam and Mia went to the park", "with a bright red kite."], size=(900, 360))
    for hint in (None, "en"):
        result = reader.read_page(image, hint)
        assert result == {
            "text": "The Lost Kite\nSam and Mia went to the park with a bright red kite.",
            "lang": "en", "notes": ocr.NOTES["en"], "contains_quran": False, "needs_manual": False,
        }
    tilted = reader.read_page(page(["Sam and Mia went to the park", "with a bright red kite."], turn=4), None)
    assert tilted["text"] == "Sam and Mia went to the park with a bright red kite."


@pytest.mark.skipif(not DEJAVU.is_file(), reason="no DejaVu Sans font")
def test_reads_a_french_page_with_its_accents(reader: PPOCRReader) -> None:
    font = ImageFont.truetype(str(DEJAVU), 36)
    result = reader.read_page(page(["Le garçon et sa sœur sont à l'école,", "près du château où ils jouent."], font=font), None)
    assert result["lang"] == "fr" and not result["needs_manual"]
    assert result["text"] == "Le garçon et sa sœur sont à l'école, près du château où ils jouent."


@pytest.mark.skipif(not (NASKH.is_file() and features.check("raqm")), reason="no Arabic font or text shaping")
def test_reads_an_arabic_page_in_reading_order(reader: PPOCRReader) -> None:
    font = ImageFont.truetype(str(NASKH), 40)
    image = page(["ذهب الولد إلى المدرسة صباحا", "مع أخيه الصغير في الصف ٣"], font=font, rtl=True)
    for hint in ("ar", None):
        result = reader.read_page(image, hint)
        assert result["lang"] == "ar" and result["notes"] == ocr.NOTES["ar"]
        assert result["text"] == "ذهب الولد إلى المدرسة صباحا مع أخيه الصغير في الصف ٣"


def test_a_page_turned_sideways_is_read_upright(reader: PPOCRReader) -> None:
    lines = ["Sam and Mia went to the park with", "a bright red kite. The wind was", "strong and the kite flew high.",
             "They ran across the grass and", "over a small bridge to the pond."]
    upright = Image.open(io.BytesIO(page(lines, size=(900, 1200))))
    for turned in (upright.transpose(Image.Transpose.ROTATE_90), upright.transpose(Image.Transpose.ROTATE_270)):
        result = reader.read_page(encode(turned), "en")
        assert result["text"].startswith("Sam and Mia went to the park"), result["text"][:60]


def test_a_blank_photo_needs_the_parent(reader: PPOCRReader) -> None:
    result = reader.read_page(encode(Image.new("RGB", (800, 600), (240, 240, 235))), "fr")
    assert result == {"text": "", "lang": "fr", "notes": "", "contains_quran": False, "needs_manual": True}


def test_nothing_is_written_to_disk_or_logged(
    reader: PPOCRReader, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    import cv2

    opened: list[tuple[str, str]] = []
    real_open = builtins.open

    def spy_open(file: Any, mode: str = "r", *args: Any, **kwargs: Any) -> Any:
        opened.append((str(file), mode))
        return real_open(file, mode, *args, **kwargs)

    def refuse(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("an image was written")

    image = page(["Quixotic zebras zigzag", "around the bright red kite."])
    monkeypatch.setattr(builtins, "open", spy_open)
    monkeypatch.setattr(cv2, "imwrite", refuse)
    monkeypatch.setattr(Image.Image, "save", refuse)
    with caplog.at_level(logging.DEBUG):
        result = reader.read_page(image, None)
    assert result["text"] == "Quixotic zebras zigzag around the bright red kite."
    assert [m for _, m in opened if any(c in m for c in "wax+")] == []
    assert "ocr: image" in caplog.text
    for word in ("Quixotic", "zebras", "zigzag", "kite"):
        assert word not in caplog.text


def test_pages_are_read_one_at_a_time(reader: PPOCRReader) -> None:
    image = page(["The cat sat on the mat."])
    results: list[str] = []
    threads = [threading.Thread(target=lambda: results.append(reader.read_page(image, "en")["text"])) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results == ["The cat sat on the mat."] * 3
