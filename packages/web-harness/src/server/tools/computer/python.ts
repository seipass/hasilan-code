/** Fixed program: tool arguments are JSON on stdin, never Python source or shell syntax. */
export const desktopPython = String.raw`
import base64
import ctypes
import importlib.metadata
import json
import os
import sys
import threading

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
cancelled = threading.Event()

def check_cancelled():
    if cancelled.is_set():
        raise RuntimeError("Computer operation cancelled")

def read_cancel():
    os.read(0, 1)
    cancelled.set()

def main():
    line = bytearray()
    while True:
        character = os.read(0, 1)
        if character == b"\n":
            break
        if not character or len(line) > 20000:
            raise RuntimeError("Invalid computer request")
        line.extend(character)
    request = json.loads(line.decode("utf-8"))
    threading.Thread(target=read_cancel, daemon=True).start()
    if sys.platform not in ("win32", "darwin", "linux"):
        raise RuntimeError("Computer use supports Windows, macOS and Linux X11")
    if sys.platform == "linux":
        if os.environ.get("WAYLAND_DISPLAY") or os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
            raise RuntimeError("Wayland is not supported; use an X11 desktop session")
        if not os.environ.get("DISPLAY"):
            raise RuntimeError("An active X11 desktop and DISPLAY are required")
    for package, expected in (("mss", "10.2.0"), ("pynput", "1.8.2")):
        try:
            version = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            raise RuntimeError("Install the pinned computer-use Python packages shown in Settings") from None
        if version != expected:
            raise RuntimeError("Computer use requires " + package + "==" + expected)
    if sys.platform == "win32":
        # Match screenshot pixels and input coordinates across mixed-DPI monitors.
        try:
            ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except AttributeError:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
    check_cancelled()
    return request

try:
    request = main()
except Exception as error:
    print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
    sys.exit(1)

# Import after setting Windows DPI awareness, before constructing controllers.
from mss import mss
from mss.tools import to_png
from pynput.keyboard import Controller as Keyboard, Key
from pynput.mouse import Controller as Mouse, Button

SPECIAL_KEYS = {
    "enter": Key.enter, "tab": Key.tab, "escape": Key.esc,
    "backspace": Key.backspace, "delete": Key.delete, "space": Key.space,
    "up": Key.up, "down": Key.down, "left": Key.left, "right": Key.right,
    "home": Key.home, "end": Key.end, "pageup": Key.page_up, "pagedown": Key.page_down,
    **{"f" + str(number): getattr(Key, "f" + str(number)) for number in range(1, 13)},
}
MODIFIERS = {"ctrl": Key.ctrl, "alt": Key.alt, "shift": Key.shift, "cmd": Key.cmd}

def execute():
    if sys.platform == "darwin":
        # Check without requesting permissions or opening system dialogs.
        accessibility = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
        accessibility.AXIsProcessTrusted.restype = ctypes.c_bool
        if not accessibility.AXIsProcessTrusted():
            raise RuntimeError("Allow Accessibility access for the Python executable in macOS System Settings")
        graphics = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        graphics.CGPreflightScreenCaptureAccess.restype = ctypes.c_bool
        if not graphics.CGPreflightScreenCaptureAccess():
            raise RuntimeError("Allow Screen Recording for the Python executable in macOS System Settings")
    mouse, keyboard = Mouse(), Keyboard()
    with mss() as capture:
        monitors = [dict(index=index, **monitor) for index, monitor in enumerate(capture.monitors) if index]
        if not monitors:
            raise RuntimeError("No active desktop monitor was found")
        if request["action"] == "screens":
            return {"screens": monitors}
        monitor = next((item for item in monitors if item["index"] == request["monitor"]), None)
        if monitor is None:
            raise RuntimeError("Monitor changed; list screens and take a new screenshot")
        bounds = {key: monitor[key] for key in ("left", "top", "width", "height")}
        if bounds["width"] * bounds["height"] > 20000000:
            raise RuntimeError("Monitor exceeds the 20 megapixel capture limit")
        if request.get("bounds") is not None and request["bounds"] != bounds:
            raise RuntimeError("Monitor geometry changed; take a new screenshot before input")
        check_cancelled()
        held_keys = []
        held_button = None
        try:
            action = request["action"]
            if "x" in request:
                mouse.position = (request["x"], request["y"])
            if action == "click":
                mouse.click(getattr(Button, request["button"]), request["count"])
            elif action == "drag":
                held_button = Button.left
                mouse.press(held_button)
                start_x, start_y = request["x"], request["y"]
                for step in range(1, 21):
                    check_cancelled()
                    fraction = step / 20
                    mouse.position = (round(start_x + (request["toX"] - start_x) * fraction), round(start_y + (request["toY"] - start_y) * fraction))
                    cancelled.wait(0.02)
            elif action == "scroll":
                # API directions are explicit; pynput's positive vertical value means up.
                dx = request["amount"] if request["direction"] == "right" else -request["amount"] if request["direction"] == "left" else 0
                dy = request["amount"] if request["direction"] == "up" else -request["amount"] if request["direction"] == "down" else 0
                mouse.scroll(dx, dy)
            elif action == "type":
                for character in request["text"]:
                    check_cancelled()
                    keyboard.type(character)
            elif action == "press":
                for modifier in request["modifiers"]:
                    check_cancelled()
                    key = MODIFIERS[modifier]
                    held_keys.append(key)
                    keyboard.press(key)
                key = SPECIAL_KEYS.get(request["key"], request["key"])
                held_keys.append(key)
                keyboard.press(key)
        finally:
            cleanup_error = None
            if held_button is not None:
                try:
                    mouse.release(held_button)
                except Exception as error:
                    cleanup_error = error
            for key in reversed(held_keys):
                try:
                    keyboard.release(key)
                except Exception as error:
                    cleanup_error = error
            if cleanup_error is not None:
                raise RuntimeError("Could not release desktop input; check host permissions") from cleanup_error
        check_cancelled()
        if action != "screenshot":
            cancelled.wait(0.15)
            check_cancelled()
        image = capture.grab(bounds)
        if image.width * image.height > 20000000:
            raise RuntimeError("Screenshot exceeds the 20 megapixel capture limit")
        png = to_png(image.rgb, image.size)
        if len(png) > 8 * 1024 * 1024:
            raise RuntimeError("Screenshot exceeds the 8 MiB limit")
        return {"bounds": bounds, "width": image.width, "height": image.height, "png": base64.b64encode(png).decode("ascii")}

try:
    result = execute()
    check_cancelled()
    print(json.dumps(result, ensure_ascii=False), flush=True)
except Exception as error:
    print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
    sys.exit(1)
`;
