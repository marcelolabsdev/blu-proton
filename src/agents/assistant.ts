'use agent';
import { Composio } from '@composio/core';
import {
	useAgentFinish,
	useInitialData,
	useModel,
	useTool,
	defineTool,
} from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/telegram.ts';

const chatData = v.object({
	type: v.literal('chat'),
	chatId: v.number(),
	messageThreadId: v.optional(v.number()),
	directMessagesTopicId: v.optional(v.number()),
	chatTitle: v.optional(v.string()),
});
const businessChatData = v.object({
	type: v.literal('business-chat'),
	businessConnectionId: v.string(),
	chatId: v.number(),
	messageThreadId: v.optional(v.number()),
	directMessagesTopicId: v.optional(v.number()),
	chatTitle: v.optional(v.string()),
});
const initialDataSchema = v.variant('type', [chatData, businessChatData]);

// ---- Composio (Platform sessions) ----
// The web chat is passcode-gated with a single holder, so one stable Composio
// user carries the connected accounts across conversations.
const COMPOSIO_USER_ID = '8lab-web-user';

let composioClient: Composio | null = null;
const composioSessions = new Map<
	string,
	Awaited<ReturnType<Composio['sessions']['create']>>
>();

function getComposio(): Composio | null {
	if (!process.env.COMPOSIO_API_KEY) return null;
	composioClient ??= new Composio();
	return composioClient;
}

async function getComposioSession() {
	const composio = getComposio();
	if (!composio) return null;
	const cached = composioSessions.get(COMPOSIO_USER_ID);
	if (cached) return cached;
	const session = await composio.sessions.create(COMPOSIO_USER_ID, {
		manageConnections: true,
	});
	composioSessions.set(COMPOSIO_USER_ID, session);
	return session;
}

function json(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

const composioToolkits = defineTool({
	name: 'composio_toolkits',
	description:
		'Lista las apps (toolkits) disponibles en Composio e indica si el usuario ya conectó cada una.',
	input: v.object({
		limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)), 50),
	}),
	async run({ data }) {
		const session = await getComposioSession();
		if (!session) return 'Composio no está configurado (falta COMPOSIO_API_KEY).';
		const result = await session.toolkits({ limit: data.limit });
		return json(result);
	},
});

const composioSearchTools = defineTool({
	name: 'composio_search_tools',
	description:
		'Busca herramientas de apps externas en Composio por caso de uso (ej. "enviar email", "leer calendario").',
	input: v.object({
		query: v.pipe(v.string(), v.minLength(1)),
		toolkits: v.optional(v.array(v.string())),
	}),
	async run({ data }) {
		const session = await getComposioSession();
		if (!session) return 'Composio no está configurado (falta COMPOSIO_API_KEY).';
		const result = await session.search({
			query: data.query,
			...(data.toolkits ? { toolkits: data.toolkits } : {}),
		});
		return json(result);
	},
});

const composioExecuteTool = defineTool({
	name: 'composio_execute_tool',
	description:
		'Ejecuta una herramienta de Composio por su slug (obtén el slug con composio_search_tools). Si la app no está conectada, la respuesta indica cómo conectarla.',
	input: v.object({
		toolSlug: v.pipe(v.string(), v.minLength(1)),
		arguments: v.optional(v.record(v.string(), v.unknown())),
	}),
	async run({ data }) {
		const session = await getComposioSession();
		if (!session) return 'Composio no está configurado (falta COMPOSIO_API_KEY).';
		const result = await session.execute(data.toolSlug, data.arguments ?? {});
		return json(result);
	},
});

const composioConnectApp = defineTool({
	name: 'composio_connect_app',
	description:
		'Genera el link de conexión (Connect Link) para que el usuario autorice una app de Composio (ej. gmail, github). Entrégale el link tal cual.',
	input: v.object({
		toolkit: v.pipe(v.string(), v.minLength(1)),
	}),
	async run({ data }) {
		const session = await getComposioSession();
		if (!session) return 'Composio no está configurado (falta COMPOSIO_API_KEY).';
		const connection = await session.authorize(data.toolkit);
		return json(connection.toJSON());
	},
});

export function Assistant() {
	useModel('google/gemini-3.5-flash-lite');
	const composio = getComposio();
	if (composio) {
		useTool(composioToolkits);
		useTool(composioSearchTools);
		useTool(composioExecuteTool);
		useTool(composioConnectApp);
	}
	// No `initialData` static: it would make creation data mandatory for every
	// instance, including plain HTTP conversations. Instead, validate at
	// runtime — Telegram dispatches carry chat data; HTTP conversations don't.
	const raw = useInitialData<unknown>();
	const parsed = raw ? v.safeParse(initialDataSchema, raw) : undefined;
	const data = parsed?.success ? parsed.output : undefined;
	const composioPrompt = composio
		? [
			'Tienes herramientas de Composio para usar apps externas del usuario (Gmail, Google Calendar, GitHub, Notion, Slack, etc.).',
			'Flujo: usa composio_search_tools para encontrar la herramienta adecuada, y composio_execute_tool para ejecutarla por su slug.',
			'Atajo para ir más rápido: si ya conoces el slug exacto de la acción, llama composio_execute_tool directamente, sin buscar y SIN verificar conexiones antes (nada de composio_toolkits previo). Slugs conocidos de Gmail: GMAIL_SEND_EMAIL (enviar correo), GMAIL_FETCH_EMAILS (leer correos), GMAIL_REPLY_TO_THREAD (responder un hilo). Slugs conocidos de Google Tasks: GOOGLETASKS_INSERT_TASK (crear tarea), GOOGLETASKS_LIST_TASKS (listar tareas; para la lista principal usa el id de lista \'@default\'), GOOGLETASKS_PATCH_TASK (actualizar o completar tarea con status "completed"), GOOGLETASKS_DELETE_TASK (eliminar tarea), GOOGLETASKS_LIST_TASK_LISTS (listar listas de tareas). Para cualquier otra app o acción que no esté en esta lista, busca primero con composio_search_tools.',
			'Nunca hagas verificaciones previas de conexión: intenta ejecutar directamente. Solo si el resultado de la ejecución indica que la app no está conectada, llama a composio_connect_app con el toolkit y entrégale al usuario el link de conexión tal cual, pidiéndole que lo abra y te avise cuando termine.',
			'Usa composio_toolkits únicamente cuando el usuario pregunte explícitamente qué apps existen o cuáles tiene conectadas.',
			'Reporta siempre los resultados en español.',
		].join(' ')
		: '';
	if (data) {
		useTool(postMessage(data));
		// Enforcement: flash models sometimes answer with plain text and skip
		// the post_telegram_message call, losing the reply entirely. Append a
		// reminder so the same response does another turn and posts it.
		useAgentFinish(({ response, append }) => {
			const posted = response.toolCalls.some(
				(call) => call.tool === 'post_telegram_message' && !call.isError,
			);
			if (posted) return;
			append({
				kind: 'signal',
				type: 'reminder',
				body: 'Terminaste sin llamar a post_telegram_message — nada llegó al usuario. Llámala ahora con tu respuesta como text.',
			});
		});
		return [
			'You are a friendly chat assistant living in a Telegram conversation.',
			'Reply to every user message by calling the `post_telegram_message` tool with your answer as `text`.',
			'Keep replies short and Telegram-friendly (plain text, no heavy markdown).',
			'Always write your entire reply in Spanish, including titles, lists, and code comments — never mix in English sentences or fragments, even if the user writes in another language.',
			composioPrompt,
		]
			.filter(Boolean)
			.join(' ');
	}
	return [
		'You are a friendly chat assistant. Keep replies clear, warm, and concise.',
		'Always write your entire reply in Spanish, including titles, lists, and code comments — never mix in English sentences or fragments, even if the user writes in another language.',
		composioPrompt,
	]
		.filter(Boolean)
		.join(' ');
}
