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

	// The SDK appends an optimistic echo of each send (id `local:*`) and only
	// drops it once the send receipt lands; meanwhile the live stream may
	// already carry the canonical message, rendering the user's message twice
	// for a few frames. Hide the echo while its canonical twin is the previous
	// visible message.
	const visible: FlueConversationMessage[] = [];
	for (const message of agent.messages) {
		if (message.display !== 'visible') continue;
		const prev = visible[visible.length - 1];
		if (
			message.id.startsWith('local:') &&
			message.role === 'user' &&
			prev?.role === 'user' &&
			messageText(prev) === messageText(message)
		) {
			continue;
		}
		visible.push(message);
	}

	const busy = agent.status === 'submitted' || agent.status === 'streaming';

	// The live stream delivers text deltas coalesced into ~1s batches, so the
	// raw feed jumps in big chunks. Reveal the last assistant message
	// character by character (typewriter) so replies appear progressively.
	const lastMessage = visible[visible.length - 1];
	const lastAssistant = lastMessage?.role === 'assistant' ? lastMessage : undefined;
	const targetText = lastAssistant ? messageText(lastAssistant) : '';
	const targetId = lastAssistant?.id ?? '';

	const [reveal, setReveal] = useState<{ id: string; count: number }>({
		id: '',
		count: 0,
	});

	useEffect(() => {
		if (!targetId) return;
		const timer = setInterval(() => {
			setReveal((prev) => {
				if (prev.id !== targetId) {
					// A fresh target reveals from zero only while a response is
					// live; settled history (re)loads fully revealed.
					return { id: targetId, count: busy ? 0 : targetText.length };
				}
				if (prev.count >= targetText.length) return prev;
				const step = Math.max(
					1,
					Math.ceil((targetText.length - prev.count) * 0.15),
				);
				return {
					id: targetId,
					count: Math.min(targetText.length, prev.count + step),
				};
			});
		}, 40);
		return () => clearInterval(timer);
	}, [targetId, targetText.length, busy]);

	const revealedCount =
		reveal.id === targetId ? Math.min(reveal.count, targetText.length) : 0;
	const revealing = !!lastAssistant && revealedCount < targetText.length;

	// A single indicator — an animated dot, no words — holds the spot until
	// the first revealed character lands, then the reply takes its exact
	// place. Nothing is ever rendered below the reply's text.
	const showActivity = busy && revealedCount === 0;

	const failed = agent.failedSends.length > 0;
	const connecting = agent.status === 'connecting' && !agent.historyReady;
	// ChatGPT-style layout: with an empty thread the composer lives centered
	// under the greeting and docks to the bottom once messages exist.
	const isEmpty = agent.historyReady && visible.length === 0;

	useEffect(() => {
		if (!pinnedToBottomRef.current) return;
		// Scroll ONLY the chat viewport: scrollIntoView() would also drag
		// every scrollable ancestor (the document itself), making the whole
		// layout — composer included — dip on every stream chunk.
		const viewport = viewportRef.current;
		if (!viewport) return;
		// 'instant' (not 'auto'): 'auto' would honor any CSS scroll-behavior,
		// and animated scrolls interrupted by the next chunk produce a tiny
		// bounce right as the reply starts.
		viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' });
	}, [agent.messages, agent.status, agent.historyReady, revealedCount]);

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
								{message.id === targetId && revealedCount === 0 ? (
									<div className="typeset">
										<span className="pulse-dot" />
									</div>
								) : (
									<div className="typeset">
										<ReactMarkdown remarkPlugins={[remarkGfm]}>
											{message.id === targetId
												? `${targetText.slice(0, revealedCount)}${busy || revealing ? ' ▍' : ''}`
												: messageText(message)}
										</ReactMarkdown>
									</div>
								)}
							</div>
						</article>
					),
				)}

				{showActivity && !lastAssistant ? (
					<article className="msg">
						<div className="msg-content">
							<div className="typeset">
								<span className="pulse-dot" />
							</div>
						</div>
					</article>
				) : null}
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