import { useFlueAgent } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import type { FlueConversationMessage } from '@flue/sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDownIcon, ArrowUpIcon, StopIcon } from './icons.tsx';
import { PASSCODE_KEY } from './App.tsx';

const SUGGESTIONS = [
	{
		label: 'Cuéntame una historia',
		prompt:
			'Cuéntame una historia corta. Formátala en markdown: un título, una cita, una lista y algo de texto en negrita.',
	},
	{
		label: '¿Qué puede hacer este agente?',
		prompt: '¿Qué es Agente y qué tareas puedes hacer por mí?',
	},
	{
		label: 'Planifica una cena',
		prompt:
			'Ayúdame a planear una cena de cumpleaños y sugiéreme un menú completo.',
	},
	{
		label: 'Consejos de productividad',
		prompt:
			'Dame 3 consejos prácticos para ser más productivo, con formato markdown.',
	},
];

function messageText(message: FlueConversationMessage): string {
	return message.parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
}

// Short, predictable-width tool label so the reserved trailing room on the
// reply's last line stays bounded.
function toolLabel(name: string): string {
	const short = name.replace(/^composio_/, '');
	return short.length > 16 ? `${short.slice(0, 15)}…` : short;
}

export function Chat({
	conversationId,
	passcode,
	onUserMessage,
}: {
	conversationId: string;
	passcode: string;
	onUserMessage?: (text: string) => void;
}) {
	const [input, setInput] = useState('');
	const [showScrollButton, setShowScrollButton] = useState(false);
	const viewportRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	// While the user is anchored near the bottom, the view follows the
	// streaming reply token by token; scrolling up unpins it.
	const pinnedToBottomRef = useRef(true);

	const client = useMemo(
		() =>
			createFlueClient({
				url: `/agents/assistant/${conversationId}`,
				headers: { 'x-chat-passcode': passcode },
			}),
		[conversationId, passcode],
	);
	const agent = useFlueAgent({ client });

	const visible = agent.messages.filter((message) => message.display === 'visible');

	// A Composio tool currently executing: the reply pauses silently while it
	// runs, so surface it as "Usando <tool>…" instead of a frozen chat.
	const workingTool = useMemo(() => {
		for (const message of agent.messages) {
			for (const part of message.parts) {
				if (
					part.type === 'dynamic-tool' &&
					part.state === 'input-available' &&
					part.toolName.startsWith('composio')
				) {
					return part.toolName;
				}
			}
		}
		return null;
	}, [agent.messages]);

	const busy = agent.status === 'submitted' || agent.status === 'streaming';

	// Whether the current turn already shows text (streaming or settled).
	const lastMessage = visible[visible.length - 1];
	const textStarted =
		lastMessage?.role === 'assistant' &&
		lastMessage.parts.some((part) => part.type === 'text' && part.text.length > 0);

	const activityLabel = workingTool
		? `Usando ${toolLabel(workingTool)}…`
		: agent.status === 'submitted'
			? 'Pensando…'
			: 'Trabajando…';
	// A single indicator line: it holds the spot until the first token
	// lands, then the reply takes its exact place. Nothing is ever rendered
	// below the reply's text.
	const showActivity = busy && !textStarted;

	const failed = agent.failedSends.length > 0;
	const connecting = agent.status === 'connecting' && !agent.historyReady;
	// ChatGPT-style layout: with an empty thread the composer lives centered
	// under the greeting and docks to the bottom once messages exist.
	const isEmpty = agent.historyReady && visible.length === 0;

	useEffect(() => {
		if (!pinnedToBottomRef.current) return;
		bottomRef.current?.scrollIntoView({
			// Instant jumps while streaming keep the view glued to the growing
			// text; smooth would lag behind rapid updates.
			behavior: agent.status === 'streaming' ? 'auto' : 'smooth',
		});
	}, [agent.messages, agent.status, agent.historyReady]);

	// If the stored passcode was invalidated (e.g. changed server-side), the
	// history load fails with 401 forever and the chat would hang on
	// "Cargando conversación…". Clear it and let the gate ask again.
	useEffect(() => {
		if (
			agent.status === 'error' &&
			/401|unauthorized|passcode/i.test(String(agent.error ?? ''))
		) {
			localStorage.removeItem(PASSCODE_KEY);
			location.reload();
		}
	}, [agent.status, agent.error]);

	function handleScroll() {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
		pinnedToBottomRef.current = distance < 120;
		setShowScrollButton(distance > 120);
	}

	function scrollToBottom() {
		pinnedToBottomRef.current = true;
		viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: 'smooth' });
	}

	async function send(text: string) {
		if (!text) return;
		await agent.sendMessage(text);
		onUserMessage?.(text);
	}

	// ChatGPT-style stop: abort the in-flight generation; the conversation
	// keeps everything the agent streamed before the abort settled.
	async function stop() {
		try {
			await client.abort();
		} catch {
			// The abort intent is best-effort; the settlement observer will
			// reflect whatever outcome lands.
		}
	}

	async function submit(event?: React.FormEvent) {
		event?.preventDefault();
		const message = input.trim();
		if (!message || busy) return;
		setInput('');
		// Sending a message always re-anchors the view to the bottom.
		pinnedToBottomRef.current = true;
		await send(message);
	}

	function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			// While a reply is streaming, Enter mirrors the stop button.
			if (busy) {
				void stop();
				return;
			}
			void submit();
		}
	}

	const composer = (
		<>
			{failed || (agent.status === 'error' && agent.historyReady) ? (
				<div className="alert destructive" role="alert">
					<div className="alert-title">No se pudo enviar el mensaje</div>
					<div className="alert-desc">
						Comprueba la conexión y el passcode, e inténtalo de nuevo.
					</div>
				</div>
			) : null}

			<form className="input-group" onSubmit={(event) => void submit(event)}>
			<textarea
				className="input-group-textarea"
					rows={1}
					autoFocus
					value={input}
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={busy ? 'Esperando respuesta…' : 'Envía un mensaje…'}
					disabled={connecting}
					aria-label="Mensaje"
				/>
				<div className="input-group-addon">
					{busy ? (
						<button
							type="button"
							className="btn default icon-sm stop-btn"
							onClick={() => void stop()}
							aria-label="Detener respuesta"
							title="Detener respuesta"
						>
							<StopIcon />
						</button>
					) : (
						<button
							type="submit"
							className="btn default icon-sm"
							aria-label="Enviar mensaje"
							disabled={!input.trim()}
						>
							<ArrowUpIcon />
						</button>
					)}
				</div>
			</form>
		</>
	);

	return (
		<div className="chat">
			<div className="viewport" ref={viewportRef} onScroll={handleScroll}>
				<div className="scroller-content">
					{!agent.historyReady && visible.length === 0 ? (
						<div className="empty-wrap">
							<p className="thinking shimmer">
								{agent.status === 'error'
									? 'Passcode inválido. Volviendo a pedirlo…'
									: 'Cargando conversación…'}
							</p>
						</div>
					) : null}

					{isEmpty ? (
						<div className="empty-wrap">
							<div className="empty">
								<div className="empty-header">
									<div className="empty-title">¿En qué puedo ayudarte?</div>
									<p className="empty-desc">
										Escribe un mensaje al agente y verás la respuesta en tiempo
										real.
									</p>
								</div>
								<div className="composer-zone in-empty">{composer}</div>
								<div className="empty-content">
									<div className="suggestions">
										{SUGGESTIONS.map((suggestion) => (
											<button
												key={suggestion.label}
												type="button"
												className="btn outline sm"
												onClick={() => {
													setInput('');
													void send(suggestion.prompt);
												}}
												disabled={busy}
											>
												{suggestion.label}
											</button>
										))}
									</div>
								</div>
							</div>
						</div>
					) : null}

				{visible.map((message) =>
					message.role === 'user' ? (
						<article key={message.id} className="msg end">
							<div className="msg-content">
								<div className="bubble">{messageText(message)}</div>
							</div>
						</article>
					) : (
						<article key={message.id} className="msg">
							<div className="msg-content">
								<div className="typeset">
									<ReactMarkdown remarkPlugins={[remarkGfm]}>
										{messageText(message)}
									</ReactMarkdown>
								</div>
							</div>
						</article>
					),
				)}

					{showActivity ? (
						<div className="msg">
							<div className="thinking">
								<span className="shimmer">{activityLabel}</span>
							</div>
						</div>
					) : null}

					<div ref={bottomRef} />
				</div>

				<button
					type="button"
					className="scroll-btn"
					hidden={!showScrollButton}
					onClick={scrollToBottom}
					aria-label="Ir al final"
				>
					<ArrowDownIcon />
				</button>
			</div>

			{/* While history is loading render no composer at all, so a thread
			    that turns out to be empty doesn't flash the docked composer. */}
			{agent.historyReady && !isEmpty ? <div className="composer-zone">{composer}</div> : null}
		</div>
	);
}