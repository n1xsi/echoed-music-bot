import { MusicBot } from './bot/music-bot.js';
import { config } from './config.js';
import { acquireSingleInstanceLock } from './lock.js';
import { createLogger } from './logger.js';
import { ytDlpVersion } from './audio/ytdlp.js';

const log = createLogger('main');

async function main(): Promise<void> {
  log.info('starting Echoed music bot');

  // Before anything else: a duplicate instance breaks voice in a way that looks
  // like a network fault, so refuse rather than let it happen.
  try {
    acquireSingleInstanceLock();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  // Fail loudly here rather than on the first /play.
  try {
    log.info(`yt-dlp ${await ytDlpVersion()} (${config.ytdlpPath})`);
  } catch (err) {
    log.error(
      'yt-dlp is not usable:',
      err instanceof Error ? err.message : err,
      '\nRun "npm run setup" to download it, or set YTDLP_PATH in .env.',
    );
    process.exit(1);
  }
  log.info(`ffmpeg: ${config.ffmpegPath}`);

  const bot = new MusicBot();

  const shutdown = (signal: string): void => {
    log.info(`received ${signal}, stopping`);
    void bot
      .stop()
      .catch((err) => log.error('shutdown error:', err))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception:', err);
  });

  await bot.start();
}

main().catch((err) => {
  log.error('fatal:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) log.debug(err.stack);
  process.exit(1);
});
