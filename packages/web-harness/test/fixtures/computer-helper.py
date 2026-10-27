"""Exercise the production helper against fake OS libraries, without desktop access."""
import base64
import ctypes
import importlib.metadata
import json
import os
import sys
import types

events = []
scenario = os.environ.get("COMPUTER_TEST_SCENARIO", "")
platform = os.environ.get("COMPUTER_TEST_PLATFORM", "linux")
sys.platform = platform
os.environ["DISPLAY"] = ":test"
os.environ.pop("WAYLAND_DISPLAY", None)
os.environ["XDG_SESSION_TYPE"] = "wayland" if scenario == "wayland" else "x11"
original_dumps = json.dumps
json.dumps = lambda value, **kwargs: original_dumps({**value, "events": events}, **kwargs)
importlib.metadata.version = lambda name: "10.2.0" if name == "mss" else "1.8.2"

def dpi(*args):
    events.append(["dpi"])

ctypes.windll = types.SimpleNamespace(user32=types.SimpleNamespace(SetProcessDpiAwarenessContext=dpi))

def trusted():
    return scenario != "accessibility-denied"

def recording():
    return scenario != "recording-denied"

ctypes.CDLL = lambda path: types.SimpleNamespace(AXIsProcessTrusted=trusted, CGPreflightScreenCaptureAccess=recording)

class Capture:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    monitors = [{}, {"left": -100, "top": 20, "width": 100, "height": 50}]

    def grab(self, bounds):
        events.append(["capture", bounds])
        return types.SimpleNamespace(width=1, height=1, rgb=b"\x00\x00\x00", size=(1, 1))

class Mouse:
    def __init__(self):
        self.moves = 0

    @property
    def position(self):
        return (0, 0)

    @position.setter
    def position(self, value):
        self.moves += 1
        events.append(["move", list(value)])
        if scenario == "cancel-drag" and self.moves == 2:
            cancelled.set()

    def click(self, button, count):
        events.append(["click", button, count])

    def press(self, button):
        events.append(["mouse-down", button])

    def release(self, button):
        events.append(["mouse-up", button])

    def scroll(self, x, y):
        events.append(["scroll", x, y])

class Keyboard:
    def press(self, key):
        events.append(["key-down", key])
        if scenario == "press-error" and key == "enter":
            raise RuntimeError("input rejected")

    def release(self, key):
        events.append(["key-up", key])

    def type(self, text):
        events.append(["type", text])
        if scenario == "cancel-type":
            cancelled.set()

keys = ["enter", "tab", "esc", "backspace", "delete", "space", "up", "down", "left", "right", "home", "end", "page_up", "page_down", "ctrl", "alt", "shift", "cmd"] + ["f" + str(number) for number in range(1, 13)]
mss_module = types.ModuleType("mss")
mss_module.mss = Capture
mss_tools = types.ModuleType("mss.tools")
mss_tools.to_png = lambda rgb, size: base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1EAAAAASUVORK5CYII=")
keyboard_module = types.ModuleType("pynput.keyboard")
keyboard_module.Controller = Keyboard
keyboard_module.Key = types.SimpleNamespace(**{key: key for key in keys})
mouse_module = types.ModuleType("pynput.mouse")
mouse_module.Controller = Mouse
mouse_module.Button = types.SimpleNamespace(left="left", right="right", middle="middle")
sys.modules.update({"mss": mss_module, "mss.tools": mss_tools, "pynput": types.ModuleType("pynput"), "pynput.keyboard": keyboard_module, "pynput.mouse": mouse_module})
with open(sys.argv[1], encoding="utf-8") as source:
    program = source.read()
exec(compile(program, "production-computer-helper", "exec"), globals())
