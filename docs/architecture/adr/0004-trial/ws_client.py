# Throwaway: connect to HOST:PORT (or a Unix socket with --unix), send one WebSocket text frame, print the echo.
# usage: ws_client.py HOST PORT HOSTHEADER [PATH]
import base64, os, socket, ssl, sys

host, port, hosthdr = sys.argv[1], int(sys.argv[2]), sys.argv[3]
path = sys.argv[4] if len(sys.argv) > 4 else "/"
s = socket.create_connection((host, port), timeout=5)
if port == 443:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    s = ctx.wrap_socket(s, server_hostname=hosthdr)
key = base64.b64encode(os.urandom(16)).decode()
s.sendall(
    (f"GET {path} HTTP/1.1\r\nHost: {hosthdr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
     f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode()
)
resp = b""
while b"\r\n\r\n" not in resp:
    d = s.recv(4096)
    if not d:
        break
    resp += d
print(resp.split(b"\r\n")[0].decode())
if b" 101 " not in resp.split(b"\r\n")[0]:
    sys.exit(1)
msg = b"ping-from-client"
mask = os.urandom(4)
s.sendall(bytes([0x81, 0x80 | len(msg)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(msg)))
hdr = s.recv(2)
body = s.recv(hdr[1] & 0x7F)
print("echo:", body.decode())
