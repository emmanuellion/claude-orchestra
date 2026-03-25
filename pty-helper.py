#!/usr/bin/env python3
"""
PTY helper: bridges stdin/stdout to a real PTY (Unix) or subprocess (Windows).
Cross-platform: macOS, Linux, Windows.

Resize protocol: write the resize command on a separate file descriptor (fd 3)
passed via the BOSS_RESIZE_FD env var, OR inline via the escape sequence
\x1b]boss:resize:ROWS:COLS\ in stdin.
"""

import os
import sys
import signal
import struct
import select
import errno
import subprocess

PLATFORM = sys.platform


def run_unix():
    import pty
    import fcntl
    import termios

    shell = os.environ.get('SHELL', '/bin/bash')
    cols = int(os.environ.get('COLUMNS', '120'))
    rows = int(os.environ.get('LINES', '30'))
    cwd = os.environ.get('PTY_CWD', os.environ.get('HOME', '/'))

    master, slave = pty.openpty()

    # Set initial window size
    winsize = struct.pack('HHHH', rows, cols, 0, 0)
    fcntl.ioctl(master, termios.TIOCSWINSZ, winsize)

    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        # Set the slave as controlling terminal
        import tty
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        if slave > 2:
            os.close(slave)
        os.chdir(cwd)
        os.execlp(shell, shell, '-i')

    # Parent
    os.close(slave)

    # Non-blocking stdin
    flags = fcntl.fcntl(sys.stdin.fileno(), fcntl.F_GETFL)
    fcntl.fcntl(sys.stdin.fileno(), fcntl.F_SETFL, flags | os.O_NONBLOCK)

    stdout = sys.stdout.buffer
    stdin_fd = sys.stdin.fileno()

    # Buffer for detecting resize escape sequences that may arrive in chunks
    pending = b''

    RESIZE_PREFIX = b'\x1b]boss:resize:'

    signal.signal(signal.SIGWINCH, lambda *_: None)

    def do_resize(r, c):
        try:
            ws = struct.pack('HHHH', r, c, 0, 0)
            fcntl.ioctl(master, termios.TIOCSWINSZ, ws)
            os.kill(pid, signal.SIGWINCH)
        except Exception:
            pass

    def process_input(data):
        """Process input data, extracting any resize commands and forwarding the rest."""
        nonlocal pending
        pending += data

        while pending:
            idx = pending.find(b'\x1b]boss:resize:')
            if idx == -1:
                # No resize command — forward everything
                os.write(master, pending)
                pending = b''
                return

            # Forward bytes before the resize command
            if idx > 0:
                os.write(master, pending[:idx])
                pending = pending[idx:]

            # Look for the end of the resize command (backslash)
            end = pending.find(b'\\', len(RESIZE_PREFIX))
            if end == -1:
                # Incomplete resize command — wait for more data
                if len(pending) > 50:
                    # Too long, probably not a real resize — forward it
                    os.write(master, pending)
                    pending = b''
                return

            # Extract and apply resize
            cmd = pending[len(RESIZE_PREFIX):end]
            pending = pending[end + 1:]
            try:
                parts = cmd.decode().split(':')
                do_resize(int(parts[0]), int(parts[1]))
            except Exception:
                pass

    try:
        while True:
            try:
                rlist, _, _ = select.select([master, stdin_fd], [], [], 0.05)
            except (select.error, InterruptedError):
                continue

            if master in rlist:
                try:
                    data = os.read(master, 65536)
                    if not data:
                        break
                    stdout.write(data)
                    stdout.flush()
                except OSError:
                    break

            if stdin_fd in rlist:
                try:
                    data = os.read(stdin_fd, 65536)
                    if not data:
                        break
                    process_input(data)
                except OSError as e:
                    if e.errno == errno.EAGAIN:
                        continue
                    break

            # Check child
            try:
                result = os.waitpid(pid, os.WNOHANG)
                if result[0] != 0:
                    # Drain remaining output
                    try:
                        while True:
                            data = os.read(master, 65536)
                            if not data:
                                break
                            stdout.write(data)
                            stdout.flush()
                    except OSError:
                        pass
                    break
            except ChildProcessError:
                break

    except KeyboardInterrupt:
        pass
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except Exception:
            pass
        try:
            os.close(master)
        except Exception:
            pass


def run_windows():
    import msvcrt
    import threading

    shell = os.environ.get('COMSPEC', 'cmd.exe')
    cwd = os.environ.get('PTY_CWD', os.environ.get('USERPROFILE', 'C:\\'))

    proc = subprocess.Popen(
        shell,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=cwd,
        bufsize=0,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
    )

    stdout = sys.stdout.buffer
    stop = threading.Event()

    def read_output():
        try:
            while not stop.is_set():
                data = proc.stdout.read1(16384) if hasattr(proc.stdout, 'read1') else proc.stdout.read(1)
                if not data:
                    break
                stdout.write(data)
                stdout.flush()
        except (OSError, ValueError):
            pass
        finally:
            stop.set()

    reader_thread = threading.Thread(target=read_output, daemon=True)
    reader_thread.start()

    try:
        while not stop.is_set() and proc.poll() is None:
            if msvcrt.kbhit():
                data = sys.stdin.buffer.read1(16384) if hasattr(sys.stdin.buffer, 'read1') else sys.stdin.buffer.read(1)
                if not data:
                    break
                if data.startswith(b'\x1b]boss:resize:'):
                    continue
                if proc.stdin and not proc.stdin.closed:
                    proc.stdin.write(data)
                    proc.stdin.flush()
            else:
                import time
                time.sleep(0.01)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        try:
            proc.terminate()
        except Exception:
            pass
        reader_thread.join(timeout=2)


if __name__ == '__main__':
    if PLATFORM == 'win32':
        run_windows()
    else:
        run_unix()
