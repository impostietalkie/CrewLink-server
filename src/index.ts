import express from 'express';
import { Server } from 'http';
import { Server as HttpsServer } from 'https';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import socketIO from 'socket.io';
import Tracer from 'tracer';
import morgan from 'morgan';

const supportedCrewLinkVersions = new Set(['0.0.0', '2.0.0', '2.0.1']);
const httpsEnabled = !!process.env.HTTPS;

const port = process.env.PORT || (httpsEnabled ? '443' : '9736');

const sslCertificatePath = process.env.SSLPATH || process.cwd();

const logger = Tracer.colorConsole({
	format: "{{timestamp}} <{{title}}> {{message}}"
});

const app = express();
let server: HttpsServer | Server;
if (httpsEnabled) {
	server = new HttpsServer({
		key: readFileSync(join(sslCertificatePath, 'privkey.pem')),
		cert: readFileSync(join(sslCertificatePath, 'fullchain.pem'))
	}, app);
} else {
	server = new Server(app);
}
const io = socketIO(server);

const clients = new Map<string, Client>();
const states = new Map<string, AmongUsState>();

interface Client {
	playerId: number;
	clientId: number;
}

interface Signal {
	data: string;
	to: string;
}

app.set('view engine', 'pug')
app.use(morgan('combined'))

let connectionCount = 0;
let address = process.env.ADDRESS || '127.0.0.1';
if (!address) {
	logger.error('You must set the ADDRESS environment variable.');
	process.exit(1);
}

app.get('/', (_, res) => {
	res.render('index', { connectionCount, address });
});

app.get('/health', (req, res) => {
	res.json({
		uptime: process.uptime(),
		connectionCount,
		address,
		name: process.env.NAME
	});
})

app.get('/hasRoomCode', (req, res) => {
	res.json({
		isValid: req.query.roomCode ? states.has(req.query.roomCode.toString()) : false,
		states: states,
	})
})

app.get('/gameState', (req, res) => {
	res.json({
		gameState: req.query.roomCode ? states.get(req.query.roomCode.toString()) : undefined,
	})
})

io.use((socket, next) => {
	next();
});

// GAME STATE
export interface AmongUsState {
	gameState: GameState;
	oldGameState: GameState;
	lobbyCode: string;
	players: Player[];
	isHost: boolean;
	clientId: number;
	hostId: number;
	commsSabotaged: boolean;
}

export interface Player {
	ptr: number;
	id: number;
	clientId: number;
	name: string;
	colorId: number;
	hatId: number;
	petId: number;
	skinId: number;
	disconnected: boolean;
	isImpostor: boolean;
	isDead: boolean;
	taskPtr: number;
	objectPtr: number;
	isLocal: boolean;

	x: number;
	y: number;
	inVent: boolean;
}

export enum MapType {
	THE_SKELD,
	MIRA_HQ,
	POLUS,
	UNKNOWN,
}

export enum GameState {
	LOBBY,
	TASKS,
	DISCUSSION,
	MENU,
	UNKNOWN,
}

io.on('connection', (socket: socketIO.Socket) => {
	connectionCount++;
	logger.info("Total connected: %d", connectionCount);
	let code: string | null = null;

	socket.on('join', (c: string, id: number, clientId: number) => {
		if (typeof c !== 'string' || typeof id !== 'number' || typeof clientId !== 'number') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid join command: %s %d %d`, socket.id, c, id, clientId);
			return;
		}

		logger.info(`Socket %s joined server with c:%s id:%d clientId:%d`, socket.id, c, id, clientId);

		let otherClients: any = {};
		if (io.sockets.adapter.rooms[c]) {
			let socketsInLobby = Object.keys(io.sockets.adapter.rooms[c].sockets);
			for (let s of socketsInLobby) {
				if (clients.has(s) && clients.get(s).clientId === clientId) {
					socket.disconnect();
					logger.error(`Socket %s sent invalid join command, attempted spoofing another client`, socket.id);
					return;
				}
				if (s !== socket.id)
					otherClients[s] = clients.get(s);
			}
		}
		code = c;
		socket.join(code);
		socket.to(code).broadcast.emit('join', socket.id, {
			playerId: id,
			clientId: clientId === Math.pow(2, 32) - 1 ? null : clientId
		});
		socket.emit('setClients', otherClients);
	});

	socket.on('id', (id: number, clientId: number) => {
		if (typeof id !== 'number' || typeof clientId !== 'number') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid id command: %d %d`, socket.id, id, clientId);
			return;
		}

		logger.info(`Socket %s ided server with id:%d clientId:%d`, socket.id, id, clientId);

		let client = clients.get(socket.id);
		if (client != null && client.clientId != null && client.clientId !== clientId) {
			socket.disconnect();
			logger.error(`Socket %s sent invalid id command, attempted spoofing another client`);
			return;
		}
		client = {
			playerId: id,
			clientId: clientId === Math.pow(2, 32) - 1 ? null : clientId
		};
		clients.set(socket.id, client);
		socket.to(code).broadcast.emit('setClient', socket.id, client);
	})

	socket.on('pushstate', (id: number, state: string) => {
		logger.info(`Socket %s (id=%d) sent state:`, socket.id, id);
		logger.info(`Current state: %s`, state);
		const gameState = JSON.parse(state) as AmongUsState;
		states.set(gameState.lobbyCode, gameState);
	})

	socket.on('leave', () => {
		if (code) {
			socket.leave(code);
			clients.delete(socket.id);
		}

		logger.info(`Socket %s left server`, socket.id);
	})

	socket.on('signal', (signal: Signal) => {
		if (typeof signal !== 'object' || !signal.data || !signal.to || typeof signal.to !== 'string') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid signal command: %j`, socket.id, signal);
			return;
		}
		const { to, data } = signal;
		io.to(to).emit('signal', {
			data,
			from: socket.id
		});

		logger.info(`Socket %s signaled server to %s`, socket.id, signal.to);
	});

	socket.on('disconnect', () => {
		clients.delete(socket.id);
		connectionCount--;
		logger.info("Total connected: %d", connectionCount);
	})

})

server.listen(port);
(async () => {
	logger.info('CrewLink Server started: %s', address);
})();
