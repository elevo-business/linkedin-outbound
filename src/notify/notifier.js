// Minimal notifier. Console by default; optional Telegram via the built-in fetch.

export class Notifier {
  constructor(config, logger = console.log) {
    this.cfg = config.notify;
    this.log = logger;
  }

  async send(text) {
    if (this.cfg.driver === 'telegram' && this.cfg.telegramToken && this.cfg.telegramChatId) {
      try {
        await fetch(`https://api.telegram.org/bot${this.cfg.telegramToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.cfg.telegramChatId, text }),
        });
        return;
      } catch (err) {
        this.log(`[notify] telegram failed: ${err.message}`);
      }
    }
    this.log(`🔔 ${text}`);
  }
}
