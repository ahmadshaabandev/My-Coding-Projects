"""Deterministic word checking: the only code that decides whether a word is wrong.

Hard rule 2 of the contract: an LLM never decides whether a child's word is right. This
module does, with a word-level Levenshtein alignment between the expected tokens and
what was heard (speech) or written (dictation).

Alignment
---------
:func:`align` is a plain word-level Levenshtein alignment (substitution, deletion and
insertion all cost 1). Among the alignments with the minimum cost, ties are broken
deterministically from the start of the text: at each step the first optimal move in
the order match, sub, del, ins is taken. A child reads from the beginning, so a
skipped stretch is reported where it starts: for expected ``the cat sat on the mat``
and heard ``the mat`` the result is ``the`` matched, ``cat sat on the`` deleted and
``mat`` matched.

:func:`align_with_joins` adds one move used for speech only: a recogniser splits and
joins words freely (``peut-être`` / ``peut être``, ``عبد الله`` / ``عبدالله``), so an
expected word whose key equals the concatenated keys of two or three consecutive heard
tokens (or the reverse) is a match at no cost. The op of a joined match keeps one
``heard_index`` (the first heard piece) and its ``heard`` field holds the pieces joined
by a space; when one heard token covers several expected words, each of them gets a
match op that points to that same heard token.

Verdicts
--------
``say_again`` is True when nothing usable was heard (no heard tokens) or the error rate
``n_errors / n_expected`` is above :data:`SAY_AGAIN_ERROR_RATE` (0.6): the input then
looks unreliable rather than wrong, and the verdict is ``"unclear"``. Otherwise the
verdict is ``"correct"`` with no errors and ``"mistakes"`` with at least one.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Callable, Literal, Sequence

import numpy as np

from .textnorm import Lang, normalize_dictation_word, normalize_word, tokenize

OpKind = Literal["match", "sub", "del", "ins"]
Verdict = Literal["correct", "mistakes", "unclear"]

#: Error rate (errors / expected words) above which the input is treated as unreliable.
SAY_AGAIN_ERROR_RATE = 0.6

#: Largest number of tokens that :func:`align_with_joins` joins into one word.
MAX_JOINED_PIECES = 3


@dataclass
class Op:
    """One step of an alignment between expected and heard (or written) tokens."""

    kind: Literal["match", "sub", "del", "ins"]  # del = child skipped an expected word; ins = child added a word
    exp_index: int | None  # index into expected tokens (None for ins)
    heard_index: int | None  # index into heard tokens (None for del)
    expected: str | None  # surface form of the expected token
    heard: str | None  # surface form of the heard token


@dataclass
class CheckResult:
    """The outcome of checking one recitation or dictation."""

    ops: list[Op]
    n_expected: int
    n_errors: int  # sub + del + ins
    first_error_exp_index: int | None
    verdict: Literal["correct", "mistakes", "unclear"]
    say_again: bool  # True when the input looks unreliable: empty, or error rate above 0.6
    word_accuracy: float  # matched / n_expected (0..1)


# ---------------------------------------------------------------------------
# Alignment core
# ---------------------------------------------------------------------------


def align(expected: list[str], heard: list[str], key: Callable[[str], str]) -> list[Op]:
    """Align two token lists with a word-level Levenshtein distance.

    ``key`` normalises a token for comparison; two tokens match when their keys are
    equal. Substitution, deletion and insertion each cost 1. Among the minimum-cost
    alignments, ties are broken from the start of the lists, preferring match, then
    sub, then del, then ins (see the module docstring).

    Returns the ops in order. Every expected index appears in exactly one match, sub or
    del op, and every heard index in exactly one match, sub or ins op, both in
    increasing order. The number of non-match ops is the edit distance.
    """
    return _align(expected, heard, key, max_pieces=1)


def align_with_joins(
    expected: list[str],
    heard: list[str],
    key: Callable[[str], str],
    *,
    max_pieces: int = MAX_JOINED_PIECES,
) -> list[Op]:
    """Like :func:`align`, but a word split or joined differently counts as a match.

    An expected token whose key equals the concatenated keys of 2..``max_pieces``
    consecutive heard tokens is matched with all of them (one op, ``heard_index`` of the
    first piece, ``heard`` the pieces joined by a space). Likewise 2..``max_pieces``
    consecutive expected tokens whose keys concatenate to one heard key are each matched
    to that heard token. Joined matches cost 0 and rank with matches in the tie-break.

    Use this for speech only: in dictation, writing ``peut être`` for ``peut-être`` is a
    spelling mistake. The key should already ignore hyphens and apostrophes.
    """
    if max_pieces < 1:
        raise ValueError("max_pieces must be at least 1")
    return _align(expected, heard, key, max_pieces=max_pieces)


def _align(
    expected: Sequence[str],
    heard: Sequence[str],
    key: Callable[[str], str],
    *,
    max_pieces: int,
) -> list[Op]:
    exp_keys = [key(t) for t in expected]
    heard_keys = [key(t) for t in heard]
    n, m = len(exp_keys), len(heard_keys)

    # Integer ids make a whole DP row comparable with one numpy operation.
    ids: dict[str, int] = {}
    exp_ids = np.array([ids.setdefault(k, len(ids)) for k in exp_keys], dtype=np.int64)
    heard_ids = np.array([ids.setdefault(k, len(ids)) for k in heard_keys], dtype=np.int64)

    join_heard, join_exp = _find_joins(exp_keys, heard_keys, max_pieces)
    join_heard_rows: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for (i, j), k in join_heard.items():
        join_heard_rows[i].append((j, k))
    join_exp_rows: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for (i, j), k in join_exp.items():
        join_exp_rows[i].append((j, k))

    # cost[i, j] = minimum cost of aligning expected[i:] with heard[j:].
    cost = np.zeros((n + 1, m + 1), dtype=np.int64)
    cols = np.arange(m + 1, dtype=np.int64)
    cost[n] = m - cols  # only insertions remain
    for i in range(n - 1, -1, -1):
        best = cost[i + 1] + 1  # delete expected[i]
        if m:
            diag = cost[i + 1, 1:] + (heard_ids != exp_ids[i])
            np.minimum(best[:m], diag, out=best[:m])
        for j, k in join_heard_rows.get(i, ()):
            best[j] = min(best[j], cost[i + 1, j + k])
        for j, k in join_exp_rows.get(i, ()):
            best[j] = min(best[j], cost[i + k, j + 1])
        # Insertions run along the row: cost[i, j] = min over j' >= j of
        # best[j'] + (j' - j), i.e. a running minimum from the right.
        shifted = best + cols
        cost[i] = np.minimum.accumulate(shifted[::-1])[::-1] - cols

    # Forward trace: take the first optimal move in the order match, sub, del, ins.
    ops: list[Op] = []
    i = j = 0
    while i < n or j < m:
        here = cost[i, j]
        if i < n and j < m and exp_ids[i] == heard_ids[j] and cost[i + 1, j + 1] == here:
            ops.append(Op("match", i, j, expected[i], heard[j]))
            i, j = i + 1, j + 1
        elif (k := join_heard.get((i, j))) and cost[i + 1, j + k] == here:
            ops.append(Op("match", i, j, expected[i], " ".join(heard[j : j + k])))
            i, j = i + 1, j + k
        elif (k := join_exp.get((i, j))) and cost[i + k, j + 1] == here:
            ops.extend(Op("match", i + t, j, expected[i + t], heard[j]) for t in range(k))
            i, j = i + k, j + 1
        elif i < n and j < m and cost[i + 1, j + 1] + 1 == here:
            ops.append(Op("sub", i, j, expected[i], heard[j]))
            i, j = i + 1, j + 1
        elif i < n and cost[i + 1, j] + 1 == here:
            ops.append(Op("del", i, None, expected[i], None))
            i += 1
        else:
            ops.append(Op("ins", None, j, None, heard[j]))
            j += 1
    return ops


def _find_joins(
    exp_keys: list[str], heard_keys: list[str], max_pieces: int
) -> tuple[dict[tuple[int, int], int], dict[tuple[int, int], int]]:
    """Find the joined matches allowed by :func:`align_with_joins`.

    Returns two maps from ``(i, j)`` to a piece count ``k``: in the first, expected[i]
    equals heard[j:j+k] joined; in the second, expected[i:i+k] joined equals heard[j].
    Since keys are non-empty, at most one ``k`` fits each ``(i, j)``.
    """
    join_heard: dict[tuple[int, int], int] = {}
    join_exp: dict[tuple[int, int], int] = {}
    if max_pieces < 2:
        return join_heard, join_exp

    def positions(keys: list[str]) -> dict[str, list[int]]:
        where: dict[str, list[int]] = defaultdict(list)
        for idx, k in enumerate(keys):
            if k:
                where[k].append(idx)
        return where

    exp_at, heard_at = positions(exp_keys), positions(heard_keys)
    for pieces, at, target, swap in (
        (heard_keys, exp_at, join_heard, False),
        (exp_keys, heard_at, join_exp, True),
    ):
        for start in range(len(pieces)):
            for k in range(2, max_pieces + 1):
                if start + k > len(pieces) or not all(pieces[start : start + k]):
                    break
                joined = "".join(pieces[start : start + k])
                for other in at.get(joined, ()):
                    target[(start, other) if swap else (other, start)] = k
    return join_heard, join_exp


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------


def build_result(ops: list[Op], n_expected: int, n_heard: int) -> CheckResult:
    """Summarise an alignment as a :class:`CheckResult`.

    ``first_error_exp_index`` is the expected index of the first non-match op; for an
    insertion it is the index of the expected word that follows it (the last expected
    word when the insertion is at the end), and None when nothing was expected.
    ``n_heard`` is the number of heard (or written) tokens; zero means nothing usable
    was heard, so the child is asked to say it again.
    """
    n_match = sum(1 for op in ops if op.kind == "match")
    n_errors = len(ops) - n_match

    first_error: int | None = None
    for pos, op in enumerate(ops):
        if op.kind == "match":
            continue
        if op.exp_index is not None:
            first_error = op.exp_index
        else:
            following = next((o.exp_index for o in ops[pos:] if o.exp_index is not None), None)
            first_error = following if following is not None else (n_expected - 1 if n_expected else None)
        break

    error_rate = n_errors / max(n_expected, 1)
    say_again = n_heard == 0 or error_rate > SAY_AGAIN_ERROR_RATE
    verdict: Verdict
    if say_again:
        verdict = "unclear"
    elif n_errors == 0:
        verdict = "correct"
    else:
        verdict = "mistakes"
    accuracy = n_match / n_expected if n_expected else 0.0
    return CheckResult(
        ops=ops,
        n_expected=n_expected,
        n_errors=n_errors,
        first_error_exp_index=first_error,
        verdict=verdict,
        say_again=say_again,
        word_accuracy=accuracy,
    )


def recitation_key(token: str, lang: Lang) -> str:
    """Comparison key of a token for speech.

    :func:`~mommy.textnorm.normalize_word` without tashkeel and without accents, and
    without hyphens and apostrophes, which cannot be heard (``peut-être`` and
    ``peutêtre``, ``l'a`` and ``la`` sound the same).
    """
    return (
        normalize_word(token, lang, keep_tashkeel=False, keep_accents=False)
        .replace("-", "")
        .replace("'", "")
    )


def writing_key(token: str, lang: Lang, *, strict_tashkeel: bool = False) -> str:
    """Comparison key of a token for dictation (spelling): see
    :func:`~mommy.textnorm.normalize_dictation_word`."""
    return normalize_dictation_word(token, lang, keep_tashkeel=strict_tashkeel)


def check_recitation(expected_text: str, heard_text: str, lang: Lang) -> CheckResult:
    """Check what a child said (as transcribed, unprompted) against the expected text.

    Both texts are tokenised with :func:`~mommy.textnorm.tokenize` (``exp_index`` and
    ``heard_index`` refer to those tokens) and compared with :func:`recitation_key`, so
    tashkeel, accents, case, punctuation and the Arabic letter variants a recogniser
    spells inconsistently do not count. Words split or joined differently by the
    recogniser are accepted (:func:`align_with_joins`).
    """
    expected = tokenize(expected_text, lang)
    heard = tokenize(heard_text, lang)
    ops = align_with_joins(expected, heard, lambda t: recitation_key(t, lang))
    return build_result(ops, len(expected), len(heard))


def check_writing(
    expected_text: str, written_text: str, lang: Lang, *, strict_tashkeel: bool = False
) -> CheckResult:
    """Check what a child wrote in a dictation against the expected text.

    Spelling counts: accents are kept (``é`` is not ``e``), and in Arabic the hamza
    seats, ta marbuta and alef maksura are significant (``مدرسه`` for ``مدرسة`` is a
    mistake). Case and punctuation are ignored. Tashkeel is ignored unless
    ``strict_tashkeel``. Plain :func:`align` is used: a word written in two parts is a
    mistake.
    """
    expected = tokenize(expected_text, lang)
    written = tokenize(written_text, lang)
    ops = align(
        expected, written, lambda t: writing_key(t, lang, strict_tashkeel=strict_tashkeel)
    )
    return build_result(ops, len(expected), len(written))


def result_summary(result: CheckResult, *, max_errors: int = 5) -> dict[str, Any]:
    """A compact, JSON-ready summary of a result, for wording feedback.

    ``{"verdict", "say_again", "n_expected", "n_errors", "word_accuracy",
    "errors": [{"kind", "expected", "heard", "exp_index"}, ...]}`` with at most
    ``max_errors`` errors, in text order. It holds only the words of the errors, so it
    can be handed to a feedback writer without changing the verdict.
    """
    errors = [
        {"kind": op.kind, "expected": op.expected, "heard": op.heard, "exp_index": op.exp_index}
        for op in result.ops
        if op.kind != "match"
    ]
    return {
        "verdict": result.verdict,
        "say_again": result.say_again,
        "n_expected": result.n_expected,
        "n_errors": result.n_errors,
        "word_accuracy": round(result.word_accuracy, 4),
        "errors": errors[:max_errors],
    }


__all__ = [
    "MAX_JOINED_PIECES",
    "SAY_AGAIN_ERROR_RATE",
    "CheckResult",
    "Op",
    "align",
    "align_with_joins",
    "build_result",
    "check_recitation",
    "check_writing",
    "recitation_key",
    "result_summary",
    "writing_key",
]
