"""Deterministic word checking: the only code that decides whether a word is wrong.

Hard rule 2 of the contract: an LLM never decides whether a child's word is right. This
module does, with a word-level Levenshtein alignment between the expected tokens and
what was heard (speech) or written (dictation).

Alignment
---------
:func:`align` is a word-level Levenshtein alignment (substitution, deletion and
insertion all cost 1). Among the alignments with the minimum cost, the one that matches
the most expected words is taken: for expected ``I see the cat`` and heard ``I see cat
now``, "``the`` skipped, ``cat`` matched, ``now`` added" (3 words right) beats "``the``
heard as ``cat``, ``cat`` heard as ``now``" (2 words right), although both cost 2. The
remaining ties are broken deterministically from the start of the text: at each step
the first optimal move in the order match, sub, del, ins is taken. A child reads from
the beginning, so a skipped stretch is reported where it starts: for expected ``the cat
sat on the mat`` and heard ``the mat`` the result is ``the`` matched, ``cat sat on the``
deleted and ``mat`` matched.

:func:`align_with_joins` adds moves used for speech only: a recogniser splits and joins
words freely (``peut-être`` / ``peut être``, ``عبد الله`` / ``عبدالله``), so an expected
word whose key equals the concatenated keys of two or three consecutive heard tokens (or
the reverse) is a match at no cost. :func:`check_recitation` also lets it match a number
written in digits with the same number in words (``12`` / ``twelve``, ``21`` / ``vingt et
un`` / ``واحد وعشرون``), an Arabic number in words with the same number in another
gender or case (``اثنتا عشرة`` / ``اثنا عشر``, ``ثلاثة`` / ``ثلاث``, ``واحد وعشرون`` /
``إحدى وعشرين``) and an English contraction with its full form (``they're`` / ``they
are``); see :func:`speech_joins`. The op of a joined match keeps one ``heard_index`` (the
first heard piece) and its ``heard`` field holds the pieces joined by a space; when one
heard token covers several expected words, each of them gets a match op that points to
that same heard token. A run of several words matched with a run of several words (a
block) gives one op per expected word, paired with the heard words in order.

Verdicts
--------
``say_again`` is True when the input looks unreliable, and the verdict is then
``"unclear"``; ``say_again_reason`` says why:

* ``"empty"``: nothing usable was heard or written (no tokens);
* ``"error_rate"`` (speech only): the error rate is above :data:`SAY_AGAIN_ERROR_RATE`
  (0.6). The rate leaves out a final run of skipped words when the child stopped early
  (see ``stopped_at_exp_index``): ``n_errors`` minus that run, divided by the expected
  words before it. A child who reads the first sentence of a page well is told where
  they stopped, not that the recording was unclear.

In dictation (:func:`check_writing`) only an empty writing gives ``say_again``: a page
full of misspellings is a result for the parent to confirm, not a bad recording.
Otherwise the verdict is ``"correct"`` with no errors and ``"mistakes"`` with at least
one.

``stopped_at_exp_index`` is the expected index of the first word of a final run of at
least :data:`STOPPED_MIN_WORDS` skipped words, when something was heard before it.

In a dictation read from a photo, a word the reader could not read is written
:data:`UNREADABLE` (``[?]``). It is aligned like any written word, so it shows as a
``sub`` whose ``heard`` is ``[?]``, never as a skipped word; ``n_unreadable`` counts
them, and the feedback does not point them out as mistakes.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Callable, Collection, Literal, Mapping, Sequence

import numpy as np

from .textnorm import (
    Lang,
    digit_number,
    english_expansions,
    fold_english_spelling,
    is_number_word,
    normalize_dictation_word,
    normalize_word,
    spoken_number,
    tokenize,
)

OpKind = Literal["match", "sub", "del", "ins"]
Verdict = Literal["correct", "mistakes", "unclear"]
SayAgainReason = Literal["empty", "error_rate"]

#: Error rate (errors / expected words) above which speech is treated as unreliable.
SAY_AGAIN_ERROR_RATE = 0.6

#: A final run of at least this many skipped words means the child stopped early.
STOPPED_MIN_WORDS = 2

#: Largest number of tokens that :func:`align_with_joins` joins into one word.
MAX_JOINED_PIECES = 3

#: The mark a page or handwriting reader writes for a word it cannot read.
UNREADABLE = "[?]"
_UNREADABLE_RE = re.compile(r"\[\s*[?\u061f]\s*\]")

#: Joined matches: ``(i, j)`` -> the piece counts ``k`` that match there (see
#: :func:`align_with_joins`).
Joins = Mapping[tuple[int, int], Sequence[int]]

#: Block matches: ``(i, j)`` -> the sizes ``(a, b)`` for which expected[i:i+a] as a
#: whole matches heard[j:j+b] as a whole (see :func:`align_with_joins`).
Blocks = Mapping[tuple[int, int], Sequence[tuple[int, int]]]


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
    say_again: bool  # True when the input looks unreliable: empty, or (speech) error rate above 0.6
    word_accuracy: float  # matched / n_expected (0..1)
    say_again_reason: SayAgainReason | None = None  # "empty" or "error_rate" when say_again
    stopped_at_exp_index: int | None = None  # first word of a final run of skipped words
    n_unreadable: int = 0  # written words read as [?] (counted in n_errors)


# ---------------------------------------------------------------------------
# Alignment core
# ---------------------------------------------------------------------------


def align(expected: list[str], heard: list[str], key: Callable[[str], str]) -> list[Op]:
    """Align two token lists with a word-level Levenshtein distance.

    ``key`` normalises a token for comparison; two tokens match when their keys are
    equal. Substitution, deletion and insertion each cost 1. Among the minimum-cost
    alignments the one with the most matched words is taken, and remaining ties are
    broken from the start of the lists, preferring match, then sub, then del, then ins
    (see the module docstring).

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
    extra_joins: tuple[Joins, Joins] | tuple[Joins, Joins, Blocks] | None = None,
    rigid: Collection[int] | None = None,
) -> list[Op]:
    """Like :func:`align`, but a word split or joined differently counts as a match.

    An expected token whose key equals the concatenated keys of 2..``max_pieces``
    consecutive heard tokens is matched with all of them (one op, ``heard_index`` of the
    first piece, ``heard`` the pieces joined by a space). Likewise 2..``max_pieces``
    consecutive expected tokens whose keys concatenate to one heard key are each matched
    to that heard token. Joined matches cost 0 and rank with matches in the tie-break.

    ``extra_joins`` adds equivalences found by the caller, as ``(join_heard,
    join_exp)`` or ``(join_heard, join_exp, blocks)``: ``join_heard[(i, j)]`` lists the
    counts ``k`` for which expected[i] matches heard[j:j+k], ``join_exp[(i, j)]`` those
    for which expected[i:i+k] matches heard[j] (``k`` may be 1), and ``blocks[(i, j)]``
    the sizes ``(a, b)`` for which expected[i:i+a] matches heard[j:j+b] as a whole
    (one move: a block is matched entirely or not at all). A block gives one match op
    per expected word, paired in order with the heard words: when ``b > a`` the last
    expected word takes the remaining heard words (joined by a space), and when ``a >
    b`` the remaining expected words all point to the last heard word, as for the joins
    above. See :func:`speech_joins`.

    ``rigid`` lists expected indices that take no part in the joins found here (the
    split and joined words): such a word matches one heard token with an equal key, or
    through ``extra_joins``, which the caller gives for it (the Quran words of a school
    text: compared as :meth:`mommy.quran.Quran.check` compares them). The caller leaves
    them out of its own equivalences (see :func:`without_rigid`).

    Use this for speech only: in dictation, writing ``peut être`` for ``peut-être`` is a
    spelling mistake. The key should already ignore hyphens and apostrophes.
    """
    if max_pieces < 1:
        raise ValueError("max_pieces must be at least 1")
    return _align(expected, heard, key, max_pieces=max_pieces, extra_joins=extra_joins, rigid=rigid)


def without_rigid(
    joins: tuple[Joins, Joins, Blocks], rigid: Collection[int]
) -> tuple[dict[tuple[int, int], list[int]], dict[tuple[int, int], list[int]], dict[tuple[int, int], list[tuple[int, int]]]]:
    """``(join_heard, join_exp, blocks)`` (as from :func:`speech_joins`) without every
    equivalence that involves an expected index in ``rigid``."""
    rigid = set(rigid)
    join_heard, join_exp, blocks = joins
    jh = {pos: list(ks) for pos, ks in join_heard.items() if pos[0] not in rigid}
    je: dict[tuple[int, int], list[int]] = {}
    for (i, j), ks in join_exp.items():
        kept = [k for k in ks if not rigid.intersection(range(i, i + k))]
        if kept:
            je[(i, j)] = kept
    bl: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for (i, j), sizes in blocks.items():
        kept_sizes = [(a, b) for a, b in sizes if not rigid.intersection(range(i, i + a))]
        if kept_sizes:
            bl[(i, j)] = kept_sizes
    return jh, je, bl


def _align(
    expected: Sequence[str],
    heard: Sequence[str],
    key: Callable[[str], str],
    *,
    max_pieces: int,
    extra_joins: tuple[Joins, Joins] | tuple[Joins, Joins, Blocks] | None = None,
    rigid: Collection[int] | None = None,
) -> list[Op]:
    exp_keys = [key(t) for t in expected]
    heard_keys = [key(t) for t in heard]
    n, m = len(exp_keys), len(heard_keys)

    # Integer ids make a whole DP row comparable with one numpy operation.
    ids: dict[str, int] = {}
    exp_ids = np.array([ids.setdefault(k, len(ids)) for k in exp_keys], dtype=np.int64)
    heard_ids = np.array([ids.setdefault(k, len(ids)) for k in heard_keys], dtype=np.int64)

    join_heard, join_exp = _find_joins(exp_keys, heard_keys, max_pieces, frozenset(rigid or ()))
    blocks: dict[tuple[int, int], list[tuple[int, int]]] = {}
    if extra_joins is not None:
        extra_heard, extra_exp = extra_joins[0], extra_joins[1]
        extra_blocks: Blocks = extra_joins[2] if len(extra_joins) == 3 else {}
        for target, extra in ((join_heard, extra_heard), (join_exp, extra_exp)):
            for (i, j), ks in extra.items():
                if 0 <= i < n and 0 <= j < m:
                    target[(i, j)] = sorted(set(target.get((i, j), ())) | {k for k in ks if k >= 1})
        # A block with one word on a side is a join: one move, the same ops.
        block_sets: dict[tuple[int, int], set[tuple[int, int]]] = defaultdict(set)
        for (i, j), sizes in extra_blocks.items():
            for a, b in sizes:
                if not (a >= 1 and b >= 1 and 0 <= i and i + a <= n and 0 <= j and j + b <= m):
                    continue
                if a == 1 or b == 1:
                    target, k = (join_heard, b) if a == 1 else (join_exp, a)
                    target[(i, j)] = sorted(set(target.get((i, j), ())) | {k})
                else:
                    block_sets[(i, j)].add((a, b))
        blocks = {pos: sorted(sizes) for pos, sizes in block_sets.items()}
        for (i, j), ks in list(join_heard.items()):
            join_heard[(i, j)] = [k for k in ks if j + k <= m]
        for (i, j), ks in list(join_exp.items()):
            join_exp[(i, j)] = [k for k in ks if i + k <= n]
    join_heard_rows: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for (i, j), ks in join_heard.items():
        join_heard_rows[i].extend((j, k) for k in ks)
    join_exp_rows: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for (i, j), ks in join_exp.items():
        join_exp_rows[i].extend((j, k) for k in ks)
    block_rows: dict[int, list[tuple[int, int, int]]] = defaultdict(list)
    for (i, j), sizes in blocks.items():
        block_rows[i].extend((j, a, b) for a, b in sizes)

    # score[i, j] = cost * big - matches for the best alignment of expected[i:] with
    # heard[j:]: the minimum cost first, then the most matched expected words (there
    # are at most n, so ``big`` keeps the two apart). int32 whenever it is wide enough.
    big = n + 1
    dtype = np.int32 if (n + m + 1) * big < 2**31 - 1 else np.int64
    score = np.empty((n + 1, m + 1), dtype=dtype)
    cols = np.arange(m + 1, dtype=dtype)
    col_cost = cols * big
    score[n] = (m - cols) * big  # only insertions remain
    for i in range(n - 1, -1, -1):
        best = score[i + 1] + big  # delete expected[i]
        if m:
            diag = score[i + 1, 1:] + np.where(heard_ids == exp_ids[i], -1, big).astype(dtype)
            np.minimum(best[:m], diag, out=best[:m])
        for j, k in join_heard_rows.get(i, ()):
            best[j] = min(best[j], score[i + 1, j + k] - 1)
        for j, k in join_exp_rows.get(i, ()):
            best[j] = min(best[j], score[i + k, j + 1] - k)
        for j, a, b in block_rows.get(i, ()):
            best[j] = min(best[j], score[i + a, j + b] - a)
        # Insertions run along the row: score[i, j] = min over j' >= j of
        # best[j'] + (j' - j) * big, i.e. a running minimum from the right.
        shifted = best + col_cost
        score[i] = np.minimum.accumulate(shifted[::-1])[::-1] - col_cost

    # Forward trace: take the first optimal move in the order match, sub, del, ins.
    ops: list[Op] = []
    i = j = 0
    while i < n or j < m:
        here = score[i, j]
        if i < n and j < m and exp_ids[i] == heard_ids[j] and score[i + 1, j + 1] - 1 == here:
            ops.append(Op("match", i, j, expected[i], heard[j]))
            i, j = i + 1, j + 1
        elif (k := next((k for k in join_heard.get((i, j), ()) if score[i + 1, j + k] - 1 == here), 0)):
            ops.append(Op("match", i, j, expected[i], " ".join(heard[j : j + k])))
            i, j = i + 1, j + k
        elif (k := next((k for k in join_exp.get((i, j), ()) if score[i + k, j + 1] - k == here), 0)):
            ops.extend(Op("match", i + t, j, expected[i + t], heard[j]) for t in range(k))
            i, j = i + k, j + 1
        elif (ab := next(((a, b) for a, b in blocks.get((i, j), ()) if score[i + a, j + b] - a == here), None)):
            a, b = ab
            for t in range(a):
                lo = j + min(t, b - 1)
                hi = j + b if t == a - 1 else lo + 1
                ops.append(Op("match", i + t, lo, expected[i + t], " ".join(heard[lo:hi])))
            i, j = i + a, j + b
        elif i < n and j < m and score[i + 1, j + 1] + big == here:
            ops.append(Op("sub", i, j, expected[i], heard[j]))
            i, j = i + 1, j + 1
        elif i < n and score[i + 1, j] + big == here:
            ops.append(Op("del", i, None, expected[i], None))
            i += 1
        else:
            ops.append(Op("ins", None, j, None, heard[j]))
            j += 1
    return ops


def _find_joins(
    exp_keys: list[str], heard_keys: list[str], max_pieces: int, rigid: frozenset[int] = frozenset()
) -> tuple[dict[tuple[int, int], list[int]], dict[tuple[int, int], list[int]]]:
    """Find the joined matches allowed by :func:`align_with_joins`.

    Returns two maps from ``(i, j)`` to piece counts ``k``: in the first, expected[i]
    equals heard[j:j+k] joined; in the second, expected[i:i+k] joined equals heard[j].
    Since keys are non-empty, at most one ``k`` fits each ``(i, j)`` here. Expected
    indices in ``rigid`` are in no join.
    """
    join_heard: dict[tuple[int, int], list[int]] = {}
    join_exp: dict[tuple[int, int], list[int]] = {}
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
                if swap and rigid and rigid.intersection(range(start, start + k)):
                    break
                joined = "".join(pieces[start : start + k])
                for other in at.get(joined, ()):
                    if not swap and other in rigid:
                        continue
                    target[(start, other) if swap else (other, start)] = [k]
    return join_heard, join_exp


def speech_joins(
    expected: Sequence[str], heard: Sequence[str], lang: Lang, *, max_pieces: int = MAX_JOINED_PIECES
) -> tuple[
    dict[tuple[int, int], list[int]],
    dict[tuple[int, int], list[int]],
    dict[tuple[int, int], list[tuple[int, int]]],
]:
    """Speech equivalences between expected and heard tokens, as ``extra_joins``.

    Returns ``(join_heard, join_exp, blocks)`` for :func:`align_with_joins`.

    * Numbers: a token written in digits matches the same number written in words in
      1..``max_pieces`` consecutive tokens on the other side (``12`` / ``twelve``, ``25``
      / ``twenty five``, ``21`` / ``vingt et un``, ``٢١`` / ``واحد وعشرون``, ``1er`` /
      ``premier``), for 0 to 100 (:func:`mommy.textnorm.spoken_number`). Digits match
      digits through the key already (Western and Arabic-Indic alike).
    * Arabic numbers in words match by value on both sides: a run of 1..``max_pieces``
      number words matches a run on the other side that spells the same number in
      another gender or case (``ثلاثة`` / ``ثلاث``, ``عشرون`` / ``عشرين``, ``اثنتا عشرة``
      / ``اثنا عشر`` / ``إثنى عشر``, ``واحد وعشرون`` / ``إحدى وعشرين``), also with a
      leading conjunction ``و`` on both sides (``وثلاث`` / ``وثلاثة``). The speech key
      already drops the case endings, and the recogniser writes numbers in the gender it
      prefers, so the difference cannot be put down to the child. Different values stay
      different (``ثلاثة`` / ``أربعة``, ``ثلاثة عشر`` / ``ثلاثة``). A run of several
      words on both sides is a block: matched as a whole or not at all. A page word
      whose vowel marks rule the number out (``سَبُع`` a beast of prey, ``خُمُس`` a
      fifth, ``تَسَعُ`` "holds") is not a number; without marks, ``سبع`` is seven.
    * English contractions: ``they're`` matches ``they are``, ``she's`` matches ``she
      is`` or ``she has``, ``don't`` matches ``do not``, on either side
      (:func:`mommy.textnorm.english_expansions`).

    Speech only: in a dictation these are spelling differences. The Quran check does not
    use these equivalences either.
    """
    join_heard: dict[tuple[int, int], list[int]] = defaultdict(list)
    join_exp: dict[tuple[int, int], list[int]] = defaultdict(list)
    blocks: dict[tuple[int, int], list[tuple[int, int]]] = defaultdict(list)

    def digits_at(tokens: Sequence[str]) -> dict[str, list[int]]:
        where: dict[str, list[int]] = defaultdict(list)
        for idx, tok in enumerate(tokens):
            if (value := digit_number(tok, lang)) is not None:
                where[value].append(idx)
        return where

    def word_numbers(tokens: Sequence[str]) -> list[tuple[int, int, str]]:
        # With the conjunction, "وثلاث" is "وc3": it equals "وثلاثة", never a digit value.
        found = []
        for start, tok in enumerate(tokens):
            if not is_number_word(tok, lang):
                continue
            for k in range(1, max_pieces + 1):
                if start + k > len(tokens):
                    break
                value = spoken_number(tokens[start : start + k], lang, conjunction=True)
                if value is not None:
                    found.append((start, k, value))
        return found

    exp_words, heard_words = word_numbers(expected), word_numbers(heard)
    exp_digits, heard_digits = digits_at(expected), digits_at(heard)
    if exp_digits:
        for j, k, value in heard_words:
            for i in exp_digits.get(value, ()):
                join_heard[(i, j)].append(k)
    if heard_digits:
        for i, k, value in exp_words:
            for j in heard_digits.get(value, ()):
                join_exp[(i, j)].append(k)

    if lang == "ar" and exp_words and heard_words:
        heard_by_value: dict[str, list[tuple[int, int]]] = defaultdict(list)
        for j, b, value in heard_words:
            heard_by_value[value].append((j, b))
        exp_ar = [recitation_key(t, lang) for t in expected]
        heard_ar = [recitation_key(t, lang) for t in heard]
        for i, a, value in exp_words:
            for j, b in heard_by_value.get(value, ()):
                if exp_ar[i : i + a] == heard_ar[j : j + b]:
                    continue  # the same words: matched by their keys already
                if a == 1:
                    join_heard[(i, j)].append(b)
                elif b == 1:
                    join_exp[(i, j)].append(a)
                else:
                    blocks[(i, j)].append((a, b))

    if lang == "en":
        def keyed(tokens: Sequence[str]) -> list[str]:
            return [recitation_key(t, "en") for t in tokens]

        def runs(keys: list[str], k: int) -> dict[tuple[str, ...], list[int]]:
            where: dict[tuple[str, ...], list[int]] = defaultdict(list)
            for idx in range(len(keys) - k + 1):
                where[tuple(keys[idx : idx + k])].append(idx)
            return where

        exp_keys, heard_keys = keyed(expected), keyed(heard)
        exp_runs = {k: runs(exp_keys, k) for k in (1, 2)}
        heard_runs = {k: runs(heard_keys, k) for k in (1, 2)}
        for j, tok in enumerate(heard):
            for full in english_expansions(tok):
                for i in exp_runs[len(full)].get(tuple(recitation_key(w, "en") for w in full), ()):
                    join_exp[(i, j)].append(len(full))
        for i, tok in enumerate(expected):
            for full in english_expansions(tok):
                for j in heard_runs[len(full)].get(tuple(recitation_key(w, "en") for w in full), ()):
                    join_heard[(i, j)].append(len(full))
    return dict(join_heard), dict(join_exp), dict(blocks)


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------


def build_result(
    ops: list[Op],
    n_expected: int,
    n_heard: int,
    *,
    unreliable_error_rate: float | None = SAY_AGAIN_ERROR_RATE,
) -> CheckResult:
    """Summarise an alignment as a :class:`CheckResult`.

    ``first_error_exp_index`` is the expected index of the first non-match op; for an
    insertion it is the index of the expected word that follows it (the last expected
    word when the insertion is at the end), and None when nothing was expected.
    ``n_heard`` is the number of heard (or written) tokens; zero means nothing usable
    was heard, so the child is asked to say it again (``say_again_reason`` ``"empty"``).

    ``unreliable_error_rate`` is the error rate above which the input is treated as
    unreliable (``"error_rate"``); a final run of skipped words after the child stopped
    is left out of that rate (see the module docstring). None turns the rule off, as
    for dictation.
    """
    n_match = sum(1 for op in ops if op.kind == "match")
    n_errors = len(ops) - n_match
    n_unreadable = sum(1 for op in ops if op.kind != "match" and op.heard == UNREADABLE)

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

    trailing = 0
    for op in reversed(ops):
        if op.kind != "del":
            break
        trailing += 1
    stopped: int | None = None
    if n_heard and trailing >= STOPPED_MIN_WORDS and trailing < len(ops):
        stopped = ops[len(ops) - trailing].exp_index

    reason: SayAgainReason | None = None
    if n_heard == 0:
        reason = "empty"
    elif unreliable_error_rate is not None:
        skipped_at_end = trailing if stopped is not None else 0
        error_rate = (n_errors - skipped_at_end) / max(n_expected - skipped_at_end, 1)
        if error_rate > unreliable_error_rate:
            reason = "error_rate"
    say_again = reason is not None
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
        say_again_reason=reason,
        stopped_at_exp_index=stopped,
        n_unreadable=n_unreadable,
    )


def recitation_key(token: str, lang: Lang) -> str:
    """Comparison key of a token for speech.

    :func:`~mommy.textnorm.normalize_word` without tashkeel and without accents, and
    without hyphens and apostrophes, which cannot be heard (``peut-être`` and
    ``peutêtre``, ``l'a`` and ``la`` sound the same). In English, British spellings are
    folded onto American ones (:func:`~mommy.textnorm.fold_english_spelling`), because
    the recogniser writes ``color`` for a child who read ``colour``.
    """
    key = (
        normalize_word(token, lang, keep_tashkeel=False, keep_accents=False)
        .replace("-", "")
        .replace("'", "")
    )
    if lang == "en" and key.isascii():
        key = fold_english_spelling(key)
    return key


def writing_key(token: str, lang: Lang, *, strict_tashkeel: bool = False) -> str:
    """Comparison key of a token for dictation (spelling): see
    :func:`~mommy.textnorm.normalize_dictation_word`. :data:`UNREADABLE` gets a key
    that matches no word."""
    if token == UNREADABLE:
        return "\x00" + UNREADABLE
    return normalize_dictation_word(token, lang, keep_tashkeel=strict_tashkeel)


def check_recitation(expected_text: str, heard_text: str, lang: Lang) -> CheckResult:
    """Check what a child said (as transcribed, unprompted) against the expected text.

    Both texts are tokenised with :func:`~mommy.textnorm.tokenize` (``exp_index`` and
    ``heard_index`` refer to those tokens) and compared with :func:`recitation_key`, so
    tashkeel, accents, case, punctuation and the Arabic letter variants a recogniser
    spells inconsistently do not count. Words split or joined differently by the
    recogniser, numbers written in digits for words (or the reverse), Arabic numbers in
    words of another gender or case (compared by value) and English contractions are
    accepted (:func:`align_with_joins`, :func:`speech_joins`). The Quran check
    (:meth:`mommy.quran.Quran.check`) uses :func:`recitation_key` without these
    equivalences.
    """
    expected = tokenize(expected_text, lang)
    heard = tokenize(heard_text, lang)
    ops = align_with_joins(
        expected, heard, lambda t: recitation_key(t, lang), extra_joins=speech_joins(expected, heard, lang)
    )
    return build_result(ops, len(expected), len(heard))


def tokenize_written(text: str, lang: Lang) -> list[str]:
    """:func:`~mommy.textnorm.tokenize`, keeping each :data:`UNREADABLE` mark (``[?]``,
    also ``[ ? ]`` or with ``؟``) as a token of its own."""
    tokens: list[str] = []
    for idx, part in enumerate(_UNREADABLE_RE.split(text)):
        if idx:
            tokens.append(UNREADABLE)
        tokens.extend(tokenize(part, lang))
    return tokens


def has_unreadable(text: str) -> bool:
    """True when ``text`` holds an :data:`UNREADABLE` mark."""
    return bool(_UNREADABLE_RE.search(text))


def check_writing(
    expected_text: str, written_text: str, lang: Lang, *, strict_tashkeel: bool = False
) -> CheckResult:
    """Check what a child wrote in a dictation against the expected text.

    Spelling counts: accents are kept (``é`` is not ``e``), and in Arabic the hamza
    seats, ta marbuta and alef maksura are significant (``مدرسه`` for ``مدرسة`` is a
    mistake). Case and punctuation are ignored. Tashkeel is ignored unless
    ``strict_tashkeel``. Plain :func:`align` is used: a word written in two parts is a
    mistake, and so is a number written in digits for words. A word the reader marked
    unreadable (``[?]``) is a ``sub`` with ``heard`` ``[?]``, counted in
    ``n_unreadable``. Only an empty writing gives ``say_again``.
    """
    expected = tokenize(expected_text, lang)
    written = tokenize_written(written_text, lang)
    ops = align(
        expected, written, lambda t: writing_key(t, lang, strict_tashkeel=strict_tashkeel)
    )
    return build_result(ops, len(expected), len(written), unreliable_error_rate=None)


def result_summary(result: CheckResult, *, max_errors: int = 5) -> dict[str, Any]:
    """A compact, JSON-ready summary of a result, for wording feedback.

    ``{"verdict", "say_again", "say_again_reason", "n_expected", "n_errors",
    "n_unreadable", "word_accuracy", "stopped_at", "stopped_at_exp_index",
    "errors": [{"kind", "expected", "heard", "exp_index"}, ...]}`` with at most
    ``max_errors`` errors, in text order. Words marked unreadable are not listed as
    errors (they are counted in ``n_unreadable``). ``stopped_at`` is the expected word
    where the child stopped, or None. It holds only the words of the errors, so it can
    be handed to a feedback writer without changing the verdict.
    """
    errors = [
        {"kind": op.kind, "expected": op.expected, "heard": op.heard, "exp_index": op.exp_index}
        for op in result.ops
        if op.kind != "match" and op.heard != UNREADABLE
    ]
    stopped = result.stopped_at_exp_index
    stopped_word = next(
        (op.expected for op in result.ops if stopped is not None and op.exp_index == stopped), None
    )
    return {
        "verdict": result.verdict,
        "say_again": result.say_again,
        "say_again_reason": result.say_again_reason,
        "n_expected": result.n_expected,
        "n_errors": result.n_errors,
        "n_unreadable": result.n_unreadable,
        "word_accuracy": round(result.word_accuracy, 4),
        "stopped_at": stopped_word,
        "stopped_at_exp_index": stopped,
        "errors": errors[:max_errors],
    }


__all__ = [
    "MAX_JOINED_PIECES",
    "SAY_AGAIN_ERROR_RATE",
    "STOPPED_MIN_WORDS",
    "UNREADABLE",
    "Blocks",
    "CheckResult",
    "Joins",
    "Op",
    "align",
    "align_with_joins",
    "build_result",
    "check_recitation",
    "check_writing",
    "has_unreadable",
    "recitation_key",
    "result_summary",
    "speech_joins",
    "tokenize_written",
    "without_rigid",
    "writing_key",
]
