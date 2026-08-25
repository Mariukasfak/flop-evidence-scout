#!/usr/bin/env python3
"""Small stdio bridge between TriAgent and the local Antigravity agentapi."""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse


try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass


USER_ROOT = Path.home()
AGENTAPI_EXE = Path(os.environ.get(
    "ANTIGRAVITY_AGENTAPI_EXE",
    USER_ROOT / "AppData" / "Local" / "Programs" / "antigravity" / "resources" / "bin" / "language_server.exe",
))
BRAIN_ROOT = USER_ROOT / ".gemini" / "antigravity" / "brain"
PROJECTS_ROOT = USER_ROOT / ".gemini" / "config" / "projects"
LOG_ROOT = USER_ROOT / "AppData" / "Roaming" / "Antigravity" / "logs"
MODEL_NAMES = {"flash_lite", "flash", "pro"}


def path_from_file_uri(uri):
    parsed = urlparse(uri)
    raw_path = unquote(parsed.path.lstrip("/"))
    return Path(raw_path).resolve()


def is_within(left, right):
    try:
        left.resolve().relative_to(right.resolve())
        return True
    except ValueError:
        return False


def discover_project_id(workspace):
    if not PROJECTS_ROOT.exists():
        return None
    best = None
    best_length = -1
    for config_path in PROJECTS_ROOT.glob("*.json"):
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        resources = data.get("projectResources", {}).get("resources", [])
        for resource in resources:
            folder_uri = resource.get("folderUri") or resource.get("gitFolder", {}).get("folderUri")
            if not folder_uri:
                continue
            try:
                folder = path_from_file_uri(folder_uri)
            except (OSError, ValueError):
                continue
            if is_within(workspace, folder) or is_within(folder, workspace):
                length = len(str(folder))
                if length > best_length:
                    best = data.get("id")
                    best_length = length
    return best


def discover_ls_address():
    configured = os.environ.get("ANTIGRAVITY_LS_ADDRESS")
    if configured:
        return configured

    candidates = [LOG_ROOT / "language_server.log", *LOG_ROOT.glob("*/ls-main.log")]
    candidates = sorted(
        (candidate for candidate in candidates if candidate.exists()),
        key=lambda candidate: candidate.stat().st_mtime,
        reverse=True,
    )
    http_pattern = re.compile(r"Language server listening on random port at (\d+) for HTTP")
    https_pattern = re.compile(r"Language server listening on random port at (\d+) for HTTPS")
    for candidate in candidates:
        try:
            content = candidate.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        http_matches = http_pattern.findall(content)
        if http_matches:
            return f"localhost:{http_matches[-1]}"
        https_matches = https_pattern.findall(content)
        if https_matches:
            return f"localhost:{https_matches[-1]}"
    return None


def discover_csrf_token():
    configured = os.environ.get("ANTIGRAVITY_CSRF_TOKEN")
    if configured:
        return configured
    command = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.CommandLine -like '*language_server*--csrf_token*' } | "
        "Select-Object -ExpandProperty CommandLine"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            # Be sito Python dekoduoja agentapi isvesti konsoles koduote (cp1257) ir
            # luzta ties bet kuria lietuviska raide: UnicodeDecodeError, stdout tampa None.
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    matches = re.findall(r"--csrf_token\s+([0-9a-fA-F-]{36})", result.stdout)
    return matches[-1] if matches else None


def connection_env(workspace):
    ls_address = discover_ls_address()
    csrf_token = discover_csrf_token()
    project_id = discover_project_id(workspace)
    if not AGENTAPI_EXE.exists():
        raise RuntimeError("Antigravity agentapi is not installed")
    if not ls_address or not csrf_token:
        raise RuntimeError("Antigravity is not running or its local session is unavailable")
    if not project_id or project_id == "outside-of-project":
        raise RuntimeError("TriAgent is not linked to an Antigravity project")

    env = os.environ.copy()
    env["ANTIGRAVITY_LS_ADDRESS"] = ls_address
    env["ANTIGRAVITY_CSRF_TOKEN"] = csrf_token
    env["ANTIGRAVITY_PROJECT_ID"] = project_id
    env["CGW_PROJECT_CWD"] = str(workspace)
    return env, project_id


def run_agentapi(arguments, workspace, env, timeout_seconds=30):
    try:
        result = subprocess.run(
            [str(AGENTAPI_EXE), "agentapi", *arguments],
            cwd=str(workspace),
            env=env,
            capture_output=True,
            text=True,
            # Be sito Python dekoduoja agentapi isvesti konsoles koduote (cp1257) ir
            # luzta ties bet kuria lietuviska raide: UnicodeDecodeError, stdout tampa None.
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Antigravity agentapi timed out") from error
    if result.returncode != 0:
        detail = result.stderr.strip()
        if not detail and result.stdout.strip():
            try:
                error_payload = json.loads(result.stdout)
                detail = str(error_payload.get("error") or error_payload.get("message") or "")
            except json.JSONDecodeError:
                detail = ""
        detail = detail or f"exit code {result.returncode}"
        raise RuntimeError(f"Antigravity agentapi failed: {detail[:500]}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("Antigravity agentapi returned invalid JSON") from error


def transcript_path(conversation_id):
    return BRAIN_ROOT / conversation_id / ".system_generated" / "logs" / "transcript.jsonl"


def read_steps(path):
    if not path.exists():
        return []
    steps = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return steps
    for line in lines:
        try:
            steps.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return steps


def latest_step_index(path):
    return max((step.get("step_index", -1) for step in read_steps(path)), default=-1)


def wait_for_terminal_step(conversation_id, after_index, timeout_seconds):
    path = transcript_path(conversation_id)
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        candidates = [
            step for step in read_steps(path)
            if step.get("step_index", -1) > after_index
            and step.get("source") == "MODEL"
            and step.get("type") == "PLANNER_RESPONSE"
            and step.get("status") == "DONE"
            and isinstance(step.get("content"), str)
            and step.get("content").strip()
            and not step.get("tool_calls")
        ]
        if candidates:
            return max(candidates, key=lambda step: step.get("step_index", -1))
        time.sleep(0.5)
    raise RuntimeError("Timed out waiting for Gemini terminal response")


def validate_existing_conversation(conversation_id, project_id, workspace, env):
    metadata_response = run_agentapi(
        ["get-conversation-metadata", conversation_id], workspace, env
    )
    metadata = metadata_response.get("response", {}).get("conversationMetadata", {}).get("metadata", {})
    conversation_project = metadata.get("projectId")
    if conversation_project and conversation_project != project_id:
        raise RuntimeError("Gemini conversation belongs to a different Antigravity project")


def log_session(workspace, project_id, conversation_id, phase, model, prompt_length):
    log_path = workspace / ".codex" / "gemini-worker" / "sessions.jsonl"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "conversation_id": conversation_id,
        "action": "council",
        "model": model,
        "cwd": str(workspace),
        "project_id": project_id,
        "summary": f"TriAgent live council phase: {phase}",
        "prompt_length": prompt_length,
    }
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def health_check():
    workspace = Path.cwd().resolve()
    env, project_id = connection_env(workspace)
    try:
        result = subprocess.run(
            [str(AGENTAPI_EXE), "agentapi", "--help"],
            cwd=str(workspace),
            env=env,
            capture_output=True,
            text=True,
            # Be sito Python dekoduoja agentapi isvesti konsoles koduote (cp1257) ir
            # luzta ties bet kuria lietuviska raide: UnicodeDecodeError, stdout tampa None.
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=10,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Antigravity health check timed out") from error
    if result.returncode != 0:
        raise RuntimeError("Antigravity agentapi health check failed")
    print(json.dumps({
        "available": True,
        "version": os.environ.get("ANTIGRAVITY_LS_VERSION", "Antigravity local agentapi"),
        "projectId": project_id,
    }, ensure_ascii=True))


def handle_request():
    try:
        request = json.loads(sys.stdin.read())
    except json.JSONDecodeError as error:
        raise RuntimeError("Bridge stdin must contain one JSON request") from error

    workspace_value = request.get("workspace")
    prompt = request.get("prompt")
    phase = request.get("phase", "council")
    model = request.get("model", "flash")
    conversation_id = request.get("conversationId")
    timeout_ms = request.get("timeoutMs", 240_000)

    if not isinstance(workspace_value, str):
        raise RuntimeError("Bridge request is missing workspace")
    workspace = Path(workspace_value).resolve()
    if not workspace.is_dir():
        raise RuntimeError("Bridge workspace does not exist")
    if not isinstance(prompt, str) or not prompt.strip():
        raise RuntimeError("Bridge request is missing prompt")
    if model not in MODEL_NAMES:
        raise RuntimeError("Unsupported Antigravity model")
    if not isinstance(timeout_ms, (int, float)) or timeout_ms < 1_000 or timeout_ms > 600_000:
        raise RuntimeError("Bridge timeoutMs must be between 1000 and 600000")

    # Windows CreateProcess CLI length limit is 32767 chars. Keep prompt safely within 25000 chars.
    MAX_CLI_PROMPT = 25000
    if len(prompt) > MAX_CLI_PROMPT:
        prompt = prompt[:MAX_CLI_PROMPT]

    env, project_id = connection_env(workspace)
    after_index = -1
    if conversation_id:
        if not isinstance(conversation_id, str):
            raise RuntimeError("Invalid Gemini conversation id")
        validate_existing_conversation(conversation_id, project_id, workspace, env)
        after_index = latest_step_index(transcript_path(conversation_id))
        run_agentapi(["send-message", conversation_id, prompt], workspace, env)
    else:
        response = run_agentapi(
            ["new-conversation", f"--model={model}", prompt], workspace, env
        )
        conversation_id = response.get("response", {}).get("newConversation", {}).get("conversationId")
        if not conversation_id:
            raise RuntimeError("Antigravity did not return a conversation id")

    log_session(workspace, project_id, conversation_id, phase, model, len(prompt))
    terminal = wait_for_terminal_step(conversation_id, after_index, timeout_ms / 1000)
    print(json.dumps({
        "conversationId": conversation_id,
        "transcript": json.dumps(terminal, ensure_ascii=True),
    }, ensure_ascii=True))


def main():
    try:
        if len(sys.argv) == 2 and sys.argv[1] == "--health":
            health_check()
            return
        if len(sys.argv) != 1:
            raise RuntimeError("Unsupported bridge arguments")
        handle_request()
    except Exception as error:
        print(f"Antigravity bridge error: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
