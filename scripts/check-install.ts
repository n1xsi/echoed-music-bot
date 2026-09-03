/**
 * Checks that the bot token works and reports which servers the bot is in.
 * Use this to confirm an install without starting the whole bot.
 *
 *   npm run check
 */
const { EchoedClient, EchoedApiError } = await import('../src/echoed/client.js');
const { isVoiceChannel } = await import('../src/bot/parser.js');

async function main(): Promise<number> {
    const api = new EchoedClient();

    console.log('\n— token —');
    try {
        const result = await api.validate();
        console.log(`  valid: ${result.valid === false ? 'NO' : 'yes'}`);
    } catch (err) {
        return reportTokenFailure(err);
    }

    const profile = await api.getProfile().catch(() => null);
    if (profile) console.log(`  bot: ${profile.username} (${profile.id})`);

    console.log('\n— servers —');
    const servers = await api.listServers().catch((err: unknown) => {
        console.error(`  could not list servers: ${describe(err)}`);
        return [];
    });

    if (servers.length === 0) {
        console.log('  none — the bot is not installed on any server yet.');
        console.log('\n  Install it: Server Settings → Bots → the pale outlined button left of');
        console.log('  the bright "browse bots" one takes the edev_ token. Grant at least');
        console.log('  VIEW_CHANNELS, SEND_MESSAGES, READ_MESSAGE_HISTORY, EMBED_LINKS,');
        console.log('  CONNECT and SPEAK, or "npm run install-bot" from the terminal.');
        return 1;
    }

    for (const server of servers) {
        console.log(`\n  ${server.name}  [${server.id}]`);
        const channels = await api.listChannels(server.id).catch(() => []);
        const voice = channels.filter(isVoiceChannel);
        const text = channels.filter((c) => !isVoiceChannel(c));

        console.log(
            `    text channels:  ${text.length === 0 ? '(none visible)' : text.map((c) => c.name).join(', ')}`,
        );
        console.log(
            `    voice channels: ${voice.length === 0 ? '(none visible)' : voice.map((c) => c.name).join(', ')}`,
        );

        // The bot cannot read a member's voice state, so spell out what /play will
        // do in this server before the user tries it.
        if (voice.length === 0) {
            console.log("    → no voice channel visible: check the bot's voice permission.");
        } else if (voice.length === 1) {
            console.log(`    → /play works immediately (only one voice channel: ${voice[0]?.name}).`);
        } else {
            console.log('    → run /join <name> first, or set DEFAULT_VOICE_CHANNEL in .env.');
        }
    }

    console.log('\n✓ bot is installed — you can run "npm run dev".');
    await checkVoicePath(api, servers);
    return 0;
}

/**
 * Asks Echoed for a real voice grant and checks the address it points at is
 * routable. Worth doing separately from `/play`, because a blocked route looks
 * exactly like a permission problem from inside Discord-style clients: the bot
 * joins, appears in the member list, and never produces sound.
 */
async function checkVoicePath(
    api: InstanceType<typeof EchoedClient>,
    servers: { id: string; name: string }[],
): Promise<void> {
    const { assertVoiceHostReachable, VoiceHostUnreachableError, parseWsEndpoint } = await import(
        '../src/voice/reachability.js'
    );

    console.log('\n— voice path —');
    for (const server of servers) {
        const channels = await api.listChannels(server.id).catch(() => []);
        const voice = channels.filter(isVoiceChannel);
        const target = voice[0];
        if (!target) {
            console.log(`  ${server.name}: no voice channel visible, skipping.`);
            continue;
        }

        let grant;
        try {
            grant = await api.joinVoice(server.id, target.id);
        } catch (err) {
            console.error(`  ${server.name}: Echoed refused a voice grant — ${describe(err)}`);
            continue;
        }

        const { host, port } = parseWsEndpoint(grant.url);
        console.log(`  grant ok: room ${grant.room} on ${host}:${port}`);

        try {
            await assertVoiceHostReachable(grant.url);
            console.log(`  ${host}:${port} reachable — voice should work.`);
        } catch (err) {
            if (err instanceof VoiceHostUnreachableError) {
                console.error(`\n  ✗ ${host}:${port} does not answer from this machine.`);
                console.error('    The grant, the token and the permissions are all fine — the');
                console.error("    packets never arrive. Echoed's voice server runs on a single");
                console.error('    bare address, unlike the API and gateway which sit behind');
                console.error('    Cloudflare, and some networks drop traffic to it.');
                console.error('\n    Give the host a route to it (VPN), or run the bot on a');
                console.error('    server outside the blocked network.');
            } else {
                console.error(`  ✗ ${describe(err)}`);
            }
        }

        // Release the slot the grant reserved; the bot never actually connected.
        await api.leaveVoice(server.id, target.id).catch(() => undefined);
    }
}

/** Turns the API's rejection into the specific next action it implies. */
function reportTokenFailure(err: unknown): number {
    const status = err instanceof EchoedApiError ? err.status : 0;
    const body = err instanceof EchoedApiError ? err.body : '';

    console.error(`  rejected (${status === 0 ? 'network' : status}): ${firstSentence(body) || describe(err)}`);

    // Echoed gates the API behind review, and a development invite install is the
    // documented way to lift that gate before approval. Note this response also
    // comes back for a token Echoed does not recognise, so it does NOT confirm
    // the key itself is valid — only that the API is still gated.
    if (body.includes('bot_not_approved') || body.includes('not approved')) {
        console.error('\n  The API is gated until the bot is approved. To test before review,');
        console.error('  add the bot to a server you administer using the edev_ development');
        console.error('  invite token — that lifts the gate for that server.');
        console.error('\n  This response looks the same for an unrecognised key, so also');
        console.error('  double-check ECHOED_BOT_TOKEN is the real zbot_ value.');
        console.error('\n  Note: renaming the bot or changing its avatar/description sends it');
        console.error('  back to the review queue, which re-locks the API.');
    } else if (status === 401 || status === 403) {
        console.error('\n  Check ECHOED_BOT_TOKEN in .env — it must be the zbot_ API key,');
        console.error('  not the edev_ development invite token.');
    }
    return 1;
}

function firstSentence(body: string): string {
    const match = /"message"\s*:\s*"([^"]+)"/.exec(body);
    return match?.[1] ?? '';
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// Set exitCode rather than calling process.exit(): an abrupt exit while the
// fetch/tsx handles are still closing trips a libuv assertion on Windows.
process.exitCode = await main();

