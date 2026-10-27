#!/usr/bin/env python3
"""Input-only X11 region and pointer sampling for the stationary desktop surface."""
import ctypes as c
import json
import os
import select
import sys
import time

x11 = c.CDLL('libX11.so.6')
shape = c.CDLL('libXext.so.6')
x11.XOpenDisplay.argtypes = [c.c_char_p]
x11.XOpenDisplay.restype = c.c_void_p
x11.XDefaultRootWindow.argtypes = [c.c_void_p]
x11.XDefaultRootWindow.restype = c.c_ulong
x11.XQueryPointer.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_ulong),
    c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_uint)]
x11.XFlush.argtypes = [c.c_void_p]
x11.XCloseDisplay.argtypes = [c.c_void_p]
x11.XGetGeometry.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_int),
    c.POINTER(c.c_int), c.POINTER(c.c_uint), c.POINTER(c.c_uint), c.POINTER(c.c_uint), c.POINTER(c.c_uint)]

class Rectangle(c.Structure):
    _fields_ = [('x', c.c_short), ('y', c.c_short), ('width', c.c_ushort), ('height', c.c_ushort)]

shape.XShapeCombineRectangles.argtypes = [c.c_void_p, c.c_ulong, c.c_int, c.c_int, c.c_int,
    c.POINTER(Rectangle), c.c_int, c.c_int, c.c_int]
display = x11.XOpenDisplay(None)
if not display:
    raise SystemExit('Cannot open X11 display')
window = int(sys.argv[1])
root = x11.XDefaultRootWindow(display)
root_return, child = c.c_ulong(), c.c_ulong()
rx, ry, wx, wy, mask = c.c_int(), c.c_int(), c.c_int(), c.c_int(), c.c_uint()
buffer = b''
last = None
last_sent = 0

def set_input(command):
    rects = command['rects']
    w, h, border, depth = c.c_uint(), c.c_uint(), c.c_uint(), c.c_uint()
    x11.XGetGeometry(display, window, c.byref(root_return), c.byref(wx), c.byref(wy),
                     c.byref(w), c.byref(h), c.byref(border), c.byref(depth))
    sx, sy = w.value / command['width'], h.value / command['height']
    rectangles = (Rectangle * len(rects))(*(Rectangle(round(r['x'] * sx), round(r['y'] * sy),
        max(0, round(r['width'] * sx)), max(0, round(r['height'] * sy))) for r in rects))
    # ShapeInput=2 only: never reshape the visible surface or move the native window.
    shape.XShapeCombineRectangles(display, window, 2, 0, 0, rectangles, len(rects), 0, 0)
    x11.XFlush(display)

try:
    set_input({'rects': [], 'width': 1, 'height': 1})
    while True:
        readable, _, _ = select.select([sys.stdin], [], [], 1 / 60)
        if readable:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                break
            buffer += chunk
            lines = buffer.split(b'\n')
            buffer = lines.pop()
            if lines:
                set_input(json.loads(lines[-1]))
        if x11.XQueryPointer(display, root, c.byref(root_return), c.byref(child),
                            c.byref(rx), c.byref(ry), c.byref(wx), c.byref(wy), c.byref(mask)):
            sample = (rx.value, ry.value, mask.value)
            now = time.monotonic()
            if sample != last or now - last_sent >= 1:
                print(json.dumps({'x': rx.value, 'y': ry.value, 'buttons': mask.value}), flush=True)
                last, last_sent = sample, now
finally:
    x11.XCloseDisplay(display)
