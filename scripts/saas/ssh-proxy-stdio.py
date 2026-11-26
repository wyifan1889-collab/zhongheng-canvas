import hashlib
import os
from pathlib import Path
import socket
import sys
import threading

wheel = Path(__file__).parent / 'vendor' / 'PySocks-1.7.1-py3-none-any.whl'
if hashlib.sha256(wheel.read_bytes()).hexdigest() != '2725bd0a9925919b9b51739eea5f9e2bae91e83288108a9ad338b2e3a4435ee5':
    raise SystemExit('SSH proxy dependency verification failed')
sys.path.insert(0, str(wheel))
import socks

if sys.argv[1:] != ['38.55.198.15', '22']:
    raise SystemExit('unexpected SSH destination')
if os.name == 'nt':
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

connection = socks.create_connection(('38.55.198.15', 22), timeout=10,
    proxy_type=socks.SOCKS5, proxy_addr='127.0.0.1', proxy_port=7897)
connection.settimeout(None)
failed = threading.Event()

def send():
    try:
        while True:
            data = sys.stdin.buffer.read1(65536)
            if not data:
                connection.shutdown(socket.SHUT_WR)
                return
            connection.sendall(data)
    except OSError:
        failed.set()
        try:
            connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

threading.Thread(target=send, daemon=True).start()
try:
    while True:
        data = connection.recv(65536)
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
except OSError:
    failed.set()
finally:
    connection.close()
raise SystemExit(1 if failed.is_set() else 0)
