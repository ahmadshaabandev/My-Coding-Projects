"""Tests for mommy.align: the deterministic word checker."""

from __future__ import annotations

import json
import random
from dataclasses import asdict
from typing import Any

import pytest

from mommy.align import (
    SAY_AGAIN_ERROR_RATE,
    CheckResult,
    Op,
    align,
    align_with_joins,
    build_result,
    check_recitation,
    check_writing,
    recitation_key,
    result_summary,
    writing_key,
)


def ident(t: str) -> str:
    return t


def kinds(ops: list[Op]) -> list[str]:
    return [op.kind for op in ops]


def counts(ops: list[Op]) -> dict[str, int]:
    out = {"match": 0, "sub": 0, "del": 0, "ins": 0}
    for op in ops:
        out[op.kind] += 1
    return out


# ---------------------------------------------------------------------------
# Independent reference implementation (plain Python, quadratic)
# ---------------------------------------------------------------------------


def reference_align(expected: list[str], heard: list[str]) -> list[tuple[str, int | None, int | None]]:
    """Suffix-cost Levenshtein, the most matches among minimum-cost alignments, and a
    forward trace: match > sub > del > ins."""
    n, m = len(expected), len(heard)
    # best[i][j] = (cost, -matches) of the best alignment of expected[i:] with heard[j:].
    best = [[(0, 0)] * (m + 1) for _ in range(n + 1)]
    for i in range(n, -1, -1):
        for j in range(m, -1, -1):
            if i == n:
                best[i][j] = (m - j, 0)
            elif j == m:
                best[i][j] = (n - i, 0)
            else:
                c, neg = best[i + 1][j + 1]
                diag = (c, neg - 1) if expected[i] == heard[j] else (c + 1, neg)
                d = best[i + 1][j]
                ins = best[i][j + 1]
                best[i][j] = min(diag, (d[0] + 1, d[1]), (ins[0] + 1, ins[1]))
    ops: list[tuple[str, int | None, int | None]] = []
    i = j = 0
    while i < n or j < m:
        here = best[i][j]
        if i < n and j < m and expected[i] == heard[j] and (best[i + 1][j + 1][0], best[i + 1][j + 1][1] - 1) == here:
            ops.append(("match", i, j))
            i, j = i + 1, j + 1
        elif i < n and j < m and (best[i + 1][j + 1][0] + 1, best[i + 1][j + 1][1]) == here:
            ops.append(("sub", i, j))
            i, j = i + 1, j + 1
        elif i < n and (best[i + 1][j][0] + 1, best[i + 1][j][1]) == here:
            ops.append(("del", i, None))
            i += 1
        else:
            ops.append(("ins", None, j))
            j += 1
    return ops


def assert_well_formed(ops: list[Op], expected: list[str], heard: list[str]) -> None:
    exp_seen = [op.exp_index for op in ops if op.kind in ("match", "sub", "del")]
    heard_seen = [op.heard_index for op in ops if op.kind in ("match", "sub", "ins")]
    assert exp_seen == list(range(len(expected)))
    assert heard_seen == list(range(len(heard)))
    for op in ops:
        if op.kind == "del":
            assert op.heard_index is None and op.heard is None
            assert op.expected == expected[op.exp_index]
        elif op.kind == "ins":
            assert op.exp_index is None and op.expected is None
            assert op.heard == heard[op.heard_index]
        else:
            assert op.expected == expected[op.exp_index]
            assert op.heard == heard[op.heard_index]


# ---------------------------------------------------------------------------
# align: basics and tie-break
# ---------------------------------------------------------------------------


def test_identical_lists_all_match() -> None:
    words = ["the", "cat", "sat"]
    ops = align(words, list(words), ident)
    assert kinds(ops) == ["match"] * 3
    assert [(op.exp_index, op.heard_index) for op in ops] == [(0, 0), (1, 1), (2, 2)]


def test_empty_inputs() -> None:
    assert align([], [], ident) == []
    assert kinds(align(["a", "b"], [], ident)) == ["del", "del"]
    assert kinds(align([], ["a", "b"], ident)) == ["ins", "ins"]


def test_key_is_used_for_comparison_and_surface_forms_are_kept() -> None:
    ops = align(["Cat", "SAT"], ["cat", "sat"], str.lower)
    assert kinds(ops) == ["match", "match"]
    assert (ops[0].expected, ops[0].heard) == ("Cat", "cat")


def test_skipped_stretch_is_reported_where_it_starts() -> None:
    expected = "the cat sat on the mat".split()
    ops = align(expected, ["the", "mat"], ident)
    assert kinds(ops) == ["match", "del", "del", "del", "del", "match"]
    assert ops[0].exp_index == 0 and ops[-1].exp_index == 5


def test_tie_break_prefers_sub_over_del_and_ins() -> None:
    ops = align(["a"], ["b", "c"], ident)
    assert [(op.kind, op.expected, op.heard) for op in ops] == [("sub", "a", "b"), ("ins", None, "c")]


def test_tie_break_prefers_sub_first_when_it_is_optimal() -> None:
    # Expected "a b", heard "c": sub+del or del+sub both cost 2, with no match; sub
    # comes first.
    assert kinds(align(["a", "b"], ["c"], ident)) == ["sub", "del"]


def test_tie_break_prefers_the_alignment_with_more_matches() -> None:
    # (del x, match a, ins y) and (sub, sub) both cost 2: the one that keeps the word
    # the child said right as a match wins.
    assert kinds(align(["x", "a"], ["a", "y"], ident)) == ["del", "match", "ins"]
    assert kinds(align(["a", "b"], ["b", "a"], ident)) == ["del", "match", "ins"]


@pytest.mark.parametrize(
    ("expected", "heard", "lang", "want"),
    [
        ("I see the cat", "I see cat now", "en", [("del", "the", None), ("ins", None, "now")]),
        ("Je vois le chat", "Je vois chat noir", "fr", [("del", "le", None), ("ins", None, "noir")]),
    ],
)
def test_a_word_said_right_is_not_reported_as_substituted(
    expected: str, heard: str, lang: str, want: list[tuple[str, str | None, str | None]]
) -> None:
    # Regression: the forward tie-break used to give "the -> cat, cat -> now" (2 subs,
    # 2 of 4 words right) although "skip the, match cat, add now" costs the same.
    r = check_recitation(expected, heard, lang)
    assert [(op.kind, op.expected, op.heard) for op in r.ops if op.kind != "match"] == want
    assert r.word_accuracy == pytest.approx(0.75)


def test_tie_break_prefers_del_over_ins() -> None:
    # "a b a" vs "b a b": a substitution first is not optimal, while skipping the first
    # expected word and adding the last heard one ties with the opposite (ins first).
    ops = align(["a", "b", "a"], ["b", "a", "b"], ident)
    assert kinds(ops) == ["del", "match", "match", "ins"]


def test_matches_reference_on_random_inputs_with_many_ties() -> None:
    rng = random.Random(1234)
    for _ in range(400):
        expected = [rng.choice("abc") for _ in range(rng.randint(0, 9))]
        heard = [rng.choice("abcd") for _ in range(rng.randint(0, 9))]
        ops = align(expected, heard, ident)
        assert [(op.kind, op.exp_index, op.heard_index) for op in ops] == reference_align(expected, heard)
        assert_well_formed(ops, expected, heard)


def test_is_deterministic() -> None:
    rng = random.Random(7)
    expected = [rng.choice("abcde") for _ in range(40)]
    heard = [rng.choice("abcde") for _ in range(35)]
    assert align(expected, heard, ident) == align(expected, heard, ident)


# ---------------------------------------------------------------------------
# align: property-style tests with random edits
# ---------------------------------------------------------------------------


def unique_words(rng: random.Random, n: int) -> list[str]:
    return [f"w{i}" for i in rng.sample(range(10 * n + 10), n)]


@pytest.mark.parametrize("seed", range(25))
def test_random_deletions_give_exact_counts(seed: int) -> None:
    rng = random.Random(seed)
    expected = unique_words(rng, rng.randint(5, 40))
    k = rng.randint(0, len(expected))
    dropped = set(rng.sample(range(len(expected)), k))
    heard = [w for i, w in enumerate(expected) if i not in dropped]
    ops = align(expected, heard, ident)
    assert counts(ops) == {"match": len(expected) - k, "sub": 0, "del": k, "ins": 0}
    assert sorted(op.exp_index for op in ops if op.kind == "del") == sorted(dropped)
    assert_well_formed(ops, expected, heard)


@pytest.mark.parametrize("seed", range(25))
def test_random_insertions_give_exact_counts(seed: int) -> None:
    rng = random.Random(100 + seed)
    expected = unique_words(rng, rng.randint(1, 40))
    heard = list(expected)
    k = rng.randint(0, 15)
    for t in range(k):
        heard.insert(rng.randint(0, len(heard)), f"extra{t}")
    ops = align(expected, heard, ident)
    assert counts(ops) == {"match": len(expected), "sub": 0, "del": 0, "ins": k}
    assert_well_formed(ops, expected, heard)


@pytest.mark.parametrize("seed", range(25))
def test_random_substitutions_give_exact_counts(seed: int) -> None:
    rng = random.Random(200 + seed)
    expected = unique_words(rng, rng.randint(1, 40))
    k = rng.randint(0, len(expected))
    changed = set(rng.sample(range(len(expected)), k))
    heard = [f"new{i}" if i in changed else w for i, w in enumerate(expected)]
    ops = align(expected, heard, ident)
    assert counts(ops) == {"match": len(expected) - k, "sub": k, "del": 0, "ins": 0}
    assert {op.exp_index for op in ops if op.kind == "sub"} == changed
    assert_well_formed(ops, expected, heard)


@pytest.mark.parametrize("seed", range(40))
def test_random_mixed_edits_cost_at_most_the_edit_count(seed: int) -> None:
    rng = random.Random(300 + seed)
    expected = unique_words(rng, rng.randint(1, 30))
    heard = list(expected)
    edits = rng.randint(0, 12)
    for t in range(edits):
        op = rng.choice(["sub", "del", "ins"])
        if op == "ins" or not heard:
            heard.insert(rng.randint(0, len(heard)), f"x{t}")
        elif op == "del":
            heard.pop(rng.randrange(len(heard)))
        else:
            heard[rng.randrange(len(heard))] = f"y{t}"
    ops = align(expected, heard, ident)
    n_errors = sum(1 for op in ops if op.kind != "match")
    assert n_errors <= edits
    assert n_errors == sum(1 for k, _, _ in reference_align(expected, heard) if k != "match")
    assert_well_formed(ops, expected, heard)


def test_long_inputs_are_fast_enough() -> None:
    import time

    rng = random.Random(5)
    expected = [f"w{rng.randrange(300)}" for _ in range(1500)]
    heard = [w if rng.random() > 0.1 else "zz" for w in expected]
    start = time.perf_counter()
    ops = align(expected, heard, ident)
    assert time.perf_counter() - start < 2.0
    assert_well_formed(ops, expected, heard)


# ---------------------------------------------------------------------------
# align_with_joins
# ---------------------------------------------------------------------------


def test_joins_one_expected_word_heard_in_pieces() -> None:
    ops = align_with_joins(["peutetre", "demain"], ["peut", "etre", "demain"], ident)
    assert [(op.kind, op.exp_index, op.heard_index, op.heard) for op in ops] == [
        ("match", 0, 0, "peut etre"),
        ("match", 1, 2, "demain"),
    ]


def test_joins_several_expected_words_heard_as_one() -> None:
    ops = align_with_joins(["qal", "abd", "allah"], ["qal", "abdallah"], ident)
    assert [(op.kind, op.exp_index, op.heard_index) for op in ops] == [
        ("match", 0, 0),
        ("match", 1, 1),
        ("match", 2, 1),
    ]


def test_joins_up_to_three_pieces_only() -> None:
    assert kinds(align_with_joins(["abc"], ["a", "b", "c"], ident)) == ["match"]
    assert "match" not in kinds(align_with_joins(["abcd"], ["a", "b", "c", "d"], ident))
    assert kinds(align_with_joins(["abcd"], ["a", "b", "c", "d"], ident, max_pieces=4)) == ["match"]


def test_joins_with_one_piece_is_plain_align() -> None:
    rng = random.Random(9)
    for _ in range(50):
        expected = [rng.choice(["a", "b", "ab"]) for _ in range(rng.randint(0, 7))]
        heard = [rng.choice(["a", "b", "ab"]) for _ in range(rng.randint(0, 7))]
        assert align_with_joins(expected, heard, ident, max_pieces=1) == align(expected, heard, ident)
    with pytest.raises(ValueError):
        align_with_joins(["a"], ["a"], ident, max_pieces=0)


def test_joins_never_cost_more_than_plain_align() -> None:
    rng = random.Random(11)
    for _ in range(200):
        expected = [rng.choice(["a", "b", "ab", "ba", "c"]) for _ in range(rng.randint(0, 8))]
        heard = [rng.choice(["a", "b", "ab", "c"]) for _ in range(rng.randint(0, 8))]
        plain = sum(op.kind != "match" for op in align(expected, heard, ident))
        joined_ops = align_with_joins(expected, heard, ident)
        assert sum(op.kind != "match" for op in joined_ops) <= plain
        # Every expected index is still covered exactly once, in order.
        assert [op.exp_index for op in joined_ops if op.kind != "ins"] == list(range(len(expected)))


# ---------------------------------------------------------------------------
# build_result and verdicts
# ---------------------------------------------------------------------------


def test_correct_result() -> None:
    r = check_recitation("The cat sat.", "the cat sat", "en")
    assert r.verdict == "correct" and not r.say_again
    assert r.n_expected == 3 and r.n_errors == 0 and r.word_accuracy == 1.0
    assert r.first_error_exp_index is None


def test_empty_heard_is_all_deletions_and_unclear() -> None:
    r = check_recitation("one two three", "", "en")
    assert kinds(r.ops) == ["del", "del", "del"]
    assert r.n_errors == 3 and r.word_accuracy == 0.0
    assert r.say_again is True and r.verdict == "unclear"
    assert r.first_error_exp_index == 0


def test_heard_with_only_punctuation_counts_as_empty() -> None:
    r = check_recitation("one two", " ... ", "en")
    assert r.say_again and r.verdict == "unclear"


def test_empty_expected() -> None:
    r = check_recitation("", "hello there", "en")
    assert kinds(r.ops) == ["ins", "ins"]
    assert r.n_expected == 0 and r.word_accuracy == 0.0
    assert r.say_again and r.verdict == "unclear"
    assert r.first_error_exp_index is None
    r = check_recitation("", "", "en")
    assert r.ops == [] and r.say_again and r.verdict == "unclear"


def test_error_rate_threshold_is_strictly_above_point_six() -> None:
    assert SAY_AGAIN_ERROR_RATE == 0.6
    expected = " ".join(f"w{i}" for i in range(10))
    six_wrong = " ".join(f"x{i}" if i < 6 else f"w{i}" for i in range(10))
    seven_wrong = " ".join(f"x{i}" if i < 7 else f"w{i}" for i in range(10))
    r6 = check_recitation(expected, six_wrong, "en")
    r7 = check_recitation(expected, seven_wrong, "en")
    assert r6.n_errors == 6 and r6.verdict == "mistakes" and not r6.say_again
    assert r7.n_errors == 7 and r7.verdict == "unclear" and r7.say_again
    assert r6.word_accuracy == pytest.approx(0.4)


def test_insertions_count_towards_the_error_rate() -> None:
    r = check_recitation("hello", "hello there my dear friend", "en")
    assert r.n_errors == 4 and r.word_accuracy == 1.0
    assert r.say_again and r.verdict == "unclear"


def test_first_error_index_for_insertions() -> None:
    r = check_recitation("one two three four five", "one two extra three four five", "en")
    assert r.verdict == "mistakes"
    assert r.first_error_exp_index == 2  # the word after the insertion
    r = check_recitation("one two three four five", "one two three four five extra", "en")
    assert r.first_error_exp_index == 4  # insertion at the end: the last word


def test_build_result_directly() -> None:
    ops = [Op("match", 0, 0, "a", "a"), Op("sub", 1, 1, "b", "c")]
    r = build_result(ops, 2, 2)
    assert r == CheckResult(ops, 2, 1, 1, "mistakes", False, 0.5, None, None, 0)


def test_result_serialises_with_asdict() -> None:
    r = check_recitation("Le chat dort.", "le chien dort", "fr")
    data = asdict(r)
    assert set(data) == {
        "ops",
        "n_expected",
        "n_errors",
        "first_error_exp_index",
        "verdict",
        "say_again",
        "word_accuracy",
        "say_again_reason",
        "stopped_at_exp_index",
        "n_unreadable",
    }
    assert data["ops"][1] == {
        "kind": "sub",
        "exp_index": 1,
        "heard_index": 1,
        "expected": "chat",
        "heard": "chien",
    }
    json.dumps(data, ensure_ascii=False)


def test_result_summary() -> None:
    r = check_recitation("one two three four five six", "one too three five six", "en")
    s = result_summary(r)
    assert s["verdict"] == "mistakes" and s["n_errors"] == 2 and s["n_expected"] == 6
    assert s["errors"] == [
        {"kind": "sub", "expected": "two", "heard": "too", "exp_index": 1},
        {"kind": "del", "expected": "four", "heard": None, "exp_index": 3},
    ]
    assert len(result_summary(r, max_errors=1)["errors"]) == 1
    json.dumps(s)


# ---------------------------------------------------------------------------
# check_recitation (speech)
# ---------------------------------------------------------------------------


def test_recitation_arabic_ignores_tashkeel_and_letter_variants() -> None:
    expected = "ذَهَبَ أَحْمَدُ إِلَى المَدْرَسَةِ."
    heard = "ذهب احمد الى المدرسه"
    r = check_recitation(expected, heard, "ar")
    assert r.verdict == "correct", asdict(r)


def test_recitation_arabic_catches_a_wrong_word() -> None:
    r = check_recitation("ذهب أحمد إلى المدرسة، ثم عاد إلى البيت", "ذهب أحمد إلى السوق ثم عاد إلى البيت", "ar")
    assert r.verdict == "mistakes"
    assert [(op.kind, op.expected, op.heard) for op in r.ops if op.kind != "match"] == [
        ("sub", "المدرسة", "السوق")
    ]
    assert r.first_error_exp_index == 3


def test_recitation_arabic_skipped_word() -> None:
    r = check_recitation("قرأ الولد الكتاب الجديد في المساء", "قرأ الولد الكتاب في المساء", "ar")
    assert [(op.kind, op.expected) for op in r.ops if op.kind != "match"] == [("del", "الجديد")]


def test_recitation_arabic_joined_words() -> None:
    r = check_recitation("جاء عبد الله", "جاء عبدالله", "ar")
    assert r.verdict == "correct"


def test_recitation_french_ignores_accents_case_and_hyphen_splits() -> None:
    expected = "Aujourd’hui, l'élève est peut-être à l'école."
    heard = "aujourd'hui l'eleve est peut etre a l'ecole"
    r = check_recitation(expected, heard, "fr")
    assert r.verdict == "correct", [(op.kind, op.expected, op.heard) for op in r.ops]
    assert r.n_expected == 6


def test_recitation_french_catches_wrong_word() -> None:
    r = check_recitation("Le petit chat dort sur le canapé.", "le petit chien dort sur le canapé", "fr")
    assert r.n_errors == 1 and r.ops[2].kind == "sub" and r.ops[2].heard == "chien"


def test_recitation_english() -> None:
    r = check_recitation("Don't run in the hall!", "dont run in the hall", "en")
    assert r.verdict == "correct"
    r = check_recitation("The quick brown fox jumps.", "the quick fox jumps over", "en")
    assert [(op.kind, op.expected, op.heard) for op in r.ops if op.kind != "match"] == [
        ("del", "brown", None),
        ("ins", None, "over"),
    ]


def test_recitation_key() -> None:
    assert recitation_key("Peut-Être", "fr") == "peutetre"
    assert recitation_key("l'a", "fr") == recitation_key("la", "fr")
    assert recitation_key("إِلَى", "ar") == recitation_key("الي", "ar")


# ---------------------------------------------------------------------------
# check_writing (dictation)
# ---------------------------------------------------------------------------


def test_writing_arabic_ta_marbuta_is_a_mistake() -> None:
    r = check_writing("ذهبت إلى المدرسة", "ذهبت إلى المدرسه", "ar")
    assert [(op.kind, op.expected, op.heard) for op in r.ops if op.kind != "match"] == [
        ("sub", "المدرسة", "المدرسه")
    ]


def test_writing_arabic_hamza_seat_is_a_mistake() -> None:
    r = check_writing("أكل الولد التفاحة", "اكل الولد التفاحة", "ar")
    assert r.n_errors == 1 and r.ops[0].kind == "sub"
    r = check_writing("مشى إلى البيت", "مشي الى البيت", "ar")
    assert r.n_errors == 2


def test_writing_arabic_ignores_tashkeel_and_punctuation_unless_strict() -> None:
    expected = "ذَهَبَ الوَلَدُ إِلَى المَدْرَسَةِ."
    written = "ذهب الولد إلى المدرسة"
    assert check_writing(expected, written, "ar").verdict == "correct"
    strict = check_writing(expected, written, "ar", strict_tashkeel=True)
    assert strict.n_errors == 4
    assert check_writing(expected, expected.rstrip("."), "ar", strict_tashkeel=True).verdict == "correct"


def test_writing_strict_tashkeel_catches_a_missing_shadda() -> None:
    r = check_writing("مُعَلِّم", "مُعَلِم", "ar", strict_tashkeel=True)
    assert r.n_errors == 1
    assert check_writing("مُعَلِّم", "مُعَلِم", "ar").n_errors == 0


def test_writing_french_accents_are_significant() -> None:
    r = check_writing("L'élève a été très sage.", "l'eleve a ete très sage", "fr")
    assert [(op.expected, op.heard) for op in r.ops if op.kind == "sub"] == [
        ("L'élève", "l'eleve"),
        ("été", "ete"),
    ]


def test_writing_is_case_and_punctuation_insensitive() -> None:
    r = check_writing("Le Chat, dort ! « Oui » dit-il.", "le chat dort oui dit-il", "fr")
    assert r.verdict == "correct"
    r = check_writing("The cat's toy.", "THE CAT’S TOY", "en")
    assert r.verdict == "correct"


def test_writing_split_word_is_a_mistake() -> None:
    r = check_writing("Il est peut-être là.", "il est peut être là", "fr")
    assert r.verdict == "mistakes"
    assert r.n_errors == 2


def test_writing_key() -> None:
    assert writing_key("Été", "fr") == "été"
    assert writing_key("مَدْرَسَةٌ", "ar") == "مدرسة"
    assert writing_key("مَدْرَسَةٌ", "ar", strict_tashkeel=True) != "مدرسة"


# ---------------------------------------------------------------------------
# Speech: numbers in digits or words, English spelling variants and contractions
# ---------------------------------------------------------------------------


def errors_of(r: CheckResult) -> list[tuple[str, str | None, str | None]]:
    return [(op.kind, op.expected, op.heard) for op in r.ops if op.kind != "match"]


@pytest.mark.parametrize(
    ("lang", "expected", "heard"),
    [
        # English: words in the text, digits from the recogniser, and the reverse.
        ("en", "The year has twelve months.", "The year has 12 months."),
        ("en", "I have twenty five marbles.", "I have 25 marbles."),
        ("en", "I have twenty-five marbles.", "I have 25 marbles."),
        ("en", "There are 7 days in a week.", "There are seven days in a week."),
        ("en", "My grandmother is 100.", "My grandmother is one hundred."),
        ("en", "It is the third day.", "It is the 3rd day."),
        ("en", "We have 0 apples.", "We have zero apples."),
        # French, including compound and ordinal numbers.
        ("fr", "Il y a sept jours dans une semaine.", "Il y a 7 jours dans une semaine."),
        ("fr", "Il a vingt et un ans.", "Il a 21 ans."),
        ("fr", "Il a vingt-et-un ans.", "Il a 21 ans."),
        ("fr", "Mon grand-père a cent ans.", "Mon grand-père a 100 ans."),
        ("fr", "Il a quatre-vingt-dix-sept ans.", "Il a 97 ans."),
        ("fr", "Elle a soixante et onze ans.", "Elle a 71 ans."),
        ("fr", "Il est né le premier mai.", "Il est né le 1er mai."),
        ("fr", "Elle habite au deuxième étage.", "Elle habite au 2e étage."),
        ("fr", "Il y a 12 mois.", "Il y a douze mois."),
        # Arabic: both genders and cases, Western and Arabic-Indic digits.
        ("ar", "عندي ثلاثة أقلام", "عندي 3 أقلام"),
        ("ar", "عندي ثلاث كرات", "عندي ٣ كرات"),
        ("ar", "عمري واحد وعشرون سنة", "عمري 21 سنة"),
        ("ar", "عمري ٢١ سنة", "عمري واحد و عشرين سنة"),
        ("ar", "في السنة اثنا عشر شهرًا", "في السنة 12 شهرا"),
        ("ar", "في الصف 100 تلميذ", "في الصف مئة تلميذ"),
        ("ar", "في الصف مائة تلميذ", "في الصف ١٠٠ تلميذ"),
    ],
)
def test_numbers_in_digits_or_words_match_in_speech(lang: str, expected: str, heard: str) -> None:
    r = check_recitation(expected, heard, lang)
    assert r.verdict == "correct", errors_of(r)
    assert r.n_expected == len(r.ops) - sum(op.kind == "ins" for op in r.ops)


def test_a_wrong_number_is_still_a_mistake() -> None:
    assert errors_of(check_recitation("The year has twelve months.", "The year has 11 months.", "en")) == [
        ("sub", "twelve", "11")
    ]
    assert errors_of(check_recitation("Il a vingt et un ans.", "Il a 22 ans.", "fr"))[0][0] in ("sub", "del")
    r = check_recitation("عندي ثلاثة أقلام", "عندي 4 أقلام", "ar")
    assert errors_of(r) == [("sub", "ثلاثة", "4")]
    # A cardinal is not an ordinal.
    assert check_recitation("It is the third day.", "It is the 3 day.", "en").verdict == "mistakes"


def test_numbers_are_a_difference_in_dictation() -> None:
    r = check_writing("The year has twelve months.", "The year has 12 months.", "en")
    assert errors_of(r) == [("sub", "twelve", "12")]
    r = check_writing("Il y a sept jours.", "Il y a 7 jours.", "fr")
    assert errors_of(r) == [("sub", "sept", "7")]
    r = check_writing("عندي ثلاثة أقلام", "عندي ٣ أقلام", "ar")
    assert errors_of(r) == [("sub", "ثلاثة", "٣")]


@pytest.mark.parametrize("check", [check_recitation, check_writing])
def test_arabic_indic_and_western_digits_are_equal_in_both_modes(check: Any) -> None:
    assert check("عندي 3 أقلام و12 كتابا", "عندي ٣ أقلام و١٢ كتابا", "ar").verdict == "correct"
    assert check("Il a 21 ans.", "Il a ٢١ ans.", "fr").verdict == "correct"


# Arabic numbers in words match by value in speech: the recogniser writes the gender and
# case it prefers, and the speech key already ignores case endings.
@pytest.mark.parametrize(
    ("expected", "heard"),
    [
        ("اثنتا عشرة", "إثنى عشر"),
        ("اثنتا عشرة", "اثنا عشر"),
        ("اثنتا عشرة", "اثني عشر"),
        ("اِثْنَتَا عَشْرَةَ", "اثنا عشر"),  # with tashkeel on the page
        ("ثلاثة", "ثلاث"),
        ("ثلاث", "ثلاثة"),
        ("عشرون", "عشرين"),
        ("عشرة", "عشر"),
        ("اثنتان", "اثنين"),
        ("ثماني", "ثمانية"),
        ("مية", "مائة"),
        ("ثلاث عشرة", "ثلاثة عشر"),
        ("إحدى عشرة", "أحد عشر"),
        ("واحد وعشرون", "إحدى وعشرين"),
        ("واحد و عشرون", "إحدى وعشرين"),  # three words against two
        ("إحدى وعشرين", "واحد و عشرين"),  # two words against three
        ("تسع وتسعون", "تسعة وتسعين"),
        ("وأربع", "وأربعة"),  # with the conjunction on both sides
        ("عندي ثلاث كرات وأربع دمى", "عندي ثلاثة كرات وأربعة دمى"),
        ("في الصف ثلاث عشرة بنتا وأربعة عشر ولدا", "في الصف ثلاثة عشر بنتا و أربع عشرة ولدا"),
        ("في السنة اثنا عشر شهرا وفي الأسبوع سبعة أيام", "في السنة اثنتي عشرة شهرا وفي الأسبوع سبع أيام"),
        # The indefinite accusative (tanwin on an added alef).
        ("صلى أربعًا", "صلى أربعة"),
        ("دخلوا واحدًا بعد الآخر", "دخلوا واحد بعد الآخر"),
        ("عاش ثلاثًا وعشرين سنة", "عاش ثلاث وعشرين سنة"),
        ("عاش ثلاثًا وعشرين سنة", "عاش ٢٣ سنة"),
        # Vowel marks that fit the number.
        ("سَبْعَ سَنَوات", "سبعة سنوات"),
        ("خَمْسَةَ عَشَرَ", "خمس عشرة"),
        ("أَحَدَ عَشَرَ كَوْكَبًا", "إحدى عشرة كوكبا"),
        ("ثَلاثَ عَشْرَةَ بِنْتًا", "ثلاثة عشر بنتا"),
        # Digits and words still interoperate, Western and Arabic-Indic.
        ("عمري ٢١ سنة", "عمري إحدى وعشرين سنة"),
        ("عمري إحدى وعشرون سنة", "عمري 21 سنة"),
        ("اشترينا 12 قلما", "اشترينا اثنتي عشرة قلما"),
        ("اشترينا اثنتا عشرة قلما", "اشترينا ١٢ قلما"),
    ],
)
def test_arabic_number_words_match_by_value_in_speech(expected: str, heard: str) -> None:
    r = check_recitation(expected, heard, "ar")
    assert r.verdict == "correct", errors_of(r)
    # Every expected word is covered once, in order.
    assert [op.exp_index for op in r.ops if op.kind != "ins"] == list(range(r.n_expected))


@pytest.mark.parametrize(
    ("expected", "heard", "errors"),
    [
        ("ثلاثة", "أربعة", [("sub", "ثلاثة", "أربعة")]),
        ("عشرون", "عشرة", [("sub", "عشرون", "عشرة")]),
        ("ثلاث", "ثلاثون", [("sub", "ثلاث", "ثلاثون")]),
        ("ستة", "ستين", [("sub", "ستة", "ستين")]),
        ("ثلاثة عشر", "ثلاثة", [("del", "عشر", None)]),
        ("اثنا عشر", "اثنان", [("sub", "اثنا", "اثنان"), ("del", "عشر", None)]),
        ("واحد وعشرون", "واحد وثلاثون", [("sub", "وعشرون", "وثلاثون")]),
        ("خمسة عشر", "خمس وعشرون", [("sub", "عشر", "وعشرون")]),
        # The conjunction is a word of its own: it must be said.
        ("وثلاث", "ثلاث", [("sub", "وثلاث", "ثلاث")]),
        # إحدى and أحد on their own are not numbers ("one of the girls").
        ("إحدى البنات", "أحد البنات", [("sub", "إحدى", "أحد")]),
    ],
)
def test_different_arabic_numbers_still_differ_in_speech(
    expected: str, heard: str, errors: list[tuple[str, str | None, str | None]]
) -> None:
    sentence = "كان في الحديقة {} من الأطفال"
    r = check_recitation(sentence.format(expected), sentence.format(heard), "ar")
    assert errors_of(r) == errors


@pytest.mark.parametrize(
    ("expected", "heard", "errors"),
    [
        ("رأيت سَبُعًا في الغابة", "رأيت سبعة في الغابة", [("sub", "سَبُعًا", "سبعة")]),  # a beast of prey
        ("أخذ خُمُسَ المال", "أخذ خمسة المال", [("sub", "خُمُسَ", "خمسة")]),  # a fifth
        ("الغرفة تَسَعُ خمسة أشخاص", "الغرفة تسعة خمسة أشخاص", [("sub", "تَسَعُ", "تسعة")]),  # "holds"
        ("أخذ عُشْرَ المال", "أخذ عشرة المال", [("sub", "عُشْرَ", "عشرة")]),  # a tenth
        ("ولد في شهر صَفَر", "ولد في شهر ٠", [("sub", "صَفَر", "٠")]),  # the month
        # The same word heard is still the same word.
        ("رأيت سَبُعًا في الغابة", "رأيت سبعا في الغابة", []),
        ("الغرفة تَسَعُ خمسة أشخاص", "الغرفة تسع خمسة أشخاص", []),
        # Without vowel marks the page cannot tell: the word is taken as the number.
        ("رأيت سبع في الغابة", "رأيت سبعة في الغابة", []),
    ],
)
def test_vowel_marks_tell_a_number_word_from_its_homograph(
    expected: str, heard: str, errors: list[tuple[str, str | None, str | None]]
) -> None:
    assert errors_of(check_recitation(expected, heard, "ar")) == errors


def test_arabic_number_values_are_for_speech_only() -> None:
    # Dictation: the gender of a number is spelling.
    r = check_writing("في الصف ثلاث عشرة بنتا", "في الصف ثلاثة عشر بنتا", "ar")
    assert errors_of(r) == [("sub", "ثلاث", "ثلاثة"), ("sub", "عشرة", "عشر")]
    assert errors_of(check_writing("صلى أربعًا", "صلى أربعة", "ar")) == [("sub", "أربعًا", "أربعة")]
    # English and French number words are not compared by value: un/une, premier/première
    # sound different.
    assert check_recitation("Il a vingt et un ans.", "Il a vingt et une ans.", "fr").verdict == "mistakes"
    assert errors_of(check_recitation("C'est le premier jour de l'année.", "C'est le première jour de l'année.", "fr")) == [
        ("sub", "premier", "première")
    ]


def test_quran_check_stays_strict_on_number_words(quran_dir: Any) -> None:
    from mommy.quran import Quran

    quran = Quran(quran_dir)
    words = quran.ayat(2, 60, 60)[0].match_words
    at = words.index("اثنتا")
    assert words[at + 1] == "عشرة"
    heard = " ".join(words[:at] + ["اثنا", "عشر"] + words[at + 2 :])
    assert check_recitation(" ".join(words), heard, "ar").verdict == "correct"  # speech
    result = quran.check(2, 60, 60, heard)  # Quran: strict, as before
    assert [(op["kind"], op["expected"], op["heard"]) for op in result["ops"] if op["kind"] != "match"] == [
        ("sub", "اثنتا", "اثنا"),
        ("sub", "عشرة", "عشر"),
    ]


def test_block_matches_in_align_with_joins() -> None:
    # expected[0:2] ~ heard[0:3] and expected[2:5] ~ heard[3:5], each as a whole.
    ops = align_with_joins(
        ["a", "b", "c", "d", "e", "z"],
        ["p", "q", "r", "s", "t", "z"],
        ident,
        extra_joins=({}, {}, {(0, 0): [(2, 3)], (2, 3): [(3, 2)]}),
    )
    assert [(op.kind, op.exp_index, op.heard_index, op.heard) for op in ops] == [
        ("match", 0, 0, "p"),
        ("match", 1, 1, "q r"),
        ("match", 2, 3, "s"),
        ("match", 3, 4, "t"),
        ("match", 4, 4, "t"),
        ("match", 5, 5, "z"),
    ]
    # A block is matched as a whole or not at all, and one out of range is ignored.
    ops = align_with_joins(["a", "b"], ["p", "b"], ident, extra_joins=({}, {}, {(0, 0): [(2, 2)]}))
    assert [op.kind for op in ops] == ["match", "match"]
    ops = align_with_joins(["a", "b"], ["p"], ident, extra_joins=({}, {}, {(0, 0): [(2, 2)]}))
    assert "match" not in kinds(ops)
    # Blocks of one word on a side are the joins of the two-map form.
    assert align_with_joins(["a", "b"], ["p"], ident, extra_joins=({}, {}, {(0, 0): [(2, 1)]})) == align_with_joins(
        ["a", "b"], ["p"], ident, extra_joins=({}, {(0, 0): [2]})
    )
    assert align_with_joins(["a"], ["p", "q"], ident, extra_joins=({}, {}, {(0, 0): [(1, 2)]})) == align_with_joins(
        ["a"], ["p", "q"], ident, extra_joins=({(0, 0): [2]}, {})
    )


@pytest.mark.parametrize(
    ("expected", "heard"),
    [
        ("My favourite colour is blue.", "My favorite color is blue."),
        ("We met at the centre of town.", "We met at the center of town."),
        ("I realise that the theatre is closed.", "I realize that the theater is closed."),
        ("They analysed the catalogue.", "They analyzed the catalog."),
        ("She travelled to her neighbour's house.", "She traveled to her neighbor's house."),
        ("The grey cat likes maths.", "The gray cat likes math."),
        ("They are going to school.", "they're going to school."),
        ("She is ten years old.", "She's 10 years old."),
        ("It is raining and we are wet.", "It's raining and we're wet."),
        ("I do not know.", "I don't know."),
        ("I don't know.", "I do not know."),
        ("They can't swim.", "They cannot swim."),
        ("They cannot swim.", "They can't swim."),
        ("We will not stop.", "We won't stop."),
        ("I am happy.", "I'm happy."),
        ("She has gone home.", "She's gone home."),
    ],
)
def test_english_spelling_variants_and_contractions_match_in_speech(expected: str, heard: str) -> None:
    r = check_recitation(expected, heard, "en")
    assert r.verdict == "correct", errors_of(r)


def test_english_variants_do_not_hide_real_mistakes() -> None:
    # "were" is not a written contraction of "we are".
    assert check_recitation("we are here with the cat", "were here with the cat", "en").verdict == "mistakes"
    # A possessive is not expanded.
    assert check_recitation("Sam is here with the cat", "Sam's here with the cat", "en").verdict == "mistakes"
    # "four" and "for" stay apart.
    assert check_recitation("I see four cats", "I see for cats", "en").verdict == "mistakes"
    # In dictation the British/American spelling and contractions are differences.
    assert errors_of(check_writing("My favourite colour", "My favorite color", "en")) == [
        ("sub", "favourite", "favorite"),
        ("sub", "colour", "color"),
    ]
    assert check_writing("They are here", "They're here", "en").verdict == "mistakes"


# ---------------------------------------------------------------------------
# say_again, stopping early and unreadable words
# ---------------------------------------------------------------------------


def test_a_child_who_stopped_early_is_told_where() -> None:
    r = check_recitation("The little cat sat on the warm mat near the door.", "The little cat", "en")
    assert r.verdict == "mistakes" and not r.say_again and r.say_again_reason is None
    assert r.stopped_at_exp_index == 3
    assert result_summary(r)["stopped_at"] == "sat"


def test_partial_reading_with_mistakes_before_the_stop() -> None:
    text = (
        "The little cat sat on the warm mat near the door. Then the cat saw a bird in the big "
        "green tree. The bird sang a happy song and flew away over the hills."
    )
    r = check_recitation(text, "The little dog sat on the mat near the door.", "en")
    assert r.verdict == "mistakes" and not r.say_again
    assert r.first_error_exp_index == 2  # cat -> dog
    assert r.stopped_at_exp_index == 11  # "Then"


def test_unreliable_speech_is_still_unclear_with_its_reason() -> None:
    r = check_recitation("one two three four five", "", "en")
    assert r.say_again and r.say_again_reason == "empty" and r.verdict == "unclear"
    r = check_recitation("one two three four five", "alpha beta gamma delta epsilon", "en")
    assert r.say_again and r.say_again_reason == "error_rate" and r.verdict == "unclear"
    assert r.stopped_at_exp_index is None
    # Garbage before stopping is still unreliable: the stop does not hide it.
    r = check_recitation("a b c d e f g h i j", "x y z", "en")
    assert r.say_again_reason == "error_rate" and r.stopped_at_exp_index == 3


def test_one_missing_last_word_is_not_a_stop() -> None:
    r = check_recitation("one two three four", "one two three", "en")
    assert r.stopped_at_exp_index is None and errors_of(r) == [("del", "four", None)]


@pytest.mark.parametrize(
    ("lang", "expected", "written"),
    [
        ("fr", "Le chat dort.", "Le cha dor."),
        ("fr", "élève", "eleve"),
        ("fr", "peut-être", "peut être"),
        ("ar", "مدرسة", "مدرسه"),
        ("en", "one two three four five", "won too tree for fife"),
    ],
)
def test_misspelled_dictation_is_mistakes_not_say_again(lang: str, expected: str, written: str) -> None:
    r = check_writing(expected, written, lang)
    assert r.verdict == "mistakes" and not r.say_again and r.say_again_reason is None


def test_empty_dictation_is_say_again() -> None:
    r = check_writing("Le chat dort.", "  ", "fr")
    assert r.say_again and r.say_again_reason == "empty" and r.verdict == "unclear"


def test_unreadable_word_in_dictation_is_not_a_skipped_word() -> None:
    r = check_writing("Le chat dort sur le tapis.", "Le chat [?] sur le tapis.", "fr")
    assert errors_of(r) == [("sub", "dort", "[?]")]
    assert r.n_unreadable == 1 and r.n_errors == 1
    s = result_summary(r)
    assert s["errors"] == [] and s["n_unreadable"] == 1
    # Spacing and the Arabic question mark are accepted, and a real mistake stays one.
    r = check_writing("ذهب الولد إلى المدرسة", "ذهب الولد [ ؟ ] المدرسه", "ar")
    assert errors_of(r) == [("sub", "إلى", "[?]"), ("sub", "المدرسة", "المدرسه")]
    assert r.n_unreadable == 1
    assert [e["expected"] for e in result_summary(r)["errors"]] == ["المدرسة"]


def test_number_values_change_only_number_words_of_the_quran_text(quran_dir: Any) -> None:
    """Measured on the verbatim Simple-Clean text: the words that can take part in a
    value match are number words, and a number said in another gender or case is
    accepted by speech matching but still a mistake for the Quran check (which does not
    use speech_joins). If a count changes, re-check which words joined the set."""
    from mommy.quran import Quran
    from mommy.textnorm import _number_table, is_number_word, spoken_number, tokenize

    lines = [
        line.split("|", 2)
        for line in (quran_dir / "quran-simple-clean.txt").read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")
    ]
    words = {w for _, _, text in lines for w in tokenize(text, "ar")}
    numbers = {w for w in words if is_number_word(w, "ar")}
    valued = {w for w in numbers if spoken_number([w], "ar", conjunction=True) is not None}
    # The accusative forms added 5 words, all numbers where they stand: واحدا (2:133 ...),
    # سبعا (15:87, 78:12), تسعا (18:25), عشرا (20:103, 28:27) and وعشرا (2:234).
    assert (len(words), len(numbers), len(valued)) == (14868, 47, 41)

    spellings: dict[str, list[tuple[str, ...]]] = {}
    for spelling, value in _number_table("ar").items():
        spellings.setdefault(value, []).append(spelling)
    quran = Quran(quran_dir)
    checked = 0
    for s, a, text in lines:
        tokens = tokenize(text, "ar")
        for start in range(len(tokens)):
            for k in (1, 2):
                value = spoken_number(tokens[start : start + k], "ar") if start + k <= len(tokens) else None
                if value is None:
                    continue
                own = tuple(recitation_key(t, "ar") for t in tokens[start : start + k])
                for other in [sp for sp in spellings[value] if sp != own][:2]:
                    heard = " ".join(tokens[:start] + list(other) + tokens[start + k :])
                    assert check_recitation(text, heard, "ar").n_errors == 0, (s, a, other)
                    assert quran.check(int(s), int(a), int(a), heard)["n_errors"] > 0, (s, a, other)
                    checked += 1
    assert checked > 100
