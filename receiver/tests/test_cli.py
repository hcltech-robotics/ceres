"""Platform checks and diagnostics without requiring a media installation."""

import sys
from types import SimpleNamespace

import pytest

from ceres_bridge import cli


@pytest.mark.parametrize("system,label", [("linux", "Linux"), ("darwin", "macOS")])
def test_doctor_checks_plugins_and_reports_the_host(monkeypatch, capsys, system, label):
    checked = []

    def find(name):
        checked.append(name)
        return object()

    gst = SimpleNamespace(ElementFactory=SimpleNamespace(find=find), version_string=lambda: "GStreamer 1.24")
    monkeypatch.setitem(sys.modules, "ceres_bridge.media", SimpleNamespace(Gst=gst, GstWebRTC=object()))
    monkeypatch.setattr(sys, "platform", system)
    monkeypatch.setattr(sys, "argv", ["ceres-bridge", "doctor"])
    cli.main()
    output = capsys.readouterr().out
    assert output.startswith(label + " ")
    assert "Receiver media dependencies are ready" in output
    assert {"webrtcbin", "nicesrc", "avdec_h264", "vp8dec", "opusdec", "appsink"} <= set(checked)


def test_doctor_reports_missing_plugins_on_macos(monkeypatch, capsys):
    gst = SimpleNamespace(ElementFactory=SimpleNamespace(find=lambda name: name != "nicesrc"),
                          version_string=lambda: "GStreamer 1.24")
    monkeypatch.setitem(sys.modules, "ceres_bridge.media", SimpleNamespace(Gst=gst, GstWebRTC=object()))
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(sys, "argv", ["ceres-bridge", "doctor"])
    with pytest.raises(SystemExit) as error:
        cli.main()
    assert error.value.code == 1
    assert "Missing GStreamer plugins: nicesrc" in capsys.readouterr().err


@pytest.mark.parametrize("system", ["linux", "darwin"])
def test_listen_reaches_the_worker_on_supported_hosts(monkeypatch, system):
    received = []

    async def run(args):
        received.append(args)

    monkeypatch.setitem(sys.modules, "ceres_bridge.worker", SimpleNamespace(run=run))
    monkeypatch.setattr(sys, "platform", system)
    monkeypatch.setattr(sys, "argv", ["ceres-bridge", "listen", "--name", "lab-receiver",
                                     "--app-origin", "https://ceres.cam"])
    cli.main()
    assert received[0].name == "lab-receiver"
    assert received[0].relay == "https://ceres.cam"


def test_unsupported_host_has_an_actionable_error(monkeypatch, capsys):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "argv", ["ceres-bridge", "listen"])
    with pytest.raises(SystemExit) as error:
        cli.main()
    assert error.value.code == 2
    assert "Run the receiver on Linux or macOS" in capsys.readouterr().err
