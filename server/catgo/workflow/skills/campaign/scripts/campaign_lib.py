"""Reference library for md-orchestration campaigns.

Lives in the campaign SKILL's scripts/ dir, NOT baked into the CLI registry, so
it stays adaptable for the unforeseen (mixed software, odd clusters, novel calc
types). The runnable entrypoints (new_campaign.py / fetch_ref.py / submit_calc.py
/ poll.py) are thin wrappers around these functions — read them as reference and
adapt freely.

ssh is plain stdlib subprocess on an ssh *alias* (ControlMaster / ~/.ssh/config
handles auth) — matches "just use ssh sbatch". No catgo-package coupling.
"""
from __future__ import annotations

import datetime
import os
import posixpath
import re
import shlex
import subprocess
import tempfile
from dataclasses import dataclass, fields
from pathlib import Path


class CampaignError(Exception):
    """A campaign operation failed (gate not satisfied, ssh/scp/sbatch error)."""


SUBDIRS = ["literature", "refs", "scripts", "calc", "analysis", "report", "archive"]


# ============================ naming (never hashes) =========================

def slugify(name: str) -> str:
    s = name.strip()
    s = re.sub(r"[^\w\s.-]", "", s)   # keep word chars, whitespace, dot, hyphen
    s = re.sub(r"\s+", "-", s)
    s = s.strip("-_.")
    return s or "item"


def disambiguate(name: str, existing: set[str]) -> str:
    if name not in existing:
        return name
    i = 2
    while f"{name}-{i}" in existing:
        i += 1
    return f"{name}-{i}"


def tldr_header(title: str, summary: str) -> str:
    return f"# {title}\n\n> **TL;DR:** {summary}\n"


def remote_mirror_path(remote_base: str, project_name: str, rel_path: str) -> str:
    return posixpath.join(
        remote_base.rstrip("/"), slugify(project_name), rel_path.strip("/")
    )


# ================================ STATUS.md ================================

_STATUS_FIELDS = [
    "state", "cluster", "job_type", "remote_dir",
    "jobid", "submitted_at", "updated_at",
]


@dataclass
class Status:
    state: str = "PENDING"
    cluster: str = ""
    job_type: str = ""
    remote_dir: str = ""
    jobid: str = ""
    submitted_at: str = ""
    updated_at: str = ""
    title: str = ""


def render_status(s: Status) -> str:
    summary = s.state + (f" on {s.cluster}" if s.cluster else "")
    summary += f" (job {s.jobid})" if s.jobid else ""
    lines = [tldr_header(s.title or "calc", summary), ""]
    lines += [f"{k}: {getattr(s, k)}" for k in _STATUS_FIELDS]
    return "\n".join(lines) + "\n"


def _parse_kv(text: str, allowed: set[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if ":" not in line or line.startswith("#") or line.startswith(">"):
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        if key in allowed:
            out[key] = val.strip()
    return out


def parse_status(text: str) -> Status:
    s = Status(**_parse_kv(text, set(_STATUS_FIELDS)))
    for raw in text.splitlines():
        if raw.startswith("# "):
            s.title = raw[2:].strip()
            break
    return s


def update_status(text: str, **changes: str) -> str:
    s = parse_status(text)
    valid = {f.name for f in fields(Status)}
    for k, v in changes.items():
        if k in valid:
            setattr(s, k, v)
    return render_status(s)


# ================================ cluster.md ===============================

REQUIRED = [
    "cluster", "ssh_host", "account", "partition", "walltime", "ntasks",
    "run_command", "load_method", "potcar_root", "python_env", "remote_base",
]


@dataclass
class ClusterConfig:
    cluster: str = ""
    ssh_host: str = ""
    account: str = ""
    partition: str = ""
    walltime: str = ""
    ntasks: str = ""
    run_command: str = ""
    load_method: str = ""
    potcar_root: str = ""
    python_env: str = ""
    remote_base: str = ""
    reference_script: str = ""


def render_cluster(c: ClusterConfig) -> str:
    lines = [
        tldr_header("cluster (CONFIRMED env)",
                    "compute env — never guessed; see the setup gate"),
        "",
    ]
    lines += [f"{f.name}: {getattr(c, f.name)}" for f in fields(ClusterConfig)]
    return "\n".join(lines) + "\n"


def parse_cluster(text: str) -> ClusterConfig:
    names = {f.name for f in fields(ClusterConfig)}
    return ClusterConfig(**_parse_kv(text, names))


def missing_fields(c: ClusterConfig) -> list[str]:
    return [k for k in REQUIRED if not getattr(c, k).strip()]


def is_submittable(c: ClusterConfig) -> bool:
    return not missing_fields(c)


# ========================== job-script adaptation ==========================

def _set_sbatch(lines: list[str], key: str, value: str) -> list[str]:
    directive = f"#SBATCH --{key}="
    new_line = f"#SBATCH --{key}={value}"
    out: list[str] = []
    replaced = False
    for line in lines:
        if line.strip().startswith(directive):
            out.append(new_line)
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.insert(1 if (out and out[0].startswith("#!")) else 0, new_line)
    return out


def adapt_job_script(reference: str, *, job_name: str, work_dir: str,
                     account: str, partition: str, walltime: str, ntasks: str,
                     run_command: str) -> str:
    """Adapt a user reference .sb: keep its module/conda preamble verbatim;
    override resource #SBATCH directives; ensure cd work_dir + run command."""
    lines = reference.splitlines()
    if not lines or not lines[0].startswith("#!"):
        lines = ["#!/bin/bash"] + lines
    for key, val in (("job-name", job_name), ("account", account),
                     ("partition", partition), ("time", walltime),
                     ("ntasks", ntasks)):
        if val:
            lines = _set_sbatch(lines, key, val)
    body = "\n".join(lines)
    if work_dir and f'cd "{work_dir}"' not in body and f"cd {work_dir}" not in body:
        lines.append(f'cd "{work_dir}"')
    if run_command and run_command not in "\n".join(lines):
        lines.append(run_command)
    return "\n".join(lines) + "\n"


# ================================= squeue ==================================

_SQUEUE_MAP = {"RUNNING": "RUNNING", "COMPLETING": "RUNNING",
               "PENDING": "PENDING", "CONFIGURING": "PENDING"}


def parse_squeue(output: str) -> str:
    s = output.strip()
    return s.splitlines()[0].strip() if s else ""


def map_state(squeue_state: str, had_jobid: bool) -> str:
    if not squeue_state:
        return "DONE" if had_jobid else "PENDING"
    return _SQUEUE_MAP.get(squeue_state, squeue_state)
