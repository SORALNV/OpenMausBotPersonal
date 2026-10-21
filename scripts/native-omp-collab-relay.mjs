import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

/** OhMyPi 18.12.5 Collab relay framing, confined to loopback; session payloads remain AES-GCM sealed. */
export async function startOmpRelay() {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
  const rooms = new Map();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const match = /^\/r\/([A-Za-z0-9_-]{10,64})$/.exec(url.pathname), role = url.searchParams.get('role');
    if (!match || !['host', 'guest'].includes(role) || req.headers.origin) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, { roomId: match[1], role }));
  });
  wss.on('connection', (ws, info) => {
    let room = rooms.get(info.roomId), peerId = 0;
    if (info.role === 'host') {
      if (room) { ws.close(4009); return; }
      room = { host: ws, guests: new Map(), next: 1 }; rooms.set(info.roomId, room);
    } else {
      if (!room) { ws.close(4004); return; }
      if (room.guests.size >= 8) { ws.close(4029); return; }
      peerId = room.next++; room.guests.set(peerId, ws);
      room.host.send(JSON.stringify({ t: 'peer-joined', peer: peerId }));
    }
    ws.on('message', (raw, binary) => {
      const data = Buffer.from(raw);
      if (!binary || data.length < 32) { ws.close(1008); return; }
      if (info.role === 'host') {
        const to = data.readUInt32BE(0);
        for (const [id, guest] of room.guests) if ((!to || id === to) && guest.readyState === WebSocket.OPEN) {
          if (guest.bufferedAmount > 16 * 1024 * 1024) guest.close(1009); else guest.send(data);
        }
      } else if (room.host.readyState === WebSocket.OPEN) {
        data.writeUInt32BE(peerId, 0); room.host.send(data);
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (info.role === 'host') {
        if (rooms.get(info.roomId)?.host !== ws) return;
        rooms.delete(info.roomId);
        for (const guest of room.guests.values()) { guest.send(JSON.stringify({ t: 'room-closed' })); guest.close(4001); }
      } else {
        room.guests.delete(peerId);
        if (room.host.readyState === WebSocket.OPEN) room.host.send(JSON.stringify({ t: 'peer-left', peer: peerId }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, close: async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  } };
}
