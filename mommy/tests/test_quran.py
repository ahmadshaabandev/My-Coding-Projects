"""Tests for mommy.quran.

No Quran word is typed in this file: every word is read from the verbatim Tanzil files
(by position) or comes from the module itself (the basmala of 1:1, the contract's
isti'adha). The Tanzil files are only read; tests that need broken files write modified
copies into pytest's temporary directory.
"""

from __future__ import annotations

import ast
import hashlib
import json
import random
import re
import shutil
import subprocess
import sys
import time
from collections import Counter
from functools import lru_cache
from pathlib import Path

import pytest

from mommy import quran as quran_module
from mommy.align import recitation_key
from mommy.quran import (
    ATTRIBUTION,
    ISTIADHA,
    MAX_MERGE,
    N_AYAT,
    N_SURAHS,
    Ayah,
    Quran,
    build_word_map,
    display_tokens,
    is_pause_mark_token,
    read_surah_metadata,
    read_tanzil_text,
    search_word_map,
)
from mommy.textnorm import has_arabic, tokenize

MOMMY_ROOT = Path(__file__).resolve().parent.parent
QURAN_DIR = MOMMY_ROOT / "data" / "quran"

#: sha256 of https://tanzil.net/res/text/metadata/quran-data.js as downloaded.
METADATA_SHA256 = "9e9930c592aaa34b5c7a79ff4e99ffdc782263a266090bfe2c49e4ed4bac4ca4"

SEED = 20261111


def key(word: str) -> str:
    return recitation_key(word, "ar")


# ---------------------------------------------------------------------------
# Independent readers of the raw files (do not reuse the module's parser)
# ---------------------------------------------------------------------------


@lru_cache(maxsize=None)
def raw(name: str) -> dict[tuple[int, int], str]:
    verses: dict[tuple[int, int], str] = {}
    for line in (QURAN_DIR / name).read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        surah, ayah, text = line.split("|", 2)
        verses[(int(surah), int(ayah))] = text
    return verses


def raw_uthmani() -> dict[tuple[int, int], str]:
    return raw("quran-uthmani.txt")


def raw_clean() -> dict[tuple[int, int], str]:
    return raw("quran-simple-clean.txt")


def basmala_surahs() -> list[int]:
    return [s for s in range(1, N_SURAHS + 1) if s not in (1, 9)]


@pytest.fixture(scope="module")
def q() -> Quran:
    return Quran(QURAN_DIR)


def all_ayat(q: Quran) -> list[Ayah]:
    return [a for s in q.surahs() for a in q.ayat(s["number"], 1, s["ayah_count"])]


def match_text(q: Quran, surah: int, start: int, end: int) -> str:
    return " ".join(a.match for a in q.ayat(surah, start, end))


def other_word(q: Quran, *avoid: str, seed: int = 0) -> str:
    """A Quran word (from the files) whose speech key differs from every ``avoid``."""
    rng = random.Random(seed)
    words = [w for a in q.ayat(2, 1, 20) for w in a.match_words]
    avoided = {key(w) for w in avoid}
    while True:
        w = rng.choice(words)
        if key(w) not in avoided:
            return w


# ---------------------------------------------------------------------------
# Loading and validation
# ---------------------------------------------------------------------------


def test_metadata_file_is_the_verbatim_tanzil_download() -> None:
    data = (QURAN_DIR / "quran-data.js").read_bytes()
    assert hashlib.sha256(data).hexdigest() == METADATA_SHA256
    assert b"Tanzil" in data[:200]


def test_both_text_files_list_the_same_6236_ayat() -> None:
    assert len(raw_uthmani()) == N_AYAT == 6236
    assert list(raw_uthmani()) == list(raw_clean())


def test_loads_every_ayah_in_file_order(q: Quran) -> None:
    ayat = all_ayat(q)
    assert len(ayat) == N_AYAT
    assert [(a.surah, a.ayah) for a in ayat] == list(raw_clean())


def test_licence_lines_are_not_ayat(q: Quran) -> None:
    assert all("#" not in a.display and "#" not in a.match for a in all_ayat(q))
    assert "Tanzil Quran Text (Uthmani, Version 1.1)" in q.licence
    assert "Creative Commons Attribution 3.0" in q.licence
    _, licence = read_tanzil_text(QURAN_DIR / "quran-simple-clean.txt")
    assert any("Simple Clean" in line for line in licence)


def test_construction_does_not_modify_the_tanzil_files() -> None:
    names = ["quran-uthmani.txt", "quran-simple-clean.txt", "quran-data.js"]
    before = {n: hashlib.sha256((QURAN_DIR / n).read_bytes()).hexdigest() for n in names}
    Quran(QURAN_DIR)
    after = {n: hashlib.sha256((QURAN_DIR / n).read_bytes()).hexdigest() for n in names}
    assert before == after


def test_attribution_and_constants(q: Quran) -> None:
    assert q.attribution == ATTRIBUTION
    assert ATTRIBUTION == "Quran text: Tanzil Project (tanzil.net), Hafs, Uthmani v1.1, CC BY 3.0, verbatim"
    assert Quran.attribution == ATTRIBUTION
    assert quran_module.SOURCE_URL == "https://tanzil.net"
    assert quran_module.RIWAYA == "hafs"


def test_surahs_come_from_the_metadata_and_agree_with_the_text(q: Quran) -> None:
    surahs = q.surahs()
    assert [s["number"] for s in surahs] == list(range(1, 115))
    counts = Counter(s for s, _ in raw_clean())
    assert all(s["ayah_count"] == counts[s["number"]] for s in surahs)
    assert sum(s["ayah_count"] for s in surahs) == 6236
    assert {"number", "name_ar", "ayah_count"} <= set(surahs[0])

    # An independent reading of the Arabic names from the metadata file.
    text = (QURAN_DIR / "quran-data.js").read_text(encoding="utf-8")
    sura_block = text[text.index("QuranData.Sura") : text.index("QuranData.Juz")]
    rows = re.findall(r"\[(\d+), (\d+), \d+, \d+, '([^']+)',", sura_block)
    assert len(rows) == 114
    assert [s["name_ar"] for s in surahs] == [name for _, _, name in rows]
    assert [s["ayah_count"] for s in surahs] == [int(n) for _, n, _ in rows]
    assert all(has_arabic(s["name_ar"]) for s in surahs)
    assert len({s["name_ar"] for s in surahs}) == 114


def test_surahs_returns_fresh_dicts(q: Quran) -> None:
    q.surahs()[0]["name_ar"] = "x"
    assert q.surahs()[0]["name_ar"] != "x"


def test_read_surah_metadata_rows() -> None:
    rows = read_surah_metadata(QURAN_DIR / "quran-data.js")
    assert len(rows) == 114
    assert rows[0].start == 0 and rows[-1].start + rows[-1].ayah_count == 6236
    assert all(r.revelation in ("Meccan", "Medinan") for r in rows)
    assert all(rows[i + 1].start == rows[i].start + rows[i].ayah_count for i in range(113))


def test_read_surah_metadata_unescapes_js_strings(tmp_path: Path) -> None:
    real = read_surah_metadata(QURAN_DIR / "quran-data.js")
    lines = [
        "var QuranData = {};",
        "QuranData.Sura = [",
        "\t// [start, ayas, order, rukus, name, tname, ename, type]",
        "\t[],",
    ]
    for r in real:
        names = f"'n\\'{r.number}', \"t\\u0041{r.number}\", 'e', 'Meccan'"
        lines.append(f"\t[{r.start}, {r.ayah_count}, {r.order}, {r.rukus}, {names}],")
    lines += ["\t[6236, 1]", "];", ""]
    path = tmp_path / "quran-data.js"
    path.write_text("\n".join(lines), encoding="utf-8")
    parsed = read_surah_metadata(path)
    assert parsed[0].name_ar == "n'1" and parsed[0].name_translit == "tA1"
    assert [p.ayah_count for p in parsed] == [r.ayah_count for r in real]


def _copy_quran_dir(tmp_path: Path) -> Path:
    target = tmp_path / "quran"
    target.mkdir()
    for name in ("quran-uthmani.txt", "quran-simple-clean.txt", "quran-data.js"):
        shutil.copyfile(QURAN_DIR / name, target / name)
    return target


def _edit_lines(path: Path, edit) -> None:
    lines = path.read_text(encoding="utf-8").split("\n")
    path.write_text("\n".join(edit(lines)), encoding="utf-8")


def test_rejects_a_missing_ayah(tmp_path: Path) -> None:
    d = _copy_quran_dir(tmp_path)
    _edit_lines(d / "quran-simple-clean.txt", lambda ls: [l for l in ls if not l.startswith("114|6|")])
    with pytest.raises(ValueError, match="6235 ayat"):
        Quran(d)


def test_rejects_different_keys_in_the_two_files(tmp_path: Path) -> None:
    d = _copy_quran_dir(tmp_path)

    def swap(ls: list[str]) -> list[str]:
        i = next(k for k, l in enumerate(ls) if l.startswith("2|1|"))
        ls[i], ls[i + 1] = ls[i + 1], ls[i]
        return ls

    _edit_lines(d / "quran-uthmani.txt", swap)
    with pytest.raises(ValueError, match="same order"):
        Quran(d)


def test_rejects_a_malformed_line(tmp_path: Path) -> None:
    d = _copy_quran_dir(tmp_path)
    _edit_lines(d / "quran-uthmani.txt", lambda ls: [l.replace("|", " ", 1) if l.startswith("3|5|") else l for l in ls])
    with pytest.raises(ValueError, match="sura\\|aya\\|text"):
        Quran(d)


def test_rejects_a_missing_licence_block(tmp_path: Path) -> None:
    d = _copy_quran_dir(tmp_path)
    _edit_lines(d / "quran-uthmani.txt", lambda ls: [l for l in ls if not l.startswith("#")])
    with pytest.raises(ValueError, match="licence"):
        Quran(d)


def test_rejects_metadata_that_disagrees_with_the_text(tmp_path: Path) -> None:
    d = _copy_quran_dir(tmp_path)
    text = (d / "quran-data.js").read_text(encoding="utf-8")
    # Move one ayah from surah 113 to surah 114: offsets and the total still add up.
    rows = re.findall(r"\t\[(\d+), (\d+), (\d+), (\d+), ", text)
    s113, s114 = rows[112], rows[113]
    text = text.replace(f"[{s113[0]}, {s113[1]}, ", f"[{s113[0]}, {int(s113[1]) - 1}, ", 1)
    text = text.replace(f"[{s114[0]}, {s114[1]}, ", f"[{int(s114[0]) - 1}, {int(s114[1]) + 1}, ", 1)
    (d / "quran-data.js").write_text(text, encoding="utf-8")
    with pytest.raises(ValueError, match="surah 113"):
        Quran(d)


def test_rejects_a_missing_metadata_file(tmp_path: Path) -> None:
    d = _copy_quran_dir(tmp_path)
    (d / "quran-data.js").unlink()
    with pytest.raises(FileNotFoundError):
        Quran(d)


def test_rejects_metadata_without_the_surah_table(tmp_path: Path) -> None:
    path = tmp_path / "quran-data.js"
    path.write_text("var QuranData = {};\n", encoding="utf-8")
    with pytest.raises(ValueError, match="QuranData.Sura"):
        read_surah_metadata(path)


# ---------------------------------------------------------------------------
# Basmala
# ---------------------------------------------------------------------------


def test_basmala_is_read_from_1_1(q: Quran) -> None:
    assert q.basmala_match == raw_clean()[(1, 1)]
    assert q.basmala_display == raw_uthmani()[(1, 1)]
    assert len(q.basmala_match.split()) == 4


def test_2_1_match_words_are_the_rest_of_the_line(q: Quran) -> None:
    ayah = q.ayat(2, 1, 1)[0]
    clean, uthmani = raw_clean()[(2, 1)], raw_uthmani()[(2, 1)]
    assert ayah.match_words == clean.split()[4:]
    assert ayah.match == " ".join(clean.split()[4:])
    assert ayah.display_words == display_tokens(uthmani)[4:]
    assert ayah.display == uthmani.split(" ", 4)[4]
    assert q.raw_lines(2, 1) == (uthmani, clean)


def test_1_1_keeps_the_basmala(q: Quran) -> None:
    ayah = q.ayat(1, 1, 1)[0]
    assert ayah.match == raw_clean()[(1, 1)] == q.basmala_match
    assert ayah.display == raw_uthmani()[(1, 1)]
    assert ayah.match_words == q.basmala_match.split()


def test_9_1_has_no_basmala(q: Quran) -> None:
    ayah = q.ayat(9, 1, 1)[0]
    assert ayah.match == raw_clean()[(9, 1)]
    assert ayah.display == raw_uthmani()[(9, 1)]
    assert ayah.match_words[:4] != q.basmala_match.split()


def test_basmala_prefix_is_removed_in_all_112_surahs(q: Quran) -> None:
    basmala_keys = [key(w) for w in q.basmala_match.split()]
    differs_from_1_1: set[int] = set()
    for s in basmala_surahs():
        ayah = q.ayat(s, 1, 1)[0]
        clean, uthmani = raw_clean()[(s, 1)], raw_uthmani()[(s, 1)]
        assert clean == q.basmala_match + " " + ayah.match
        assert uthmani.endswith(ayah.display) and ayah.display
        prefix = uthmani[: len(uthmani) - len(ayah.display)].strip()
        assert [key(w) for w in display_tokens(prefix)] == basmala_keys
        assert ayah.display_words == display_tokens(uthmani)[4:]
        if prefix != q.basmala_display:
            differs_from_1_1.add(s)
    # Measured: two surahs spell the Uthmani basmala with an extra mark, which is why
    # the prefix is compared on speech keys rather than bytes.
    assert differs_from_1_1 == {95, 97}


def test_basmala_inside_an_ayah_is_untouched(q: Quran) -> None:
    hits = [k for k, text in raw_clean().items() if q.basmala_match in text and k[1] != 1]
    assert hits  # the basmala also occurs inside an ayah
    for s, a in hits:
        assert q.ayat(s, a, a)[0].match == raw_clean()[(s, a)]


# ---------------------------------------------------------------------------
# Display words and pause marks
# ---------------------------------------------------------------------------


def test_display_and_match_are_verbatim(q: Quran) -> None:
    for a in all_ayat(q):
        uthmani, clean = q.raw_lines(a.surah, a.ayah)
        if a.ayah == 1 and a.surah not in (1, 9):
            assert uthmani.endswith(" " + a.display) and clean.endswith(" " + a.match)
        else:
            assert (a.display, a.match) == (uthmani, clean)
        assert a.match_words == a.match.split()


def test_standalone_pause_marks_are_not_display_words(q: Quran) -> None:
    skipped = 0
    for a in all_ayat(q):
        assert not any(is_pause_mark_token(w) for w in a.display_words)
        tokens = a.display.split()
        assert a.display_words == [t for t in tokens if not is_pause_mark_token(t)]
        skipped += len(tokens) - len(a.display_words)
    expected = sum(
        1 for text in raw_uthmani().values() for t in text.split() if all("\u06d6" <= c <= "\u06ed" for c in t)
    )
    assert skipped == expected == 4379  # measured


def test_pause_marks_stay_in_the_display_line(q: Quran) -> None:
    ayah = q.ayat(2, 2, 2)[0]
    marks = [t for t in ayah.display.split() if is_pause_mark_token(t)]
    assert marks  # 2:2 has standalone pause marks
    assert not set(marks) & set(ayah.display_words)
    assert len(ayah.display_words) == len(ayah.match_words)


def test_is_pause_mark_token() -> None:
    marks = [t for t in raw_uthmani()[(2, 2)].split() if all("\u06d6" <= c <= "\u06ed" for c in t)]
    assert marks and all(is_pause_mark_token(m) for m in marks)
    assert not is_pause_mark_token("")
    assert not is_pause_mark_token(raw_uthmani()[(2, 2)].split()[0])


# ---------------------------------------------------------------------------
# word_map
# ---------------------------------------------------------------------------


def test_word_counts_differ_in_363_ayat(q: Quran) -> None:
    diffs = Counter(len(a.match_words) - len(a.display_words) for a in all_ayat(q))
    n_differ = sum(n for d, n in diffs.items() if d)
    assert n_differ == 363  # measured: 359 by one word, 4 by two
    assert diffs[1] == 359 and diffs[2] == 4
    assert all(d >= 0 for d in diffs)  # Simple-Clean is never shorter


def test_every_word_map_is_monotonic_in_range_and_complete(q: Quran) -> None:
    for a in all_ayat(q):
        m = a.word_map
        assert len(m) == len(a.match_words)
        assert m[0] == 0 and m[-1] == len(a.display_words) - 1
        assert all(0 <= x - y <= 1 for x, y in zip(m[1:], m)), (a.surah, a.ayah)
        assert set(m) == set(range(len(a.display_words)))


def test_equal_word_counts_give_identity_maps(q: Quran) -> None:
    for a in all_ayat(q):
        if len(a.match_words) == len(a.display_words):
            assert a.word_map == list(range(len(a.match_words)))


def test_merged_display_words_spell_their_match_words(q: Quran) -> None:
    inexact: set[tuple[int, int]] = set()
    merges = 0
    for a in all_ayat(q):
        groups: dict[int, list[str]] = {}
        for i, j in enumerate(a.word_map):
            groups.setdefault(j, []).append(a.match_words[i])
        for j, words in groups.items():
            if len(words) < 2:
                continue
            merges += 1
            if "".join(key(w) for w in words) != key(a.display_words[j]):
                inexact.add((a.surah, a.ayah))
    # 359 ayat with one 2-to-1 merge; of the 4 ayat two words longer, three have two
    # 2-to-1 merges and 20:94 has one 3-to-1 merge.
    assert merges == 359 + 3 * 2 + 1
    # Measured: two assimilated spellings that are not plain concatenations.
    assert inexact == {(20, 94), (72, 16)}


def test_vocative_written_as_one_uthmani_word(q: Quran) -> None:
    ayah = q.ayat(2, 21, 21)[0]
    assert len(ayah.match_words) == len(ayah.display_words) + 1
    assert ayah.word_map[:3] == [0, 0, 1]
    assert key(ayah.match_words[0]) + key(ayah.match_words[1]) == key(ayah.display_words[0])


def test_three_match_words_on_one_display_word(q: Quran) -> None:
    ayah = q.ayat(20, 94, 94)[0]
    assert len(ayah.match_words) == len(ayah.display_words) + 2
    assert ayah.word_map[:5] == [0, 1, 1, 1, 2]


def test_anchored_maps_equal_the_full_search(q: Quran) -> None:
    checked = 0
    for a in all_ayat(q):
        mk, dk = [key(w) for w in a.match_words], [key(w) for w in a.display_words]
        if mk == dk:
            continue
        checked += 1
        assert search_word_map(mk, dk) == a.word_map, (a.surah, a.ayah)
    assert checked == 699  # measured: ayat whose keys are not all equal


@pytest.mark.parametrize(
    ("match", "display", "expected"),
    [
        (["ab", "cd"], ["ab", "cd"], [0, 1]),
        (["ab", "cd", "ef"], ["abcd", "ef"], [0, 0, 1]),
        (["ab", "cd", "ef"], ["ab", "cdef"], [0, 1, 1]),
        (["ab", "cd", "ef", "gh"], ["abcdef", "gh"], [0, 0, 0, 1]),
        (["abcd", "ef"], ["ab", "cd", "ef"], [0, 2]),
        (["ab", "xy", "ef"], ["ab", "cd", "ef"], [0, 1, 2]),
        (["ab", "cd", "zz", "ef", "gh"], ["abcd", "zz", "efgh"], [0, 0, 1, 2, 2]),
        ([], [], []),
    ],
)
def test_build_word_map_examples(match: list[str], display: list[str], expected: list[int]) -> None:
    assert build_word_map(match, display) == expected
    assert search_word_map(match, display) == expected


@pytest.mark.parametrize(("match", "display"), [(["a"], []), ([], ["a"]), (["a"] * (MAX_MERGE + 1), ["a"])])
def test_build_word_map_rejects_impossible_maps(match: list[str], display: list[str]) -> None:
    with pytest.raises(ValueError):
        build_word_map(match, display)


# ---------------------------------------------------------------------------
# check()
# ---------------------------------------------------------------------------


def _assert_ops_are_mapped(q: Quran, result: dict, surah: int, start: int, end: int) -> None:
    locs = [(a.surah, a.ayah, i) for a in q.ayat(surah, start, end) for i in range(len(a.match_words))]
    for op in result["ops"]:
        if op["kind"] == "ins":
            assert op["exp_index"] is None and op["word_index_display"] is None
            continue
        s, a, i = locs[op["exp_index"]]
        ayah = q.ayat(s, a, a)[0]
        assert (op["surah"], op["ayah"], op["word_index"]) == (s, a, i)
        assert op["expected"] == ayah.match_words[i]
        assert op["word_index_display"] == ayah.word_map[i]
        assert op["expected_display"] == ayah.display_words[ayah.word_map[i]]


def test_check_exact_recitation_is_correct(q: Quran) -> None:
    result = q.check(112, 1, 4, match_text(q, 112, 1, 4))
    assert result["verdict"] == "correct"
    assert not result["say_again"]
    assert result["first_error"] is None
    assert result["n_errors"] == 0 and result["word_accuracy"] == 1.0
    assert result["tolerated"] == []
    assert all(op["kind"] == "match" for op in result["ops"])
    assert result["n_expected"] == sum(len(a.match_words) for a in q.ayat(112, 1, 4))
    _assert_ops_are_mapped(q, result, 112, 1, 4)
    json.dumps(result, ensure_ascii=False)


def test_check_accepts_vocalised_and_punctuated_text(q: Quran) -> None:
    # A surah whose Uthmani and Simple-Clean words have the same speech keys.
    def same_keys(a: Ayah) -> bool:
        return [key(w) for w in a.display_words] == [key(w) for w in a.match_words]

    surah = next(s for s in range(78, 115) if all(same_keys(a) for a in q.ayat(s, 1, q.ayah_count(s))))
    end = q.ayah_count(surah)
    heard = "، ".join(a.display for a in q.ayat(surah, 1, end)) + "."  # Arabic comma
    assert q.check(surah, 1, end, heard)["verdict"] == "correct"


def test_check_substitution_points_at_the_display_word(q: Quran) -> None:
    ayat = q.ayat(78, 1, 5)
    words = match_text(q, 78, 1, 5).split()
    target = sum(len(a.match_words) for a in ayat[:2]) + 1  # second word of 78:3
    wrong = other_word(q, *words[target - 1 : target + 2])
    words[target] = wrong
    result = q.check(78, 1, 5, " ".join(words))
    ayah3 = q.ayat(78, 3, 3)[0]
    assert result["verdict"] == "mistakes"
    assert result["first_error"] == {
        "surah": 78,
        "ayah": 3,
        "word_index_display": ayah3.word_map[1],
        "expected_display_word": ayah3.display_words[ayah3.word_map[1]],
        "kind": "sub",
    }
    sub = next(op for op in result["ops"] if op["kind"] != "match")
    assert sub["kind"] == "sub" and sub["heard"] == wrong and sub["exp_index"] == target
    _assert_ops_are_mapped(q, result, 78, 1, 5)


def test_check_deletion_and_insertion(q: Quran) -> None:
    words = match_text(q, 78, 1, 5).split()
    n1 = len(q.ayat(78, 1, 1)[0].match_words)

    skipped = words[: n1] + words[n1 + 1 :]  # first word of 78:2 left out
    result = q.check(78, 1, 5, " ".join(skipped))
    assert result["first_error"]["kind"] == "del"
    assert (result["first_error"]["ayah"], result["first_error"]["word_index_display"]) == (2, 0)
    assert result["n_errors"] == 1

    extra = other_word(q, words[n1 - 1], words[n1])
    added = words[:n1] + [extra] + words[n1:]
    result = q.check(78, 1, 5, " ".join(added))
    ins = [op for op in result["ops"] if op["kind"] == "ins"]
    assert len(ins) == 1 and ins[0]["heard"] == extra and ins[0]["heard_index"] == n1
    assert ins[0]["surah"] is None and ins[0]["expected_display"] is None
    # The first error of an insertion is the expected word that follows it.
    assert result["first_error"]["kind"] == "ins"
    assert (result["first_error"]["ayah"], result["first_error"]["word_index_display"]) == (2, 0)
    entries = result["words"]
    i = next(k for k, e in enumerate(entries) if e["status"] == "ins")
    assert entries[i]["heard"] == extra
    assert (entries[i + 1]["ayah"], entries[i + 1]["word_index_display"]) == (2, 0)


def test_check_partly_said_merged_word(q: Quran) -> None:
    ayah = q.ayat(2, 21, 21)[0]
    heard = " ".join(ayah.match_words[1:])  # the first of the two merged words left out
    result = q.check(2, 21, 21, heard)
    first = result["ops"][0]
    assert first["kind"] == "del"
    assert first["word_index_display"] == 0 and first["expected_display"] == ayah.display_words[0]
    assert result["words"][0]["status"] == "sub"  # only part of the display word was said
    assert result["words"][0]["heard"] == ayah.match_words[1]
    assert all(e["status"] == "match" for e in result["words"][1:])


def test_check_words_view_covers_every_display_word(q: Quran) -> None:
    result = q.check(2, 20, 22, match_text(q, 2, 20, 22))
    entries = [e for e in result["words"] if e["status"] != "ins"]
    expected = [(a.ayah, j, w) for a in q.ayat(2, 20, 22) for j, w in enumerate(a.display_words)]
    assert [(e["ayah"], e["word_index_display"], e["display"]) for e in entries] == expected
    assert all(e["status"] == "match" for e in entries)


def test_check_tolerates_istiadha_and_basmala(q: Quran) -> None:
    heard = f"{ISTIADHA} {q.basmala_match} {match_text(q, 112, 1, 4)}"
    result = q.check(112, 1, 4, heard)
    assert result["verdict"] == "correct"
    assert result["tolerated"] == ["istiadha", "basmala"]
    n_prefix = len(tokenize(ISTIADHA, "ar")) + 4
    assert result["ops"][0]["heard_index"] == n_prefix  # indexes the full heard text


def test_check_tolerates_istiadha_mid_surah(q: Quran) -> None:
    result = q.check(2, 255, 255, f"{ISTIADHA} {match_text(q, 2, 255, 255)}")
    assert result["verdict"] == "correct" and result["tolerated"] == ["istiadha"]


def test_check_ignores_basmala_before_surah_9(q: Quran) -> None:
    result = q.check(9, 1, 2, f"{q.basmala_match} {match_text(q, 9, 1, 2)}")
    assert result["verdict"] == "correct" and result["tolerated"] == ["basmala"]


def test_check_basmala_is_ayah_1_of_al_fatiha(q: Quran) -> None:
    full = match_text(q, 1, 1, 7)
    result = q.check(1, 1, 7, full)
    assert result["verdict"] == "correct" and result["tolerated"] == []
    assert result["n_expected"] == len(full.split())

    with_istiadha = q.check(1, 1, 7, f"{ISTIADHA} {full}")
    assert with_istiadha["verdict"] == "correct" and with_istiadha["tolerated"] == ["istiadha"]

    without_basmala = q.check(1, 1, 7, match_text(q, 1, 2, 7))
    assert without_basmala["verdict"] == "mistakes"
    assert without_basmala["n_errors"] == 4
    assert without_basmala["first_error"]["ayah"] == 1 and without_basmala["first_error"]["kind"] == "del"


def test_check_basmala_before_al_fatiha_from_ayah_2(q: Quran) -> None:
    # The range does not start with the basmala, so saying it first is not an error.
    result = q.check(1, 2, 7, f"{q.basmala_match} {match_text(q, 1, 2, 7)}")
    assert result["verdict"] == "correct" and result["tolerated"] == ["basmala"]


def test_check_tolerates_asr_errors_in_the_formulas(q: Quran) -> None:
    istiadha = tokenize(ISTIADHA, "ar")
    istiadha[0] = istiadha[0][1:]  # first word misheard
    result = q.check(112, 1, 4, " ".join(istiadha) + " " + match_text(q, 112, 1, 4))
    assert result["verdict"] == "correct" and result["tolerated"] == ["istiadha"]

    basmala = q.basmala_match.split()
    short = basmala[:2] + basmala[3:]  # one basmala word missing
    result = q.check(112, 1, 4, " ".join(short) + " " + match_text(q, 112, 1, 4))
    assert result["verdict"] == "correct" and result["tolerated"] == ["basmala"]


def test_check_does_not_hide_a_skipped_start_that_resembles_the_istiadha(q: Quran) -> None:
    ayah = q.ayat(16, 98, 98)[0]
    tail = ayah.match_words[3:]
    # Precondition: the end of 16:98 is within one word of the isti'adha.
    found = quran_module._leading_formula(
        [key(w) for w in tokenize(ISTIADHA, "ar")], [key(w) for w in tail], quran_module.ISTIADHA_MAX_ERRORS
    )
    assert found is not None and found[1] >= 1
    result = q.check(16, 98, 98, " ".join(tail))
    assert result["tolerated"] == []
    assert [op["kind"] for op in result["ops"][:3]] == ["del"] * 3
    assert result["n_errors"] == 3


def test_check_surahs_113_and_114_are_not_mistaken_for_the_istiadha(q: Quran) -> None:
    for surah in (113, 114):
        end = q.ayah_count(surah)
        result = q.check(surah, 1, end, match_text(q, surah, 1, end))
        assert result["verdict"] == "correct" and result["tolerated"] == []
        skipped_first = " ".join(match_text(q, surah, 1, end).split()[1:])
        result = q.check(surah, 1, end, skipped_first)
        assert result["tolerated"] == [] and result["n_errors"] == 1


def test_check_empty_or_formula_only_is_unclear(q: Quran) -> None:
    for heard in ("", "   ", f"{ISTIADHA} {q.basmala_match}"):
        result = q.check(112, 1, 4, heard)
        assert result["verdict"] == "unclear" and result["say_again"]
        assert all(op["kind"] == "del" for op in result["ops"])


def test_check_unrelated_text_is_unclear(q: Quran) -> None:
    result = q.check(112, 1, 4, match_text(q, 2, 1, 3))
    assert result["verdict"] == "unclear" and result["say_again"]


@pytest.mark.parametrize(
    ("surah", "start", "end"),
    [(0, 1, 1), (115, 1, 1), (1, 0, 1), (1, 3, 2), (1, 1, 8), (114, 7, 7), ("2", 1, 1), (2, 1.0, 2), (True, 1, 1)],
)
def test_invalid_ranges_raise(q: Quran, surah, start, end) -> None:
    with pytest.raises(ValueError):
        q.ayat(surah, start, end)
    with pytest.raises(ValueError):
        q.check(surah, start, end, "")


def test_ayat_range(q: Quran) -> None:
    ayat = q.ayat(2, 1, 5)
    assert [(a.surah, a.ayah) for a in ayat] == [(2, i) for i in range(1, 6)]
    assert q.ayah_count(2) == 286 and q.ayah_count(114) == 6
    with pytest.raises(ValueError):
        q.ayah_count(0)
    with pytest.raises(ValueError):
        q.raw_lines(1, 8)


# ---------------------------------------------------------------------------
# locate()
# ---------------------------------------------------------------------------


def _juz_amma_windows(q: Quran, size: int = 7) -> list[list[tuple[int, int, int, str]]]:
    """Every window of ``size`` consecutive match words inside one surah of 78-114."""
    windows = []
    for s in range(78, 115):
        words = [(a.surah, a.ayah, i, w) for a in q.ayat(s, 1, q.ayah_count(s)) for i, w in enumerate(a.match_words)]
        windows.extend(words[p : p + size] for p in range(len(words) - size + 1))
    return windows


def _window_counts(q: Quran, size: int) -> Counter:
    """How often each ``size``-word window of normalised match words occurs (inside a surah)."""
    counts: Counter = Counter()
    for s in range(1, 115):
        words = [key(w) for a in q.ayat(s, 1, q.ayah_count(s)) for w in a.match_words]
        counts.update(tuple(words[p : p + size]) for p in range(len(words) - size + 1))
    return counts


def _top1(q: Quran, heard: str) -> tuple[int, int, int] | None:
    found = q.locate(heard)
    if not found:
        return None
    return found[0]["surah"], found[0]["ayah"], found[0]["match_word_index"]


def _samples(q: Quran) -> list[list[tuple[int, int, int, str]]]:
    return random.Random(SEED).sample(_juz_amma_windows(q), 200)


def test_locate_exact_7_word_windows(q: Quran) -> None:
    counts = _window_counts(q, 7)
    hits, misses = 0, []
    for window in _samples(q):
        if _top1(q, " ".join(w for *_, w in window)) == window[0][:3]:
            hits += 1
        else:
            misses.append(window)
    rate = hits / 200
    print(f"locate exact 7-word top-1: {rate:.3f}")
    assert rate >= 0.95
    # A miss can only be a passage that occurs more than once.
    assert all(counts[tuple(key(w) for *_, w in win)] > 1 for win in misses)


def test_locate_with_one_substituted_word(q: Quran) -> None:
    rng = random.Random(SEED + 1)
    vocabulary = sorted({w for a in all_ayat(q) for w in a.match_words})
    hits = 0
    for window in _samples(q):
        words = [w for *_, w in window]
        i = rng.randrange(7)
        while key(replacement := rng.choice(vocabulary)) == key(words[i]):
            pass
        words[i] = replacement
        hits += _top1(q, " ".join(words)) == window[0][:3]
    rate = hits / 200
    print(f"locate 7 words with one substitution top-1: {rate:.3f}")
    assert rate >= 0.85


def test_locate_with_one_dropped_or_added_word(q: Quran) -> None:
    rng = random.Random(SEED + 2)
    vocabulary = sorted({w for a in all_ayat(q) for w in a.match_words})
    dropped = added = 0
    for window in _samples(q):
        words = [w for *_, w in window]
        i = rng.randrange(7)
        heard = words[:i] + words[i + 1 :]
        dropped += _top1(q, " ".join(heard)) == window[1 if i == 0 else 0][:3]
        # An extra word before the first one cannot be told apart from a wrong first
        # word, so it goes inside the window.
        j = rng.randrange(1, 7)
        heard = words[:j] + [rng.choice(vocabulary)] + words[j:]
        added += _top1(q, " ".join(heard)) == window[0][:3]
    print(f"locate with one dropped word: {dropped / 200:.3f}, one added word: {added / 200:.3f}")
    assert dropped / 200 >= 0.85 and added / 200 >= 0.85


def test_uniqueness_census_of_7_word_windows(q: Quran) -> None:
    counts = _window_counts(q, 7)
    total = sum(counts.values())
    unique = sum(1 for c in counts.values() if c == 1)
    share = unique / total
    print(f"7-word windows that occur once: {share:.4f} of {total}")
    assert abs(q.ngram_uniqueness(7) - share) < 1e-12
    assert 0.96 <= share <= 0.97  # about 96.5%
    assert q.ngram_uniqueness(3) < q.ngram_uniqueness(5) < share


def test_locate_reports_display_index_and_preview(q: Quran) -> None:
    ayah = q.ayat(2, 21, 21)[0]
    found = q.locate(" ".join(ayah.match_words[2:9]))
    assert found[0]["surah"] == 2 and found[0]["ayah"] == 21
    assert found[0]["match_word_index"] == 2
    assert found[0]["word_index"] == ayah.word_map[2] == 1
    following = ayah.display_words[1:] + q.ayat(2, 22, 22)[0].display_words
    assert found[0]["display_preview"] == " ".join(following[:8])
    assert set(found[0]) == {"surah", "ayah", "word_index", "match_word_index", "score", "display_preview"}
    json.dumps(found, ensure_ascii=False)


def test_locate_preview_stops_at_the_end_of_the_surah(q: Quran) -> None:
    last = q.ayat(114, 6, 6)[0]
    previous = q.ayat(114, 5, 5)[0]
    heard = " ".join(previous.match_words[-2:] + last.match_words)
    found = q.locate(heard, within_surah=114)
    assert (found[0]["ayah"], found[0]["match_word_index"]) == (5, len(previous.match_words) - 2)
    assert found[0]["display_preview"] == " ".join(previous.display_words[-2:] + last.display_words)
    assert len(found[0]["display_preview"].split()) <= 8


def test_locate_within_surah(q: Quran) -> None:
    refrain = " ".join(q.ayat(55, 13, 13)[0].match_words)
    everywhere = q.locate(refrain, top_k=50)
    assert len(everywhere) > 5 and all(c["score"] == 1.0 for c in everywhere)
    # Equally good places are listed in Quran order and do not overlap.
    assert [(c["surah"], c["ayah"]) for c in everywhere] == sorted((c["surah"], c["ayah"]) for c in everywhere)
    inside = q.locate(refrain, top_k=50, within_surah=55)
    assert inside and all(c["surah"] == 55 for c in inside)
    assert q.locate(refrain, within_surah=112) == []


def test_locate_sorted_by_score_and_top_k(q: Quran) -> None:
    words = q.ayat(2, 255, 255)[0].match_words
    found = q.locate(" ".join(words[:10]), top_k=3)
    assert 1 <= len(found) <= 3
    assert [c["score"] for c in found] == sorted((c["score"] for c in found), reverse=True)
    assert (found[0]["surah"], found[0]["ayah"], found[0]["match_word_index"]) == (2, 255, 0)
    assert found[0]["score"] == 1.0


def test_locate_with_basmala_before_a_surah(q: Quran) -> None:
    start = match_text(q, 78, 1, 2)
    assert _top1(q, f"{q.basmala_match} {start}") == (78, 1, 0)
    assert _top1(q, f"{ISTIADHA} {q.basmala_match} {start}") == (78, 1, 0)


def test_locate_al_fatiha_from_the_basmala(q: Quran) -> None:
    assert _top1(q, match_text(q, 1, 1, 2)) == (1, 1, 0)


def test_locate_short_and_unusable_input(q: Quran) -> None:
    assert q.locate("") == []
    assert q.locate("hello world, this is not it") == []
    word = q.ayat(112, 1, 1)[0].match_words[-1]
    found = q.locate(word, top_k=3)
    assert found and all(c["score"] == 1.0 for c in found)
    for c in found:
        ayah = q.ayat(c["surah"], c["ayah"], c["ayah"])[0]
        assert key(ayah.match_words[c["match_word_index"]]) == key(word)
    pair = " ".join(q.ayat(112, 1, 1)[0].match_words[-2:])
    assert q.locate(pair, within_surah=112)[0]["ayah"] == 1


def test_locate_invalid_arguments(q: Quran) -> None:
    for bad in (0, -1, True, 1.5):
        with pytest.raises(ValueError):
            q.locate("x", top_k=bad)
    with pytest.raises(ValueError):
        q.locate("x", within_surah=115)


def test_locate_is_fast(q: Quran) -> None:
    windows = _samples(q)[:50]
    q.locate(" ".join(w for *_, w in windows[0]))  # warm up
    timings = []
    for window in windows:
        t = time.perf_counter()
        q.locate(" ".join(w for *_, w in window))
        timings.append(time.perf_counter() - t)
    long_text = match_text(q, 2, 1, 10)  # longer than the 40-word cap
    t = time.perf_counter()
    q.locate(long_text)
    timings.append(time.perf_counter() - t)
    one_word = q.ayat(1, 1, 1)[0].match_words[1]  # a very frequent word
    t = time.perf_counter()
    q.locate(one_word)
    timings.append(time.perf_counter() - t)
    print(f"locate: mean {sum(timings) / len(timings) * 1000:.1f} ms, max {max(timings) * 1000:.1f} ms")
    assert max(timings) < 0.1


def test_construction_is_fast_in_a_fresh_process() -> None:
    code = (
        "import sys, time, json; sys.path.insert(0, 'backend');"
        "from pathlib import Path; from mommy.quran import Quran;"
        "t = time.perf_counter(); Quran(Path('data/quran')); print(json.dumps(time.perf_counter() - t))"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=MOMMY_ROOT, capture_output=True, text=True, check=True)
    seconds = json.loads(out.stdout.strip().splitlines()[-1])
    print(f"Quran() construction in a fresh process: {seconds:.2f} s")
    assert seconds < 2.0


# ---------------------------------------------------------------------------
# Hard rules
# ---------------------------------------------------------------------------


def test_quran_module_uses_no_llm_tts_or_network() -> None:
    tree = ast.parse(Path(quran_module.__file__).read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add("." * node.level + (node.module or ""))
    allowed = {
        "__future__", "dataclasses", "difflib", "functools", "math", "pathlib", "re", "typing",
        "numpy", ".align", ".textnorm",
    }
    assert imported <= allowed, imported - allowed
