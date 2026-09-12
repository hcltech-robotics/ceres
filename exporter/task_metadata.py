"""Resolve LeRobot task metadata from a recorded Ceres episode."""

from __future__ import annotations


def lerobot_task_description(episode: dict) -> str:
    """Return the human-readable task description with legacy fallbacks."""
    for key in ("taskDescription", "taskLabel"):
        value = episode.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "Untitled Quest task"
