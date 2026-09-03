/**
 * Installs the bot on a server with its `edev_` development invite token.
 *
 *   npm run install-bot
 *
 * This is the same flow the Echoed web client runs behind the "add by
 * development token" button on Server Settings → Bots. That button is the
 * easier route; this script exists for when it is unavailable (older desktop
 * build, or you want the exact server response in front of you).
 *
 * Neither the flow nor its endpoints appear in the developer docs — they were
 * read out of the web client's own bundle (assets/botService-*.js on
 * beta.echoed.gg), so treat them as unofficial and liable to change:
 *
 *   POST /v1/bots/dev-token/preview        { token }
 *        → { botId, name, avatar, requestedPermissions }
 *   POST /v1/bots/{serverId}/invite/token  { token, grantedPermissions, acknowledgeRisk }
 *
 * Both are *user* routes, not bot routes: they authenticate with the session
 * JWT of a human who holds MANAGE_SERVER, not with the zbot_ key. Verified:
 * calling preview with no auth returns 401 `user_unauthenticated`.
 */
import dotenv from 'dotenv';

// Not importing src/config.ts on purpose: it exits when ECHOED_BOT_TOKEN is
// missing, and installing the bot is what you do before the token works.
dotenv.config();

const BASE = 'https://go.echoed.gg';
const DEV_TOKEN = process.env['DEV_INVITE_TOKEN']?.trim() ?? '';
const JWT = process.env['ECHOED_USER_JWT']?.trim() ?? '';
const SERVER_ID = process.env['SERVER_ID']?.trim() ?? '';

interface DevTokenPreview {
    botId?: string;
    name?: string;
    avatar?: string | null;
    requestedPermissions?: number;
}

async function main(): Promise<number> {
    if (DEV_TOKEN === '' || JWT === '') {
        printSetupHelp();
        return 1;
    }

    // Step 1 — resolve the token. This is also the only working way to learn the
    // bot's own id: /validate and /profile both carry it but are behind the
    // pre-approval gate, so the id is unreachable until the bot is installed.
    console.log('\nResolving the development token…');
    const preview = await postJson<DevTokenPreview>('/v1/bots/dev-token/preview', { token: DEV_TOKEN });

    const botId = preview.botId ?? '';
    console.log(`  bot:  ${preview.name ?? '(unnamed)'}`);
    console.log(`  id:   ${botId === '' ? '(not in the response)' : botId}`);

    const requested = preview.requestedPermissions ?? 0;
    console.log(`  asks for permissions: ${requested === 0 ? 'none (0)' : `bitmask ${requested}`}`);

    // The web client grants exactly what the bot asked for. Passing the same value
    // avoids hardcoding permission bits, whose numeric values are not documented.
    if (requested === 0) {
        console.error('\nThe bot requests no permissions, so installing it now would grant it none');
        console.error('and /play could not join voice. Set them first:');
        console.error('  Settings → Bot Profile → permissions, then tick at least');
        console.error('  VIEW_CHANNELS, SEND_MESSAGES, READ_MESSAGE_HISTORY, EMBED_LINKS,');
        console.error('  CONNECT, SPEAK, USE_VOICE_ACTIVITY — then re-run this.');
        return 1;
    }

    if (SERVER_ID === '') {
        console.error('\nSERVER_ID is not set in .env. Open the server in the web client and');
        console.error('copy the id out of the URL: /servers/<SERVER_ID>');
        return 1;
    }

    // Step 2 — the install itself. `acknowledgeRisk` is what the consent screen's
    // "this bot has not been reviewed" warning maps to; the client always sends true.
    console.log(`\nInstalling on server ${SERVER_ID}…`);
    const result = await postJson<unknown>(`/v1/bots/${encodeURIComponent(SERVER_ID)}/invite/token`, {
        token: DEV_TOKEN,
        grantedPermissions: requested,
        acknowledgeRisk: true,
    });

    console.log(`✓ installed. Server response: ${JSON.stringify(result).slice(0, 300)}`);
    console.log('\nThe API gate should now be open for this server. Next: npm run check');
    return 0;
}

function printSetupHelp(): void {
    console.error('\nThis script needs two values in .env:\n');
    console.error('  DEV_INVITE_TOKEN   the edev_… token from Settings → Bot Profile');
    console.error('  ECHOED_USER_JWT    a session JWT for YOUR account (not the bot)');
    console.error('  SERVER_ID          optional here, required for the install step');
    console.error('\nTo get the JWT: open beta.echoed.gg logged in as yourself, DevTools →');
    console.error('Network, click any request to go.echoed.gg, and copy the value after');
    console.error('"Bearer " in its Authorization header. It is short-lived — if this');
    console.error('script reports 401, grab a fresh one.');
    console.error('\nEasier alternative, no JWT needed: in the web client open the server →');
    console.error('Server Settings → Bots. Top right has two buttons; the pale outlined one');
    console.error('to the LEFT of the bright "browse bots" button opens a dialog that takes');
    console.error('the edev_ token directly.');
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${JWT}`,
            'content-type': 'application/json',
            accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
    });

    const body = (await res.text()).trim();
    if (!res.ok) {
        if (res.status === 401) {
            throw new Error(
                `POST ${path} → 401. The JWT is missing, wrong or expired — grab a fresh one from ` +
                'DevTools → Network → Authorization header.',
            );
        }
        throw new Error(`POST ${path} → ${res.status}: ${body.slice(0, 400)}`);
    }

    try {
        return JSON.parse(body) as T;
    } catch {
        return body as unknown as T;
    }
}

// Set exitCode rather than calling process.exit(): an abrupt exit while fetch
// handles are still closing trips a libuv assertion on Windows.
try {
    process.exitCode = await main();
} catch (err) {
    console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
}

