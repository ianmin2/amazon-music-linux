/**
 * Optional local control channel for the Android companion app.
 *
 * The original implementation listened on 0.0.0.0:3000 by default, was enabled
 * by default, and accepted any connection with no authentication whatsoever.
 * Anyone on the same network could control playback and pull down the current
 * track, artist and album art. It now:
 *
 *   - is disabled by default,
 *   - binds loopback unless the user explicitly opts into a wider interface,
 *   - requires a shared token presented in the Socket.IO handshake,
 *   - reports bind failures instead of swallowing them.
 *
 * Socket.IO v4 rejects cross-origin browser clients unless CORS is configured,
 * and it is deliberately left unconfigured here: the companion is a native app,
 * so no web page should ever be able to reach this socket.
 */

import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import { Server as SocketIoServer, type Socket } from "socket.io";

import type { CompanionServerSettings } from "./settings-store";

export type CompanionCommand = "playPause" | "next" | "previous";

export interface CompanionHandlers {
  onCommand(command: CompanionCommand): void;
  /** Called when a client connects, so it can be sent the current state. */
  onClientConnected(): void;
}

interface TrackPayload {
  title: string;
  artist: string;
  album: string;
  artwork: string | null;
}

function tokensMatch(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || expected.length === 0) {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths separately.
  return a.length === b.length && timingSafeEqual(a, b);
}

export class CompanionServer {
  private http: http.Server | undefined;
  private io: SocketIoServer | undefined;
  private lastTrack: TrackPayload | null = null;
  private lastPlaying = false;

  public isRunning(): boolean {
    return this.http !== undefined;
  }

  public async start(config: CompanionServerSettings, handlers: CompanionHandlers): Promise<void> {
    await this.stop();

    if (!config.enabled) {
      return;
    }
    if (config.token.length < 32) {
      console.error("[companion] refusing to start without a configured token");
      return;
    }

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("Amazon Music companion server is running.\n");
    });

    const io = new SocketIoServer(server, {
      // No `cors` option: browser clients from other origins stay blocked.
      serveClient: false,
    });

    io.use((socket, next) => {
      if (tokensMatch(socket.handshake.auth?.token, config.token)) {
        next();
        return;
      }
      next(new Error("unauthorized"));
    });

    io.on("connection", (socket: Socket) => {
      console.log("[companion] client connected");
      this.pushStateTo(socket);
      handlers.onClientConnected();

      const commands: CompanionCommand[] = ["playPause", "next", "previous"];
      for (const command of commands) {
        socket.on(command, () => handlers.onCommand(command));
      }
      socket.on("disconnect", () => console.log("[companion] client disconnected"));
    });

    await new Promise<void>((resolve) => {
      // `listen` reports failures asynchronously — the previous try/catch around
      // it could never have caught EADDRINUSE.
      server.once("error", (error) => {
        console.error(`[companion] could not bind ${config.host}:${config.port}:`, error);
        server.close();
        this.http = undefined;
        this.io = undefined;
        resolve();
      });
      server.listen(config.port, config.host, () => {
        console.log(`[companion] listening on ${config.host}:${config.port}`);
        resolve();
      });
    });

    if (server.listening) {
      this.http = server;
      this.io = io;
    } else {
      void io.close();
    }
  }

  public async stop(): Promise<void> {
    const io = this.io;
    const server = this.http;
    this.io = undefined;
    this.http = undefined;

    if (io) {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
    if (server && server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  public setTrack(track: TrackPayload | null): void {
    this.lastTrack = track;
    this.io?.emit("track", track);
  }

  public setPlaying(playing: boolean): void {
    this.lastPlaying = playing;
    this.io?.emit("playing", playing);
  }

  private pushStateTo(socket: Socket): void {
    socket.emit("track", this.lastTrack);
    socket.emit("playing", this.lastPlaying);
  }
}
