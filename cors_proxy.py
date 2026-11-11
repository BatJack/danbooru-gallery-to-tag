"""本地 CORS 转发器 + 静态站点启动器（仅用于本机调试）。

用法：python cors_proxy.py

界面里选择是否经由本地代理（如 Clash 的 7897），填写转发端口，确认后：
1. 在 127.0.0.1:<转发端口> 启动带 CORS 头的转发服务；
2. 在 127.0.0.1:<站点端口> 启动本目录的静态站点，并自动打开浏览器。

把 http://127.0.0.1:<转发端口>/?url={url} 填到应用设置的
「CORS 代理」和「图片代理」即可。
"""

import http.server
import os
import queue
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime

import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk

ALLOWED_HOSTS = (
    "danbooru.donmai.us",
    "donmai.us",
    "gelbooru.com",
    "gelbooru.org",
)

DEFAULT_PROXY_PORT = 7897
DEFAULT_FORWARD_PORT = 8787
DEFAULT_SITE_PORT = 8000


def build_opener(proxy_url):
    """proxy_url 形如 http://127.0.0.1:7897；为空则直连。"""
    if not proxy_url:
        return urllib.request.build_opener()
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
    )


def make_cors_handler(opener, log):
    class CorsProxyHandler(http.server.BaseHTTPRequestHandler):
        def _cors_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            # Chrome 私有网络访问（公网页面 -> 127.0.0.1）需要该头
            self.send_header("Access-Control-Allow-Private-Network", "true")

        def _reply(self, status, body=b"", content_type=None):
            # 浏览器会主动取消请求（切页、图片被替换、AbortController 超时），
            # 此时写回响应会抛 WinError 10053，属于正常现象，直接丢弃。
            try:
                self.send_response(status)
                self._cors_headers()
                if content_type:
                    self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if body:
                    self.wfile.write(body)
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                pass

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors_headers()
            self.end_headers()

        def _fetch(self, target):
            host = urllib.parse.urlparse(target).hostname or ""
            headers = {
                "User-Agent": self.headers.get("User-Agent", "Mozilla/5.0"),
                "Accept": self.headers.get("Accept", "*/*"),
            }
            # Gelbooru 的图片 CDN 有防盗链：缺少站点 Referer 会被 302 到 hotlink.php
            if host == "gelbooru.com" or host.endswith((".gelbooru.com", ".gelbooru.org")):
                headers["Referer"] = "https://gelbooru.com/"
            elif host == "donmai.us" or host.endswith(".donmai.us"):
                headers["Referer"] = "https://danbooru.donmai.us/"
            request = urllib.request.Request(target, headers=headers)
            last_error = None
            for attempt in range(2):
                try:
                    return opener.open(request, timeout=30)
                except urllib.error.HTTPError:
                    raise
                except Exception as error:  # 上游代理偶发断连，重试一次
                    last_error = error
                    if attempt == 0:
                        log(f"重试 {target} -> {error}")
                        time.sleep(0.3)
            raise last_error

        def do_GET(self):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            target = (query.get("url") or [""])[0]
            parsed = urllib.parse.urlparse(target)
            host = parsed.hostname or ""
            allowed = parsed.scheme in ("http", "https") and any(
                host == item or host.endswith("." + item) for item in ALLOWED_HOSTS
            )
            if not allowed:
                self._reply(403, b"target not allowed", "text/plain; charset=utf-8")
                log(f"拒绝 {target or '(空)'}")
                return

            try:
                with self._fetch(target) as response:
                    body = response.read()
                    self._reply(response.status, body, response.headers.get("Content-Type"))
                    log(f"{response.status} {target} ({len(body)} B)")
            except urllib.error.HTTPError as error:
                body = error.read()
                self._reply(error.code, body, error.headers.get("Content-Type"))
                log(f"HTTP {error.code} {target}")
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                log(f"客户端已断开 {target}")
            except Exception as error:  # 超时、DNS、上游代理不可用等
                self._reply(502, str(error).encode("utf-8"), "text/plain; charset=utf-8")
                log(f"502 {target} -> {error}")

        def log_message(self, fmt, *args):
            pass

    return CorsProxyHandler


def make_static_handler(directory, log):
    class StaticHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

        def log_message(self, fmt, *args):
            log(f"站点 {self.command} {self.path}")

    return StaticHandler


def start_server(port, handler):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def port_in_use(port):
    # Windows 上 SO_REUSEADDR 允许两个进程绑同一端口，请求可能落到旧进程，
    # 所以启动前先探测一次，避免"改了代码但请求仍由旧实例处理"。
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def stop_server(server):
    if server is None:
        return

    def run():
        server.shutdown()
        server.server_close()

    threading.Thread(target=run, daemon=True).start()


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("CORS 代理 + 本地站点")
        self.resizable(False, False)
        self.proxy_server = None
        self.site_server = None
        self.log_queue = queue.Queue()

        self.use_local_proxy = tk.BooleanVar(value=True)
        self.proxy_port = tk.StringVar(value=str(DEFAULT_PROXY_PORT))
        self.forward_port = tk.StringVar(value=str(DEFAULT_FORWARD_PORT))
        self.site_port = tk.StringVar(value=str(DEFAULT_SITE_PORT))
        self.open_browser = tk.BooleanVar(value=True)
        self.status = tk.StringVar(value="未启动")

        self._build_ui()
        self.after(150, self._drain_log_queue)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _build_ui(self):
        padding = {"padx": 12, "pady": 6}
        form = ttk.Frame(self, padding=12)
        form.grid(row=0, column=0, sticky="nsew")

        ttk.Checkbutton(
            form,
            text="使用本地代理（如 Clash）",
            variable=self.use_local_proxy,
            command=self._sync_proxy_entry,
        ).grid(row=0, column=0, columnspan=2, sticky="w", **padding)

        ttk.Label(form, text="本地代理端口").grid(row=1, column=0, sticky="w", **padding)
        self.proxy_entry = ttk.Entry(form, textvariable=self.proxy_port, width=12)
        self.proxy_entry.grid(row=1, column=1, sticky="w", **padding)

        ttk.Label(form, text="转发端口").grid(row=2, column=0, sticky="w", **padding)
        ttk.Entry(form, textvariable=self.forward_port, width=12).grid(
            row=2, column=1, sticky="w", **padding
        )

        ttk.Label(form, text="站点端口").grid(row=3, column=0, sticky="w", **padding)
        ttk.Entry(form, textvariable=self.site_port, width=12).grid(
            row=3, column=1, sticky="w", **padding
        )

        ttk.Checkbutton(
            form, text="启动后打开浏览器", variable=self.open_browser
        ).grid(row=4, column=0, columnspan=2, sticky="w", **padding)

        buttons = ttk.Frame(form)
        buttons.grid(row=5, column=0, columnspan=2, sticky="w", pady=(6, 0))
        self.start_btn = ttk.Button(buttons, text="启动", command=self._start)
        self.start_btn.pack(side="left")
        self.stop_btn = ttk.Button(buttons, text="停止", command=self._stop, state="disabled")
        self.stop_btn.pack(side="left", padx=8)
        ttk.Button(buttons, text="复制代理地址", command=self._copy_url).pack(side="left")

        ttk.Label(form, textvariable=self.status, foreground="#2f7d4f").grid(
            row=6, column=0, columnspan=2, sticky="w", **padding
        )

        ttk.Label(
            form,
            text="把上面的地址同时填入设置的「CORS 代理」和「图片代理」。",
            foreground="#666666",
        ).grid(row=7, column=0, columnspan=2, sticky="w", padx=12)

        self.log_view = scrolledtext.ScrolledText(form, width=64, height=12, state="disabled")
        self.log_view.grid(row=8, column=0, columnspan=2, padx=12, pady=(6, 12), sticky="nsew")

        self._sync_proxy_entry()

    def _sync_proxy_entry(self):
        self.proxy_entry.configure(state="normal" if self.use_local_proxy.get() else "disabled")

    def _read_port(self, value, label):
        text = value.strip()
        if not text.isdigit() or not (1 <= int(text) <= 65535):
            raise ValueError(f"{label}必须是 1-65535 的数字")
        return int(text)

    def _proxy_url(self):
        return f"http://127.0.0.1:{self.forward_port.get().strip()}/?url={{url}}"

    def _log(self, message):
        # 服务线程只负责入队，由主线程定时取出写控件，避免跨线程操作 Tk。
        self.log_queue.put(f"[{datetime.now():%H:%M:%S}] {message}\n")

    def _drain_log_queue(self):
        while not self.log_queue.empty():
            line = self.log_queue.get_nowait()
            self.log_view.configure(state="normal")
            self.log_view.insert("end", line)
            self.log_view.see("end")
            self.log_view.configure(state="disabled")
        if self.winfo_exists():
            self.after(150, self._drain_log_queue)

    def _start(self):
        if self.proxy_server:
            return
        try:
            forward_port = self._read_port(self.forward_port.get(), "转发端口")
            site_port = self._read_port(self.site_port.get(), "站点端口")
            upstream = ""
            if self.use_local_proxy.get():
                proxy_port = self._read_port(self.proxy_port.get(), "本地代理端口")
                upstream = f"http://127.0.0.1:{proxy_port}"
        except ValueError as error:
            messagebox.showerror("参数错误", str(error))
            return
        if forward_port == site_port:
            messagebox.showerror("参数错误", "转发端口和站点端口不能相同")
            return
        if port_in_use(forward_port):
            messagebox.showerror(
                "端口被占用",
                f"转发端口 {forward_port} 已有服务在监听。\n请先关闭旧的 cors_proxy 窗口，或改用其他转发端口。",
            )
            return

        opener = build_opener(upstream)
        handler = make_cors_handler(opener, self._log)
        try:
            self.proxy_server = start_server(forward_port, handler)
        except OSError as error:
            self.proxy_server = None
            messagebox.showerror("启动失败", f"转发端口 {forward_port} 无法监听：{error}")
            return

        self._log(f"CORS 转发已启动，上行 {'-> ' + upstream if upstream else '直连'}")
        self.status.set(f"已启动：{self._proxy_url()}")

        if port_in_use(site_port):
            self._log(f"站点端口 {site_port} 已被占用，跳过静态站点；仅运行 CORS 转发")
        else:
            try:
                static_handler = make_static_handler(
                    os.path.dirname(os.path.abspath(__file__)), self._log
                )
                self.site_server = start_server(site_port, static_handler)
                self._log(f"静态站点已启动：http://127.0.0.1:{site_port}/")
                if self.open_browser.get():
                    self.after(300, lambda: webbrowser.open(f"http://127.0.0.1:{site_port}/"))
            except OSError as error:
                self._log(f"站点端口 {site_port} 无法监听（{error}），仅运行 CORS 转发")

        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")

    def _stop(self):
        stop_server(self.site_server)
        stop_server(self.proxy_server)
        self.site_server = None
        self.proxy_server = None
        self.status.set("已停止")
        self._log("已停止")
        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")

    def _copy_url(self):
        self.clipboard_clear()
        self.clipboard_append(self._proxy_url())
        self.status.set("代理地址已复制")

    def _on_close(self):
        self._stop()
        time.sleep(0.05)
        self.destroy()


if __name__ == "__main__":
    App().mainloop()
