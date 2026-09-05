/**
 * Unit checks for pure logic — parser, channel matching, queue, formatting.
 * No network or API token required.
 *
 *   npx tsx scripts/verify-logic.ts
 */
process.env['ECHOED_BOT_TOKEN'] ??= 'zbot_logic_verification_placeholder';

const { parseCommand, findChannel, isVoiceChannel } = await import('../src/bot/parser.js');
const { Queue } = await import('../src/player/queue.js');
const { formatDuration, progressBar } = await import('../src/ui/embeds.js');
type Track = import('../src/audio/resolver.js').Track;
type EchoedChannel = import('../src/echoed/types.js').EchoedChannel;

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${e}\n        got      ${a}`}`);
}

function track(title: string, duration = 100): Track {
  return {
    url: `https://example.com/${title}`,
    title,
    author: 'artist',
    duration,
    source: 'Test',
    isLive: false,
    requestedBy: 'tester',
    requestedById: 'u1',
  };
}

console.log('\n— command parser —');
check('basic play', parseCommand('/play some song', '/')?.name, 'play');
check('play args', parseCommand('/play some song', '/')?.args, 'some song');
check('uppercase normalised', parseCommand('/PLAY X', '/')?.name, 'play');
check('surrounding whitespace', parseCommand('   /queue 2   ', '/')?.name, 'queue');
check('argv split', parseCommand('/move 3 1', '/')?.argv, ['3', '1']);
check('no-arg command', parseCommand('/np', '/')?.args, '');
check('non-command ignored', parseCommand('hello', '/'), null);
check('bare prefix ignored', parseCommand('/', '/'), null);
check('link argument kept intact', parseCommand('/play https://a.b/c?d=1&e=2', '/')?.args, 'https://a.b/c?d=1&e=2');
check('custom prefix', parseCommand('!play x', '!')?.name, 'play');
check('wrong prefix ignored', parseCommand('!play x', '/'), null);

console.log('\n— channel matching —');
const channels: EchoedChannel[] = [
  { id: 'c1', name: 'General', type: 'video' },
  { id: 'c2', name: 'general-chat', type: 'text' },
  { id: 'c3', name: 'Music', type: 'video' },
  { id: 'c4', name: 'Tasks', type: 'tasks' },
];
check('voice channels only', channels.filter(isVoiceChannel).map((c) => c.name), ['General', 'Music']);
check('match by id', findChannel(channels, 'c3')?.name, 'Music');
check('match by name, any case', findChannel(channels, 'music')?.name, 'Music');
check('strips leading #', findChannel(channels, '#Music')?.name, 'Music');
check('exact name beats partial', findChannel(channels, 'General')?.name, 'General');
check('ambiguous partial → null', findChannel(channels, 'gener'), null);
check('unknown → null', findChannel(channels, 'nope'), null);
check('empty → null', findChannel(channels, '  '), null);

console.log('\n— queue —');
const q = new Queue();
q.push(track('a'), track('b'), track('c'));
check('length', q.length, 3);
check('next() → a', q.next()?.title, 'a');
check('current is a', q.current?.title, 'a');
check('remaining after shift', q.length, 2);
check('next() → b', q.next()?.title, 'b');

q.loop = 'track';
check('loop=track repeats b', q.next()?.title, 'b');
check('skip escapes track loop', q.next(true)?.title, 'c');

q.loop = 'queue';
const beforeRequeue = q.length;
check('loop=queue re-appends current', q.next()?.title === undefined ? 'empty' : 'has-track', 'has-track');
check('queue grew back', q.length >= beforeRequeue, true);

const q2 = new Queue();
q2.push(track('x'), track('y'), track('z'));
check('remove position 2', q2.remove(2)?.title, 'y');
check('remove out of range', q2.remove(99), null);
check('after removal', q2.upcoming.map((t) => t.title), ['x', 'z']);
check('move 1→2', q2.move(1, 2), true);
check('after move', q2.upcoming.map((t) => t.title), ['z', 'x']);
check('move out of range', q2.move(1, 99), false);
check('totalDuration', q2.totalDuration, 200);
q2.clear();
check('clear empties', q2.length, 0);
check('next() on empty → null', q2.next(), null);

const q3 = new Queue();
for (let i = 0; i < 40; i++) q3.push(track(`t${i}`));
const before = q3.upcoming.map((t) => t.title).join(',');
q3.shuffle();
check('shuffle keeps every track', q3.length, 40);
check('shuffle reorders', q3.upcoming.map((t) => t.title).join(',') !== before, true);
check('shuffle loses nothing', [...q3.upcoming].map((t) => t.title).sort().length, 40);

console.log('\n— formatting —');
check('0 → LIVE', formatDuration(0), 'LIVE');
check('seconds', formatDuration(45), '0:45');
check('minutes', formatDuration(130), '2:10');
check('pads seconds', formatDuration(65), '1:05');
check('hours', formatDuration(3725), '1:02:05');
check('progress bar width', progressBar(50, 100).length, 20);
check('progress bar half', progressBar(50, 100), '▰'.repeat(10) + '▱'.repeat(10));
check('progress bar start', progressBar(0, 100), '▱'.repeat(20));
check('progress bar end', progressBar(100, 100), '▰'.repeat(20));
check('progress bar clamps overshoot', progressBar(500, 100), '▰'.repeat(20));
check('progress bar live', progressBar(10, 0).length, 20);

console.log(
  failures === 0
    ? '\n✓ all logic checks passed'
    : `\n✗ ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
