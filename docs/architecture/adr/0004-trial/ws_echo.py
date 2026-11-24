# Throwaway: a WebSocket echo server on the standard library only (text frames, no fragmentation).
import base64, hashlib, socket, struct, threading, sys

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def recv_exact(c, n):
    b = b""
    while len(b) < n:
        d = c.recv(n - len(b))
        if not d:
            raise EOFError
        b += d
    return b


def handle(c):
    try:
        req = b""
        while b"\r\n\r\n" not in req:
            req += c.recv(4096)
        key = [l.split(b":", 1)[1].strip() for l in req.split(b"\r\n") if l.lower().startswith(b"sec-websocket-key")]
        if not key:
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nhello-plain\n")
            return
        acc = base64.b64encode(hashlib.sha1(key[0] + GUID).digest())
        c.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + b"\r\n\r\n")
        while True:
            h = recv_exact(c, 2)
            op, ln = h[0] & 0x0F, h[1] & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", recv_exact(c, 2))[0]
            masked = h[1] & 0x80
            mask = recv_exact(c, 4) if masked else b""
            data = recv_exact(c, ln)
            if masked:
                data = bytes(x ^ mask[i % 4] for i, x in enumerate(data))
            if op == 8:
                c.sendall(b"\x88\x00")
                return
            if op == 1:
                c.sendall(bytes([0x81, len(data)]) + data)
    except Exception:
        pass
    finally:
        c.close()


s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 8000))
s.listen(16)
while True:
    conn, _ = s.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
