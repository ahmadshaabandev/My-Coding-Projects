"""deploy/huggingface/deploy.py against a fake huggingface_hub (no network, no token).

The fake keeps a Space's files, variables and secret names in memory, and can be told to
fail a call. It mirrors the calls of huggingface_hub 2.x that the script makes.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import re
import sys
import types
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy" / "huggingface" / "deploy.py"
LINK = re.compile(r"https://([a-z0-9-]+)\.hf\.space/#code=([a-z0-9]+)")


class FakeHTTPError(Exception):
    def __init__(self, message: str, status: int = 503) -> None:
        super().__init__(message)
        self.response = types.SimpleNamespace(status_code=status)
        self.server_message = message


class Hub:
    """The state of the fake Hub."""

    def __init__(self, *, exists: bool = False, is_pro: bool = True, user: str = "Some.User_x") -> None:
        self.user = user
        self.exists = exists
        self.is_pro = is_pro
        self.secrets: dict[str, str] = {}
        self.variables: dict[str, str] = {}
        self.files: dict[str, bytes] = {}
        self.sha = "c0" if exists else None
        self.commits = 0
        self.calls: list[str] = []
        self.fail: dict[str, BaseException] = {}  # call name -> exception to raise once
        self.restarts = 0

    def call(self, name: str) -> None:
        self.calls.append(name)
        exc = self.fail.pop(name, None)
        if exc is not None:
            raise exc


def fake_module(hub: Hub) -> types.ModuleType:
    class HfApi:
        def __init__(self, token: str | None = None) -> None:
            assert token

        def whoami(self) -> dict[str, Any]:
            hub.call("whoami")
            return {"name": hub.user, "type": "user", "isPro": hub.is_pro}

        def repo_exists(self, repo_id: str, repo_type: str | None = None) -> bool:
            hub.call("repo_exists")
            return hub.exists

        def create_repo(self, repo_id: str, **kwargs: Any) -> None:
            hub.call("create_repo")
            assert kwargs == {"repo_type": "space", "space_sdk": "docker", "private": False, "exist_ok": True}
            if not hub.exists:
                hub.exists = True
                hub.commits += 1
                hub.sha = f"c{hub.commits}"

        def space_info(self, repo_id: str) -> Any:
            hub.call("space_info")
            return types.SimpleNamespace(subdomain=repo_id.replace("/", "-").replace(".", "-").replace("_", "-").lower(), sha=hub.sha)

        def get_space_secrets(self, repo_id: str) -> dict[str, object]:
            hub.call("get_space_secrets")
            return {name: object() for name in hub.secrets}

        def get_space_variables(self, repo_id: str) -> dict[str, Any]:
            hub.call("get_space_variables")
            return {k: types.SimpleNamespace(value=v) for k, v in hub.variables.items()}

        def add_space_variable(self, repo_id: str, key: str, value: str, description: str | None = None) -> None:
            hub.call(f"add_space_variable:{key}")
            hub.variables[key] = value

        def add_space_secret(self, repo_id: str, key: str, value: str, description: str | None = None) -> None:
            hub.call(f"add_space_secret:{key}")
            hub.secrets[key] = value

        def upload_folder(self, *, repo_id: str, repo_type: str, folder_path: str, commit_message: str,
                          delete_patterns: str) -> Any:
            hub.call("upload_folder")
            assert repo_type == "space" and delete_patterns == "*"
            root = Path(folder_path)
            files = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            if files != hub.files:
                hub.files = files
                hub.commits += 1
                hub.sha = f"c{hub.commits}"
            return types.SimpleNamespace(commit_url=f"https://huggingface.co/spaces/{repo_id}/commit/{hub.sha}", oid=hub.sha)

        def restart_space(self, repo_id: str) -> None:
            hub.call("restart_space")
            hub.restarts += 1

    module = types.ModuleType("huggingface_hub")
    module.HfApi = HfApi  # type: ignore[attr-defined]
    errors = types.ModuleType("huggingface_hub.errors")
    errors.HfHubHTTPError = FakeHTTPError  # type: ignore[attr-defined]
    module.errors = errors  # type: ignore[attr-defined]
    return module


def run(hub: Hub, monkeypatch: pytest.MonkeyPatch, *args: str) -> tuple[int, str, str]:
    module = fake_module(hub)
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    monkeypatch.setitem(sys.modules, "huggingface_hub.errors", module.errors)
    monkeypatch.setenv("HF_TOKEN", "placeholder")
    spec = importlib.util.spec_from_file_location("deploy_under_test", DEPLOY)
    assert spec and spec.loader
    deploy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy)
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = deploy.main(list(args))
    return rc, out.getvalue(), err.getvalue()


def links(text: str) -> list[tuple[str, str]]:
    return LINK.findall(text)


def test_first_deploy_prints_the_link_before_the_upload(monkeypatch: pytest.MonkeyPatch) -> None:
    hub = Hub()
    rc, out, err = run(hub, monkeypatch)
    assert rc == 0, err
    [(host, code)] = links(out)
    assert host == "some-user-x-mommy" and hub.secrets["MOMMY_ACCESS_CODE"] == code
    assert re.fullmatch(r"[abcdefghjkmnpqrstuvwxyz23456789]{12}", code)
    assert out.count(code) == 1  # shown once, in the link
    assert out.index(code) < out.index("uploaded ")
    assert hub.calls.index("add_space_secret:MOMMY_ACCESS_CODE") < hub.calls.index("upload_folder")
    assert hub.variables == {"MOMMY_ALLOWED_HOSTS": "some-user-x-mommy.hf.space"}
    assert "requirements-runtime.lock" in hub.files and "requirements.lock" not in hub.files
    assert not any(name.startswith(("tests/", "docs/", "models/", ".venv/")) for name in hub.files)
    assert "restart_space" not in hub.calls


@pytest.mark.parametrize(
    "failure",
    [FakeHTTPError("Service Unavailable", 503), ConnectionError("Connection reset by peer"), TimeoutError("timed out")],
    ids=["http", "connection", "timeout"],
)
def test_a_failure_after_the_code_is_set_keeps_the_link(failure: BaseException, monkeypatch: pytest.MonkeyPatch) -> None:
    """OPS-2 / SEC-7: the Hub never returns a secret, so the link is printed as soon as
    the code is set; a later failure ends with one line saying the link is valid."""
    hub = Hub()
    hub.fail["upload_folder"] = failure
    rc, out, err = run(hub, monkeypatch)
    assert rc == 1
    [(_host, code)] = links(out)
    assert hub.secrets["MOMMY_ACCESS_CODE"] == code
    assert "Traceback" not in err and err.count("\n") == 1
    assert "share link printed above is valid" in err and "run deploy.py again" in err
    assert code not in err
    # The next run keeps that code and finishes the upload.
    rc, out, err = run(hub, monkeypatch)
    assert rc == 0, err
    assert links(out) == [] and "The access code was kept" in out
    assert hub.secrets["MOMMY_ACCESS_CODE"] == code and hub.files


def test_a_network_error_before_anything_is_one_line(monkeypatch: pytest.MonkeyPatch) -> None:
    hub = Hub()
    hub.fail["whoami"] = ConnectionError("Name or service not known")
    rc, _out, err = run(hub, monkeypatch)
    assert rc == 1 and "Traceback" not in err and "ConnectionError" in err
    hub.fail["repo_exists"] = ConnectionError("reset")
    rc, _out, err = run(hub, monkeypatch)
    assert rc == 1 and "share link" not in err and hub.secrets == {}


def test_no_pro_plan_stops_before_creating_anything(monkeypatch: pytest.MonkeyPatch) -> None:
    """OPS-1: Hugging Face asks for a PRO plan to create a Docker Space."""
    hub = Hub(is_pro=False)
    rc, out, err = run(hub, monkeypatch)
    assert rc == 1 and "PRO" in err and "--try-anyway" in err
    assert "create_repo" not in hub.calls and hub.secrets == {} and hub.variables == {}
    assert links(out) == []
    rc, out, err = run(hub, monkeypatch, "--try-anyway")
    assert rc == 0, err
    assert "create_repo" in hub.calls and len(links(out)) == 1


def test_no_pro_plan_can_still_update_an_existing_space(monkeypatch: pytest.MonkeyPatch) -> None:
    hub = Hub(exists=True, is_pro=False)
    hub.secrets["MOMMY_ACCESS_CODE"] = "x" * 12
    rc, out, err = run(hub, monkeypatch)
    assert rc == 0, err
    assert hub.files and links(out) == []


def test_new_code_restarts_the_space_when_no_file_changed(monkeypatch: pytest.MonkeyPatch) -> None:
    """OPS-5: without a new commit there is no rebuild, and the running app would keep the
    old code (and accept the old cookies) until its next restart."""
    hub = Hub()
    assert run(hub, monkeypatch)[0] == 0
    old = hub.secrets["MOMMY_ACCESS_CODE"]
    rc, out, err = run(hub, monkeypatch, "--new-code")
    assert rc == 0, err
    [(_host, code)] = links(out)
    assert code != old and hub.secrets["MOMMY_ACCESS_CODE"] == code
    assert hub.restarts == 1 and "restarted" in out
    assert "stop working once the Space shows Running again" in out


def test_new_code_with_changed_files_rebuilds_instead(monkeypatch: pytest.MonkeyPatch) -> None:
    hub = Hub()
    assert run(hub, monkeypatch)[0] == 0
    hub.files = {}  # the Space's files differ from the upload: a new commit, a new build
    rc, out, _ = run(hub, monkeypatch, "--new-code")
    assert rc == 0 and hub.restarts == 0 and "builds the image" in out


def test_unchanged_deploy_neither_sets_variables_nor_restarts(monkeypatch: pytest.MonkeyPatch) -> None:
    """OPS-9: a variable is set only when its value changes."""
    hub = Hub()
    assert run(hub, monkeypatch)[0] == 0
    hub.calls.clear()
    rc, _out, _ = run(hub, monkeypatch)
    assert rc == 0
    assert not [c for c in hub.calls if c.startswith(("add_space_variable", "add_space_secret"))]
    assert hub.restarts == 0
    rc, _out, _ = run(hub, monkeypatch, "--anthropic-model-text", "test-text-model")
    assert rc == 0
    assert hub.calls.count("add_space_variable:MOMMY_TEXT_MODEL") == 1
    assert "add_space_variable:MOMMY_ALLOWED_HOSTS" not in hub.calls[-12:]
    assert hub.restarts == 1  # a new variable and no new commit: restarted to take it
    assert hub.variables["MOMMY_TEXT_MODEL"] == "test-text-model"


def test_dry_run_needs_no_hub(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "huggingface_hub", None)  # an import would fail
    monkeypatch.delenv("HF_TOKEN", raising=False)
    spec = importlib.util.spec_from_file_location("deploy_dry", DEPLOY)
    assert spec and spec.loader
    deploy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        assert deploy.main(["--dry-run"]) == 0
    text = out.getvalue()
    assert "requirements-runtime.lock" in text and "scripts/space_start.sh" in text
    assert " requirements.lock" not in text and "tests/" not in text
