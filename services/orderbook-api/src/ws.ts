import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { BookSnapshot, ClientMsg, OrderRecord, ServerMsg } from "@seltra/sdk";
import { config, pairById } from "./config";
import { buildBook, diffBookLevels } from "./book";
import type { OrderStore } from "./store";

interface Client {
  socket: WebSocket;
  channels: Set<string>;
}

export class StreamHub {
  private clients = new Set<Client>();
  private heartbeat: ReturnType<typeof setInterval>;
  private wss: WebSocketServer;
  /** Last book broadcast per pair; diffs are computed against this. */
  private books = new Map<string, { seq: number; book: BookSnapshot }>();

  constructor(server: Server, private readonly store: OrderStore) {
    this.wss = new WebSocketServer({ server, path: "/stream" });
    this.wss.on("connection", (socket) => {
      const client: Client = { socket, channels: new Set() };
      this.clients.add(client);
      socket.on("message", (data) => this.onMessage(client, data.toString()));
      socket.on("close", () => this.clients.delete(client));
      socket.on("error", () => socket.close());
    });
    this.heartbeat = setInterval(() => {
      this.broadcastAll({ v: 1, type: "heartbeat", ts: Date.now() });
    }, config.heartbeatMs);
    this.heartbeat.unref();
  }

  private onMessage(client: Client, raw: string) {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return;
    }
    if (msg.type === "subscribe" && typeof msg.channel === "string") {
      client.channels.add(msg.channel);
      // Snapshot-then-diff: a fresh book snapshot on every (re)subscribe.
      if (msg.channel.startsWith("book:")) {
        const pair = pairById(msg.channel.slice("book:".length));
        if (pair) {
          let state = this.books.get(pair.id);
          if (!state) {
            state = { seq: 0, book: buildBook(this.store.restingForPair(pair.id), pair) };
            this.books.set(pair.id, state);
          }
          this.sendTo(client, { v: 1, type: "book.snapshot", pair: pair.id, seq: state.seq, book: state.book });
        }
      }
    } else if (msg.type === "unsubscribe" && typeof msg.channel === "string") {
      client.channels.delete(msg.channel);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
    this.wss.close();
  }

  private sendTo(client: Client, msg: ServerMsg) {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(msg));
  }

  broadcastBook(pairId: string, book: BookSnapshot) {
    const prev = this.books.get(pairId);
    if (!prev) {
      this.books.set(pairId, { seq: 0, book });
      this.broadcast(`book:${pairId}`, { v: 1, type: "book.snapshot", pair: pairId, seq: 0, book });
      return;
    }
    const seq = prev.seq + 1;
    const { bids, asks } = diffBookLevels(prev.book, book);
    this.books.set(pairId, { seq, book });
    // An empty diff is still broadcast: a book push is the client's signal that
    // the tape/candles/stats may have moved (fills rebroadcast the book).
    this.broadcast(`book:${pairId}`, { v: 1, type: "book.diff", pair: pairId, seq, bids, asks, ts: book.ts });
  }

  broadcastUserOrder(record: OrderRecord) {
    this.broadcast(`user:${record.order.maker}`, { v: 1, type: "user.order", order: record });
  }

  private broadcast(channel: string, msg: ServerMsg) {
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.channels.has(channel) && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  private broadcastAll(msg: ServerMsg) {
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  }
}
