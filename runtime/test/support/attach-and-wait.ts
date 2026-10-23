// Opens a synthetic chat on the companion root in argv[2], attaches a client, reports `attached` on stdout and then waits
// until it is killed, so a test can end a runtime abruptly while its helper service and children are live.
import { openSyntheticChat } from './synthetic-chat.ts';
import { testHelperImage } from './native-helper.ts';

const root = process.argv[2];
if (root === undefined) { throw new Error('Usage: attach-and-wait.ts <companion root>'); }
const chat = await openSyntheticChat(root, await testHelperImage());
const attached = await chat.host.attachVerified(() => {});
process.stdout.write(`${attached.result}${String.fromCharCode(10)}`);
setInterval(() => {}, 60_000);
