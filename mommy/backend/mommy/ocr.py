"""Local reading of printed pages (OCR): PP-OCR models (PaddleOCR, Apache-2.0) run by
onnxruntime, with no network and no Claude.

``/api/page/read`` uses it when Claude may not be used for the request (no AI consent, or
no Claude on the server): a photo of a printed textbook page or worksheet comes back as
text that the parent checks and edits before it is used, exactly as a page read by
Claude. Handwriting is not read here (a dictation photo still needs Claude or typing).

Pipeline (:meth:`PPOCRReader.read_page`), all in memory:

1. The JPEG the app has already cleaned (:func:`mommy.app.clean_image`: upright from its
   EXIF orientation, at most 2000 px, no metadata) is decoded; anything larger than
   :data:`MAX_IMAGE_EDGE` is reduced first.
2. Page orientation: the PP-LCNet document orientation classifier turns a page
   photographed sideways or upside down upright (only when it is sure).
3. Text detection (DB, PP-OCRv6 small det) on the page reduced to at most
   :data:`DET_MAX_SIDE` px: one rotated box per line or line segment.
4. Each box is cut out straight (perspective warp) and recognised (CTC): Arabic with the
   PP-OCRv5 mobile Arabic model, French and English with the PP-OCRv5 mobile Latin one. The
   Arabic model reads a line left to right (visual order); it is put in reading order
   with numbers and Latin runs kept as they are (:func:`arabic_reading_order`). A line
   of Arabic with tashkeel is read again stretched (:data:`REC_STRETCH_MARKED`): the
   recogniser writes at most one character per 8 px of its input, too few for letters
   and marks together. A mark read with low confidence is left out
   (:data:`MIN_MARK_CONFIDENCE`): a missing vowel mark is easier for the parent to see
   and less harmful than a wrong one.
5. Reading order (:func:`order_lines`): the boxes are grouped into lines along the
   page's own slope (a photo is rarely straight), the lines run top to bottom, and the
   boxes of a line right to left for Arabic, left to right otherwise. Lines are joined
   into paragraphs with single spaces; a wide vertical gap or a short line starts a new
   paragraph (``\\n``), as Claude is asked to do (:func:`join_lines`).
6. A word the recogniser is unsure of (:data:`UNSURE_WORD_CONFIDENCE`) is written
   ``[?]`` so that the parent types it, as Claude does for a word it cannot read.

Models: :data:`MODEL_FILES`, in ``models/ppocr-onnx/`` (``scripts/download_models.sh``
fetches them, each file checked against its pinned sha256).

Privacy (hard rule 5): the image is only ever in memory (bytes, a Pillow image, numpy
arrays) and never written to disk; logs carry sizes, counts and timings, never text or
pixels. The models are read from disk once (at the first page, or :meth:`preload`) and
the network is never used.

Threads: one lock serialises reading (one page at a time), with ``num_threads``
intra-op threads (``MOMMY_OCR_THREADS``).
"""

from __future__ import annotations

import io
import logging
import math
import threading
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

import numpy as np

from .textnorm import Lang

if TYPE_CHECKING:
    from .config import Settings

log = logging.getLogger(__name__)

#: The directory under ``models/`` that holds the OCR models.
MODEL_DIR_NAME = "ppocr-onnx"

#: File names in :data:`MODEL_DIR_NAME`, by role. ``det``: text detection; ``rec_ar`` +
#: ``dict_ar``: Arabic recognition (PP-OCRv5 mobile: PP-OCRv6 has no Arabic model);
#: ``rec_latin`` + ``dict_latin``: French and English (PP-OCRv5 mobile Latin: as accurate as
#: PP-OCRv6 small on our pages, at a third of its size);
#: ``doc_ori``: page orientation (0, 90, 180 or 270 degrees).
MODEL_FILES: dict[str, str] = {
    "det": "PP-OCRv6_small_det.onnx",
    "rec_ar": "arabic_PP-OCRv5_mobile_rec.onnx",
    "dict_ar": "ppocrv5_arabic_dict.txt",
    "rec_latin": "latin_PP-OCRv5_mobile_rec.onnx",
    "dict_latin": "ppocrv5_latin_dict.txt",
    "doc_ori": "PP-LCNet_x1_0_doc_ori.onnx",
}

#: Longest image edge read (pixels), as the app's MAX_IMAGE_EDGE; larger images are reduced.
MAX_IMAGE_EDGE = 2000
#: Most pixels decoded (a PNG is not decoded at a reduced scale), as the app's MAX_IMAGE_PIXELS.
MAX_IMAGE_PIXELS = 4096 * 4096
#: Smallest image edge worth reading (pixels).
MIN_IMAGE_EDGE = 32
#: Longest edge of the image given to the text detector (pixels).
DET_MAX_SIDE = 1536
#: DB post-processing (the PP-OCRv6 det defaults).
DET_THRESH = 0.2
DET_BOX_THRESH = 0.45
DET_UNCLIP_RATIO = 1.4
DET_MAX_CANDIDATES = 1000
#: Text recognition input height (pixels) and batch size.
REC_HEIGHT = 48
REC_BATCH = 8
#: Widest recogniser input, as a multiple of its height (a longer box is squeezed): bounds
#: the memory and time of one line (a 2000 px line at 30 px is 67, x2 stretched 133).
MAX_REC_RATIO = 160
#: Horizontal stretch of a crop before recognition: Arabic first, and a line of Arabic
#: with tashkeel (more than :data:`MARKED_LINE_SHARE` marks per letter) again.
REC_STRETCH: dict[str, float] = {"ar": 1.5, "latin": 1.0}
REC_STRETCH_MARKED = 2.0
MARKED_LINE_SHARE = 0.25
#: Most text boxes recognised on one page (a page of a children's book has far fewer).
MAX_BOXES = 400
#: A box whose mean character confidence is below this is dropped (texture, a picture).
MIN_LINE_CONFIDENCE = 0.5
#: A word whose lowest letter confidence is below this is written ``[?]``.
UNSURE_WORD_CONFIDENCE = 0.35
#: An Arabic mark (tashkeel) read with a lower confidence is left out.
MIN_MARK_CONFIDENCE = 0.6
#: The page is turned only when the orientation classifier is at least this sure.
ORIENTATION_CONFIDENCE = 0.8

UNREADABLE = "[?]"

#: Notes for the parent, in the language of the page.
NOTES: dict[str, str] = {
    "en": "Read on this server, without AI. Please check every word before confirming.",
    "fr": "Lu sur ce serveur, sans IA. Vérifiez chaque mot avant de confirmer.",
    "ar": "قرأ الخادم هذه الصفحة دون ذكاء اصطناعي. يرجى مراجعة كل كلمة وعلامات التشكيل قبل التأكيد.",
}


class OCRUnavailable(RuntimeError):
    """The OCR models or packages are missing."""


class OCRBusy(RuntimeError):
    """Another page was being read for longer than the caller wanted to wait."""


@runtime_checkable
class PageReader(Protocol):
    """What the app needs from a local page reader."""

    available: bool

    def read_page(self, image_jpeg: bytes, lang_hint: Lang | None, *, timeout: float | None = None) -> dict:
        """``{"text", "lang", "notes", "contains_quran": False, "needs_manual"}``, as
        :meth:`mommy.llm.Brain.read_page`; raises :class:`OCRBusy`, :class:`OCRUnavailable`
        or ValueError."""
        ...


# ---------------------------------------------------------------------------
# Text helpers (pure)
# ---------------------------------------------------------------------------

#: One recognised character and the recogniser's confidence in it.
Read = list[tuple[str, float]]


def is_mark(ch: str) -> bool:
    """A combining mark (Arabic tashkeel, a decomposed accent)."""
    return unicodedata.combining(ch) != 0


def is_arabic_letter(ch: str) -> bool:
    """An Arabic-script letter (not a mark, digit or punctuation sign)."""
    return "؀" <= ch <= "ۿ" and ch.isalpha() and not is_mark(ch)


def is_latin_letter(ch: str) -> bool:
    """A letter of the Latin script (with its accented forms)."""
    return ch.isalpha() and ch < "ɐ"


def arabic_share(text: str) -> float:
    """Share of Arabic letters among the letters of ``text`` (0.0 with no letter)."""
    ar = sum(1 for ch in text if is_arabic_letter(ch))
    la = sum(1 for ch in text if is_latin_letter(ch))
    return ar / (ar + la) if ar + la else 0.0


def mark_share(text: str) -> float:
    """Marks per Arabic letter in ``text`` (about 0.8 for a fully vowelled text)."""
    letters = sum(1 for ch in text if is_arabic_letter(ch))
    return sum(1 for ch in text if is_mark(ch)) / letters if letters else 0.0


def _keeps_ltr(ch: str) -> bool:
    """Characters whose runs keep their order in a reversed Arabic line: Latin letters,
    digits (Western and Arabic-Indic numbers are written left to right) and the signs
    inside numbers."""
    return ch.isdigit() or is_latin_letter(ch) or ch in ".,:%+-/*"


def reading_order(visual: Read) -> Read:
    """An Arabic line read left to right (visual order) in reading order.

    The characters are reversed, except runs of Latin letters and numbers (with the signs
    inside them), which keep their order, as PaddleOCR does for its Arabic models. The
    recogniser writes a mark before its letter in visual order, so after the reversal it
    follows it again; a mark left with no letter before it (at the start, after a space
    or a sign) is dropped.
    """
    runs: list[Read] = []
    run: Read = []
    for item in visual:
        if _keeps_ltr(item[0]):
            run.append(item)
            continue
        if run:
            runs.append(run)
            run = []
        runs.append([item])
    if run:
        runs.append(run)
    out: Read = []
    for part in reversed(runs):
        for item in part:
            if is_mark(item[0]) and (not out or not (is_arabic_letter(out[-1][0]) or is_mark(out[-1][0]))):
                continue
            out.append(item)
    return out


def arabic_reading_order(visual: str) -> str:
    """:func:`reading_order` of a plain string."""
    return "".join(ch for ch, _ in reading_order([(ch, 1.0) for ch in visual]))


def tidy(read: Read, *, min_mark: float | None = None, unsure: float | None = None) -> str:
    """The text of one box: runs of spaces as one, marks under ``min_mark`` (default
    :data:`MIN_MARK_CONFIDENCE`) left out, a word whose lowest letter confidence is under
    ``unsure`` (default :data:`UNSURE_WORD_CONFIDENCE`) written ``[?]``."""
    min_mark = MIN_MARK_CONFIDENCE if min_mark is None else min_mark
    unsure = UNSURE_WORD_CONFIDENCE if unsure is None else unsure
    words: list[Read] = [[]]
    for ch, conf in read:
        if ch.isspace():
            if words[-1]:
                words.append([])
        elif not (is_mark(ch) and conf < min_mark):
            words[-1].append((ch, conf))
    out = []
    for word in words:
        if not word:
            continue
        letters = [conf for ch, conf in word if not is_mark(ch)]
        out.append(UNREADABLE if letters and min(letters) < unsure else "".join(ch for ch, _ in word))
    return " ".join(out)


def guess_latin_lang(text: str) -> Lang:
    """``"fr"`` or ``"en"`` for a page in Latin script, from accents and common words."""
    words = [w.strip(".,;:!?«»\"'()").casefold() for w in text.split()]
    fr_words = {"le", "la", "les", "des", "et", "est", "une", "un", "du", "de", "dans", "sur", "pour", "avec",
                "il", "elle", "nous", "vous", "ils", "pas", "que", "qui", "au", "aux", "ce", "sa", "son", "ses"}
    en_words = {"the", "and", "is", "a", "an", "of", "to", "in", "on", "with", "he", "she", "it", "we", "you",
                "they", "was", "were", "his", "her", "their", "for", "at", "from", "not", "that", "this"}
    fr = sum(1 for w in words if w in fr_words) + 2 * sum(1 for ch in text if ch in "éèêàùçâîôûëïœ«»")
    en = sum(1 for w in words if w in en_words)
    return "fr" if fr > en else "en"


# ---------------------------------------------------------------------------
# Geometry and reading order (pure, numpy)
# ---------------------------------------------------------------------------


@dataclass
class TextBox:
    """One detected text segment: its four corners (top-left, top-right, bottom-right,
    bottom-left, in the upright page) and, once recognised, its text."""

    points: np.ndarray  # (4, 2) float32
    text: str = ""
    rtl: bool = False

    @property
    def center(self) -> tuple[float, float]:
        c = self.points.mean(axis=0)
        return float(c[0]), float(c[1])

    @property
    def height(self) -> float:
        p = self.points
        return float((np.linalg.norm(p[0] - p[3]) + np.linalg.norm(p[1] - p[2])) / 2)

    @property
    def width(self) -> float:
        p = self.points
        return float((np.linalg.norm(p[0] - p[1]) + np.linalg.norm(p[3] - p[2])) / 2)

    @property
    def angle(self) -> float:
        """Slope of the top edge, in radians."""
        d = self.points[1] - self.points[0]
        return math.atan2(float(d[1]), float(d[0]))


def order_points(pts: np.ndarray) -> np.ndarray:
    """Four corners as top-left, top-right, bottom-right, bottom-left."""
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    xs = pts[np.argsort(pts[:, 0], kind="stable")]
    left, right = xs[:2], xs[2:]
    tl, bl = left[np.argsort(left[:, 1], kind="stable")]
    tr, br = right[np.argsort(right[:, 1], kind="stable")]
    return np.array([tl, tr, br, bl], dtype=np.float32)


@dataclass
class Line:
    """Boxes read as one printed line, in reading order."""

    boxes: list[TextBox]
    y: float  # position across the page's slope (down)
    x0: float  # extent along it (left to right)
    x1: float
    height: float
    rtl: bool

    @property
    def text(self) -> str:
        return " ".join(b.text for b in self.boxes if b.text)


def order_lines(boxes: list[TextBox]) -> list[Line]:
    """Group recognised boxes into printed lines, in reading order.

    The page's slope is the median slope of the wide boxes, and positions are measured
    along and across it, so a tilted photo still gives straight lines. A box joins the
    line whose position across the slope is within half a line height of its own; lines
    run top to bottom, and the boxes of a line right to left when most of its letters
    are Arabic, else left to right.
    """
    if not boxes:
        return []
    wide = [b.angle for b in boxes if b.width > 2 * b.height]
    theta = float(np.median(wide)) if wide else 0.0
    cos, sin = math.cos(theta), math.sin(theta)

    def along(b: TextBox) -> float:
        cx, cy = b.center
        return cx * cos + cy * sin

    def across(b: TextBox) -> float:
        cx, cy = b.center
        return -cx * sin + cy * cos

    groups: list[list[TextBox]] = []
    ys: list[float] = []
    hs: list[float] = []
    for b in sorted(boxes, key=across):
        y, h = across(b), max(b.height, 1.0)
        best = None
        for k in range(len(groups)):
            if abs(ys[k] - y) < 0.5 * max(hs[k], h) and (best is None or abs(ys[k] - y) < abs(ys[best] - y)):
                best = k
        if best is None:
            groups.append([b])
            ys.append(y)
            hs.append(h)
        else:
            n = len(groups[best])
            groups[best].append(b)
            ys[best] = (ys[best] * n + y) / (n + 1)
            hs[best] = max(hs[best], h)
    lines: list[Line] = []
    for members, y, h in zip(groups, ys, hs):
        rtl = arabic_share(" ".join(b.text for b in members)) > 0.5
        members.sort(key=along, reverse=rtl)
        for b in members:
            b.rtl = rtl
        x0 = min(along(b) - b.width / 2 for b in members)
        x1 = max(along(b) + b.width / 2 for b in members)
        lines.append(Line(members, y, x0, x1, h, rtl))
    lines.sort(key=lambda line: line.y)
    return lines


def join_lines(lines: list[Line]) -> str:
    """The text of the lines: the lines of a paragraph joined by single spaces,
    paragraphs separated by ``\\n``. A new paragraph starts after a line that ends well
    before the block's edge (a title, the last line of a paragraph, a line of a list or a
    poem), or after a wider space than between the page's other lines (more than 1.35
    times the median line pitch, or a gap of more than 1.5 line heights)."""
    lines = [line for line in lines if line.text.strip()]
    if not lines:
        return ""
    left = float(np.median([line.x0 for line in lines]))
    right = float(np.median([line.x1 for line in lines]))
    width = max(right - left, 1.0)
    pitch = float(np.median([b.y - a.y for a, b in zip(lines, lines[1:])])) if len(lines) > 1 else 0.0
    paragraphs: list[list[str]] = [[lines[0].text]]
    for prev, line in zip(lines, lines[1:]):
        gap = line.y - prev.y - (prev.height + line.height) / 2
        wide = line.y - prev.y > 1.35 * pitch or gap > 1.5 * max(prev.height, line.height)
        # A line ends at its left edge in Arabic, at its right edge otherwise.
        short = (prev.x0 - left if prev.rtl else right - prev.x1) > 0.2 * width
        if wide or short:
            paragraphs.append([line.text])
        else:
            paragraphs[-1].append(line.text)
    return "\n".join(" ".join(p) for p in paragraphs)


def drop_page_numbers(lines: list[Line]) -> list[Line]:
    """``lines`` without a first or last line that is only a number (a page number)."""

    def is_number(line: Line) -> bool:
        t = line.text.strip(" -–—.()")
        return 0 < len(t) <= 3 and t.isdigit()

    if len(lines) > 1 and is_number(lines[-1]):
        lines = lines[:-1]
    if len(lines) > 1 and is_number(lines[0]):
        lines = lines[1:]
    return lines


# ---------------------------------------------------------------------------
# The reader
# ---------------------------------------------------------------------------


def decode_image(data: bytes) -> np.ndarray:
    """A JPEG or PNG, in memory, as a BGR uint8 array of at most :data:`MAX_IMAGE_EDGE`
    px on the long edge. ValueError when it cannot be decoded, has more than
    :data:`MAX_IMAGE_PIXELS` pixels (a JPEG is decoded at a reduced scale first) or is
    smaller than :data:`MIN_IMAGE_EDGE`."""
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.format == "JPEG":
                img.draft("RGB", (MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))  # decode at 1/2, 1/4 or 1/8 scale
            if img.width * img.height > MAX_IMAGE_PIXELS:
                raise ValueError("the image has too many pixels")
            rgb = img.convert("RGB")
    except ValueError:
        raise
    except Exception as exc:  # a broken file: Pillow raises many kinds
        raise ValueError(f"the image could not be decoded ({type(exc).__name__})") from None
    if max(rgb.size) > MAX_IMAGE_EDGE:
        rgb.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
    if min(rgb.size) < MIN_IMAGE_EDGE:
        raise ValueError("the image is too small")
    return np.ascontiguousarray(np.asarray(rgb)[:, :, ::-1])


def _load_dict(path: Path) -> list[str]:
    """The recogniser's characters: the CTC blank, one per line of the file, then a
    space (PaddleOCR's ``use_space_char``)."""
    chars = path.read_text(encoding="utf-8").split("\n")
    if chars and chars[-1] == "":
        chars.pop()
    return ["<blank>"] + [c.rstrip("\r") for c in chars] + [" "]


class PPOCRReader:
    """Reads printed pages with PP-OCR ONNX models (see the module docstring).

    The models are loaded at the first page (or by :meth:`preload`), under the lock that
    also serialises reading. ``available`` is False, with ``unavailable_reason``, when a
    model file or the ``onnxruntime`` / ``cv2`` (opencv-python-headless) package is
    missing; :meth:`read_page` then raises :class:`OCRUnavailable`.
    """

    def __init__(self, models_dir: Path, num_threads: int = 2, files: dict[str, str] | None = None) -> None:
        self.directory = Path(models_dir) / MODEL_DIR_NAME
        self.files = dict(MODEL_FILES if files is None else files)
        self.num_threads = max(1, int(num_threads))
        self._lock = threading.Lock()
        self._sessions: dict[str, Any] = {}
        self._dicts: dict[str, list[str]] = {}
        reason = None
        try:
            import cv2  # noqa: F401
            import onnxruntime  # noqa: F401
        except ImportError as exc:
            reason = f"the {exc.name or 'onnxruntime or cv2'} package is not installed"
        if reason is None:
            missing = sorted(f for f in self.files.values() if not (self.directory / f).is_file())
            if missing:
                reason = f"OCR model files missing in {self.directory}: {', '.join(missing)}"
        self.unavailable_reason: str | None = reason
        self.available: bool = reason is None
        if not self.available:
            log.warning("local page reading unavailable: %s", reason)

    @classmethod
    def from_settings(cls, settings: Settings) -> PPOCRReader:
        return cls(settings.models_dir, num_threads=getattr(settings, "ocr_threads", 2))

    # -- models ------------------------------------------------------------

    def _session(self, role: str) -> Any:
        """The onnxruntime session of ``role`` (call with the lock held)."""
        session = self._sessions.get(role)
        if session is None:
            import onnxruntime as ort

            options = ort.SessionOptions()
            options.intra_op_num_threads = self.num_threads
            options.inter_op_num_threads = 1
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            # No memory arena: the input size changes with every page and box, and an
            # arena would keep the largest page's buffers for the life of the process.
            options.enable_cpu_mem_arena = False
            options.log_severity_level = 3
            started = time.perf_counter()
            session = ort.InferenceSession(
                str(self.directory / self.files[role]), sess_options=options, providers=["CPUExecutionProvider"]
            )
            self._sessions[role] = session
            log.info("ocr: loaded %s in %.2f s", role, time.perf_counter() - started)
        return session

    def _chars(self, role: str) -> list[str]:
        chars = self._dicts.get(role)
        if chars is None:
            chars = self._dicts[role] = _load_dict(self.directory / self.files[role])
        return chars

    def preload(self) -> None:
        """Load every model now, so that the first page is not slower."""
        if not self.available:
            return
        with self._lock:
            for role in ("det", "rec_ar", "rec_latin", "doc_ori"):
                if role in self.files:
                    self._session(role)
            self._chars("dict_ar")
            self._chars("dict_latin")

    # -- steps (call with the lock held) -------------------------------------

    def _orientation(self, bgr: np.ndarray) -> int:
        """0, 90, 180 or 270: how far the page is turned clockwise (the classifier's
        labels); 0 when the classifier is not sure (:data:`ORIENTATION_CONFIDENCE`)."""
        import cv2

        if "doc_ori" not in self.files:
            return 0
        h, w = bgr.shape[:2]
        scale = 256 / min(h, w)
        img = cv2.resize(bgr, (max(224, round(w * scale)), max(224, round(h * scale))), interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]
        top, left = (h - 224) // 2, (w - 224) // 2
        img = img[top : top + 224, left : left + 224].astype(np.float32) / 255.0
        img = (img - np.float32([0.485, 0.456, 0.406])) / np.float32([0.229, 0.224, 0.225])
        session = self._session("doc_ori")
        probs = session.run(None, {session.get_inputs()[0].name: img.transpose(2, 0, 1)[None]})[0][0]
        k = int(np.argmax(probs))
        return (0, 90, 180, 270)[k] if float(probs[k]) >= ORIENTATION_CONFIDENCE else 0

    def _detect(self, bgr: np.ndarray) -> list[TextBox]:
        import cv2

        h, w = bgr.shape[:2]
        scale = min(1.0, DET_MAX_SIDE / max(h, w))
        rh = max(32, int(round(h * scale / 32)) * 32)
        rw = max(32, int(round(w * scale / 32)) * 32)
        img = cv2.resize(bgr, (rw, rh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
        img = (img.astype(np.float32) / 255.0 - np.float32([0.485, 0.456, 0.406])) / np.float32([0.229, 0.224, 0.225])
        x = img.transpose(2, 0, 1)[None]
        del img
        session = self._session("det")
        pred = session.run(None, {session.get_inputs()[0].name: x})[0][0, 0]
        del x
        bitmap = (pred > DET_THRESH).astype(np.uint8)
        contours, _ = cv2.findContours(bitmap, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        sx, sy = w / rw, h / rh
        boxes: list[TextBox] = []
        for contour in contours[:DET_MAX_CANDIDATES]:
            (cx, cy), (bw, bh), angle = cv2.minAreaRect(contour)
            if min(bw, bh) < 3:
                continue
            x0, y0, cw, ch = cv2.boundingRect(contour)
            mask = np.zeros((ch, cw), np.uint8)
            cv2.fillPoly(mask, [contour.reshape(-1, 2) - [x0, y0]], 1)
            if cv2.mean(pred[y0 : y0 + ch, x0 : x0 + cw], mask)[0] < DET_BOX_THRESH:
                continue
            # Unclip: the detector finds a shrunk text kernel; it grows back by
            # area * ratio / perimeter on every side.
            d = bw * bh * DET_UNCLIP_RATIO / (2 * (bw + bh))
            pts = cv2.boxPoints(((cx, cy), (bw + 2 * d, bh + 2 * d), angle))
            pts[:, 0] = np.clip(pts[:, 0] * sx, 0, w - 1)
            pts[:, 1] = np.clip(pts[:, 1] * sy, 0, h - 1)
            box = TextBox(order_points(pts))
            if min(box.width, box.height) >= 5:
                boxes.append(box)
        boxes.sort(key=lambda b: -b.width * b.height)
        return boxes[:MAX_BOXES]

    @staticmethod
    def _crop(bgr: np.ndarray, box: TextBox) -> np.ndarray:
        import cv2

        p = box.points
        width = max(1, int(round(max(np.linalg.norm(p[0] - p[1]), np.linalg.norm(p[3] - p[2])))))
        height = max(1, int(round(max(np.linalg.norm(p[0] - p[3]), np.linalg.norm(p[1] - p[2])))))
        dst = np.float32([[0, 0], [width, 0], [width, height], [0, height]])
        matrix = cv2.getPerspectiveTransform(p, dst)
        crop = cv2.warpPerspective(bgr, matrix, (width, height), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
        if height >= 1.5 * width:  # a vertical box: read it turned
            crop = np.ascontiguousarray(np.rot90(crop))
        return crop

    def _recognize(self, crops: list[np.ndarray], role: str, dict_role: str, stretch: float = 1.0) -> list[Read]:
        """What each crop reads, in visual order, character by character with the
        recogniser's confidence."""
        import cv2

        chars = self._chars(dict_role)
        session = self._session(role)
        name = session.get_inputs()[0].name
        results: list[Read] = [[] for _ in crops]
        ratios = [min(MAX_REC_RATIO, stretch * c.shape[1] / max(c.shape[0], 1)) for c in crops]
        order = np.argsort(ratios, kind="stable")
        for start in range(0, len(crops), REC_BATCH):
            idx = order[start : start + REC_BATCH]
            width = int(math.ceil(REC_HEIGHT * max(320 / REC_HEIGHT, max(ratios[i] for i in idx))))
            batch = np.zeros((len(idx), 3, REC_HEIGHT, width), np.float32)
            for k, i in enumerate(idx):
                rw = min(width, max(1, int(math.ceil(REC_HEIGHT * ratios[i]))))
                img = cv2.resize(crops[i], (rw, REC_HEIGHT), interpolation=cv2.INTER_LINEAR).astype(np.float32)
                batch[k, :, :, :rw] = ((img / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)
            probs = session.run(None, {name: batch})[0]
            best = probs.argmax(axis=2)
            conf = probs.max(axis=2)
            for k, i in enumerate(idx):
                read: Read = []
                prev = 0
                for t, c in enumerate(best[k]):
                    if c != prev and 0 < c < len(chars):
                        read.append((chars[c], float(conf[k, t])))
                    prev = c
                results[i] = read
        return results

    def _read_arabic(self, crops: list[np.ndarray]) -> list[Read]:
        """The Arabic model's reading of each crop, in reading order; a line with many
        marks is read again stretched, and a line with no Arabic letter but Latin ones
        (a French word, a name on an Arabic page) by the Latin model."""
        reads = self._recognize(crops, "rec_ar", "dict_ar", REC_STRETCH["ar"])
        marked = [i for i, r in enumerate(reads) if mark_share("".join(ch for ch, _ in r)) > MARKED_LINE_SHARE]
        if marked:
            again = self._recognize([crops[i] for i in marked], "rec_ar", "dict_ar", REC_STRETCH_MARKED)
            for i, r in zip(marked, again):
                reads[i] = r
        latin = [i for i, r in enumerate(reads) if arabic_share("".join(ch for ch, _ in r)) == 0.0
                 and any(is_latin_letter(ch) for ch, _ in r)]
        out = [reading_order(r) for r in reads]
        if latin:
            for i, r in zip(latin, self._recognize([crops[i] for i in latin], "rec_latin", "dict_latin",
                                                    REC_STRETCH["latin"])):
                out[i] = r
        return out

    def _script(self, crops: list[np.ndarray], lang_hint: Lang | None) -> Lang | None:
        """``"ar"``, or None for Latin script: from the hint when there is one, else
        from the Arabic model's reading of the widest boxes (its alphabet has the Latin
        letters too)."""
        if lang_hint is not None:
            return "ar" if lang_hint == "ar" else None
        sample = sorted(range(len(crops)), key=lambda i: -crops[i].shape[1])[:6]
        # A piece of each line is enough to tell the script (and costs far less).
        pieces = [crops[i][:, : 12 * crops[i].shape[0]] for i in sample]
        reads = self._recognize(pieces, "rec_ar", "dict_ar", REC_STRETCH["ar"])
        return "ar" if arabic_share("".join(ch for r in reads for ch, _ in r)) > 0.5 else None

    def _read(self, bgr: np.ndarray, lang_hint: Lang | None) -> tuple[str, Lang | None, dict[str, int]]:
        turned = self._orientation(bgr)
        if turned:  # turned clockwise by `turned` degrees: turn it back (np.rot90 turns counter-clockwise)
            bgr = np.ascontiguousarray(np.rot90(bgr, k=turned // 90))
        boxes = self._detect(bgr)
        stats = {"boxes": len(boxes), "lines": 0, "turned": turned}
        if not boxes:
            return "", None, stats
        crops = [self._crop(bgr, b) for b in boxes]
        script = self._script(crops, lang_hint)
        if script == "ar":
            reads = self._read_arabic(crops)
        else:
            reads = self._recognize(crops, "rec_latin", "dict_latin", REC_STRETCH["latin"])
        del crops
        kept: list[TextBox] = []
        for box, read in zip(boxes, reads):
            if not read or float(np.mean([conf for _, conf in read])) < MIN_LINE_CONFIDENCE:
                continue
            box.text = tidy(read)
            if box.text and box.text != UNREADABLE:
                kept.append(box)
        lines = drop_page_numbers(order_lines(kept))
        stats["lines"] = len(lines)
        text = join_lines(lines)
        if not text:
            return "", None, stats
        if script == "ar":
            return text, "ar", stats
        if lang_hint in ("en", "fr"):
            return text, lang_hint, stats
        return text, guess_latin_lang(text), stats

    # -- reading -------------------------------------------------------------

    def read_page(self, image_jpeg: bytes, lang_hint: Lang | None, *, timeout: float | None = None) -> dict:
        """Read a printed page: ``{"text", "lang", "notes", "contains_quran": False,
        "needs_manual"}``, the shape of :meth:`mommy.llm.Brain.read_page` (the server
        decides about the Quran from the text). ``needs_manual`` is True when no text
        was read. Waits at most ``timeout`` seconds (None: as long as it takes) for a
        page being read to finish, else raises :class:`OCRBusy`. Raises
        :class:`OCRUnavailable`, or ValueError for an image that cannot be decoded or an
        unknown hint."""
        if lang_hint is not None and lang_hint not in NOTES:
            raise ValueError(f"unsupported language: {lang_hint!r}")
        if not self.available:
            raise OCRUnavailable(self.unavailable_reason or "local page reading is not available")
        started = time.perf_counter()
        bgr = decode_image(image_jpeg)
        if not self._lock.acquire(timeout=-1 if timeout is None else max(0.0, timeout)):
            raise OCRBusy("another page is being read")
        try:
            waited = time.perf_counter()
            text, lang, stats = self._read(bgr, lang_hint)
        finally:
            self._lock.release()
        del bgr
        log.info(
            "ocr: image %d bytes, %d boxes, %d lines, %d chars, turned %d, wait %.2f s, read %.2f s",
            len(image_jpeg), stats["boxes"], stats["lines"], len(text), stats["turned"],
            waited - started, time.perf_counter() - waited,
        )
        lang = lang or lang_hint
        return {
            "text": text,
            "lang": lang,
            "notes": NOTES[lang] if text and lang in NOTES else "",
            "contains_quran": False,
            "needs_manual": not text.strip(),
        }


class FakePageReader:
    """For tests: returns a preset reading and records ``(n_bytes, lang_hint)``."""

    def __init__(self, text: str = "", lang: Lang | None = None, *, available: bool = True,
                 error: Exception | None = None) -> None:
        self.text = text
        self.lang = lang
        self.available = available
        self.unavailable_reason = None if available else "the fake reader is off"
        self.error = error
        self.calls: list[tuple[int, Lang | None]] = []

    def read_page(self, image_jpeg: bytes, lang_hint: Lang | None, *, timeout: float | None = None) -> dict:
        self.calls.append((len(image_jpeg), lang_hint))
        if not self.available:
            raise OCRUnavailable(self.unavailable_reason or "")
        if self.error is not None:
            raise self.error
        lang = self.lang or lang_hint
        return {"text": self.text, "lang": lang, "notes": NOTES.get(lang or "", "") if self.text else "",
                "contains_quran": False, "needs_manual": not self.text.strip()}


__all__ = [
    "DET_MAX_SIDE",
    "MAX_IMAGE_EDGE",
    "MODEL_DIR_NAME",
    "MODEL_FILES",
    "NOTES",
    "UNREADABLE",
    "FakePageReader",
    "Line",
    "OCRBusy",
    "OCRUnavailable",
    "PPOCRReader",
    "PageReader",
    "TextBox",
    "arabic_reading_order",
    "arabic_share",
    "decode_image",
    "drop_page_numbers",
    "guess_latin_lang",
    "is_arabic_letter",
    "is_latin_letter",
    "is_mark",
    "join_lines",
    "mark_share",
    "order_lines",
    "order_points",
    "reading_order",
    "tidy",
]
