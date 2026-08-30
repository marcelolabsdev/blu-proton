import { useEffect, useMemo, useState } from 'react';
import { Chat } from './Chat.tsx';
import {
	CloseIcon,
	MoreHorizontalIcon,
	PanelLeftIcon,
	PencilIcon,
	PlusIcon,
	SearchIcon,
	SparklesIcon,
	TrashIcon,
} from './icons.tsx';

const PASSCODE_KEY = 'flue-chat-passcode';
const CONVERSATION_KEY = 'flue-chat-conversation-id';
const CONVERSATIONS_KEY = 'flue-chat-conversations';
const DAY_MS = 86_400_000;

interface Conversation {
	id: string;
	title: string;
	updatedAt: number;
}

interface ConversationGroup {
	label: string;
	items: Conversation[];
}

function loadPasscode(): string {
	return localStorage.getItem(PASSCODE_KEY) ?? '';
}

function newConversationId(): string {
	const id = crypto.randomUUID();
	localStorage.setItem(CONVERSATION_KEY, id);
	return id;
}

function loadActiveConversationId(): string {
	const existing = localStorage.getItem(CONVERSATION_KEY);
	if (existing) return existing;
	return newConversationId();
}

function loadConversations(): Conversation[] {
	try {
		const raw = localStorage.getItem(CONVERSATIONS_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(entry): entry is Conversation =>
					typeof entry === 'object' &&
					entry !== null &&
					typeof (entry as Conversation).id === 'string',
			)
			.map((entry) => ({
				id: entry.id,
				title: typeof entry.title === 'string' ? entry.title : '',
				updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
			}));
	} catch {
		return [];
	}
}

function persistConversations(conversations: Conversation[]) {
	localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
}

function firstMessageTitle(text: string): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	const firstLine = clean.split('\n')[0] ?? '';
	return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}

function groupOf(timestamp: number): string {
	if (timestamp <= 0) return 'Hoy';
	const now = new Date();
	const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (timestamp >= startToday) return 'Hoy';
	if (timestamp >= startToday - DAY_MS) return 'Ayer';
	if (timestamp >= startToday - 7 * DAY_MS) return 'Últimos 7 días';
	return 'Anteriormente';
}

const GROUP_ORDER = ['Hoy', 'Ayer', 'Últimos 7 días', 'Anteriormente'];

function buildGroups(conversations: Conversation[]): ConversationGroup[] {
	const buckets = new Map<string, Conversation[]>();
	for (const entry of conversations) {
		const label = groupOf(entry.updatedAt);
		const list = buckets.get(label);
		if (list) list.push(entry);
		else buckets.set(label, [entry]);
	}
	return GROUP_ORDER.filter((label) => buckets.has(label)).map((label) => ({
		label,
		items: buckets.get(label)!,
	}));
}

function PasscodeGate({ onUnlock }: { onUnlock: (passcode: string) => void }) {
	const [value, setValue] = useState('');
	const [error, setError] = useState('');

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		const passcode = value.trim();
		if (!passcode) return;

		// Verify against the server before storing: a wrong passcode would
		// otherwise linger in localStorage and break every future request.
		// GET history goes through the same auth middleware without
		// triggering a model call. The probe uses a random conversation id
		// that never exists, so the expected outcomes are:
		//   401 -> wrong passcode; 200/404 -> passcode accepted.
		const probe = await fetch(`/agents/assistant/probe-${crypto.randomUUID()}?view=history`, {
			headers: { 'x-chat-passcode': passcode },
		});
		if (probe.status === 401) {
			setError('Passcode incorrecto.');
			return;
		}
		if (!probe.ok && probe.status !== 404) {
			setError(`No se pudo contactar al servidor (HTTP ${probe.status}).`);
			return;
		}
		localStorage.setItem(PASSCODE_KEY, passcode);
		onUnlock(passcode);
	}

	return (
		<div className="gate-wrap">
			<form className="gate" onSubmit={submit}>
				<h1>8lab Chat</h1>
				<p>Introduce el passcode para hablar con el agente.</p>
				<input
					className="gate-input"
					type="password"
					value={value}
					onChange={(event) => setValue(event.target.value)}
					placeholder="Passcode"
					autoFocus
				/>
				<button type="submit" className="btn default" disabled={!value.trim()}>
					Entrar
				</button>
				{error ? <p className="gate-error">{error}</p> : null}
			</form>
		</div>
	);
}

export function App() {
	const [passcode, setPasscode] = useState(loadPasscode);
	const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
	const [activeId, setActiveId] = useState(loadActiveConversationId);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');
	const [openMenuId, setOpenMenuId] = useState<string | null>(null);

	useEffect(() => {
		if (!openMenuId) return;
		function closeOnOutsideClick(event: MouseEvent) {
			const target = event.target as HTMLElement | null;
			if (target?.closest('.sidebar-menu, .sidebar-more')) return;
			setOpenMenuId(null);
		}
		document.addEventListener('click', closeOnOutsideClick);
		return () => document.removeEventListener('click', closeOnOutsideClick);
	}, [openMenuId]);

	function startRenaming(entry: Conversation) {
		setRenamingId(entry.id);
		setRenameValue(entry.title);
	}

	function commitRename() {
		if (!renamingId) return;
		const title = renameValue.trim();
		if (title) {
			commitConversations(
				conversations.map((entry) =>
					entry.id === renamingId ? { ...entry, title } : entry,
				),
			);
		}
		setRenamingId(null);
		setRenameValue('');
	}

	function toggleSidebar() {
		// Desktop shows the sidebar statically, so the panel toggle collapses
		// it; on mobile the sidebar is an overlay opened by the same button.
		if (window.matchMedia('(min-width: 768px)').matches) {
			setSidebarCollapsed((value) => !value);
		} else {
			setSidebarOpen(true);
		}
	}

	function commitConversations(next: Conversation[]) {
		setConversations(next);
		persistConversations(next);
	}

	async function selectConversation(id: string) {
		localStorage.setItem(CONVERSATION_KEY, id);
		setActiveId(id);
		setSidebarOpen(false);
	}

	function startNewConversation() {
		// A blank chat isn't listed until the first message is sent
		// (recordActivity adds it), so there is nothing to duplicate.
		const current = conversations.find((entry) => entry.id === activeId);
		if (!current) return;
		setActiveId(newConversationId());
		setSidebarOpen(false);
	}

	function deleteConversation(id: string) {
		const remaining = conversations.filter((entry) => entry.id !== id);
		if (activeId === id) {
			// Jump to the next existing conversation, or to a blank chat that
			// stays unlisted until a message is sent.
			setActiveId(remaining.length > 0 ? remaining[0].id : newConversationId());
		}
		commitConversations(remaining);
	}

	function recordActivity(text: string) {
		const title = firstMessageTitle(text);
		const now = Date.now();
		const exists = conversations.some((entry) => entry.id === activeId);
		commitConversations(
			exists
				? conversations.map((entry) =>
						entry.id === activeId
							? { ...entry, title: entry.title || title, updatedAt: now }
							: entry,
					)
				: [{ id: activeId, title, updatedAt: now }, ...conversations],
		);
	}

	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [dropTargetId, setDropTargetId] = useState<string | null>(null);

	function moveConversation(dragId: string, targetId: string) {
		if (dragId === targetId) return;
		const next = conversations.filter((entry) => entry.id !== dragId);
		const index = next.findIndex((entry) => entry.id === targetId);
		if (index === -1) return;
		next.splice(index, 0, conversations.find((entry) => entry.id === dragId)!);
		commitConversations(next);
	}

	// The stored array order is the display order: new conversations are
	// prepended and manual drag-reordering persists through localStorage.
	const sorted = conversations;

	const groups = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase();
		const filtered = normalizedQuery
			? sorted.filter((entry) => entry.title.toLowerCase().includes(normalizedQuery))
			: sorted;
		return buildGroups(filtered);
	}, [sorted, query]);

	if (!passcode) {
		return <PasscodeGate onUnlock={setPasscode} />;
	}

	return (
		<div className="app">
			<aside
				className={`sidebar${sidebarOpen ? ' open' : ''}${sidebarCollapsed ? ' collapsed' : ''}`}
			>
				<div className="sidebar-head">
					<span className="sidebar-logo">
						<SparklesIcon />
						8lab Chat
					</span>
					<div className="sidebar-head-actions">
						<button
							type="button"
							className={`btn ghost icon-sm sidebar-search-toggle${searchOpen ? ' active' : ''}`}
							onClick={() => {
								setSearchOpen((value) => {
									if (value) setQuery('');
									return !value;
								});
							}}
							aria-label="Buscar chats"
							title="Buscar chats"
						>
							<SearchIcon />
						</button>
						<button
							type="button"
							className="btn ghost icon-sm sidebar-close"
							onClick={() => setSidebarOpen(false)}
							aria-label="Cerrar"
						>
							<CloseIcon />
						</button>
					</div>
				</div>

				{searchOpen ? (
					<div className="sidebar-search-row">
						<SearchIcon />
						<input
							type="text"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Escape') {
									setSearchOpen(false);
									setQuery('');
								}
							}}
							placeholder="Buscar chats"
							aria-label="Buscar chats"
							autoFocus
						/>
					</div>
				) : null}

				<div className="sidebar-actions">
					<button type="button" className="sidebar-new" onClick={startNewConversation}>
						<PlusIcon />
						Nueva conversación
					</button>
				</div>

				<div className="sidebar-list">
					{groups.length === 0 ? (
						<p className="sidebar-empty">
							{sorted.length === 0 ? 'Aún no hay conversaciones.' : 'Sin resultados.'}
						</p>
					) : null}
					{groups.map((group) => (
						<div className="sidebar-group" key={group.label}>
							<div className="sidebar-group-label">{group.label}</div>
							{group.items.map((entry) => (
								<div
									key={entry.id}
									className={`sidebar-item${entry.id === activeId ? ' active' : ''}${
										entry.id === draggingId ? ' dragging' : ''
									}${entry.id === dropTargetId ? ' drop-target' : ''}`}
									draggable={renamingId !== entry.id}
									onDragStart={(event) => {
										setDraggingId(entry.id);
										event.dataTransfer.effectAllowed = 'move';
										event.dataTransfer.setData('text/plain', entry.id);
									}}
									onDragOver={(event) => {
										if (!draggingId) return;
										event.preventDefault();
										event.dataTransfer.dropEffect = 'move';
										if (dropTargetId !== entry.id) setDropTargetId(entry.id);
									}}
									onDragLeave={() => {
										if (dropTargetId === entry.id) setDropTargetId(null);
									}}
									onDrop={(event) => {
										event.preventDefault();
										const dragId = draggingId ?? event.dataTransfer.getData('text/plain');
										if (dragId) moveConversation(dragId, entry.id);
										setDraggingId(null);
										setDropTargetId(null);
									}}
									onDragEnd={() => {
										setDraggingId(null);
										setDropTargetId(null);
									}}
								>
									{renamingId === entry.id ? (
										<input
											className="sidebar-rename-input"
											value={renameValue}
											onChange={(event) => setRenameValue(event.target.value)}
											onKeyDown={(event) => {
												if (event.key === 'Enter') commitRename();
												if (event.key === 'Escape') {
													setRenamingId(null);
													setRenameValue('');
												}
											}}
											onBlur={commitRename}
											autoFocus
											aria-label="Renombrar conversación"
										/>
									) : (
										<button
											type="button"
											className="sidebar-main"
											onClick={() => void selectConversation(entry.id)}
										>
											<span className="sidebar-item-title">
												{entry.title || 'Nueva conversación'}
											</span>
										</button>
									)}
									{renamingId !== entry.id ? (
										<div className="sidebar-more-wrap">
											<button
												type="button"
												className="btn ghost icon-sm sidebar-more"
												onClick={() =>
													setOpenMenuId((value) => (value === entry.id ? null : entry.id))
												}
												aria-label="Más opciones"
												title="Más opciones"
											>
												<MoreHorizontalIcon />
											</button>
											{openMenuId === entry.id ? (
												<div className="sidebar-menu" role="menu">
													<button
														type="button"
														className="sidebar-menu-item"
														role="menuitem"
														onClick={() => {
															setOpenMenuId(null);
															startRenaming(entry);
														}}
													>
														<PencilIcon />
														Renombrar
													</button>
													<button
														type="button"
														className="sidebar-menu-item destructive"
														role="menuitem"
														onClick={() => {
															setOpenMenuId(null);
															deleteConversation(entry.id);
														}}
													>
														<TrashIcon />
														Eliminar
													</button>
												</div>
											) : null}
										</div>
									) : null}
								</div>
							))}
					</div>
				))}
				</div>
			</aside>

			{sidebarOpen ? (
				<div className="scrim" onClick={() => setSidebarOpen(false)} />
			) : null}

			<div className="main">
				<div className="panel-head">
					<button
						type="button"
						className="btn ghost icon-sm panel-toggle"
						onClick={toggleSidebar}
						aria-label={sidebarCollapsed ? 'Mostrar barra lateral' : 'Ocultar barra lateral'}
						title={sidebarCollapsed ? 'Mostrar barra lateral' : 'Ocultar barra lateral'}
					>
						<PanelLeftIcon />
					</button>
					<span className="panel-title">
						{conversations.find((entry) => entry.id === activeId)?.title ||
							'Nueva conversación'}
					</span>
				</div>
				<Chat
					key={activeId}
					conversationId={activeId}
					passcode={passcode}
					onUserMessage={recordActivity}
				/>
			</div>
		</div>
	);
}