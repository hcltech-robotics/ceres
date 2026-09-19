"""Pairing invitations retain their expiry and retry only code collisions."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from ceres_bridge import worker


@pytest.fixture
def invitation_args():
    return SimpleNamespace(name="lab-receiver", app_origin="https://ceres.cam/", relay="https://ceres.cam")


def test_invitation_uses_nine_secure_letters_and_saves_before_registration(monkeypatch, tmp_path, invitation_args):
    path = tmp_path / "receiver.json"
    choices = []
    letters = iter("JKMNPQRST")

    def choose(alphabet):
        choices.append(alphabet)
        return next(letters)

    monkeypatch.setattr(worker.secrets, "choice", choose)
    monkeypatch.setattr(worker.time, "time", lambda: 1000)

    async def request(route, body):
        assert route == "/bindings"
        assert json.loads(path.read_text()) == body
        assert body["invitation_expires"] == 1300
        assert body["appOrigin"] == "https://ceres.cam"
        return {"epoch": 3}

    identity = asyncio.run(worker.invitation(SimpleNamespace(request=request), invitation_args, path))
    assert choices == ["ABCDEFGHJKMNPQRSTUVWXYZ"] * 9
    assert identity["code"] == "JKMNPQRST"
    assert identity["epoch"] == 3
    assert json.loads(path.read_text()) == identity


@pytest.mark.parametrize("collisions", [1, 4, 5])
def test_invitation_retries_collisions_up_to_five_attempts(monkeypatch, tmp_path, invitation_args, collisions):
    attempts = []
    path = tmp_path / "receiver.json"
    letters = iter("A" * 9 + "B" * 9 + "C" * 9 + "D" * 9 + "E" * 9)
    monkeypatch.setattr(worker.secrets, "choice", lambda alphabet: next(letters))
    monkeypatch.setattr(worker.time, "time", lambda: 2000)

    async def request(route, body):
        assert route == "/bindings"
        assert json.loads(path.read_text()) == body
        assert body["invitation_expires"] == 2300
        attempts.append(body.copy())
        if len(attempts) <= collisions:
            raise worker.RelayError(409, "Code already allocated")
        return {"epoch": 1}

    relay = SimpleNamespace(request=request)
    if collisions == 5:
        with pytest.raises(RuntimeError, match="Cannot allocate a receiver code"):
            asyncio.run(worker.invitation(relay, invitation_args, path))
    else:
        identity = asyncio.run(worker.invitation(relay, invitation_args, path))
        assert identity["code"] == attempts[-1]["code"]
        assert identity["epoch"] == 1
    assert len(attempts) == min(collisions + 1, 5)
    assert [attempt["code"] for attempt in attempts] == [letter * 9 for letter in "ABCDE"[:len(attempts)]]


def test_invitation_does_not_retry_other_relay_errors(tmp_path, invitation_args):
    attempts = []

    async def request(route, body):
        attempts.append(body)
        assert len(body["code"]) == 9
        assert set(body["code"]) <= set("ABCDEFGHJKMNPQRSTUVWXYZ")
        raise worker.RelayError(503, "Relay unavailable")

    with pytest.raises(worker.RelayError, match="Relay unavailable"):
        asyncio.run(worker.invitation(SimpleNamespace(request=request), invitation_args, tmp_path / "receiver.json"))
    assert len(attempts) == 1


def test_invitation_link_disappears_at_expiry(monkeypatch, capsys):
    identity = {"code": "ABCDEFGHJ", "appOrigin": "https://ceres.cam", "invitation_expires": 300}
    monkeypatch.setattr(worker.time, "time", lambda: 299)
    worker.show_invitation(identity)
    assert capsys.readouterr().out == "Pairing code: ABCDEFGHJ\nOpen https://ceres.cam/bridge/?code=ABCDEFGHJ\n"
    monkeypatch.setattr(worker.time, "time", lambda: 300)
    worker.show_invitation(identity)
    assert capsys.readouterr().out == ""
