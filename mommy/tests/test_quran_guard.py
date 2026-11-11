"""The Quran guards of the general endpoints, measured on ordinary Arabic.

``tests/arabic_school_sentences.txt`` holds ordinary Arabic school sentences (sections
``ordinary``, ``split`` and ``quranic``) and sentences that quote a whole ayah
(``quotes``, with ``{surah:ayah}`` placeholders filled from the Tanzil text, so no Quran
word is typed). The counts asserted here are the ones quoted in ``docs/CONTRACT.md``:
when the fixture or a rule changes, update both.

The guards (``mommy.app``):

* word by word (strict): :func:`looks_like_quran`, unchanged (runs of 5);
* the voice (``/api/tts``) and every dictation phrase and line: :func:`is_quran_phrase`,
  now with the contained-ayah rule (a whole ayah of K = 3 or 4 words inside the phrase);
* by meaning (contextual): :func:`looks_like_quran_for_meaning`, runs of 4 that do not
  pass through an everyday formula, plus the contained-ayah rule.
"""

from __future__ import annotations

import random
import re
from pathlib import Path

import pytest

from mommy import quran as quran_mod
from mommy.app import (
    QURAN_GUARD_CONTAINED_AYAH_WORDS,
    QURAN_GUARD_CONTEXTUAL_RUN_WORDS,
    QURAN_GUARD_MIN_SCORE,
    QURAN_GUARD_RUN_WORDS,
    contains_short_ayah,
    dictation_speaks_quran,
    is_quran_phrase,
    looks_like_quran,
    looks_like_quran_for_meaning,
)
from mommy.phrases import split_phrases
from mommy.quran import EVERYDAY_AYAT, EVERYDAY_FORMULAS, SHORT_AYAH_MAX_WORDS, Quran, _leading_formula, _speech_key

FIXTURE = Path(__file__).with_name("arabic_school_sentences.txt")
SECTIONS = ("ordinary", "split", "quranic", "quotes")
_PLACEHOLDER = re.compile(r"\{(\d+):(\d+)\}")
#: The last four quotes were first written as ordinary uses of a recognisable Quranic
#: phrase (see the fixture); the counts report them apart.
RECLASSIFIED = 4


@pytest.fixture(scope="module")
def quran(quran_dir: Path) -> Quran:
    return Quran(quran_dir)


def read_fixture() -> dict[str, list[str]]:
    """The fixture's sections, placeholders not yet filled."""
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in FIXTURE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        header = re.fullmatch(r"\[(\w+)\]", line)
        if header:
            current = header[1]
            sections[current] = []
            continue
        assert current is not None, line
        sections[current].append(line)
    return sections


def fill(quran: Quran, sentence: str) -> str:
    return _PLACEHOLDER.sub(lambda m: quran.ayat(int(m[1]), int(m[2]), int(m[2]))[0].match, sentence)


@pytest.fixture(scope="module")
def sentences(quran: Quran) -> dict[str, list[str]]:
    return {name: [fill(quran, s) for s in lines] for name, lines in read_fixture().items()}


@pytest.fixture(scope="module")
def non_quotes(sentences: dict[str, list[str]]) -> list[str]:
    return sentences["ordinary"] + sentences["split"] + sentences["quranic"]


def voice_scopes(text: str) -> set[str]:
    """Everything the voice could be asked to say for ``text``: the text itself, its
    dictation phrases and its lines."""
    return {text, *split_phrases(text, "ar"), *(line.strip() for line in text.splitlines() if line.strip())}


def raw_contained(quran: Quran, text: str, k: int) -> bool:
    """A whole ayah of k..4 words inside ``text``, without the everyday-ayat list."""
    keys = [_speech_key(t) for t in quran.strip_framing(text)[0]]
    return any(
        tuple(keys[i : i + n]) in quran._ayah_by_keys
        for n in range(k, SHORT_AYAH_MAX_WORDS + 1)
        for i in range(len(keys) - n + 1)
    )


def count(texts: list[str], test) -> int:
    return sum(1 for t in texts if test(t))


# ---------------------------------------------------------------------------
# The fixture
# ---------------------------------------------------------------------------


class TestFixture:
    def test_sections_and_size(self) -> None:
        raw = read_fixture()
        assert tuple(raw) == SECTIONS
        assert len(raw["ordinary"]) >= 250
        assert sum(len(raw[s]) for s in ("ordinary", "split", "quranic")) == 324
        everything = [s for lines in raw.values() for s in lines]
        assert len(everything) == len(set(everything)), "duplicate sentences"
        # Only the quotes hold Quran words, and only through placeholders.
        for name in ("ordinary", "split", "quranic"):
            assert not any("{" in s for s in raw[name]), name
        assert all(_PLACEHOLDER.search(s) for s in raw["quotes"])

    def test_the_task_examples_and_formulas_are_in_it(self) -> None:
        ordinary = read_fixture()["ordinary"]
        text = "\n".join(ordinary)
        for formula in ("إن شاء الله", "الحمد لله على السلامة", "بسم الله نبدأ", "السلام عليكم", "جزاك الله خيرًا", "سبحان الله"):
            assert formula in text, formula
        assert "ثم نظر إلى السماء." in ordinary

    def test_quotes_quote_a_short_ayah(self, quran: Quran) -> None:
        for sentence in read_fixture()["quotes"]:
            for m in _PLACEHOLDER.finditer(sentence):
                words = quran.ayat(int(m[1]), int(m[2]), int(m[2]))[0].match_words
                assert 2 <= len(words) <= SHORT_AYAH_MAX_WORDS, m[0]


# ---------------------------------------------------------------------------
# The contained-ayah rule (voice and dictation phrases): K = 3
# ---------------------------------------------------------------------------


class TestContainedAyahRule:
    def test_k_is_three(self) -> None:
        assert QURAN_GUARD_CONTAINED_AYAH_WORDS == 3 and SHORT_AYAH_MAX_WORDS == 4 == QURAN_GUARD_RUN_WORDS - 1

    def test_measured_refusals_per_k(self, quran: Quran, sentences: dict[str, list[str]], non_quotes: list[str]) -> None:
        """How many sentences each K refuses at phrase scope (the sentence, a phrase or a
        line of it holds a whole ayah of K..4 words), without the everyday-ayat list."""
        quotes = sentences["quotes"]
        reclassified, quoting = quotes[-RECLASSIFIED:], quotes[:-RECLASSIFIED]

        def refused(texts: list[str], k: int) -> int:
            return count(texts, lambda t: any(raw_contained(quran, p, k) for p in voice_scopes(t)))

        table = {k: (refused(non_quotes, k), refused(reclassified, k), refused(quoting, k)) for k in (2, 3, 4)}
        assert table == {2: (32, 4, 13), 3: (11, 4, 13), 4: (0, 1, 10)}

    def test_no_false_positives_at_the_chosen_k(self, quran: Quran, non_quotes: list[str]) -> None:
        for text in non_quotes:
            for part in voice_scopes(text):
                assert not contains_short_ayah(part, quran), part

    def test_the_everyday_ayat_are_exactly_the_three_word_hits(self, quran: Quran, non_quotes: list[str]) -> None:
        # Every listed ayah was measured in an ordinary sentence, and nothing else was.
        hits = set()
        for text in non_quotes:
            keys = [_speech_key(t) for t in quran.strip_framing(text)[0]]
            for i in range(len(keys) - 2):
                where = quran._ayah_by_keys.get(tuple(keys[i : i + 3]))
                if where:
                    hits.add(where)
        assert hits == set(EVERYDAY_AYAT)

    def test_quotes_are_refused_for_the_voice_and_dictation_only(self, quran: Quran, sentences: dict[str, list[str]]) -> None:
        for text in sentences["quotes"]:
            assert not looks_like_quran(text, quran), text  # still recited word by word
            assert contains_short_ayah(text, quran) and is_quran_phrase(text, quran), text
            assert dictation_speaks_quran(text, "ar", quran), text

    def test_two_word_ayat_count_only_as_a_phrase_of_their_own(self, quran: Quran) -> None:
        two = " ".join(quran.ayat(74, 21, 21)[0].match_words)
        assert len(two.split()) == 2
        assert not is_quran_phrase(two + " إلى السماء", quran)
        assert is_quran_phrase(two, quran)  # the earlier whole-ayah rule

    def test_everyday_ayat_are_still_whole_ayat(self, quran: Quran) -> None:
        for surah, ayah in EVERYDAY_AYAT:
            words = quran.ayat(surah, ayah, ayah)[0].match_words
            assert not contains_short_ayah("في المدرسة " + " ".join(words), quran)
            assert is_quran_phrase(" ".join(words), quran)  # exactly the ayah: a whole ayah


# ---------------------------------------------------------------------------
# Contextual mode: runs of 4, everyday formulas left out, and K
# ---------------------------------------------------------------------------


class TestContextualRule:
    def test_threshold_is_four(self) -> None:
        assert QURAN_GUARD_CONTEXTUAL_RUN_WORDS == 4 and QURAN_GUARD_RUN_WORDS == 5

    def test_measured_refusals_per_threshold(self, quran: Quran, sentences: dict[str, list[str]], non_quotes: list[str]) -> None:
        quotes = sentences["quotes"]
        reclassified, quoting = quotes[-RECLASSIFIED:], quotes[:-RECLASSIFIED]

        def runs(texts: list[str], n: int, exclude: bool) -> int:
            return count(texts, lambda t: bool(quran.quran_runs(quran.strip_framing(t)[0], n, exclude_formulas=exclude)))

        table = {
            (n, exclude): (runs(non_quotes, n, exclude), runs(reclassified, n, exclude), runs(quoting, n, exclude))
            for n in (3, 4, 5)
            for exclude in (False, True)
        }
        assert table == {
            (3, False): (35, 4, 13), (3, True): (22, 4, 9),
            (4, False): (8, 1, 10), (4, True): (2, 1, 6),
            (5, False): (0, 0, 0), (5, True): (0, 0, 0),
        }

    def test_formulas_left_out_are_the_ordinary_formula_sentences(self, quran: Quran, non_quotes: list[str]) -> None:
        # The six run-of-4 refusals that leaving the formulas out removes are all
        # sentences around an everyday formula.
        removed = [
            t for t in non_quotes
            if quran.quran_runs(quran.strip_framing(t)[0], 4)
            and not quran.quran_runs(quran.strip_framing(t)[0], 4, exclude_formulas=True)
        ]
        assert len(removed) == 6
        keys = [[_speech_key(w) for w in f.split()] for f in EVERYDAY_FORMULAS]
        for text in removed:
            words = [_speech_key(w) for w in quran.strip_framing(text)[0]]
            assert any(words[i : i + len(f)] == f for f in keys for i in range(len(words))), text

    def test_k_adds_no_false_positive_in_contextual_mode(self, quran: Quran, non_quotes: list[str]) -> None:
        runs_only = {t for t in non_quotes if quran.quran_runs(quran.strip_framing(t)[0], 4, exclude_formulas=True)}
        with_k = {t for t in non_quotes if looks_like_quran_for_meaning(t, quran)}
        assert with_k == runs_only

    def test_sections(self, quran: Quran, sentences: dict[str, list[str]]) -> None:
        for name in ("ordinary", "split"):
            for text in sentences[name]:
                assert not looks_like_quran_for_meaning(text, quran), text
        for name in ("quranic", "quotes"):
            for text in sentences[name]:
                assert looks_like_quran_for_meaning(text, quran), text


# ---------------------------------------------------------------------------
# Every guard on every section
# ---------------------------------------------------------------------------


class TestGuardsOnTheFixture:
    def test_word_by_word_accepts_every_sentence(self, quran: Quran, sentences: dict[str, list[str]]) -> None:
        for name in SECTIONS:
            for text in sentences[name]:
                assert not looks_like_quran(text, quran), text

    def test_dictation_and_the_voice(self, quran: Quran, sentences: dict[str, list[str]]) -> None:
        for name in ("ordinary", "quranic"):
            for text in sentences[name]:
                assert not dictation_speaks_quran(text, "ar", quran), text
        for text in sentences["ordinary"]:
            for part in voice_scopes(text):
                assert not is_quran_phrase(part, quran), part
        for name in ("split", "quotes"):
            for text in sentences[name]:
                assert dictation_speaks_quran(text, "ar", quran), text

    def test_the_split_sentences_were_already_refused_by_the_voice(self, quran: Quran, sentences: dict[str, list[str]]) -> None:
        # Before the contained-ayah rule, /api/tts refused one of their phrases.
        for text in sentences["split"]:
            phrases = split_phrases(text, "ar")
            assert any(looks_like_quran(p, quran) or quran.whole_ayah(quran.strip_framing(p)[0]) for p in phrases), text


# ---------------------------------------------------------------------------
# The Quran helpers behind the rules
# ---------------------------------------------------------------------------


class TestQuranHelpers:
    def test_contained_ayat(self, quran: Quran) -> None:
        ayah = quran.ayat(112, 1, 1)[0].match_words
        tokens = ["ذهب", *ayah, "يا", "أحمد"]
        assert quran.contained_ayat(tokens, 3) == [(1, 1 + len(ayah), 112, 1)]
        two = quran.ayat(74, 21, 21)[0].match_words
        assert quran.contained_ayat([*two, "إلى", "السماء"], 3) == []
        assert quran.contained_ayat([*two, "إلى", "السماء"], 2) == [(0, 2, 74, 21)]
        long_ayah = quran.ayat(2, 255, 255)[0].match_words  # longer than 4: a run of 5
        assert quran.contained_ayat(long_ayah, 3) == [] and quran.quran_runs(long_ayah, 5)
        with pytest.raises(ValueError):
            quran.contained_ayat(tokens, 1)

    def test_everyday_ayat_are_listed_by_number(self) -> None:
        source = Path(quran_mod.__file__).read_text(encoding="utf-8")
        block = source[source.index("EVERYDAY_AYAT: tuple") : source.index("SHORT_AYAH_MAX_WORDS = ")]
        assert not re.search(r"[؀-ۿ]", block)  # no Quran word typed in the code
        assert len(EVERYDAY_AYAT) == len(set(EVERYDAY_AYAT)) == 8

    def test_a_listed_ayah_that_is_not_three_words_stops_loading(
        self, quran_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(quran_mod, "EVERYDAY_AYAT", ((112, 1),))  # four words
        with pytest.raises(ValueError, match="EVERYDAY_AYAT"):
            Quran(quran_dir)

    def test_runs_do_not_pass_through_formulas(self, quran: Quran) -> None:
        tokens = "قالت المعلمة لا إله إلا الله محمد رسول الله".split()
        assert quran.quran_runs(tokens, 4)
        assert quran.quran_runs(tokens, 4, exclude_formulas=True) == []
        quote = quran.ayat(112, 1, 1)[0].match_words + ["يا", "أحمد"]
        assert quran.quran_runs(quote, 4, exclude_formulas=True) == [(0, 4)]

    def test_locate_min_score_keeps_every_good_candidate(self, quran: Quran, sentences: dict[str, list[str]]) -> None:
        rng = random.Random(3)
        texts = [s for lines in sentences.values() for s in lines]
        for surah in (1, 36, 67, 78, 112):
            words = [w for a in quran.ayat(surah, 1, min(quran.ayah_count(surah), 4)) for w in a.match_words]
            texts.append(" ".join(words))
            changed = list(words)
            changed[rng.randrange(len(changed))] = "المدرسة"
            texts.append(" ".join(changed))
            texts.append(quran.basmala_match + " " + " ".join(changed))
        for text in texts:
            full = [c for c in quran.locate(text, top_k=5) if c["score"] >= QURAN_GUARD_MIN_SCORE]
            fast = [c for c in quran.locate(text, top_k=5, min_score=QURAN_GUARD_MIN_SCORE) if c["score"] >= QURAN_GUARD_MIN_SCORE]
            assert fast == full, text

    def test_leading_formula_fast_exit_changes_nothing(self, quran: Quran, sentences: dict[str, list[str]]) -> None:
        def reference(formula: list[str], heard: list[str], max_errors: int) -> tuple[int, int] | None:
            f, best = len(formula), None
            for k in range(max(1, f - max_errors), min(len(heard), f + max_errors) + 1):
                errors = quran_mod._count_errors(formula, heard[:k])
                cand = (errors, abs(k - f), k)
                if best is None or cand < best:
                    best = cand
            return None if best is None or best[0] > max_errors else (best[2], best[0])

        formulas = [quran._istiadha_keys, quran._basmala_keys]
        texts = [s for lines in sentences.values() for s in lines]
        texts += [quran.basmala_match + " " + s for s in texts[:40]]
        texts += [" ".join(quran.basmala_match.split()[1:]) + " " + s for s in texts[:20]]
        for text in texts:
            keys = [_speech_key(t) for t in text.split()]
            for formula in formulas:
                for max_errors in (0, 1, 2):
                    assert _leading_formula(formula, keys, max_errors) == reference(formula, keys, max_errors), text
