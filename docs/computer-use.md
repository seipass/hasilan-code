# Computer use

The `computer` agent tool operates the desktop of the machine running Hasilan Code. It supports screenshots, pointer movement/hover, left/right/middle and double clicks, left-button drags, horizontal/vertical wheel scrolling, Unicode text, and key combinations. Screenshots appear in the tool result and are supplied to the selected model as images. Use an image-capable model.

## Requirements

| Host | Requirements |
| --- | --- |
| Windows | An interactive desktop, Python 3.9 or newer, and the packages below. Input uses the Python process's existing privileges; elevated windows and the secure desktop are not bypassed. |
| macOS | Python 3.9 or newer; grant Accessibility and Screen Recording access to the Python executable or launching terminal in System Settings. |
| Linux | Python 3.9 or newer, an active X11 desktop, the correct `DISPLAY`, and X server access for the launching account. Wayland sessions are rejected, including sessions with XWayland. |

The backend uses [MSS 10.2](https://python-mss.readthedocs.io/v10.2.0/examples.html) for capture and [pynput 1.8.2](https://pypi.org/project/pynput/1.8.2/) for input. [pynput's platform limitations](https://pynput.readthedocs.io/en/latest/limitations.html) explain its X11 and macOS requirements. The app checks permissions without granting them or installing packages automatically. It does not register keyboard/mouse listeners or read/change the clipboard.

Install the direct dependencies at their exact versions into a private environment. For the default agent directory on Windows:

```powershell
python -m venv "$env:USERPROFILE/.hasilan-code/agent/computer-use"
& "$env:USERPROFILE/.hasilan-code/agent/computer-use/Scripts/python.exe" -m pip install mss==10.2.0 pynput==1.8.2
```

On macOS/Linux:

```sh
python3 -m venv ~/.hasilan-code/agent/computer-use
~/.hasilan-code/agent/computer-use/bin/python3 -m pip install mss==10.2.0 pynput==1.8.2
```

When `HASILAN_CODE_AGENT_DIR` changes, create the environment in that directory's `computer-use/` folder instead. Hasilan Code selects that environment when present, or `python` on Windows and `python3` elsewhere. `HASILAN_CODE_COMPUTER_PYTHON` overrides discovery and accepts an executable path, without command-line arguments. Configuration is read at host startup. The selected environment must contain the pinned versions.

Open **Settings → Environment → Computer use** to check availability. The probe reads monitor metadata; it does not capture the screen or move the pointer.

## Activity viewer

The conversation groups `computer` calls into one activity viewer until a successful `release`. Each completed input updates the screenshot; this is step-by-step feedback, not a continuous video stream. Pointer targets and drag paths show where the AI acted. The history slider revisits earlier screenshots, and **最新に戻る** resumes following new operations. Viewing history does not send input to the desktop.

After release, Stop, or run completion, the viewer keeps the last available screenshot with its ended/error state. **呼び出し履歴** opens the original call records. Loading older conversation pages extends the available history. Screenshots are launch-local artifacts and may no longer load after the host restarts.

## Tool flow

1. `{"action":"screens"}` lists monitor indices and their desktop bounds.
2. `{"action":"screenshot","monitor":1}` acquires exclusive control for the calling session/agent and returns an image plus `frameId`, `width`, and `height`.
3. Send one input with that `frameId`, for example `{"action":"click","frameId":"…","x":120,"y":80}` or `{"action":"press","frameId":"…","key":"a","modifiers":["ctrl"]}`. Coordinates use pixels in the returned image, starting at its top-left. The host maps them to the selected monitor, accounting for negative monitor origins and Retina/DPI scaling.
4. Inspect the returned screenshot and use its new `frameId` for subsequent input. Reusing an earlier frame is rejected. Moving/resizing a monitor requires a fresh screenshot. A failed post-input capture invalidates the previous frame because the input may already have taken effect.
5. `{"action":"release"}` releases ownership when finished or waiting for the user. Other agents can list monitors but cannot capture or input while another session owns control. The end of a run, Stop, deletion, and host shutdown release it as well.

`type` accepts up to 2,000 Unicode characters. `press` accepts letters, digits, F1–F12, Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home/End and Page Up/Down; optional modifiers are `ctrl`, `alt`, `shift`, and `cmd`. Use `type` for full text and punctuation. Scroll `amount` is 1–20 wheel steps, with explicit `up`, `down`, `left`, or `right` direction. Drag duration is approximately 400 ms.

Each operation runs a fixed Python program in an isolated child process, with JSON on stdin; arguments are never evaluated as Python or shell source. Operations time out after 20 seconds. Cancellation asks the helper to stop and release held keys/buttons before the next operation; an unresponsive helper is terminated after a 5-second grace period. A monitor can contain up to 20 million pixels, and an encoded PNG up to 8 MiB. Returned artifacts use the existing authenticated, launch-local image store.

Screen contents are untrusted task data. The tool does not authorize following instructions in displayed pages or documents. Desktop operations act with the launching account's existing permissions, like the existing terminal and browser tools; the workspace file boundary is not a desktop sandbox.
