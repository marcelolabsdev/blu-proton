import { createHash } from 'node:crypto';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { createAgentRouter } from '@flue/runtime/routing';
import { setProvider } from '@flue/runtime';
import { Hono } from 'hono';
import { Assistant } from './agents/assistant.ts';
import { channel as telegram } from './channels/telegram.ts';

// Groq provider registrado para dejar `groq/openai/gpt-oss-20b` disponible:
// en el free tier de Groq este modelo está limitado a 8k TPM (no usable para
// el agente hoy), pero al pagar el Dev Tier basta cambiar la línea de
// useModel() en el agente para usarlo. Esto reemplaza el provider groq
// integrado de Flue para esta app.
setProvider(
	createProvider({
		id: 'groq',
		auth: {
			apiKey: {
				name: 'Groq API key',
				resolve: async () => {
					const key = process.env.GROQ_API_KEY;
					if (!key) return undefined;
					return { auth: { apiKey: key }, source: 'GROQ_API_KEY' };
				},
			},
		},
		models: [
			{
				id: 'openai/gpt-oss-20b',
				name: 'GPT OSS 20B',
				api: 'openai-completions',
				provider: 'groq',
				baseUrl: 'https://api.groq.com/openai/v1',
				reasoning: true,
				input: ['text'],
				cost: { input: 0.075, output: 0.3, cacheRead: 0.0375, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 65536,
			},
		],
		api: openAICompletionsApi(),
	}),
);

const app = new Hono();

// The route map: every agent, channel, and custom route is mounted here
// explicitly. Talk to Assistant with one POST per message:
//
//   curl -X POST http://localhost:5173/agents/assistant/my-first-chat \
//     -H 'content-type: application/json' \
//     -H 'x-chat-passcode: <CHAT_PASSCODE>' \
//     -d '{"kind":"user","body":"Tell me a joke."}'

// Passcode gate on the HTTP surface (the Telegram channel bypasses it: its
// dispatch is internal, and the channel's own webhook secret does the work).
const PASSCODE_HEADER = 'x-chat-passcode';

function samePasscode(provided: string, expected: string): boolean {
	const a = createHash('sha256').update(provided).digest();
	const b = createHash('sha256').update(expected).digest();
	return a.length === b.length && a.equals(b);
}

app.use('/agents/assistant/*', async (c, next) => {
	const expected = process.env.CHAT_PASSCODE;
	const provided = c.req.header(PASSCODE_HEADER);
	if (!expected || !provided || !samePasscode(provided, expected)) {
		return c.json(
			{ error: { type: 'unauthorized', message: 'Missing or invalid passcode.' } },
			401,
		);
	}
	await next();
});

app.route('/agents/assistant', createAgentRouter(Assistant));

// Telegram webhook ingress: https://<worker>.workers.dev/channels/telegram/webhook
app.route('/channels/telegram', telegram.route());

export default app;
