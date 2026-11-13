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
   photographed sideways or upside down upright (only when it is confident).
3. Text detection (DB, PP-OCRv6 small det) on the page reduced to at most
   :data:`DET_MAX_SIDE` px: one rotated box per line segment.
4. Each box is cut out straight (perspective warp) and recognised (CTC): Arabic with the
   PP-OCRv5 Arabic model, French and English with the PP-OCRv6 small model. The Arabic
   model writes a line in visual order (left to right); it is turned into reading order
   with numbers and Latin runs kept as they are (:func:`arabic_reading_order`).
5. Reading order (:func:`order_lines`): the boxes are grouped into lines along the
   page's own slope (a photo is rarely straight), the lines run top to bottom, and the
   boxes of a line right to left for Arabic, left to right otherwise. Lines are joined
   into paragraphs with single spaces; a wide vertical gap or a short last line starts
   a new paragraph (``\\n``), as Claude is asked to do.
6. A word the recogniser is unsure of (:data:`UNSURE_WORD_CONFIDENCE`) is written
   ``[?]`` so that the parent types it, as Claude does for a word it cannot read.

Models (``scripts/download_models.sh`` fetches them into ``models/ppocr-onnx/``, each file
checked against its pinned sha256): see :data:`MODEL_FILES`.

Privacy (hard rule 5): the image is only ever in memory (bytes, a Pillow image, numpy
arrays) and never written to disk; logs carry sizes, counts and timings, never text or
pixels. The models are read from disk once (lazily, at the first page) and the network is
never used.

Threads: one lock serialises reading, so at most one page is read at a time, with
``num_threads`` intra-op threads (``MOMMY_OCR_THREADS``).
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
#: ``dict_ar``: Arabic recognition (PP-OCRv5 mobile, the only PP-OCR model for Arabic);
#: ``rec_latin`` + ``dict_latin``: French and English (PP-OCRv6 small, multilingual Latin);
#: ``doc_ori``: page orientation (0/90/180/270).
MODEL_FILES: dict[str, str] = {
    "det": "PP-OCRv6_small_det.onnx",
    "rec_ar": "arabic_PP-OCRv5_mobile_rec.onnx",
    "dict_ar": "ppocrv5_arabic_dict.txt",
    "rec_latin": "PP-OCRv6_small_rec.onnx",
    "dict_latin": "ppocrv6_dict.txt",
    "doc_ori": "PP-LCNet_x1_0_doc_ori.onnx",
}

#: Longest image edge read (pixels): the app's MAX_IMAGE_EDGE (larger images are reduced).
MAX_IMAGE_EDGE = 2000
#: Smallest image edge worth reading (pixels).
MIN_IMAGE_EDGE = 32
#: Longest edge of the image given to the text detector (pixels, a multiple of 32).
DET_MAX_SIDE = 1536
#: DB post-processing (the PP-OCRv6 det defaults).
DET_THRESH = 0.2
DET_BOX_THRESH = 0.45
DET_UNCLIP_RATIO = 1.4
DET_MAX_CANDIDATES = 1000
#: Text recognition input height (pixels) and the batch size.
REC_HEIGHT = 48
REC_BATCH = 8
#: Horizontal stretch of a crop before recognition, by script. The recogniser emits at
#: most one character per 8 px of input width; a line of Arabic with tashkeel has about
#: twice as many characters (letters and marks) per pixel as one without, and in a box
#: tall enough for its marks it is squeezed further, so it is stretched to give every
#: character and mark room.
REC_STRETCH: dict[str, float] = {"ar": 1.0, "latin": 1.0}
#: Most text boxes recognised on one page (a page of a children's book has far fewer).
MAX_BOXES = 400
#: A line whose mean character confidence is below this is dropped (texture, a picture).
MIN_LINE_CONFIDENCE = 0.5
#: A word whose lowest character confidence is below this is written ``[?]``.
UNSURE_WORD_CONFIDENCE = 0.35
#: The page is turned only when the orientation classifier is at least this sure.
ORIENTATION_CONFIDENCE = 0.9

UNREADABLE = "[?]"

#: Notes for the parent, in the language of the page.
NOTES: dict[str, str] = {
    "en": "Read on this server without AI. Please check every word before confirming.",
    "fr": "Lu sur ce serveur, sans IA. Vérifiez chaque mot avant de confirmer.",
    "ar": "قرأ الخادم هذه الصفحة دون ذكاء اصطناعي. يرجى مراجعة كل كلمة وعلامات التشكيل قبل التأكيد.",
}


class OCRUnavailable(RuntimeError):
    """The OCR models or packages are missing."""


@runtime_checkable
class PageReader(Protocol):
    """What the app needs from a local page reader."""

    available: bool

    def read_page(self, image_jpeg: bytes, lang_hint: Lang | None) -> dict:
        """``{"text", "lang", "notes", "contains_quran": False, "needs_manual"}``, as
        :meth:`mommy.llm.Brain.read_page`; raises :class:`OCRUnavailable` or ValueError."""
        ...


# ---------------------------------------------------------------------------
# Text helpers (pure)
# ---------------------------------------------------------------------------


def _is_arabic_letter(ch: str) -> bool:
    return ("ؠ" <= ch <= "ي") or ("ٮ" <= ch <= "ۓ") or ch in "ەۺۻۼ"


def _is_latin_letter(ch: str) -> bool:
    return ch.isalpha() and not _is_arabic_letter(ch) and ord(ch) < 0x0600


def arabic_share(text: str) -> float:
    """Share of Arabic letters among the letters of ``text`` (0.0 with no letter)."""
    ar = sum(1 for ch in text if _is_arabic_letter(ch))
    la = sum(1 for ch in text if _is_latin_letter(ch))
    return ar / (ar + la) if ar + la else 0.0


def _keeps_ltr(ch: str) -> bool:
    """Characters whose runs keep their order inside a reversed Arabic line: Latin
    letters, digits (Western and Arabic-Indic, which are written left to right) and the
    signs inside numbers."""
    if ch.isdigit() or _is_latin_letter(ch):
        return True
    return ch in ".,:%+-/*"


def arabic_reading_order(visual: str) -> str:
    """An Arabic line recognised left to right (visual order) in reading order.

    The characters are reversed, except runs of Latin letters and numbers (with the
    signs inside them), which keep their own order, as PaddleOCR does for its Arabic
    models. A combining mark stays after the letter it belongs to: the recogniser emits
    the mark before its letter in visual order, so after reversing it follows it again;
    a mark left in front of a letter (or a run) by a misread is moved after it.
    """
    runs: list[str] = []
    run = ""
    for ch in visual:
        if _keeps_ltr(ch):
            run += ch
            continue
        if run:
            runs.append(run)
            run = ""
        runs.append(ch)
    if run:
        runs.append(run)
    text = "".join(reversed(runs))
    # A mark at the start or right after a space attaches to nothing: drop it.
    out: list[str] = []
    for ch in text:
        if unicodedata.combining(ch) and (not out or out[-1].isspace()):
            continue
        out.append(ch)
    return "".join(out)


def guess_latin_lang(text: str) -> Lang:
    """"fr" or "en" for a page in Latin script, from accents and common words."""
    words = [w.strip(".,;:!?«»\"'()").casefold() for w in text.split()]
    fr_words = {"le", "la", "les", "des", "et", "est", "une", "un", "du", "de", "dans", "sur", "pour", "avec",
                "il", "elle", "nous", "vous", "ils", "pas", "que", "qui", "au", "aux", "ce", "sa", "son", "ses"}
    en_words = {"the", "and", "is", "a", "an", "of", "to", "in", "on", "with", "he", "she", "it", "we", "you",
                "they", "was", "were", "his", "her", "their", "for", "at", "from", "not", "that", "this"}
    fr = sum(1 for w in words if w in fr_words) + 2 * sum(1 for ch in text if ch in "éèêàùçâîôûëïœ«»")
    en = sum(1 for w in words if w in en_words)
    return "fr" if fr > en else "en"


# ---------------------------------------------------------------------------
# Geometry (pure, numpy)
# ---------------------------------------------------------------------------


@dataclass
class TextBox:
    """One detected text segment: its four corners (clockwise from top-left, in the
    upright page) and, once recognised, its text and confidence."""

    points: np.ndarray  # (4, 2) float32
    text: str = ""
    confidence: float = 0.0
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
    xs = pts[np.argsort(pts[:, 0])]
    left, right = xs[:2], xs[2:]
    tl, bl = left[np.argsort(left[:, 1])]
    tr, br = right[np.argsort(right[:, 1])]
    return np.array([tl, tr, br, bl], dtype=np.float32)


@dataclass
class Line:
    """Boxes read as one printed line, in reading order."""

    boxes: list[TextBox]
    y: float  # position across the page's slope
    x0: float  # extent along it
    x1: float
    height: float

    @property
    def text(self) -> str:
        return " ".join(b.text for b in self.boxes if b.text)


def order_lines(boxes: list[TextBox]) -> list[Line]:
    """Group recognised boxes into printed lines, in reading order.

    The page's slope is the median slope of the wide boxes; positions are measured along
    and across it, so a tilted photo still gives straight lines. A box joins the line
    whose position across the slope is within half a line height of its own; lines run
    top to bottom, and the boxes of a line right to left when most of its letters are
    Arabic, else left to right.
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

    lines: list[list[TextBox]] = []
    ys: list[float] = []
    hs: list[float] = []
    for b in sorted(boxes, key=across):
        y, h = across(b), max(b.height, 1.0)
        best = None
        for k in range(len(lines)):
            if abs(ys[k] - y) < 0.5 * max(hs[k], h) and (best is None or abs(ys[k] - y) < abs(ys[best] - y)):
                best = k
        if best is None:
            lines.append([b])
            ys.append(y)
            hs.append(h)
        else:
            n = len(lines[best])
            lines[best].append(b)
            ys[best] = (ys[best] * n + y) / (n + 1)
            hs[best] = max(hs[best], h)
    out: list[Line] = []
    for members, y, h in zip(lines, ys, hs):
        rtl = arabic_share(" ".join(b.text for b in members)) > 0.5
        members.sort(key=along, reverse=rtl)
        for b in members:
            b.rtl = rtl
        xs0 = [along(b) - b.width / 2 for b in members]
        xs1 = [along(b) + b.width / 2 for b in members]
        out.append(Line(members, y, min(xs0), max(xs1), h))
    out.sort(key=lambda line: line.y)
    return out


def join_lines(lines: list[Line]) -> str:
    """The text of the lines: a paragraph's lines joined by single spaces, paragraphs
    separated by ``\\n``. A new paragraph starts after a vertical gap of more than 0.8 of
    a line height, or after a line that ends well before the block's edge (a title, the
    last line of a paragraph, a line of a list or a poem)."""
    lines = [line for line in lines if line.text.strip()]
    if not lines:
        return ""
    left = float(np.median([line.x0 for line in lines]))
    right = float(np.median([line.x1 for line in lines]))
    width = max(right - left, 1.0)
    paragraphs: list[list[str]] = [[lines[0].text]]
    for prev, line in zip(lines, lines[1:]):
        gap = line.y - prev.y - (prev.height + line.height) / 2
        rtl = prev.boxes[0].rtl
        # The end of a line is its left edge in Arabic, its right edge otherwise.
        short = (prev.x0 - left if rtl else right - prev.x1) > 0.2 * width
        if gap > 0.8 * max(prev.height, line.height) or short:
            paragraphs.append([line.text])
        else:
            paragraphs[-1].append(line.text)
    return "\n".join(" ".join(p) for p in paragraphs)


# ---------------------------------------------------------------------------
# The reader
# ---------------------------------------------------------------------------


def _load_dict(path: Path) -> list[str]:
    """The recogniser's characters: one per line (the CTC blank comes first and a space
    last, as PaddleOCR's ``use_space_char``)."""
    chars = path.read_text(encoding="utf-8").split("\n")
    if chars and chars[-1] == "":
        chars.pop()
    return ["<blank>"] + [c.rstrip("\r") for c in chars] + [" "]


class PPOCRReader:
    """Reads printed pages with PP-OCR ONNX models (see the module docstring).

    The models are loaded at the first page (or by :meth:`preload`), under the lock that
    also serialises reading. ``available`` is False, with ``unavailable_reason``, when a
    model file or the ``onnxruntime`` / ``cv2`` package is missing; :meth:`read_page`
    then raises :class:`OCRUnavailable`.
    """

    name = "local"

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
            reason = f"the {exc.name or 'onnxruntime or opencv'} package is not installed"
        if reason is None:
            missing = [f for f in self.files.values() if not (self.directory / f).is_file()]
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
            # No memory arena: the detector's input size varies from page to page, and an
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
        """Load every model now (the first page is then not slower)."""
        if not self.available:
            return
        with self._lock:
            for role in ("det", "rec_ar", "rec_latin", "doc_ori"):
                if role in self.files:
                    self._session(role)
            self._chars("dict_ar")
            self._chars("dict_latin")

    # -- steps -------------------------------------------------------------

    def _orientation(self, bgr: np.ndarray) -> int:
        """0, 90, 180 or 270: how far the page is turned counter-clockwise, or 0 when
        the classifier is not sure (:data:`ORIENTATION_CONFIDENCE`)."""
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
        x = img.transpose(2, 0, 1)[None]
        session = self._session("doc_ori")
        probs = session.run(None, {session.get_inputs()[0].name: x})[0][0]
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
            score = float(cv2.mean(pred[y0 : y0 + ch, x0 : x0 + cw], mask)[0])
            if score < DET_BOX_THRESH:
                continue
            # Unclip: the shrunk text kernel grows back by area * ratio / perimeter.
            d = bw * bh * DET_UNCLIP_RATIO / (2 * (bw + bh))
            bw, bh = bw + 2 * d, bh + 2 * d
            if min(bw, bh) < 5:
                continue
            pts = cv2.boxPoints(((cx, cy), (bw, bh), angle))
            pts[:, 0] = np.clip(pts[:, 0] * sx, 0, w - 1)
            pts[:, 1] = np.clip(pts[:, 1] * sy, 0, h - 1)
            boxes.append(TextBox(order_points(pts)))
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
            crop = np.rot90(crop)
        return crop

    def _recognize(self, crops: list[np.ndarray], role: str, dict_role: str) -> list[tuple[str, list[float]]]:
        """``(text, per-character confidences)`` of each crop, in visual order."""
        import cv2

        chars = self._chars(dict_role)
        session = self._session(role)
        name = session.get_inputs()[0].name
        results: list[tuple[str, list[float]]] = [("", [])] * len(crops)
        stretch = REC_STRETCH["ar" if role == "rec_ar" else "latin"]
        ratios = [stretch * c.shape[1] / max(c.shape[0], 1) for c in crops]
        order = np.argsort(ratios)
        for start in range(0, len(crops), REC_BATCH):
            idx = order[start : start + REC_BATCH]
            max_ratio = max(320 / REC_HEIGHT, max(ratios[i] for i in idx))
            width = int(math.ceil(REC_HEIGHT * max_ratio))
            batch = np.zeros((len(idx), 3, REC_HEIGHT, width), np.float32)
            for k, i in enumerate(idx):
                rw = min(width, max(1, int(math.ceil(REC_HEIGHT * ratios[i]))))
                img = cv2.resize(crops[i], (rw, REC_HEIGHT), interpolation=cv2.INTER_LINEAR).astype(np.float32)
                batch[k, :, :, :rw] = ((img / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)
            probs = session.run(None, {name: batch})[0]
            best = probs.argmax(axis=2)
            conf = probs.max(axis=2)
            for k, i in enumerate(idx):
                text, confs, prev = [], [], 0
                for t, c in enumerate(best[k]):
                    if c != prev and c != 0 and c < len(chars):
                        text.append(chars[c])
                        confs.append(float(conf[k, t]))
                    prev = c
                results[i] = ("".join(text), confs)
        return results

    # -- reading -----------------------------------------------------------

    def read_page(self, image_jpeg: bytes, lang_hint: Lang | None) -> dict:
        """Read a printed page: ``{"text", "lang", "notes", "contains_quran": False,
        "needs_manual"}`` (the shape of :meth:`mommy.llm.Brain.read_page`; the server
        decides about the Quran from the text). ``needs_manual`` is True when no text
        was read. Raises :class:`OCRUnavailable`, or ValueError for an image that cannot
        be decoded or an unknown hint."""
        if lang_hint is not None and lang_hint not in NOTES:
            raise ValueError(f"unsupported language: {lang_hint!r}")
        if not self.available:
            raise OCRUnavailable(self.unavailable_reason or "local page reading is not available")
        started = time.perf_counter()
        bgr = decode_image(image_jpeg)
        with self._lock:
            waited = time.perf_counter()
            text, lang, stats = self._read(bgr, lang_hint)
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

    def _read(self, bgr: np.ndarray, lang_hint: Lang | None) -> tuple[str, Lang | None, dict[str, int]]:
        turned = self._orientation(bgr)
        if turned:
            # The classifier says the page is turned by `turned` degrees counter-clockwise:
            # turn it back clockwise.
            bgr = np.ascontiguousarray(np.rot90(bgr, k=-(turned // 90)))
        boxes = self._detect(bgr)
        stats = {"boxes": len(boxes), "lines": 0, "turned": turned}
        if not boxes:
            return "", None, stats
        crops = [self._crop(bgr, b) for b in boxes]
        script = self._script(crops, lang_hint)
        if script == "ar":
            read = self._recognize(crops, "rec_ar", "dict_ar")
            latin_again = [i for i, (t, _) in enumerate(read) if t.strip() and arabic_share(t) == 0.0
                           and any(_is_latin_letter(ch) for ch in t)]
            for i, (t, c) in enumerate(read):
                if i not in latin_again:
                    read[i] = (arabic_reading_order(t), c[::-1])
            if latin_again:
                # A line in Latin script on an Arabic page (a French word, a name).
                again = self._recognize([crops[i] for i in latin_again], "rec_latin", "dict_latin")
                for i, r in zip(latin_again, again):
                    read[i] = r
        else:
            read = self._recognize(crops, "rec_latin", "dict_latin")
        del crops
        kept: list[TextBox] = []
        for box, (text, confs) in zip(boxes, read):
            text = " ".join(text.split())
            if not text or not confs or float(np.mean(confs)) < MIN_LINE_CONFIDENCE:
                continue
            box.text = _mark_unsure(text, confs)
            box.confidence = float(np.mean(confs))
            kept.append(box)
        lines = order_lines(kept)
        lines = _drop_page_numbers(lines)
        stats["lines"] = len(lines)
        text = join_lines(lines)
        if not text:
            return "", None, stats
        if lang_hint is not None and (lang_hint == "ar") == (script == "ar"):
            lang: Lang = lang_hint
        else:
            lang = "ar" if script == "ar" else guess_latin_lang(text)
        return text, lang, stats

    def _script(self, crops: list[np.ndarray], lang_hint: Lang | None) -> str:
        """``"ar"`` or ``"latin"``: the hint when there is one, else the Arabic model's
        reading of the widest boxes (its alphabet has Latin letters too)."""
        if lang_hint is not None:
            return "ar" if lang_hint == "ar" else "latin"
        sample = sorted(range(len(crops)), key=lambda i: -crops[i].shape[1])[:8]
        read = self._recognize([crops[i] for i in sample], "rec_ar", "dict_ar")
        return "ar" if arabic_share(" ".join(t for t, _ in read)) > 0.5 else "latin"


def _mark_unsure(text: str, confs: list[float]) -> str:
    """``text`` with each word whose lowest character confidence is under
    :data:`UNSURE_WORD_CONFIDENCE` replaced by ``[?]``. ``confs`` has one value per
    character of the recogniser's output (spaces included)."""
    if len(confs) != len(text):
        return text
    words, pos = [], 0
    for word in text.split(" "):
        low = min(confs[pos : pos + len(word)], default=1.0)
        words.append(UNREADABLE if word and low < UNSURE_WORD_CONFIDENCE else word)
        pos += len(word) + 1
    return " ".join(words)


def _drop_page_numbers(lines: list[Line]) -> list[Line]:
    """Without a first or last line that is only a number (a page number)."""

    def is_number(line: Line) -> bool:
        t = line.text.strip(" -–—.()")
        return 0 < len(t) <= 3 and all(ch.isdigit() for ch in t)

    if len(lines) > 1 and is_number(lines[-1]):
        lines = lines[:-1]
    if len(lines) > 1 and is_number(lines[0]):
        lines = lines[1:]
    return lines


def decode_image(data: bytes) -> np.ndarray:
    """A JPEG or PNG, in memory, as a BGR uint8 array of at most :data:`MAX_IMAGE_EDGE`
    px on the long edge. ValueError when it cannot be decoded or is too small."""
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.width * img.height > 50_000_000:
                raise ValueError("image too large")
            if img.format == "JPEG":
                img.draft("RGB", (MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
            rgb = img.convert("RGB")
    except ValueError:
        raise
    except Exception as exc:  # a broken file: Pillow raises many kinds
        raise ValueError(f"the image could not be decoded ({type(exc).__name__})") from None
    if max(rgb.size) > MAX_IMAGE_EDGE:
        rgb.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
    if min(rgb.size) < MIN_IMAGE_EDGE:
        raise ValueError("image too small")
    return np.ascontiguousarray(np.asarray(rgb)[:, :, ::-1])


class FakePageReader:
    """For tests: returns a preset reading and records ``(n_bytes, lang_hint)``."""

    name = "local"

    def __init__(self, text: str = "", lang: Lang | None = None, *, available: bool = True,
                 error: Exception | None = None) -> None:
        self.text = text
        self.lang = lang
        self.available = available
        self.unavailable_reason = None if available else "fake reader off"
        self.error = error
        self.calls: list[tuple[int, Lang | None]] = []

    def read_page(self, image_jpeg: bytes, lang_hint: Lang | None) -> dict:
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
    "FakePageReader",
    "Line",
    "OCRUnavailable",
    "PPOCRReader",
    "PageReader",
    "TextBox",
    "arabic_reading_order",
    "arabic_share",
    "decode_image",
    "guess_latin_lang",
    "join_lines",
    "order_lines",
    "order_points",
]
